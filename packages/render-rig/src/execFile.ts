import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'

/**
 * Injectable subset of `child_process.execFile` - the same shape
 * `packages/verify/src/execJson.ts` uses for its layer wrappers, duplicated here rather than
 * imported (render-rig has no dependency on `@voyager/verify`; they are independent siblings per
 * the architecture doc, not a stack). Production code uses `defaultExecFile`; tests substitute a
 * fake so no real process/filesystem work happens.
 */
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
      // Renders are small PNGs (a few hundred KB total across 8 views) but stdout only ever
      // carries the one-line JSON result - a generous maxBuffer costs nothing and avoids a
      // truncated-JSON failure mode if stderr ever gets chatty (e.g. matplotlib font-cache
      // warnings on first run).
      { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? ((error as ExecFileException).code ?? 1) : 0
        resolvePromise({ code: typeof code === 'number' ? code : 1, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}
