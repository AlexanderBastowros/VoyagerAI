import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  copyImportSource,
  detectImportFormat,
  finalizeMeshImport,
  finalizeStepImport,
  isUnitlessFormat,
  measureMeshImport,
  pickUnitConfirmationAxis,
  slugifyForFilename
} from './importModel'
import type { SpawnLike } from './importModel'

interface FakeOutcome {
  code?: number | null
  stdout?: string
  stderr?: string
  sideEffect?: (cwd: string, args: readonly string[]) => Promise<void>
}

function makeFakeSpawn(outcome: FakeOutcome): { spawnFn: SpawnLike; calls: Array<{ cwd?: string; args: readonly string[] }> } {
  const calls: Array<{ cwd?: string; args: readonly string[] }> = []
  const spawnFn: SpawnLike = (_command, args, options) => {
    calls.push({ cwd: options.cwd ? String(options.cwd) : undefined, args })
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    Object.assign(child, { stdout, stderr })

    queueMicrotask(() => {
      void (async () => {
        if (outcome.sideEffect) await outcome.sideEffect(String(options.cwd), args)
        if (outcome.stdout) stdout.emit('data', Buffer.from(outcome.stdout))
        if (outcome.stderr) stderr.emit('data', Buffer.from(outcome.stderr))
        child.emit('close', outcome.code ?? 0)
      })()
    })
    return child
  }
  return { spawnFn, calls }
}

describe('detectImportFormat', () => {
  it.each([
    ['model.step', 'step'],
    ['model.STP', 'step'],
    ['model.stl', 'stl'],
    ['model.STL', 'stl'],
    ['model.obj', 'obj'],
    ['model.3mf', '3mf'],
    ['model.gltf', null],
    ['model', null]
  ])('detects %s as %s', (path, expected) => {
    expect(detectImportFormat(path)).toBe(expected)
  })
})

describe('isUnitlessFormat', () => {
  it('is true only for stl/obj', () => {
    expect(isUnitlessFormat('stl')).toBe(true)
    expect(isUnitlessFormat('obj')).toBe(true)
    expect(isUnitlessFormat('step')).toBe(false)
    expect(isUnitlessFormat('3mf')).toBe(false)
  })
})

describe('pickUnitConfirmationAxis', () => {
  it('picks the largest extent', () => {
    expect(pickUnitConfirmationAxis([120, 40, 10])).toEqual({ axis: 'x', measuredMm: 120 })
    expect(pickUnitConfirmationAxis([10, 120, 40])).toEqual({ axis: 'y', measuredMm: 120 })
    expect(pickUnitConfirmationAxis([10, 40, 120])).toEqual({ axis: 'z', measuredMm: 120 })
  })

  it('ties break toward the earlier axis', () => {
    expect(pickUnitConfirmationAxis([50, 50, 50])).toEqual({ axis: 'x', measuredMm: 50 })
  })
})

describe('slugifyForFilename', () => {
  it('lowercases, collapses separators, and strips leading/trailing dashes', () => {
    expect(slugifyForFilename('Lid Assembly!')).toBe('lid-assembly')
    expect(slugifyForFilename('../escape')).toBe('escape')
    expect(slugifyForFilename('')).toBe('part')
  })
})

let scratch: string
let projectDir: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'voyager-import-'))
  projectDir = join(scratch, 'project')
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('copyImportSource', () => {
  it('copies the source into imports/<uuid>.<ext> without touching the original', async () => {
    const sourcePath = join(scratch, 'downloaded.stl')
    await writeFile(sourcePath, 'stl-bytes', 'utf-8')

    const result = await copyImportSource(projectDir, sourcePath, 'stl')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.importRelPath).toMatch(/^imports\/[0-9a-f-]+\.stl$/)
    const copied = await readFile(join(projectDir, result.importRelPath), 'utf-8')
    expect(copied).toBe('stl-bytes')
    // Original untouched.
    expect(await readFile(sourcePath, 'utf-8')).toBe('stl-bytes')
  })

  it('fails cleanly when the source does not exist', async () => {
    const result = await copyImportSource(projectDir, join(scratch, 'missing.stl'), 'stl')
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('Could not read') as unknown as string
    })
  })

  it('fails cleanly when the source is a directory', async () => {
    const dirPath = join(scratch, 'a-directory')
    await mkdir(dirPath)
    const result = await copyImportSource(projectDir, dirPath, 'stl')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('is not a file')
  })
})

describe('measureMeshImport', () => {
  it('parses a successful measurement', async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      code: 0,
      stdout: JSON.stringify({ ok: true, bboxMm: [120, 40, 10], watertight: true, faceCount: 100, vertexCount: 52 })
    })
    const result = await measureMeshImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      projectDir,
      'imports/abc.stl'
    )
    expect(result).toEqual({
      ok: true,
      measurement: { bboxMm: [120, 40, 10], watertight: true, faceCount: 100, vertexCount: 52 }
    })
    expect(calls[0]?.args).toEqual(['/remix/measure_mesh.py', join(projectDir, 'imports/abc.stl')])
  })

  it('surfaces a reason when the script itself reports failure', async () => {
    const { spawnFn } = makeFakeSpawn({
      code: 0,
      stdout: JSON.stringify({ ok: false, reason: 'No mesh data found.' })
    })
    const result = await measureMeshImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      projectDir,
      'imports/abc.stl'
    )
    expect(result).toEqual({ ok: false, reason: 'No mesh data found.' })
  })

  it('fails with the stderr tail on a non-zero exit', async () => {
    const { spawnFn } = makeFakeSpawn({ code: 1, stderr: 'Traceback: boom' })
    const result = await measureMeshImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      projectDir,
      'imports/abc.stl'
    )
    expect(result).toEqual({ ok: false, reason: 'Traceback: boom' })
  })

  it('fails cleanly when stdout is not parseable JSON', async () => {
    const { spawnFn } = makeFakeSpawn({ code: 0, stdout: 'not json' })
    const result = await measureMeshImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      projectDir,
      'imports/abc.stl'
    )
    expect(result).toEqual({ ok: false, reason: 'Could not parse the measurement output.' })
  })
})

describe('finalizeMeshImport', () => {
  it('writes the self-contained script, runs it, and folds the repair report into the summary', async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      code: 0,
      stdout: JSON.stringify({ repairReport: ['filled 1 hole(s)'], watertight: true, bboxMm: [25, 25, 25] }),
      sideEffect: async (cwd) => {
        // A real run's script export - the fake spawn simulates the side effect a real
        // `base.export(...)` call inside the generated script would have produced.
        await writeFile(join(cwd, 'outputs', 'main_v1.stl'), 'stl-bytes')
      }
    })

    const result = await finalizeMeshImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      {
        projectDir,
        importRelPath: 'imports/abc.stl',
        partId: 'main',
        nextN: 1,
        scaleFactor: 2.5,
        sourceBaseName: 'downloaded.stl'
      }
    )

    expect(result).toEqual({
      ok: true,
      scriptRelPath: 'outputs/main_v1.py',
      stlRelPath: 'outputs/main_v1.stl',
      summary: 'Imported downloaded.stl (repaired: filled 1 hole(s))'
    })

    // Ran with cwd = the real project dir (not a scratch dir - this is the recorded artifact).
    expect(calls[0]?.cwd).toBe(projectDir)

    const scriptOnDisk = await readFile(join(projectDir, 'outputs/main_v1.py'), 'utf-8')
    expect(scriptOnDisk).toContain('SOURCE = "imports/abc.stl"')
    expect(scriptOnDisk).toContain('SCALE = 2.5')
    expect(scriptOnDisk).toContain('base.export("./outputs/main_v1.stl")')
    // Self-contained: no cross-package import of this repo's own remix/ helpers.
    expect(scriptOnDisk).not.toContain('from repair_mesh')
    expect(scriptOnDisk).not.toContain('import repair_mesh')

    expect(await stat(join(projectDir, 'outputs', 'main_v1.stl'))).toBeTruthy()
  })

  it('omits the repair-report parenthetical when nothing needed fixing', async () => {
    const { spawnFn } = makeFakeSpawn({
      code: 0,
      stdout: JSON.stringify({ repairReport: [], watertight: true, bboxMm: [10, 10, 10] })
    })
    const result = await finalizeMeshImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      { projectDir, importRelPath: 'imports/abc.stl', partId: 'main', nextN: 1, scaleFactor: 1, sourceBaseName: 'clean.stl' }
    )
    expect(result).toEqual({
      ok: true,
      scriptRelPath: 'outputs/main_v1.py',
      stlRelPath: 'outputs/main_v1.stl',
      summary: 'Imported clean.stl'
    })
  })

  it('fails with the stderr tail when the script exits non-zero', async () => {
    const { spawnFn } = makeFakeSpawn({ code: 1, stderr: 'Traceback: something broke' })
    const result = await finalizeMeshImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      { projectDir, importRelPath: 'imports/abc.stl', partId: 'main', nextN: 1, scaleFactor: 1, sourceBaseName: 'x.stl' }
    )
    expect(result).toEqual({
      ok: false,
      reason: 'Could not finalize the import: Traceback: something broke'
    })
  })
})

describe('finalizeStepImport', () => {
  it('writes a build123d import_step script referencing the import and runs it', async () => {
    const { spawnFn, calls } = makeFakeSpawn({ code: 0, stdout: JSON.stringify({ bboxMm: [40, 20, 10] }) })

    const result = await finalizeStepImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      { projectDir, importRelPath: 'imports/xyz.step', partId: 'main', nextN: 1, sourceBaseName: 'bracket.step' }
    )

    expect(result).toEqual({
      ok: true,
      scriptRelPath: 'outputs/main_v1.py',
      stlRelPath: 'outputs/main_v1.stl',
      stepRelPath: 'outputs/main_v1.step',
      summary: 'Imported bracket.step (STEP - full parametric remix available)'
    })
    expect(calls[0]?.cwd).toBe(projectDir)

    const scriptOnDisk = await readFile(join(projectDir, 'outputs/main_v1.py'), 'utf-8')
    expect(scriptOnDisk).toContain('import_step(SOURCE)')
    expect(scriptOnDisk).toContain('SOURCE = "imports/xyz.step"')
    expect(scriptOnDisk).toContain('export_stl(base, "./outputs/main_v1.stl"')
    expect(scriptOnDisk).toContain('export_step(base, "./outputs/main_v1.step")')
  })

  it('fails with the stderr tail when the script exits non-zero', async () => {
    const { spawnFn } = makeFakeSpawn({ code: 1, stderr: 'Could not read STEP file' })
    const result = await finalizeStepImport(
      { pythonPath: '/venv/bin/python3', measureMeshScriptPath: '/remix/measure_mesh.py', spawn: spawnFn },
      { projectDir, importRelPath: 'imports/xyz.step', partId: 'main', nextN: 1, sourceBaseName: 'bad.step' }
    )
    expect(result).toEqual({
      ok: false,
      reason: 'Could not finalize the import: Could not read STEP file'
    })
  })
})
