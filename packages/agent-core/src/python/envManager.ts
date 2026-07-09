import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SetupCheck } from '@shared/ipc'

/**
 * Injectable subset of `child_process.spawn`'s signature. Production code
 * uses the real `node:child_process` spawn; unit tests substitute a fake
 * child process so no real filesystem/network/process work happens.
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcess

export interface EnvManagerOptions {
  /** Root directory the managed venv + marker file live under, e.g. `<userData>/pyenv`. */
  baseDir: string
  /** Directory a downloaded `uv` binary is stored in, e.g. `<userData>/bin`. */
  binDir: string
  /** Absolute path to the bundled `smoke_test.py` resource. */
  smokeTestScriptPath: string
  /** Defaults to `process.platform`; injectable for tests. */
  platform?: NodeJS.Platform
  /** Defaults to the real `child_process.spawn`; injectable for tests. */
  spawn?: SpawnLike
}

export interface SmokeTestResult {
  ok: boolean
  sizeBytes?: number
  watertight?: boolean
  error?: string
}

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

/** How to invoke `uv` - either a plain binary or a `python -m uv` shim installed via pip. */
interface UvInvocation {
  command: string
  baseArgs: string[]
  env?: NodeJS.ProcessEnv
}

const MARKER_SCHEMA_VERSION = 1
const REQUIRED_PACKAGES = ['build123d', 'trimesh', 'numpy'] as const

interface PyEnvMarker {
  schemaVersion: number
  createdAt: string
  pythonVersion: string
  packages: Record<string, string>
  smokeTest: { ok: boolean; sizeBytes: number; watertight: boolean; at: string }
}

/**
 * Coarse, human-readable stages surfaced to the renderer while the python
 * environment installs. Matched against raw stdout/stderr lines emitted by
 * `uv` / `pip` - order matters here, first match wins, and lines that don't
 * match anything (progress bars, blank lines, etc.) are simply ignored.
 */
const STAGE_PATTERNS: ReadonlyArray<{ pattern: RegExp; stage: string }> = [
  { pattern: /creating virtual environment/i, stage: 'Creating virtual environment…' },
  { pattern: /\bocp\b/i, stage: 'Downloading build123d (OCP wheel is large, this can take several minutes)…' },
  { pattern: /build123d/i, stage: 'Downloading build123d (OCP wheel is large, this can take several minutes)…' },
  { pattern: /trimesh/i, stage: 'Installing trimesh…' },
  { pattern: /\bnumpy\b/i, stage: 'Installing numpy…' },
  { pattern: /resolved \d+ package/i, stage: 'Resolving package versions…' },
  { pattern: /installed \d+ package/i, stage: 'Finalizing installation…' },
  { pattern: /smoke.?test/i, stage: 'Running smoke test…' }
]

/**
 * Classifies a single line of raw installer output into one of the coarse
 * stages above, or returns null if the line doesn't match anything we
 * surface to the user.
 */
export function parseProgressLine(line: string): string | null {
  for (const { pattern, stage } of STAGE_PATTERNS) {
    if (pattern.test(line)) return stage
  }
  return null
}

function venvPythonPath(venvDir: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python3')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function tail(text: string, length = 400): string {
  return text.trim().slice(-length)
}

function extractPackageVersions(output: string): Record<string, string> {
  const found: Record<string, string> = {}
  const pattern = /\b(build123d|trimesh|numpy)[-=]{1,2}([0-9][\w.]*)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(output))) {
    found[match[1].toLowerCase()] = match[2]
  }
  return found
}

/**
 * Provisions and owns a Python virtual environment with build123d, trimesh,
 * and numpy installed, rooted at `options.baseDir`. Contains no top-level
 * `electron` import and takes all filesystem roots + the spawn function as
 * constructor options, so it is fully unit-testable under plain Node/vitest.
 * The Electron wiring (src/main/ipc.ts) constructs this with
 * `app.getPath('userData')`-derived paths.
 */
export class EnvManager {
  private readonly baseDir: string
  private readonly binDir: string
  private readonly venvDir: string
  private readonly markerPath: string
  private readonly smokeTestScriptPath: string
  private readonly platform: NodeJS.Platform
  private readonly spawnFn: SpawnLike

  private status: SetupCheck = { state: 'unchecked', detail: 'Not checked yet' }
  private inFlight: Promise<SetupCheck> | null = null
  private lastStage: string | null = null

  constructor(options: EnvManagerOptions) {
    this.baseDir = options.baseDir
    this.binDir = options.binDir
    this.venvDir = join(this.baseDir, 'venv')
    this.markerPath = join(this.baseDir, 'pyenv.json')
    this.smokeTestScriptPath = options.smokeTestScriptPath
    this.platform = options.platform ?? process.platform
    this.spawnFn = options.spawn ?? nodeSpawn
  }

  /** Absolute path to the venv's python executable (M3 injects this into the agent session env). */
  pythonPath(): string {
    return venvPythonPath(this.venvDir, this.platform)
  }

  /** Last known status; performs no I/O. Used for the immediate `setup:getStatus` reply. */
  getStatus(): SetupCheck {
    return this.status
  }

  /**
   * Ensures the environment is ready, provisioning it if needed. Safe to
   * call repeatedly/concurrently - an in-flight provisioning run is shared
   * rather than duplicated, and a marker-file fast path skips reinstalling
   * on subsequent launches.
   */
  async ensureReady(onProgress?: (check: SetupCheck) => void): Promise<SetupCheck> {
    if (this.inFlight) return this.inFlight
    const run = this.runEnsureReady(onProgress).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  /** Forces a fresh provisioning attempt, discarding any prior venv. Backs the Retry button. */
  async retry(onProgress?: (check: SetupCheck) => void): Promise<SetupCheck> {
    this.status = { state: 'unchecked', detail: 'Retrying…' }
    this.lastStage = null
    await rm(this.venvDir, { recursive: true, force: true }).catch(() => {})
    await rm(this.markerPath, { force: true }).catch(() => {})
    return this.ensureReady(onProgress)
  }

  /** Re-runs the smoke test against the existing venv and refreshes the marker file. */
  async verify(): Promise<SetupCheck> {
    if (!(await pathExists(this.pythonPath()))) {
      const check: SetupCheck = { state: 'error', detail: 'Virtual environment is missing; run setup again.' }
      this.status = check
      return check
    }
    const smoke = await this.smokeTest()
    if (!smoke.ok) {
      const check: SetupCheck = { state: 'error', detail: `Smoke test failed: ${smoke.error ?? 'unknown error'}` }
      this.status = check
      return check
    }
    await this.writeMarker(smoke)
    const check: SetupCheck = { state: 'ready', detail: 'Python environment ready (verified).' }
    this.status = check
    return check
  }

  /**
   * Runs the bundled build123d/trimesh smoke test with the venv's own
   * python: builds a 20mm box with a 5mm hole, exports STL, and checks the
   * result is a non-trivial, watertight mesh via trimesh.
   */
  async smokeTest(): Promise<SmokeTestResult> {
    const pyPath = this.pythonPath()
    const outPath = join(this.baseDir, 'smoke-test-output.stl')
    try {
      const result = await this.run(pyPath, [this.smokeTestScriptPath, outPath])
      if (result.code !== 0) {
        return { ok: false, error: tail(result.stderr) || tail(result.stdout) || `exited with code ${result.code}` }
      }
      const info = await stat(outPath).catch(() => null)
      if (!info || info.size < 100) {
        return { ok: false, error: 'STL output is missing or unexpectedly small' }
      }
      const watertight = /watertight=True/i.test(result.stdout)
      if (!watertight) {
        return { ok: false, error: 'Generated STL is not watertight' }
      }
      return { ok: true, sizeBytes: info.size, watertight: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await rm(outPath, { force: true }).catch(() => {})
    }
  }

  // -- internal ---------------------------------------------------------

  private async runEnsureReady(onProgress?: (check: SetupCheck) => void): Promise<SetupCheck> {
    const emit = (check: SetupCheck): SetupCheck => {
      this.status = check
      onProgress?.(check)
      return check
    }

    emit({ state: 'in_progress', detail: 'Checking for an existing Python environment…' })

    const cached = await this.quickCheck()
    if (cached) return emit(cached)

    try {
      await mkdir(this.baseDir, { recursive: true })
      await mkdir(this.binDir, { recursive: true })
      // Clear out any partial venv left behind by a previous failed attempt.
      await rm(this.venvDir, { recursive: true, force: true }).catch(() => {})

      // (a) Prefer uv, if it's already available (PATH or a prior download).
      const uv = await this.detectUv()
      if (uv) return await this.provisionWithUv(uv, emit)

      // (b) Else fall back to a system python3 >= 3.10.
      const pythonCmd = await this.detectSystemPython()
      if (pythonCmd) return await this.provisionWithSystemPython(pythonCmd, emit)

      // (c) Else try to download uv on demand, then use it like (a).
      emit({ state: 'in_progress', detail: 'Downloading uv package manager…' })
      const downloadedUv = await this.downloadUv(emit)
      if (!downloadedUv) {
        return emit({ state: 'error', detail: 'Install Python 3.10+ or uv, then retry.' })
      }
      return await this.provisionWithUv(downloadedUv, emit)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return emit({ state: 'error', detail: `Python environment setup failed: ${message}` })
    }
  }

  private async provisionWithUv(uv: UvInvocation, emit: (c: SetupCheck) => SetupCheck): Promise<SetupCheck> {
    emit({ state: 'in_progress', detail: 'Creating virtual environment…' })
    const venvResult = await this.runUv(uv, ['venv', this.venvDir, '--python', '>=3.10'], emit)
    if (venvResult.code !== 0) {
      return emit({
        state: 'error',
        detail: `Failed to create virtual environment: ${tail(venvResult.stderr) || `exit code ${venvResult.code}`}`
      })
    }

    emit({
      state: 'in_progress',
      detail: 'Installing build123d, trimesh, numpy (OCP wheel is large, this can take several minutes)…'
    })
    const install = await this.runUv(uv, ['pip', 'install', '--python', this.pythonPath(), ...REQUIRED_PACKAGES], emit)
    return this.finishInstall(install, emit)
  }

  private async provisionWithSystemPython(
    pythonCmd: string,
    emit: (c: SetupCheck) => SetupCheck
  ): Promise<SetupCheck> {
    emit({ state: 'in_progress', detail: 'Creating virtual environment…' })
    const venvResult = await this.run(pythonCmd, ['-m', 'venv', this.venvDir])
    if (venvResult.code !== 0) {
      return emit({
        state: 'error',
        detail: `Failed to create virtual environment: ${tail(venvResult.stderr) || `exit code ${venvResult.code}`}`
      })
    }

    emit({
      state: 'in_progress',
      detail: 'Installing build123d, trimesh, numpy (OCP wheel is large, this can take several minutes)…'
    })
    // Invoke pip via `python -m pip` rather than the venv's `pip` script directly - the
    // script's shebang line can exceed OS limits when the venv lives in a deep userData path.
    const install = await this.run(this.pythonPath(), ['-m', 'pip', 'install', ...REQUIRED_PACKAGES], (line) =>
      this.trackStage(line, emit)
    )
    return this.finishInstall(install, emit)
  }

  private async finishInstall(install: CommandResult, emit: (c: SetupCheck) => SetupCheck): Promise<SetupCheck> {
    if (install.code !== 0) {
      return emit({
        state: 'error',
        detail: `Failed to install python packages: ${tail(install.stderr) || `exit code ${install.code}`}`
      })
    }

    emit({ state: 'in_progress', detail: 'Running smoke test (building a test part with build123d)…' })
    const smoke = await this.smokeTest()
    if (!smoke.ok) {
      return emit({ state: 'error', detail: `Smoke test failed: ${smoke.error ?? 'unknown error'}` })
    }

    await this.writeMarker(smoke, install.stdout + '\n' + install.stderr)
    return emit({ state: 'ready', detail: 'Python environment ready (build123d, trimesh, numpy installed).' })
  }

  private async quickCheck(): Promise<SetupCheck | null> {
    if (!(await pathExists(this.pythonPath()))) return null
    const marker = await this.readMarker()
    if (!marker || marker.schemaVersion !== MARKER_SCHEMA_VERSION || !marker.smokeTest.ok) return null
    return { state: 'ready', detail: 'Python environment ready (cached).' }
  }

  private async detectUv(): Promise<UvInvocation | null> {
    const onPath: UvInvocation = { command: 'uv', baseArgs: [] }
    if (await this.canRunUv(onPath)) return onPath

    const downloaded: UvInvocation = { command: join(this.binDir, 'uv'), baseArgs: [] }
    if (await this.canRunUv(downloaded)) return downloaded

    return null
  }

  private async canRunUv(uv: UvInvocation): Promise<boolean> {
    try {
      const result = await this.runUv(uv, ['--version'])
      return result.code === 0
    } catch {
      return false
    }
  }

  private async detectSystemPython(): Promise<string | null> {
    try {
      const result = await this.run('python3', ['--version'])
      if (result.code !== 0) return null
      const match = /Python (\d+)\.(\d+)/.exec(result.stdout + result.stderr)
      if (!match) return null
      const major = Number(match[1])
      const minor = Number(match[2])
      if (major > 3 || (major === 3 && minor >= 10)) return 'python3'
      return null
    } catch {
      return null
    }
  }

  /**
   * Downloads uv into `binDir` on demand: the official install script first
   * (no python required), falling back to `pip install uv` (the PyPI wheel
   * route) invoked as `python3 -m uv` if some python happens to be present
   * but couldn't satisfy the >=3.10 venv requirement.
   */
  private async downloadUv(emit: (check: SetupCheck) => SetupCheck): Promise<UvInvocation | null> {
    try {
      await this.run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], undefined, {
        UV_INSTALL_DIR: this.binDir,
        UV_NO_MODIFY_PATH: '1',
        INSTALLER_NO_MODIFY_PATH: '1'
      })
      const candidate: UvInvocation = { command: join(this.binDir, 'uv'), baseArgs: [] }
      if (await this.canRunUv(candidate)) return candidate
    } catch {
      // fall through to the pip-based fallback below
    }

    emit({ state: 'in_progress', detail: 'Falling back to installing uv via pip…' })
    try {
      const pyCheck = await this.run('python3', ['--version'])
      if (pyCheck.code !== 0) return null
      const targetDir = join(this.binDir, 'uv-pkg')
      await mkdir(targetDir, { recursive: true })
      const install = await this.run('python3', ['-m', 'pip', 'install', '--quiet', '--target', targetDir, 'uv'])
      if (install.code !== 0) return null
      const candidate: UvInvocation = { command: 'python3', baseArgs: ['-m', 'uv'], env: { PYTHONPATH: targetDir } }
      if (await this.canRunUv(candidate)) return candidate
      return null
    } catch {
      return null
    }
  }

  private async runUv(uv: UvInvocation, args: string[], emit?: (check: SetupCheck) => SetupCheck): Promise<CommandResult> {
    return this.run(
      uv.command,
      [...uv.baseArgs, ...args],
      emit ? (line) => this.trackStage(line, emit) : undefined,
      uv.env
    )
  }

  private trackStage(line: string, emit: (check: SetupCheck) => SetupCheck): void {
    const stage = parseProgressLine(line)
    if (stage && stage !== this.lastStage) {
      this.lastStage = stage
      emit({ state: 'in_progress', detail: stage })
    }
  }

  private run(
    command: string,
    args: string[],
    onLine?: (line: string) => void,
    extraEnv?: NodeJS.ProcessEnv
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(command, args, {
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env
      })

      let stdout = ''
      let stderr = ''
      let pendingStdout = ''
      let pendingStderr = ''

      const consumeLines = (text: string, pending: string): string => {
        const combined = pending + text
        const lines = combined.split('\n')
        const remainder = lines.pop() ?? ''
        for (const line of lines) {
          if (line.length > 0) onLine?.(line)
        }
        return remainder
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stdout += text
        pendingStdout = consumeLines(text, pendingStdout)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stderr += text
        pendingStderr = consumeLines(text, pendingStderr)
      })
      child.on('error', (err) => reject(err))
      child.on('close', (code) => {
        if (pendingStdout) onLine?.(pendingStdout)
        if (pendingStderr) onLine?.(pendingStderr)
        resolve({ code, stdout, stderr })
      })
    })
  }

  private async readMarker(): Promise<PyEnvMarker | null> {
    try {
      const raw = await readFile(this.markerPath, 'utf-8')
      return JSON.parse(raw) as PyEnvMarker
    } catch {
      return null
    }
  }

  private async writeMarker(smoke: SmokeTestResult, installOutput = ''): Promise<void> {
    const versionResult = await this.run(this.pythonPath(), ['--version']).catch(() => null)
    const pythonVersion = versionResult ? (versionResult.stdout + versionResult.stderr).trim() : 'unknown'
    const marker: PyEnvMarker = {
      schemaVersion: MARKER_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      pythonVersion,
      packages: extractPackageVersions(installOutput),
      smokeTest: {
        ok: smoke.ok,
        sizeBytes: smoke.sizeBytes ?? 0,
        watertight: smoke.watertight ?? false,
        at: new Date().toISOString()
      }
    }
    await writeFile(this.markerPath, JSON.stringify(marker, null, 2), 'utf-8')
  }
}
