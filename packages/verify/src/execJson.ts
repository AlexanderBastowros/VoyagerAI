import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import type { FindingSeverity, VerificationFinding, VerificationLayer } from '@shared/ipc'

/** Shared by every layer's python wrapper - same injectable-exec pattern as `validateStl.ts`. */
export interface ExecFileResult {
  code: number | null
  stdout: string
  stderr: string
}

export type ExecFileFn = (command: string, args: readonly string[]) => Promise<ExecFileResult>

export function defaultExecFile(command: string, args: readonly string[]): Promise<ExecFileResult> {
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

export interface JsonCheckResult<T> {
  ok: boolean
  data: T | null
  stderr: string
}

/** Runs a layer script and parses its single JSON line from stdout. Every layer script under
 *  `packages/verify/python` prints `{"findings": [...], ...}` and exits 0 even when it reports
 *  blocking findings - only a genuine crash (bad stdout, missing interpreter) fails to parse,
 *  which callers turn into a single `info` finding rather than losing the rest of the report. */
export async function runJsonCheck<T>(
  execFileFn: ExecFileFn,
  command: string,
  args: readonly string[]
): Promise<JsonCheckResult<T>> {
  const result = await execFileFn(command, args)
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T, stderr: result.stderr }
  } catch {
    return { ok: false, data: null, stderr: result.stderr.trim() || result.stdout.trim() }
  }
}

/** Trims a stderr/stdout blob down to its last `length` characters - long python tracebacks
 *  shouldn't dominate a one-line finding message. */
export function tail(text: string, length = 400): string {
  return text.trim().slice(-length)
}

/** A layer script's raw JSON shape: one `findings` array of loosely-typed entries (`severity`
 *  is a bare string on the wire - the layer script is the only place that needs to agree with
 *  `FindingSeverity`'s exact values). */
export interface RawFindingsOutput {
  findings: Array<{ severity: string; message: string; briefField?: string }>
}

/**
 * Shared by every layer wrapper (`layer1StaticScript.ts`/`layer2Geometry.ts`/
 * `layer3BriefConformance.ts`): tags a parsed script's raw findings with `layer`, or - when the
 * script itself couldn't be parsed (crash, bad stdout) - returns one `info` finding saying so,
 * so a single failing layer never loses the rest of the report.
 */
export function findingsFromCheck<T extends RawFindingsOutput>(
  layer: VerificationLayer,
  result: JsonCheckResult<T>,
  actionLabel: string
): VerificationFinding[] {
  if (!result.ok || !result.data) {
    return [{ layer, severity: 'info', message: `${actionLabel} could not run: ${result.stderr || 'unknown error'}` }]
  }
  return result.data.findings.map((entry) => ({
    layer,
    severity: entry.severity as FindingSeverity,
    message: entry.message,
    ...(entry.briefField ? { briefField: entry.briefField } : {})
  }))
}
