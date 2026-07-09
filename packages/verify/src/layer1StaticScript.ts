import type { VerificationFinding } from '@shared/ipc'
import { defaultExecFile, findingsFromCheck, runJsonCheck, tail } from './execJson'
import type { ExecFileFn, RawFindingsOutput } from './execJson'

export interface Layer1Options {
  /** Absolute path to the managed venv's python. */
  pythonPath: string
  /** Absolute path to the bundled `static_check.py`. */
  staticCheckScriptPath: string
  /** Absolute path to the generated CAD script to check. */
  scriptPath: string
  /**
   * Absolute path to WS-B's `extract_params.py` - injected rather than imported cross-package
   * (mirrors `ProjectStoreOptions.extractParamsScriptPath`). Omitted skips the PARAMS-block
   * validity check, matching how that option is optional everywhere else it's threaded.
   */
  extractParamsScriptPath?: string
}

/** Layer 1 (architecture doc §5): does the script parse, and does it stick to an import
 *  allowlist / PARAMS-block grammar? Pure computation - no filesystem writes. */
export async function runLayer1StaticScript(
  options: Layer1Options,
  execFileFn: ExecFileFn = defaultExecFile
): Promise<VerificationFinding[]> {
  const staticResult = await runJsonCheck<RawFindingsOutput>(execFileFn, options.pythonPath, [
    options.staticCheckScriptPath,
    options.scriptPath
  ])
  const findings = findingsFromCheck('static-script', staticResult, 'Static script check')

  if (options.extractParamsScriptPath) {
    const paramsResult = await execFileFn(options.pythonPath, [options.extractParamsScriptPath, options.scriptPath])
    if (paramsResult.code !== 0) {
      findings.push({
        layer: 'static-script',
        severity: 'blocking',
        message: `PARAMS block is missing or invalid: ${tail(paramsResult.stderr || paramsResult.stdout)}`
      })
    }
  }

  return findings
}
