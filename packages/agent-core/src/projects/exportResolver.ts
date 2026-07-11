import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
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

/** The single-file formats this module resolves - `'plate'` (bakes every part's placement into
 *  one merged STL) and `'package'` (bundles every artifact) have their own resolution paths and
 *  never reach these functions (§14/WS-F). */
export type SingleFileExportFormat = 'stl' | 'step' | '3mf'

/** Resolves `candidate` against `projectDir`, or null if it escapes the project directory
 *  (or is the directory itself) - the containment guard described above. Exported so
 *  `exportPackage.ts`'s graduation-package builder (which reads several more artifacts per
 *  part - STEP/3MF/script/manifest) applies the identical guard rather than duplicating it. */
export function containedAbsPath(projectDir: string, candidate: string): string | null {
  const abs = resolve(projectDir, candidate)
  const rel = relative(projectDir, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/**
 * The conventional 3MF sibling of a recorded STL path: same directory/basename, `.3mf` extension
 * in place of `.stl` - mirrors `manifestPathForStl`'s "no new field on `ProjectIteration` needed"
 * convention (`packages/agent-core/params/manifestConvention.ts`), since the skill already keeps
 * `script.py`/`.stl`/`.step` co-located and identically named per version (SKILL.md Phase 4).
 * `ProjectIteration` has no `threeMfPath` field - a 3MF is only ever "offered" by the skill today,
 * not always produced (a contract-change request for that lives in the roadmap) - so callers must
 * still probe whether the derived path actually exists on disk before trusting it; this function
 * stays pure (no I/O) and only computes where it *would* be.
 */
export function deriveThreeMfPath(stlPath: string): string {
  const dir = dirname(stlPath)
  const base = basename(stlPath).replace(/\.stl$/i, '')
  return dir === '.' ? `${base}.3mf` : `${dir}/${base}.3mf`
}

/** Human-readable label for an error message, e.g. `'3mf' -> '3MF'`, `'step' -> 'STEP'`. */
function formatLabel(format: SingleFileExportFormat): string {
  return format.toUpperCase()
}

export function resolveExportSource(
  activeIteration: (Pick<ProjectIteration, 'stlPath' | 'stepPath'> & { threeMfPath?: string }) | null,
  projectDir: string,
  format: SingleFileExportFormat
): ExportSourceResolution {
  if (!activeIteration) {
    return { ok: false, reason: 'No model has been generated yet.' }
  }

  const candidate =
    format === 'step'
      ? activeIteration.stepPath
      : format === '3mf'
        ? activeIteration.threeMfPath
        : activeIteration.stlPath
  if (!candidate) {
    return {
      ok: false,
      reason:
        format === 'stl'
          ? 'This model has no STL export.'
          : `This model has no ${formatLabel(format)} export - ask Voyager to export ${formatLabel(format)}, or use "Export STL" instead.`
    }
  }

  const abs = containedAbsPath(projectDir, candidate)
  if (!abs) {
    return {
      ok: false,
      reason: `The recorded ${formatLabel(format)} path resolves outside the project directory and was rejected.`
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
  iteration: (Pick<ProjectIteration, 'n' | 'stlPath' | 'stepPath'> & { threeMfPath?: string }) | null
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
 * Meaningful for the per-part single-file formats (`'stl' | 'step' | '3mf'`); `'plate'`
 * intentionally merges and `'package'` has its own builder, so the type narrows to keep
 * those from ending up here.
 */
export function resolveAllPartsExportSources(
  parts: PartExportSource[],
  projectDir: string,
  format: SingleFileExportFormat,
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
    const candidate =
      format === 'step' ? part.iteration.stepPath : format === '3mf' ? part.iteration.threeMfPath : part.iteration.stlPath
    if (!candidate) {
      skippedParts.push(part.name)
      continue
    }
    const abs = containedAbsPath(projectDir, candidate)
    if (!abs) {
      return {
        ok: false,
        reason: `The recorded ${formatLabel(format)} path for part "${part.name}" resolves outside the project directory and was rejected.`
      }
    }
    entries.push({ absPath: abs, entryName: `${part.id}_v${part.iteration.n}.${format}` })
  }

  if (entries.length === 0) {
    if (!sawIteration) return { ok: false, reason: 'No model has been generated yet.' }
    return {
      ok: false,
      reason:
        format === 'stl'
          ? 'None of the parts has an STL export.'
          : `None of the parts has a ${formatLabel(format)} export - ask Voyager to export ${formatLabel(format)}, or use "Export STL" instead.`
    }
  }

  const base = slugifyZipBase(zipBaseName ?? '') || 'parts'
  return { ok: true, entries, skippedParts, zipFileName: `${base}-${format}.zip` }
}

/** Filesystem-safe zip base name from a project's display name (same character policy as
 *  `slugifyPartId`); exported so `exportPackage.ts`'s package builder names its zip the same way. */
export function slugifyZipBase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
