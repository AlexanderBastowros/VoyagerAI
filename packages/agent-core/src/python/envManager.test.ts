import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EnvManager, parseProgressLine } from './envManager'
import type { SpawnLike } from './envManager'
import type { SetupCheck } from '@shared/ipc'

interface FakeOutcome {
  code?: number
  stdoutLines?: string[]
  stderrLines?: string[]
  enoent?: boolean
  sideEffect?: () => void | Promise<void>
}

interface FakeCall {
  command: string
  args: string[]
}

function makeFakeSpawn(resolver: (command: string, args: string[]) => FakeOutcome): {
  spawnFn: SpawnLike
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const spawnFn: SpawnLike = (command, args) => {
    const argsArray = [...args]
    calls.push({ command, args: argsArray })

    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    Object.assign(child, { stdout, stderr })

    const outcome = resolver(command, argsArray)

    queueMicrotask(() => {
      void (async () => {
        if (outcome.sideEffect) await outcome.sideEffect()
        if (outcome.enoent) {
          child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }))
          return
        }
        for (const line of outcome.stdoutLines ?? []) stdout.emit('data', Buffer.from(`${line}\n`))
        for (const line of outcome.stderrLines ?? []) stderr.emit('data', Buffer.from(`${line}\n`))
        child.emit('close', outcome.code ?? 0)
      })()
    })

    return child
  }
  return { spawnFn, calls }
}

let tempRoots: string[] = []

async function makeDirs(): Promise<{ baseDir: string; binDir: string; venvPython: string }> {
  const root = await mkdtemp(join(tmpdir(), 'voyager-envmanager-'))
  tempRoots.push(root)
  const baseDir = join(root, 'pyenv')
  const binDir = join(root, 'bin')
  const venvPython = join(baseDir, 'venv', 'bin', 'python3')
  return { baseDir, binDir, venvPython }
}

beforeEach(() => {
  tempRoots = []
})

afterEach(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })))
})

function smokeTestOutcome(outPath: string): FakeOutcome {
  return {
    code: 0,
    stdoutLines: ['SMOKE_TEST_OK size=1500 watertight=True'],
    sideEffect: () => writeFile(outPath, Buffer.alloc(1500, 1))
  }
}

describe('parseProgressLine', () => {
  it('classifies known installer output lines into coarse stages', () => {
    expect(parseProgressLine('Creating virtual environment at: /foo/venv')).toBe(
      'Creating virtual environment…'
    )
    expect(parseProgressLine('Downloaded build123d==0.8.2')).toMatch(/build123d/)
    expect(parseProgressLine('Building wheel for OCP (pyproject.toml)')).toMatch(/build123d/)
    expect(parseProgressLine('Downloaded trimesh==4.0.1')).toBe('Installing trimesh…')
    expect(parseProgressLine('Downloaded numpy==1.26.4')).toBe('Installing numpy…')
    expect(parseProgressLine('Downloaded bd_warehouse==0.2.0')).toMatch(/bd_warehouse/)
    expect(parseProgressLine('Resolved 12 packages in 340ms')).toBe('Resolving package versions…')
    expect(parseProgressLine('Installed 12 packages in 2.1s')).toBe('Finalizing installation…')
  })

  it('returns null for lines that do not match any known stage', () => {
    expect(parseProgressLine('')).toBeNull()
    expect(parseProgressLine('some totally unrelated log line')).toBeNull()
    expect(parseProgressLine('Building wheel for foo (pyproject.toml)')).toBeNull()
  })
})

describe('EnvManager strategy selection', () => {
  it('prefers uv on PATH when available', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    const { spawnFn, calls } = makeFakeSpawn((command, args) => {
      if (command === 'uv') {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['uv 0.4.0'] }
        if (args[0] === 'venv') return { code: 0, stdoutLines: [`Creating virtual environment at: ${args[1]}`] }
        if (args[0] === 'pip' && args[1] === 'install') {
          return {
            code: 0,
            stdoutLines: [
              'Resolved 12 packages in 400ms',
              'Downloaded build123d==0.8.0',
              'Downloaded trimesh==4.0.0',
              'Downloaded numpy==1.26.0',
              'Installed 12 packages in 3.2s'
            ]
          }
        }
      }
      if (command === venvPython) {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.11.7'] }
        return smokeTestOutcome(args[1])
      }
      return { enoent: true }
    })

    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })
    const progress: SetupCheck[] = []
    const result = await envManager.ensureReady((c) => progress.push(c))

    expect(result.state).toBe('ready')
    // Only uv was ever invoked for provisioning - never python3, sh, or a downloaded uv copy.
    expect(calls.some((c) => c.command === 'python3')).toBe(false)
    expect(calls.some((c) => c.command === 'sh')).toBe(false)
    expect(calls.some((c) => c.command === 'uv' && c.args[0] === 'venv')).toBe(true)
    expect(calls.some((c) => c.command === 'uv' && c.args[0] === 'pip')).toBe(true)
    expect(progress.some((p) => p.detail.includes('Creating virtual environment'))).toBe(true)
    // WS-H: bd_warehouse (spur-gear library, `references/gears.md` §1) rides along in the same
    // single install call as the other always-installed packages - no separate lazy step for it.
    const pipInstallCall = calls.find((c) => c.command === 'uv' && c.args[0] === 'pip' && c.args[1] === 'install')
    expect(pipInstallCall?.args).toContain('bd_warehouse')
  })

  it('falls back to system python3 >= 3.10 when uv is unavailable', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    const { spawnFn, calls } = makeFakeSpawn((command, args) => {
      if (command === 'uv' || command === join(binDir, 'uv')) return { enoent: true }
      if (command === 'python3') {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.11.2'] }
        if (args[0] === '-m' && args[1] === 'venv') return { code: 0, stdoutLines: [] }
      }
      if (command === venvPython) {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.11.2'] }
        if (args[0] === '-m' && args[1] === 'pip') {
          return { code: 0, stdoutLines: ['Collecting build123d', 'Collecting trimesh', 'Collecting numpy'] }
        }
        return smokeTestOutcome(args[1])
      }
      return { enoent: true }
    })

    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })
    const result = await envManager.ensureReady()

    expect(result.state).toBe('ready')
    expect(calls.some((c) => c.command === 'python3' && c.args[0] === '-m' && c.args[1] === 'venv')).toBe(true)
    expect(calls.some((c) => c.command === venvPython && c.args[0] === '-m' && c.args[1] === 'pip')).toBe(true)
    // 'uv' may be *probed* as part of strategy detection, but never used to actually provision.
    expect(calls.some((c) => c.command === 'uv' && (c.args[0] === 'venv' || c.args[0] === 'pip'))).toBe(false)
  })

  it('downloads uv on demand when neither uv nor a usable system python3 is available', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    const uvBinPath = join(binDir, 'uv')
    // Starts out not-yet-downloaded; the 'sh' install script "installs" it,
    // flipping this so the post-install `uv --version` probe succeeds.
    let uvDownloaded = false
    const { spawnFn, calls } = makeFakeSpawn((command, args) => {
      if (command === 'uv') return { enoent: true }
      if (command === 'python3') {
        // Present, but too old to satisfy the >=3.10 venv requirement.
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.6.9'] }
        return { enoent: true }
      }
      if (command === 'sh') {
        return {
          code: 0,
          stdoutLines: ['installed uv to ' + binDir],
          sideEffect: () => {
            uvDownloaded = true
          }
        }
      }
      if (command === uvBinPath) {
        if (!uvDownloaded) return { enoent: true }
        if (args[0] === '--version') return { code: 0, stdoutLines: ['uv 0.4.0'] }
        if (args[0] === 'venv') return { code: 0, stdoutLines: [`Creating virtual environment at: ${args[1]}`] }
        if (args[0] === 'pip' && args[1] === 'install') {
          return { code: 0, stdoutLines: ['Downloaded build123d==0.8.0', 'Installed 3 packages'] }
        }
      }
      if (command === venvPython) {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.11.7'] }
        return smokeTestOutcome(args[1])
      }
      return { enoent: true }
    })

    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })
    const result = await envManager.ensureReady()

    expect(result.state).toBe('ready')
    expect(calls.some((c) => c.command === 'sh')).toBe(true)
    expect(calls.some((c) => c.command === uvBinPath && c.args[0] === 'venv')).toBe(true)
  })

  it('reports an actionable error when uv, python3, and the uv download all fail', async () => {
    const { baseDir, binDir } = await makeDirs()
    const { spawnFn } = makeFakeSpawn(() => ({ enoent: true }))

    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })
    const result = await envManager.ensureReady()

    expect(result.state).toBe('error')
    expect(result.detail).toMatch(/install python 3\.10\+ or uv/i)
  })
})

describe('EnvManager failure surfacing', () => {
  it('surfaces a package install failure as an error state', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    const { spawnFn } = makeFakeSpawn((command, args) => {
      if (command === 'uv') {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['uv 0.4.0'] }
        if (args[0] === 'venv') return { code: 0, stdoutLines: [] }
        if (args[0] === 'pip') return { code: 1, stderrLines: ['error: failed to build build123d (OCP wheel)'] }
      }
      if (command === venvPython) return { code: 0, stdoutLines: ['Python 3.11.7'] }
      return { enoent: true }
    })

    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })
    const result = await envManager.ensureReady()

    expect(result.state).toBe('error')
    expect(result.detail).toMatch(/failed to install python packages/i)
  })

  it('surfaces a smoke test failure as an error state', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    const { spawnFn } = makeFakeSpawn((command, args) => {
      if (command === 'uv') {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['uv 0.4.0'] }
        if (args[0] === 'venv') return { code: 0, stdoutLines: [] }
        if (args[0] === 'pip') return { code: 0, stdoutLines: ['Installed 3 packages'] }
      }
      if (command === venvPython) {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.11.7'] }
        // Smoke test script itself fails.
        return { code: 1, stderrLines: ['Failed to build/export test part: boom'] }
      }
      return { enoent: true }
    })

    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })
    const result = await envManager.ensureReady()

    expect(result.state).toBe('error')
    expect(result.detail).toMatch(/smoke test failed/i)
  })
})

describe('EnvManager marker-file fast path', () => {
  it('reports ready without spawning anything when a valid marker + venv python already exist', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    await mkdir(join(baseDir, 'venv', 'bin'), { recursive: true })
    await writeFile(venvPython, '#!/bin/sh\n')
    await writeFile(
      join(baseDir, 'pyenv.json'),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        pythonVersion: 'Python 3.11.7',
        packages: { build123d: '0.8.0', trimesh: '4.0.0', numpy: '1.26.0' },
        smokeTest: { ok: true, sizeBytes: 1500, watertight: true, at: new Date().toISOString() }
      })
    )

    const { spawnFn, calls } = makeFakeSpawn(() => ({ enoent: true }))
    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })

    const result = await envManager.ensureReady()

    expect(result.state).toBe('ready')
    expect(calls.length).toBe(0)
  })

  it('falls through to full provisioning when the marker is missing even if the venv python exists', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    await mkdir(join(baseDir, 'venv', 'bin'), { recursive: true })
    await writeFile(venvPython, '#!/bin/sh\n')
    // No pyenv.json marker written.

    const { spawnFn, calls } = makeFakeSpawn((command, args) => {
      if (command === 'uv') {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['uv 0.4.0'] }
        if (args[0] === 'venv') return { code: 0, stdoutLines: [] }
        if (args[0] === 'pip') return { code: 0, stdoutLines: ['Installed 3 packages'] }
      }
      if (command === venvPython) {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.11.7'] }
        return smokeTestOutcome(args[1])
      }
      return { enoent: true }
    })
    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })

    const result = await envManager.ensureReady()

    expect(result.state).toBe('ready')
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('EnvManager retry()', () => {
  it('discards a cached-ready marker and re-provisions from scratch', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    await mkdir(join(baseDir, 'venv', 'bin'), { recursive: true })
    await writeFile(venvPython, '#!/bin/sh\n')
    await writeFile(
      join(baseDir, 'pyenv.json'),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        pythonVersion: 'Python 3.11.7',
        packages: {},
        smokeTest: { ok: true, sizeBytes: 1500, watertight: true, at: new Date().toISOString() }
      })
    )

    const { spawnFn, calls } = makeFakeSpawn((command, args) => {
      if (command === 'uv') {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['uv 0.4.0'] }
        if (args[0] === 'venv') return { code: 0, stdoutLines: [] }
        if (args[0] === 'pip') return { code: 0, stdoutLines: ['Installed 3 packages'] }
      }
      if (command === venvPython) {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.11.7'] }
        return smokeTestOutcome(args[1])
      }
      return { enoent: true }
    })
    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })

    const result = await envManager.retry()

    expect(result.state).toBe('ready')
    expect(calls.some((c) => c.command === 'uv' && c.args[0] === 'venv')).toBe(true)
  })
})

describe('EnvManager.ensureReady concurrency', () => {
  it('shares a single in-flight provisioning run across concurrent callers', async () => {
    const { baseDir, binDir, venvPython } = await makeDirs()
    const { spawnFn, calls } = makeFakeSpawn((command, args) => {
      if (command === 'uv') {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['uv 0.4.0'] }
        if (args[0] === 'venv') return { code: 0, stdoutLines: [] }
        if (args[0] === 'pip') return { code: 0, stdoutLines: ['Installed 3 packages'] }
      }
      if (command === venvPython) {
        if (args[0] === '--version') return { code: 0, stdoutLines: ['Python 3.11.7'] }
        return smokeTestOutcome(args[1])
      }
      return { enoent: true }
    })
    const envManager = new EnvManager({ baseDir, binDir, smokeTestScriptPath: '/fake/smoke_test.py', spawn: spawnFn })

    const [r1, r2] = await Promise.all([envManager.ensureReady(), envManager.ensureReady()])

    expect(r1.state).toBe('ready')
    expect(r2.state).toBe('ready')
    expect(calls.filter((c) => c.command === 'uv' && c.args[0] === 'venv').length).toBe(1)
  })
})
