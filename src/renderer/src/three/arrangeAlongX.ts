import type * as THREE from 'three'
import type { Placement } from '../../../shared/ipc'
import { rotatedLocalBounds } from './placement'

/**
 * Pure, WebGL-free row-layout math for the **print-orientation preview** (the "arrange the parts on
 * the X axis when the user asks for recommended print settings" feature). Same posture as
 * `placement.ts`: no store, no IPC, no renderer - just bounds in, placements out, so the layout is
 * unit-testable without a canvas.
 *
 * ## What the preview is
 *
 * The viewport's build plate is the world `y = 0` plane (a `GridHelper` in XZ; the ViewCube maps TOP
 * to +Y), but model/print space is **Z-up** everywhere else in the app: the DFM reference, the
 * printable-cad skill, the build123d reference and `validate_stl.py`'s bed-height axis all treat Z
 * as the print direction. Nothing in the pipeline converts - `buildMesh` only translates geometry
 * and three's `STLLoader` does not remap axes - so a part's *printed bed face* currently points at
 * the ViewCube's BACK. Spreading parts along X at that pose would space them out without previewing
 * the print orientation at all, which is literally what was asked for. So the preview also applies
 * one **display-only** rotation mapping model +Z to world +Y: `MODEL_UP_TO_WORLD_UP_DEG`.
 *
 * The rotation is a *parameter*, never a hardcode inside the layout loop, so if the repo ever fixes
 * its up-axis convention globally this argument simply becomes `[0, 0, 0]` and the row math is
 * unchanged. Nothing here is persisted: the caller applies the result straight to the viewer's
 * meshes and never writes `Placement`s back to the store or to `project.json`.
 *
 * ## Spacing provenance (never invent a threshold - see CLAUDE.md)
 *
 * `PLATE_MARGIN_MM = 5` is the skill's and the validator's **per-side** bed margin for brim/skirt:
 * `SKILL.md` §"Print bed size?" says "Reserve a margin (~5 mm per side) for brim/skirt", and
 * `packages/verify/python/validate_stl.py` takes `--margin` with `default=5` documented as
 * "per-side bed margin for brim/skirt (mm)" and spends it as `bed - 2 * margin`
 * (`geometry_report.py` does the same). Two adjacent parts each own a 5 mm per-side allowance, so
 * facing edges need `PART_GAP_MM = 2 * PLATE_MARGIN_MM = 10` mm between them and each bed edge keeps
 * one 5 mm margin - i.e. `usableXMm = bedXMm - 2 * PLATE_MARGIN_MM`.
 *
 * NOT the 0.3-0.5 mm figure from `design-for-printing.md` §"Moving parts": that is the
 * **print-in-place joint** clearance between two surfaces of one assembly, a different category
 * entirely, and using it here would put parts close enough for their skirts to merge.
 */

/**
 * The display rotation (XYZ Euler degrees, like every `Placement.rotation`) that maps model +Z -
 * the print/bed-height axis - onto the viewport's world +Y. `Rx(-90)` maps `(x, y, z) -> (x, z, -y)`,
 * so footprint width along X is unchanged, footprint depth along Z becomes the model's Y, and the
 * *visible vertical* extent becomes the real print height. For a min-corner-origined box at this
 * rotation the resting lift is 0 (`rotatedLocalBounds().min.y === localMin.z === 0`), so the part
 * already sits exactly on the plate and `groundClamp` leaves it untouched.
 */
export const MODEL_UP_TO_WORLD_UP_DEG: readonly [number, number, number] = [-90, 0, 0]

/** Per-side bed margin reserved for brim/skirt (mm) - see the module doc for provenance. */
export const PLATE_MARGIN_MM = 5

/** Clear distance between two adjacent parts' facing edges (mm): each part owns its own per-side
 *  margin, so the gap is two of them. */
export const PART_GAP_MM = 2 * PLATE_MARGIN_MM

/** One part to lay out: its id and its **local** axis-aligned bounds (as produced by `loadPart`,
 *  min corner at the local origin - i.e. `mesh.geometry.boundingBox`). */
export interface ArrangeItem {
  partId: string
  localMin: THREE.Vector3
  localMax: THREE.Vector3
}

export interface ArrangeOptions {
  /** The display rotation to apply to every part (XYZ Euler degrees). Pass
   *  `MODEL_UP_TO_WORLD_UP_DEG` for the print-orientation preview, `[0, 0, 0]` for a pose-preserving
   *  row. */
  rotationDeg: readonly [number, number, number]
  /** Usable bed width along X (mm) - `bedXMm - 2 * PLATE_MARGIN_MM` - or `null` when no printer
   *  profile is active. `null` means "bed not checked": no overflow verdict is reported. */
  usableXMm: number | null
}

export interface ArrangeResult {
  /** One placement per input item, in input order. Display-only - never persist these. */
  placements: Array<{ partId: string; placement: Placement }>
  /** Total X extent of the row (mm), including the inter-part gaps but not the bed margins. */
  rowWidthMm: number
  /** Set only when the bed width is known AND the row does not fit it. The placements are
   *  **unchanged** either way: the codebase's posture is to warn/report, not to silently shrink,
   *  wrap or re-pack geometry (there is no sourced row pitch for a second row). */
  overflow: { rowWidthMm: number; usableXMm: number } | null
}

/**
 * Lays the given parts out as a single row along world X, each rotated into its print orientation,
 * centred on the grid origin, each straddling `z = 0` and each resting on the plate.
 *
 * TWO SUBTLETIES ARE LOAD-BEARING, both because parts are **min-corner-origined and rotate about
 * that origin** (`buildMesh` translates geometry by `-bounds.min`), which makes `Placement.position`
 * neither a centre nor a world-AABB min:
 *
 * - `position[0] = cursor - rb.min.x`, not `cursor` - the compensation is what makes the part's
 *   world-AABB min land on the cursor. For `MODEL_UP_TO_WORLD_UP_DEG` specifically `rb.min.x` is 0,
 *   so this term is a no-op *for that rotation only*; it bites for anything else (e.g. `[0, 45, 0]`).
 * - `position[2] = -(rb.min.z + rb.max.z) / 2` centres the rotated depth on the plate centreline.
 *   For `MODEL_UP_TO_WORLD_UP_DEG`, `rb.min.z = -localMax.y` and `rb.max.z = -localMin.y`, so this
 *   term is decidedly *not* zero - without it every part would sit entirely at negative Z instead of
 *   straddling the centreline.
 *
 * Idempotent: the result depends only on the items' local bounds and the requested rotation, never
 * on their current placements, so arranging an already-arranged set returns the same placements.
 */
export function arrangeAlongX(items: readonly ArrangeItem[], options: ArrangeOptions): ArrangeResult {
  const { rotationDeg, usableXMm } = options

  // Bounds are needed twice (row width, then per-part offsets) - compute once, in input order,
  // which is the store's parts order so the row is stable across re-runs.
  const bounds = items.map((item) => rotatedLocalBounds(item.localMin, item.localMax, rotationDeg))
  const widths = bounds.map((rb) => rb.max.x - rb.min.x)

  const gapTotal = items.length > 1 ? PART_GAP_MM * (items.length - 1) : 0
  const rowWidthMm = widths.reduce((sum, w) => sum + w, 0) + gapTotal

  let cursor = -rowWidthMm / 2
  const placements = items.map((item, i) => {
    const rb = bounds[i]
    const placement: Placement = {
      position: [cursor - rb.min.x, -rb.min.y, -(rb.min.z + rb.max.z) / 2],
      rotation: [rotationDeg[0], rotationDeg[1], rotationDeg[2]]
    }
    cursor += widths[i] + PART_GAP_MM
    return { partId: item.partId, placement }
  })

  const overflow =
    usableXMm !== null && rowWidthMm > usableXMm ? { rowWidthMm, usableXMm } : null

  return { placements, rowWidthMm, overflow }
}
