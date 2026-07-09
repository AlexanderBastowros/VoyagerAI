import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rerunWithParam } from './rerun'
import type { SpawnLike } from './rerun'
import type { ScriptManifest } from '@shared/ipc'

const SCRIPT = `from build123d import *

# --- PARAMS ---
WIDTH = 40.0     # unit=mm min=10 max=200 label="Width"
HEIGHT = 20.0    # unit=mm min=5 max=100 label="Height"
# --- END PARAMS ---

with BuildPart() as part:
    Box(WIDTH, HEIGHT, 10)
`

const MANIFEST: ScriptManifest = {
  params: [
    { name: 'WIDTH', value: 40, unit: 'mm', label: 'Width', min: 10, max: 200 },
    { name: 'HEIGHT', value: 20, unit: 'mm', label: 'Height', min: 5, max: 100 }
  ],
  featureBindings: []
}

interface FakeOutcome {
  code?: number | null
  stderr?: string
  sideEffect?: (cwd: string) => Promise<void>
}

function makeFakeSpawn(outcome: FakeOutcome): { spawnFn: SpawnLike; cwds: string[] } {
  const cwds: string[] = []
  const spawnFn: SpawnLike = (_command, _args, options) => {
    cwds.push(String(options.cwd))
    const child = new EventEmitter() as unknown as ChildProcess
    const stderr = new EventEmitter()
    Object.assign(child, { stdout: new EventEmitter(), stderr })

    queueMicrotask(() => {
      void (async () => {
        if (outcome.sideEffect) await outcome.sideEffect(String(options.cwd))
        if (outcome.stderr) stderr.emit('data', Buffer.from(outcome.stderr))
        child.emit('close', outcome.code ?? 0)
      })()
    })
    return child
  }
  return { spawnFn, cwds }
}

let scratch: string
let projectDir: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'voyager-rerun-'))
  projectDir = join(scratch, 'project')
  await mkdir(join(projectDir, 'outputs', 'versions'), { recursive: true })
  await writeFile(join(projectDir, 'outputs', 'versions', 'v3.py'), SCRIPT, 'utf-8')
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('rerunWithParam', () => {
  it('substitutes the value, re-runs the script, and records the new artifacts + manifest', async () => {
    const { spawnFn, cwds } = makeFakeSpawn({
      code: 0,
      sideEffect: async (cwd) => {
        await mkdir(join(cwd, 'outputs'), { recursive: true })
        await writeFile(join(cwd, 'outputs', 'bracket_v4.stl'), 'stl-bytes')
        await writeFile(join(cwd, 'outputs', 'bracket_v4.step'), 'step-bytes')
      }
    })

    const result = await rerunWithParam(
      { projectDir, scriptRelPath: 'outputs/versions/v3.py', name: 'WIDTH', value: 55, manifest: MANIFEST },
      { pythonPath: '/venv/bin/python3', spawn: spawnFn }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.stlRelPath).toMatch(/^outputs\/param-edits\/.+\/outputs\/bracket_v4\.stl$/)
    expect(result.stepRelPath).toMatch(/^outputs\/param-edits\/.+\/outputs\/bracket_v4\.step$/)
    expect(result.scriptRelPath).toMatch(/^outputs\/param-edits\/.+\/v3\.py$/)
    expect(result.manifest.params[0]).toEqual({ name: 'WIDTH', value: 55, unit: 'mm', label: 'Width', min: 10, max: 200 })

    // The script that actually ran has the substituted value, not the original.
    const ranScript = await readFile(join(projectDir, result.scriptRelPath), 'utf-8')
    expect(ranScript).toContain('WIDTH = 55     # unit=mm min=10 max=200 label="Width"')

    // Manifest was written beside the STL, per the naming convention.
    const manifestPath = join(projectDir, 'outputs', 'param-edits', cwds[0].split('/').pop() as string, 'outputs', 'bracket_v4.manifest.json')
    const manifestOnDisk = JSON.parse(await readFile(manifestPath, 'utf-8'))
    expect(manifestOnDisk.params[0].value).toBe(55)

    // Ran with cwd set to the fresh scratch dir, not the project root.
    expect(cwds[0]).not.toBe(projectDir)
  })

  it('fails without spawning when the substitution itself fails', async () => {
    const { spawnFn, cwds } = makeFakeSpawn({ code: 0 })
    const result = await rerunWithParam(
      { projectDir, scriptRelPath: 'outputs/versions/v3.py', name: 'DEPTH', value: 5, manifest: MANIFEST },
      { pythonPath: '/venv/bin/python3', spawn: spawnFn }
    )
    expect(result).toEqual({ ok: false, reason: 'Parameter "DEPTH" was not found in the PARAMS block.' })
    expect(cwds).toEqual([])
  })

  it('fails when the source script cannot be read', async () => {
    const result = await rerunWithParam(
      { projectDir, scriptRelPath: 'outputs/versions/missing.py', name: 'WIDTH', value: 55, manifest: MANIFEST },
      { pythonPath: '/venv/bin/python3', spawn: makeFakeSpawn({ code: 0 }).spawnFn }
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Could not read the script')
  })

  it('fails with the stderr tail when the script exits non-zero', async () => {
    const { spawnFn } = makeFakeSpawn({ code: 1, stderr: 'Traceback: something broke' })
    const result = await rerunWithParam(
      { projectDir, scriptRelPath: 'outputs/versions/v3.py', name: 'WIDTH', value: 55, manifest: MANIFEST },
      { pythonPath: '/venv/bin/python3', spawn: spawnFn }
    )
    expect(result).toEqual({
      ok: false,
      reason: 'The script failed to re-run: Traceback: something broke'
    })
  })

  it('fails when the script exits 0 but produces no STL', async () => {
    const { spawnFn } = makeFakeSpawn({ code: 0 })
    const result = await rerunWithParam(
      { projectDir, scriptRelPath: 'outputs/versions/v3.py', name: 'WIDTH', value: 55, manifest: MANIFEST },
      { pythonPath: '/venv/bin/python3', spawn: spawnFn }
    )
    expect(result).toEqual({ ok: false, reason: 'The script ran but did not produce an STL export.' })
  })
})
