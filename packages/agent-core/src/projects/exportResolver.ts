import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { ExportFormat } from '@shared/ipc'
import type { ProjectIteration } from './store'

/**
 * Resolves which on-disk file `model:export` should copy for a given format,
 * given the project's active iteration (R4: the explicit `activeIteration`
 * pointer set by `revertTo()`, not necessarily the most recently recorded
 * one - see `ProjectStore.activeIterationRecord`).
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

/** Resolves `candidate` against `projectDir`, or null if it escapes the project directory
 *  (or is the directory itself) - the containment guard described above. */
function containedAbsPath(projectDir: string, candidate: string): string | null {
  const abs = resolve(projectDir, candidate)
  const rel = relative(projectDir, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

export function resolveExportSource(
  activeIteration: Pick<ProjectIteration, 'stlPath' | 'stepPath'> | null,
  projectDir: string,
  format: ExportFormat
): ExportSourceResolution {
  if (!activeIteration) {
    return { ok: false, reason: 'No model has been generated yet.' }
  }

  const candidate = format === 'step' ? activeIteration.stepPath : activeIteration.stlPath
  if (!candidate) {
    return {
      ok: false,
      reason:
        format === 'step'
          ? 'This model has no STEP export - ask Voyager to export STEP, or use "Export STL" instead.'
          : 'This model has no STL export.'
    }
  }

  const abs = containedAbsPath(projectDir, candidate)
  if (!abs) {
    return {
      ok: false,
      reason: `The recorded ${format.toUpperCase()} path resolves outside the project directory and was rejected.`
    }
  }

  return { ok: true, absPath: abs, fileName: basename(abs) }
}

/**
 * One part's inputs to the all-parts export: its identity plus its active iteration (null
 * when the part has no iterations yet - such parts are skipped, mirroring their empty
 * viewport). The caller assembles these from `ProjectStore.listParts()` +
 * `activeIterationRecord(partId)` so this stays a pure function.
 */
export interface PartExportSource {
  id: string
  name: string
  iteration: Pick<ProjectIteration, 'n' | 'stlPath' | 'stepPath'> | null
}

export interface ZipEntrySource {
  absPath: string
  /** Archive-internal file name, `<partId>_v<N>.<format>` - the §12.1 `{part}_v{N}`
   *  convention. Part ids are unique slugs and `N` is per-part, so names can't collide. */
  entryName: string
}

export type AllPartsExportResolution =
  | { ok: true; entries: ZipEntrySource[]; skippedParts: string[]; zipFileName: string }
  | { ok: false; reason: string }

/**
 * Resolves which files "export all parts" should bundle into one zip - each part's active
 * iteration as its own entry, never a merged solid (§14/WS-F). Parts without an iteration
 * (or, for STEP, without a recorded STEP) are reported in `skippedParts` rather than
 * failing the export, matching `resolveExportSource`'s degrade-gracefully behavior; a
 * containment violation on any part still fails the whole export, since a corrupted
 * record must never leak a file from outside the project directory.
 *
 * Only meaningful for `'stl' | 'step'` (the per-part single-file formats); `'plate'`
 * intentionally merges and `'package'` has its own builder, so the type narrows to keep
 * those from ending up here.
 */
export function resolveAllPartsExportSources(
  parts: PartExportSource[],
  projectDir: string,
  format: 'stl' | 'step',
  zipBaseName?: string
): AllPartsExportResolution {
  const entries: ZipEntrySource[] = []
  const skippedParts: string[] = []
  let sawIteration = false

  for (const part of parts) {
    if (!part.iteration) {
      skippedParts.push(part.name)
      continue
    }
    sawIteration = true
    const candidate = format === 'step' ? part.iteration.stepPath : part.iteration.stlPath
    if (!candidate) {
      skippedParts.push(part.name)
      continue
    }
    const abs = containedAbsPath(projectDir, candidate)
    if (!abs) {
      return {
        ok: false,
        reason: `The recorded ${format.toUpperCase()} path for part "${part.name}" resolves outside the project directory and was rejected.`
      }
    }
    entries.push({ absPath: abs, entryName: `${part.id}_v${part.iteration.n}.${format}` })
  }

  if (entries.length === 0) {
    if (!sawIteration) return { ok: false, reason: 'No model has been generated yet.' }
    return {
      ok: false,
      reason:
        format === 'step'
          ? 'None of the parts has a STEP export - ask Voyager to export STEP, or use "Export STL" instead.'
          : 'None of the parts has an STL export.'
    }
  }

  const base = slugifyZipBase(zipBaseName ?? '') || 'parts'
  return { ok: true, entries, skippedParts, zipFileName: `${base}-${format}.zip` }
}

/** Filesystem-safe zip base name from a project's display name (same character policy as
 *  `slugifyPartId`, local to keep this module dependency-free). */
function slugifyZipBase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
