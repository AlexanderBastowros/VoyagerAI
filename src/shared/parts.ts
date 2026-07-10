/**
 * Multi-part projects (architecture doc §14, product doc §5.3). A project holds one or more
 * **parts** - a box *and* its lid, a gear *pair*, a bracket *set* - each with its own script
 * lineage, iteration history, and active-iteration pointer (the full per-part history lives in the
 * main-process `ProjectStore`; WS-I owns it). This module defines only the renderer-safe shapes
 * that cross the IPC boundary: `PartRecord` (a trimmed view, mirroring how `IterationInfo` trims
 * `ProjectIteration`) and `Placement`.
 *
 * `Placement` is **layout, not geometry**: it positions/orients a part in the shared build space
 * for the viewport gizmo and cross-part interference checks, and never modifies a part's script or
 * mesh (no invisible geometry drift - §14). This module is shape + validation only; WS-I owns the
 * store, the placement controller, and the parts panel that give it behavior.
 */

import { z } from 'zod'

/**
 * A part's layout in the shared build space. Position is in mm; `rotation` is Euler angles in
 * degrees applied in XYZ order (human-readable in `project.json` and the parts panel - the viewer
 * converts to/from quaternions for the gizmo). The identity placement (see `identityPlacement`)
 * leaves a part where its own script authored it.
 */
export const PlacementSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]),
  /** Euler angles in degrees, applied XYZ. */
  rotation: z.tuple([z.number(), z.number(), z.number()])
})
export type Placement = z.infer<typeof PlacementSchema>

/** The zero placement - part sits at the origin, unrotated, i.e. wherever its script authored it. */
export function identityPlacement(): Placement {
  return { position: [0, 0, 0], rotation: [0, 0, 0] }
}

/**
 * Renderer-safe summary of one part. The main-process `ProjectStore` owns the authoritative
 * per-part iteration history (WS-I); this is the trimmed shape the `PartsPanel` renders and the
 * `part:list`/`part:updated` IPC surface carries.
 */
export const PartRecordSchema = z.object({
  /** Stable slug, unique within the project. A migrated single-part project has one part, `main`. */
  id: z.string(),
  name: z.string(),
  placement: PlacementSchema,
  /** Whether the part is shown in the viewport (per-part visibility toggle). */
  visible: z.boolean(),
  /** The `n` of this part's active iteration, or null if the part has no iterations yet. */
  activeIteration: z.number().int().nullable()
})
export type PartRecord = z.infer<typeof PartRecordSchema>

/** The default part id every pre-multi-part project migrates into (discover-don't-recreate, §14). */
export const MAIN_PART_ID = 'main'

export function isPartRecord(value: unknown): value is PartRecord {
  return PartRecordSchema.safeParse(value).success
}

export function isPlacement(value: unknown): value is Placement {
  return PlacementSchema.safeParse(value).success
}
