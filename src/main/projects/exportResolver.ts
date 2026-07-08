import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { ExportFormat } from '../../shared/ipc'
import type { ProjectIteration } from './store'

/**
 * Resolves which on-disk file `model:export` should copy for a given format,
 * given the project's latest recorded iteration.
 *
 * Kept as a pure function (no `electron` import, no filesystem I/O) so it is
 * unit-testable without a dialog or a real project directory - `src/main/
 * ipc.ts`'s `model:export` handler is a thin wrapper that calls this, then
 * does the actual `dialog.showSaveDialog` + file copy.
 *
 * Path containment mirrors the `resolveWithinProject` guard in
 * `src/main/agent/mcpTools.ts`: `project.json` is written by this app, but a
 * corrupted or hand-edited record could still carry a `../../` path, and
 * that must never let an IPC caller read a file outside the project dir.
 */
export type ExportSourceResolution =
  | { ok: true; absPath: string; fileName: string }
  | { ok: false; reason: string }

export function resolveExportSource(
  latestIteration: Pick<ProjectIteration, 'stlPath' | 'stepPath'> | null,
  projectDir: string,
  format: ExportFormat
): ExportSourceResolution {
  if (!latestIteration) {
    return { ok: false, reason: 'No model has been generated yet.' }
  }

  const candidate = format === 'step' ? latestIteration.stepPath : latestIteration.stlPath
  if (!candidate) {
    return {
      ok: false,
      reason:
        format === 'step'
          ? 'This model has no STEP export - ask Voyager to export STEP, or use "Export STL" instead.'
          : 'This model has no STL export.'
    }
  }

  const abs = resolve(projectDir, candidate)
  const rel = relative(projectDir, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      reason: `The recorded ${format.toUpperCase()} path resolves outside the project directory and was rejected.`
    }
  }

  return { ok: true, absPath: abs, fileName: basename(abs) }
}
