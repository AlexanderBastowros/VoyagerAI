import { defaultExecFile } from './execJson'
import type { ExecFileFn } from './execJson'

/**
 * Thin TS wrapper around the bundled `validate_stl.py` (watertight/manifold, bed-fit, overhang
 * checks - see `python/validate_stl.py`). Runs it with the managed Python environment's own
 * interpreter and hands back its raw stdout/stderr; parsing that into a structured report is
 * `layer2Geometry.ts`'s job (verification layer 2) - this wrapper stays as the skill-facing,
 * human-readable CLI path (SKILL.md Phase 5), unchanged.
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
