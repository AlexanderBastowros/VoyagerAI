import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'

/**
 * Thin TS wrapper around the bundled `validate_stl.py` (watertight/manifold, bed-fit, overhang
 * checks - see `python/validate_stl.py`). Runs it with the managed Python environment's own
 * interpreter and hands back its raw stdout/stderr; parsing that into a structured report is
 * WS-C's job (verification layer 2).
 */
export interface ValidateStlOptions {
  /** Absolute path to the managed venv's python (EnvManager.pythonPath()). */
  pythonPath: string
  /** Absolute path to the bundled validate_stl.py. */
  scriptPath: string
  /** Absolute path to the STL to validate. */
  stlPath: string
  bedXMm?: number
  bedYMm?: number
  bedZMm?: number
  nozzleMm?: number
}

export interface ValidateStlResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

interface ExecFileResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Injectable subset of `child_process.execFile`, matching the pattern used by `ClaudeChecker`/
 *  `EnvManager` so this is unit-testable without spawning a real Python process. */
export type ExecFileFn = (command: string, args: readonly string[]) => Promise<ExecFileResult>

function defaultExecFile(command: string, args: readonly string[]): Promise<ExecFileResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args as string[],
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? ((error as ExecFileException).code ?? 1) : 0
        resolvePromise({ code: typeof code === 'number' ? code : 1, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

export async function validateStl(
  options: ValidateStlOptions,
  execFileFn: ExecFileFn = defaultExecFile
): Promise<ValidateStlResult> {
  const args = [options.scriptPath, options.stlPath]
  if (options.bedXMm !== undefined) args.push('--bed-x', String(options.bedXMm))
  if (options.bedYMm !== undefined) args.push('--bed-y', String(options.bedYMm))
  if (options.bedZMm !== undefined) args.push('--bed-z', String(options.bedZMm))
  if (options.nozzleMm !== undefined) args.push('--nozzle', String(options.nozzleMm))

  const result = await execFileFn(options.pythonPath, args)
  return { ok: result.code === 0, exitCode: result.code, stdout: result.stdout, stderr: result.stderr }
}
