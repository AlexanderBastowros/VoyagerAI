import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

/**
 * External model import & remix (WS-G, architecture doc §12.5 / product doc §5.6). Pure logic -
 * no `electron` import - mirroring `EnvManager`/`params/rerun.ts`'s injected-spawn pattern so this
 * is unit-testable under plain Node/vitest. `src/main/ipc.ts`'s `model:import` handler is the thin
 * orchestration layer that calls these functions, resolves the native file picker, and calls
 * `ProjectStore.recordIteration({ createdBy: 'import' })` once a finalize step succeeds - this
 * module knows nothing about `ProjectStore` (same separation `rerunWithParam` keeps from
 * `recordIteration`).
 *
 * Two lineages, set by format (never both):
 * - STEP → full parametric remix: the generated script references the import via build123d's
 *   `import_step` and exports both STL and STEP - everything downstream (added features, a
 *   parameter panel scoped to what Voyager adds, STEP export) keeps working.
 * - Mesh (STL/OBJ/3MF) → trimesh load, a dependency-free repair pass (fill holes, drop
 *   degenerate/duplicate faces - no networkx/scipy, mirroring `packages/verify/python/
 *   geometry_report.py`'s own no-extra-dependency precedent) that reports exactly what it
 *   changed, STL-only export (no STEP - there's no B-rep to export; `resolveExportSource`
 *   already degrades gracefully for an iteration with no `stepPath`).
 *
 * STL/OBJ carry no units - the never-guess-scale rule applies at the door (product doc §5.6):
 * `measureMeshImport` reports the raw bounding box so the caller can ask the user to confirm or
 * correct one dimension, then re-invoke `finalizeMeshImport` with the resulting `scaleFactor`.
 * 3MF and STEP already carry real-world units, so they finalize immediately (`scaleFactor: 1`).
 */

export type ImportFormat = 'step' | 'stl' | 'obj' | '3mf'

const EXTENSION_FOR_FORMAT: Record<ImportFormat, string> = { step: 'step', stl: 'stl', obj: 'obj', '3mf': '3mf' }

/** Injectable subset of `child_process.spawn` - mirrors `EnvManager`/`params/rerun.ts`'s `SpawnLike`
 *  (each module in this codebase keeps its own tiny local copy rather than sharing one type). */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcess

export interface ImportModelDeps {
  /** Absolute path to the managed venv's python (`EnvManager.pythonPath()`). */
  pythonPath: string
  /** Absolute path to the bundled `remix/measure_mesh.py` (see `src/main/ipc.ts`'s
   *  `measureMeshScriptPath()`, mirroring `verifyScriptPath()`'s dev/packaged resolution). */
  measureMeshScriptPath: string
  spawn?: SpawnLike
}

/** How long a spawned import/finalize step is allowed to run before it's treated as hung and
 *  killed - same generous ceiling as `params/rerun.ts`'s `RUN_TIMEOUT_MS` (these are the same
 *  parametric/mesh builds the agent runs, just without an LLM in the loop). */
const RUN_TIMEOUT_MS = 60_000

function tail(text: string, length = 600): string {
  return text.trim().slice(-length)
}

/**
 * Normalizes a caller-supplied part-id hint into a safe filesystem slug for building *this
 * module's own* output filenames (`outputs/<partId>_v<n>.py/.stl/.step`) before `recordIteration`
 * runs. Deliberately duplicated (not imported) from `ProjectStore.slugifyPartId` - same reasoning
 * as `exportResolver.ts`'s `slugifyZipBase`: this module stays dependency-free from `store.ts`
 * (which isn't part of WS-G's owned surface), and `recordIteration` re-slugifies its own `partId`
 * argument anyway, so a mismatch here is at worst a cosmetic filename oddity, never a correctness
 * issue.
 */
export function slugifyForFilename(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'part'
}

/** Detects the import lineage from a source file's extension, or `null` for an unsupported type. */
export function detectImportFormat(sourcePath: string): ImportFormat | null {
  const ext = extname(sourcePath).toLowerCase().replace(/^\./, '')
  if (ext === 'step' || ext === 'stp') return 'step'
  if (ext === 'stl') return 'stl'
  if (ext === 'obj') return 'obj'
  if (ext === '3mf') return '3mf'
  return null
}

/** STL/OBJ carry no units (the never-guess-scale rule, product doc §5.6); STEP and 3MF already
 *  carry real-world units and skip the unit-confirmation step entirely. */
export function isUnitlessFormat(format: ImportFormat): boolean {
  return format === 'stl' || format === 'obj'
}

export type CopyImportSourceResult =
  | { ok: true; importRelPath: string }
  | { ok: false; reason: string }

/**
 * Copies an externally-sourced file into the project's `imports/` directory under a generated id
 * (architecture doc §8: `imports/{importId}.{step|stl|3mf|obj}`), never touching the original.
 * `sourceAbsPath` is a native absolute OS path (from a picker or a drag-drop), not caller-supplied
 * "relative to the project" text, so there is nothing for it to path-traverse *into* - the only
 * path this function builds from untrusted input is the destination, and that's always a fresh
 * `imports/<uuid>.<ext>` this function generates itself, so it can never resolve outside the
 * project directory (mirrors the reasoning in `exportResolver.ts`'s `containedAbsPath` guard,
 * just with the roles of "caller input" and "generated path" reversed).
 */
export async function copyImportSource(
  projectDir: string,
  sourceAbsPath: string,
  format: ImportFormat
): Promise<CopyImportSourceResult> {
  let stats
  try {
    stats = await stat(sourceAbsPath)
  } catch {
    return { ok: false, reason: `Could not read "${sourceAbsPath}" - the file may have moved or been deleted.` }
  }
  if (!stats.isFile()) {
    return { ok: false, reason: `"${sourceAbsPath}" is not a file.` }
  }

  const importsDir = join(projectDir, 'imports')
  await mkdir(importsDir, { recursive: true })
  const importRelPath = `imports/${randomUUID()}.${EXTENSION_FOR_FORMAT[format]}`
  try {
    await copyFile(sourceAbsPath, join(projectDir, importRelPath))
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? `Could not copy the file into the project: ${err.message}` : 'Could not copy the file into the project.'
    }
  }
  return { ok: true, importRelPath }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Runs one process to completion, collecting stdout/stderr and enforcing `RUN_TIMEOUT_MS` -
 *  mirrors `params/rerun.ts`'s `runScript` (each spawn-based module in this codebase keeps its
 *  own small copy of this rather than sharing one implementation). */
function runProcess(spawnFn: SpawnLike, command: string, args: readonly string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawnFn(command, args, cwd ? { cwd } : {})
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

/** Parses the last non-empty line of `stdout` as JSON, or `null` if that fails - every remix/
 *  verify script in this codebase prints exactly one JSON object as its last line of stdout. */
function parseTrailingJson<T>(stdout: string): T | null {
  const lines = stdout.trim().split('\n')
  const last = lines.at(-1)
  if (!last) return null
  try {
    return JSON.parse(last) as T
  } catch {
    return null
  }
}

export interface MeshMeasurement {
  bboxMm: [number, number, number]
  watertight: boolean
  faceCount: number
  vertexCount: number
}

interface RawMeasureMeshOutput {
  ok: boolean
  reason?: string
  bboxMm?: [number, number, number]
  watertight?: boolean
  faceCount?: number
  vertexCount?: number
}

/** Runs `remix/measure_mesh.py` against an already-copied mesh import - read-only, used both for
 *  the unit-confirmation dialog's bounding box (STL/OBJ) and a quick watertight/face-count
 *  summary. Never invoked for STEP (no separate measure step - `finalizeStepImport` reads the
 *  build123d shape directly) or when a scale has already been confirmed and 3MF/STEP go straight
 *  to finalize. */
export async function measureMeshImport(
  deps: ImportModelDeps,
  projectDir: string,
  importRelPath: string
): Promise<{ ok: true; measurement: MeshMeasurement } | { ok: false; reason: string }> {
  const spawnFn = deps.spawn ?? nodeSpawn
  const absPath = join(projectDir, importRelPath)
  const run = await runProcess(spawnFn, deps.pythonPath, [deps.measureMeshScriptPath, absPath])

  if (run.code !== 0) {
    const reason = run.timedOut
      ? 'Measuring the import took too long and was stopped.'
      : tail(run.stderr) || tail(run.stdout) || `measure_mesh.py exited with code ${run.code}.`
    return { ok: false, reason }
  }

  const parsed = parseTrailingJson<RawMeasureMeshOutput>(run.stdout)
  if (!parsed) {
    return { ok: false, reason: 'Could not parse the measurement output.' }
  }
  if (!parsed.ok || !parsed.bboxMm || parsed.watertight === undefined) {
    return { ok: false, reason: parsed.reason ?? 'Measurement failed.' }
  }

  return {
    ok: true,
    measurement: {
      bboxMm: parsed.bboxMm,
      watertight: parsed.watertight,
      faceCount: parsed.faceCount ?? 0,
      vertexCount: parsed.vertexCount ?? 0
    }
  }
}

/**
 * Picks which dimension the unit-confirmation dialog shows: the largest bounding-box extent
 * (most legible as "width" - matches product doc §5.6's example, "this reads as 120mm wide"),
 * tie-broken toward the earlier axis.
 */
export function pickUnitConfirmationAxis(bboxMm: [number, number, number]): {
  axis: 'x' | 'y' | 'z'
  measuredMm: number
} {
  const labels: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z']
  let best = 0
  for (let i = 1; i < 3; i++) {
    if (bboxMm[i] > bboxMm[best]) best = i
  }
  return { axis: labels[best], measuredMm: bboxMm[best] }
}

/**
 * Builds the self-contained mesh-lineage import script (`outputs/<partId>_v<n>.py`). It is BOTH
 * the file `finalizeMeshImport` executes to produce the artifacts AND the file `recordIteration`
 * snapshots as "the exact script that produced this iteration" - so it deliberately does not call
 * out to any file in this package (`remix/repair_mesh.py` is the same algorithm, kept as a
 * standalone, independently testable/runnable reference - see its own module docstring for why
 * the two aren't just one shared import). No PARAMS block: nothing Voyager-authored exists yet to
 * tune (product doc §5.6) - the parameter panel scopes itself to features added on top, once any
 * exist.
 */
function buildMeshImportScript(importRelPath: string, outRelPath: string, scaleFactor: number): string {
  return `"""Imported base (WS-G remix, mesh lineage) - see references/remix.md.
No PARAMS block: nothing Voyager-authored exists yet to tune. Add boolean-surgery features
below \`base\` on the next iteration - a robust boolean backend (manifold3d) plus the
plug-and-recut pattern are documented in references/remix.md and packages/agent-core/remix/
boolean_ops.py.

The repair pass below is dependency-free (no networkx/scipy - the managed environment doesn't
include it); see packages/agent-core/remix/repair_mesh.py for the same algorithm as a standalone,
independently runnable tool."""
import json
from collections import defaultdict

import numpy as np
import trimesh

SOURCE = "${importRelPath}"
SCALE = ${scaleFactor}  # confirmed against the user's real-world measurement at import time


def _fill_holes(mesh):
    """Dependency-free boundary-loop fan-fill (no networkx) - groups open edges into loops by
    walking vertex adjacency, then fan-triangulates each loop from its first vertex. Handles the
    common simple-hole case; a highly non-convex hole may still need a manual fix."""
    edge_count = defaultdict(int)
    for a, b in mesh.edges_sorted:
        edge_count[(int(a), int(b))] += 1
    boundary = [e for e, c in edge_count.items() if c == 1]
    if not boundary:
        return 0

    adjacency = defaultdict(list)
    for a, b in boundary:
        adjacency[a].append(b)
        adjacency[b].append(a)

    visited = set()
    loops = []
    for a, b in boundary:
        key = tuple(sorted((a, b)))
        if key in visited:
            continue
        loop = [a, b]
        visited.add(key)
        cur = b
        while True:
            candidates = [n for n in adjacency[cur] if tuple(sorted((cur, n))) not in visited]
            if not candidates:
                break
            nxt = candidates[0]
            visited.add(tuple(sorted((cur, nxt))))
            if nxt == loop[0]:
                break
            loop.append(nxt)
            cur = nxt
        loops.append(loop)

    extra_faces = []
    for loop in loops:
        for i in range(1, len(loop) - 1):
            extra_faces.append([loop[0], loop[i], loop[i + 1]])
    if extra_faces:
        mesh.faces = np.vstack([mesh.faces, np.array(extra_faces)])
    return len(loops)


base = trimesh.load(SOURCE, force="mesh")
if SCALE != 1.0:
    base.apply_scale(SCALE)

report = []
nd_mask = base.nondegenerate_faces()
if not nd_mask.all():
    report.append(f"removed {int((~nd_mask).sum())} degenerate face(s)")
    base.update_faces(nd_mask)
uniq_mask = base.unique_faces()
if not uniq_mask.all():
    report.append(f"removed {int((~uniq_mask).sum())} duplicate face(s)")
    base.update_faces(uniq_mask)
base.merge_vertices()
base.remove_unreferenced_vertices()
if not base.is_watertight:
    filled = _fill_holes(base)
    if filled:
        report.append(f"filled {filled} hole(s)")
        base.remove_unreferenced_vertices()
    if not base.is_watertight:
        report.append("still not watertight after repair - the hole(s) may be too irregular for automatic fill")
if not base.is_winding_consistent:
    report.append("winding is inconsistent (not auto-fixed in this environment - requires networkx)")

if __name__ == "__main__":
    base.export("./${outRelPath}")
    print(json.dumps({
        "repairReport": report,
        "watertight": bool(base.is_watertight),
        "bboxMm": [float(x) for x in base.extents]
    }))
`
}

/**
 * Builds the self-contained STEP-lineage import script (`outputs/<partId>_v<n>.py`) - an ordinary
 * build123d script following the skill's own conventions (SKILL.md Phase 4), just with `base`
 * referencing the import instead of primitives. Future agent turns add or cut features on top of
 * `base` and keep exporting STEP - full parametric remix (architecture doc §12.5).
 */
function buildStepImportScript(importRelPath: string, stlOutRelPath: string, stepOutRelPath: string): string {
  return `"""Imported base (WS-G remix, STEP lineage) - see references/remix.md.
\`base\` references the externally-authored STEP directly. Add or cut features on top of it with
ordinary build123d code - no PARAMS block yet (nothing Voyager-authored exists to tune); add one
once you add dimensions worth exposing to the parameter panel (SKILL.md Phase 4). Re-export both
STL and STEP after every edit, exactly like a from-scratch generated script."""
import json

from build123d import export_step, export_stl, import_step

SOURCE = "${importRelPath}"

base = import_step(SOURCE)

if __name__ == "__main__":
    export_stl(base, "./${stlOutRelPath}", tolerance=0.01, angular_tolerance=0.1)
    export_step(base, "./${stepOutRelPath}")
    try:
        size = base.bounding_box().size
        try:
            bbox = [float(size.X), float(size.Y), float(size.Z)]
        except AttributeError:
            bbox = [float(size.x), float(size.y), float(size.z)]
    except Exception:
        bbox = None
    print(json.dumps({"bboxMm": bbox}))
`
}

export interface FinalizeMeshImportOptions {
  projectDir: string
  importRelPath: string
  /** Already-slugified (see `slugifyForFilename`). */
  partId: string
  /** Cosmetic version number for the filename - `recordIteration` computes the authoritative `n`
   *  independently, so a mismatch is harmless (same tolerance `params/rerun.ts` relies on for a
   *  re-run script's own chosen filename). */
  nextN: number
  scaleFactor: number
  /** Original source file's display name, folded into the recorded iteration's summary. */
  sourceBaseName: string
}

export type FinalizeImportResult =
  | { ok: true; scriptRelPath: string; stlRelPath: string; stepRelPath?: string; summary: string }
  | { ok: false; reason: string }

/**
 * Finalizes a mesh-lineage import: writes the self-contained import script to its final resting
 * path, runs it with the managed venv's python (producing the repaired/scaled STL), and folds the
 * repair report into a human-readable summary (there is no dedicated response field for it in the
 * frozen `ImportModelResponse` contract, so - mirroring WS-B's precedent of encoding provenance a
 * plain `ProjectIteration.summary` string when no field exists for it - it lives in the iteration
 * summary, which the chat/version-history panels already render for every iteration).
 */
export async function finalizeMeshImport(
  deps: ImportModelDeps,
  options: FinalizeMeshImportOptions
): Promise<FinalizeImportResult> {
  const scriptRelPath = `outputs/${options.partId}_v${options.nextN}.py`
  const stlRelPath = `outputs/${options.partId}_v${options.nextN}.stl`

  await mkdir(join(options.projectDir, 'outputs'), { recursive: true })
  const scriptAbsPath = join(options.projectDir, scriptRelPath)
  await writeFile(scriptAbsPath, buildMeshImportScript(options.importRelPath, stlRelPath, options.scaleFactor), 'utf-8')

  const spawnFn = deps.spawn ?? nodeSpawn
  const run = await runProcess(spawnFn, deps.pythonPath, [scriptAbsPath], options.projectDir)
  if (run.code !== 0) {
    const reason = run.timedOut
      ? 'Finalizing the import took too long and was stopped.'
      : tail(run.stderr) || tail(run.stdout) || `The import script exited with code ${run.code}.`
    return { ok: false, reason: `Could not finalize the import: ${reason}` }
  }

  const parsed = parseTrailingJson<{ repairReport?: string[] }>(run.stdout)
  const repairReport = parsed?.repairReport ?? []
  const summary =
    repairReport.length > 0
      ? `Imported ${options.sourceBaseName} (repaired: ${repairReport.join('; ')})`
      : `Imported ${options.sourceBaseName}`

  return { ok: true, scriptRelPath, stlRelPath, summary }
}

export interface FinalizeStepImportOptions {
  projectDir: string
  importRelPath: string
  partId: string
  nextN: number
  sourceBaseName: string
}

/**
 * Finalizes a STEP-lineage import: writes the ordinary build123d script referencing the import
 * and runs it, producing both an STL (for display/verification) and a STEP (for full parametric
 * remix downstream). Not execution-verified in this environment - build123d/OCP aren't installed
 * here (see this work order's final report); the mesh-lineage path above IS execution-verified,
 * since trimesh/numpy happen to be available in this sandbox.
 */
export async function finalizeStepImport(
  deps: ImportModelDeps,
  options: FinalizeStepImportOptions
): Promise<FinalizeImportResult> {
  const scriptRelPath = `outputs/${options.partId}_v${options.nextN}.py`
  const stlRelPath = `outputs/${options.partId}_v${options.nextN}.stl`
  const stepRelPath = `outputs/${options.partId}_v${options.nextN}.step`

  await mkdir(join(options.projectDir, 'outputs'), { recursive: true })
  const scriptAbsPath = join(options.projectDir, scriptRelPath)
  await writeFile(scriptAbsPath, buildStepImportScript(options.importRelPath, stlRelPath, stepRelPath), 'utf-8')

  const spawnFn = deps.spawn ?? nodeSpawn
  const run = await runProcess(spawnFn, deps.pythonPath, [scriptAbsPath], options.projectDir)
  if (run.code !== 0) {
    const reason = run.timedOut
      ? 'Finalizing the import took too long and was stopped.'
      : tail(run.stderr) || tail(run.stdout) || `The import script exited with code ${run.code}.`
    return { ok: false, reason: `Could not finalize the import: ${reason}` }
  }

  return {
    ok: true,
    scriptRelPath,
    stlRelPath,
    stepRelPath,
    summary: `Imported ${options.sourceBaseName} (STEP - full parametric remix available)`
  }
}
