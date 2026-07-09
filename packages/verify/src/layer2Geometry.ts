import type { VerificationFinding } from '@shared/ipc'
import { defaultExecFile, findingsFromCheck, runJsonCheck } from './execJson'
import type { ExecFileFn, RawFindingsOutput } from './execJson'

export interface Layer2Options {
  /** Absolute path to the managed venv's python. */
  pythonPath: string
  /** Absolute path to the bundled `geometry_report.py`. */
  geometryReportScriptPath: string
  /** Absolute path to the exported STL. */
  stlPath: string
  bedXMm?: number
  bedYMm?: number
  bedZMm?: number
  nozzleMm?: number
}

/** Layer 2 (architecture doc §5): `validate_stl.py` grown up - watertight/manifold, bed-fit
 *  (against the brief's printer profile when set), overhangs, multi-body interference, and a
 *  coarse thin-feature smell test. Pure computation - no filesystem writes. */
export async function runLayer2Geometry(
  options: Layer2Options,
  execFileFn: ExecFileFn = defaultExecFile
): Promise<VerificationFinding[]> {
  const args = [options.geometryReportScriptPath, options.stlPath]
  if (options.bedXMm !== undefined) args.push('--bed-x', String(options.bedXMm))
  if (options.bedYMm !== undefined) args.push('--bed-y', String(options.bedYMm))
  if (options.bedZMm !== undefined) args.push('--bed-z', String(options.bedZMm))
  if (options.nozzleMm !== undefined) args.push('--nozzle', String(options.nozzleMm))

  const result = await runJsonCheck<RawFindingsOutput>(execFileFn, options.pythonPath, args)
  return findingsFromCheck('geometry', result, 'Geometry check')
}
