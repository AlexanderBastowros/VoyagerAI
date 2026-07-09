import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { ScriptManifest } from '@shared/ipc'
import { findFileByExt } from './findExports'
import { manifestPathForStl } from './manifestConvention'
import { patchManifestValue } from './patchManifest'
import { substituteParamValue } from './paramsBlock'

/** Injectable subset of `child_process.spawn`'s signature - mirrors `EnvManager`'s `SpawnLike`
 *  so production code and tests share the same fake-process pattern. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcess

export interface ParamRerunOptions {
  /** Absolute path to the project directory. */
  projectDir: string
  /** The active iteration's script, relative to `projectDir` - callers should prefer
   *  `scriptSnapshotPath` (the app-controlled, version-locked copy) over the agent's own
   *  `scriptPath`, since it's guaranteed to match the currently-displayed model exactly. */
  scriptRelPath: string
  name: string
  value: number
  /** The manifest already read for the active iteration (`readManifestForIteration`) - patched,
   *  not re-extracted, into the new iteration's manifest. */
  manifest: ScriptManifest
}

export interface ParamRerunDeps {
  /** Absolute path to the managed venv's python (`EnvManager.pythonPath()`). */
  pythonPath: string
  spawn?: SpawnLike
}

export type ParamRerunResult =
  | {
      ok: true
      scriptRelPath: string
      stlRelPath: string
      stepRelPath?: string
      manifest: ScriptManifest
    }
  | { ok: false; reason: string }

/** How long a re-run is allowed to take before it's treated as hung and killed. Generous - these
 *  are the same parametric-solid builds the agent runs, just without an LLM in the loop - but a
 *  hard ceiling so a runaway script can't block the panel forever. */
const RUN_TIMEOUT_MS = 60_000

function tail(text: string, length = 600): string {
  return text.trim().slice(-length)
}

function toProjectRelPath(projectDir: string, absPath: string): string {
  return relative(projectDir, absPath).split(sep).join('/')
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runScript(spawnFn: SpawnLike, pythonPath: string, scriptAbsPath: string, cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawnFn(pythonPath, [scriptAbsPath], { cwd })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, RUN_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
  })
}

/**
 * The no-LLM parameter edit path (architecture doc §7): substitutes one PARAMS constant, re-runs
 * the script with the managed venv's own python in a fresh scratch directory (so whatever
 * filename the script's own `export_stl`/`export_step` calls hardcode can never collide with an
 * earlier iteration's files - every iteration is immutable), locates the resulting STL/STEP, and
 * writes the patched manifest beside the STL per `manifestPathForStl`'s convention.
 *
 * Does not call `ProjectStore.recordIteration` itself - the caller (the `param:update` IPC
 * handler) does that once this resolves `ok: true`, exactly as `display_model` does for an
 * agent-authored iteration.
 */
export async function rerunWithParam(options: ParamRerunOptions, deps: ParamRerunDeps): Promise<ParamRerunResult> {
  const scriptAbsPath = join(options.projectDir, options.scriptRelPath)
  let scriptText: string
  try {
    scriptText = await readFile(scriptAbsPath, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      reason: `Could not read the script to re-run: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const substitution = substituteParamValue(scriptText, options.name, options.value)
  if (!substitution.ok) return { ok: false, reason: substitution.reason }

  const runDir = join(options.projectDir, 'outputs', 'param-edits', randomUUID())
  await mkdir(runDir, { recursive: true })
  const runScriptAbsPath = join(runDir, basename(options.scriptRelPath))
  await writeFile(runScriptAbsPath, substitution.text, 'utf-8')

  const spawnFn = deps.spawn ?? nodeSpawn
  const run = await runScript(spawnFn, deps.pythonPath, runScriptAbsPath, runDir)

  if (run.code !== 0) {
    const reason = run.timedOut
      ? 'The script took too long to re-run and was stopped.'
      : tail(run.stderr) || tail(run.stdout) || `The script exited with code ${run.code}.`
    return { ok: false, reason: run.timedOut ? reason : `The script failed to re-run: ${reason}` }
  }

  const stlAbsPath = await findFileByExt(runDir, 'stl')
  if (!stlAbsPath) {
    return { ok: false, reason: 'The script ran but did not produce an STL export.' }
  }
  const stepAbsPath = await findFileByExt(runDir, 'step')

  const stlRelPath = toProjectRelPath(options.projectDir, stlAbsPath)
  const stepRelPath = stepAbsPath ? toProjectRelPath(options.projectDir, stepAbsPath) : undefined
  const scriptRelPath = toProjectRelPath(options.projectDir, runScriptAbsPath)

  const manifest = patchManifestValue(options.manifest, options.name, options.value)
  const manifestAbsPath = join(options.projectDir, manifestPathForStl(stlRelPath))
  await mkdir(dirname(manifestAbsPath), { recursive: true })
  await writeFile(manifestAbsPath, JSON.stringify(manifest, null, 2), 'utf-8')

  return { ok: true, scriptRelPath, stlRelPath, stepRelPath, manifest }
}
