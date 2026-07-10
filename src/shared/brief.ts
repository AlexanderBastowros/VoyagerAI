/**
 * The Design Brief - the co-authored, machine-checkable spec that gates generation and powers
 * verification layer 3 (architecture doc §6). Stored as versioned JSON, zod-validated (zod is
 * already a dependency), rendered by `BriefPanel.tsx` (WS-A), consumed by the designer prompt and
 * the conformance layer.
 *
 * Provenance (`user` vs `inferred`) is load-bearing: inferred values render distinctly in the
 * panel until confirmed, and the designer must never treat an inferred dimension as settled - the
 * same "never invent a dimension" rule the skill already encodes, made enforceable.
 *
 * This module defines shape + validation only - WS-A owns the brief store, MCP tool, and prompt
 * wiring that give it real behavior; every field below is a stub-friendly default until then.
 */

import { z } from 'zod'

export const DimProvenanceSchema = z.enum(['user', 'inferred'])
export type DimProvenance = z.infer<typeof DimProvenanceSchema>

export const DimSchema = z.object({
  value: z.number(),
  unit: z.literal('mm'),
  tolerance: z.number().optional(),
  provenance: DimProvenanceSchema
})
export type Dim = z.infer<typeof DimSchema>

export const ImageRefSchema = z.object({
  /** Path to the stored reference image, relative to the project directory. */
  path: z.string(),
  /** Caption or note describing what the image shows / which dimension it scales. */
  caption: z.string().optional()
})
export type ImageRef = z.infer<typeof ImageRefSchema>

/** Reusable, per-user printer settings (WS-E owns the store; referenced here by value). */
export const PrinterProfileRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  bedXMm: z.number(),
  bedYMm: z.number(),
  bedZMm: z.number(),
  nozzleDiameterMm: z.number(),
  materials: z.array(z.string())
})
export type PrinterProfileRef = z.infer<typeof PrinterProfileRefSchema>

const FeatureBaseSchema = z.object({
  id: z.string(),
  label: z.string().optional()
})

export const HolePurposeSchema = z.enum(['clearance', 'tapped', 'press_fit'])
export type HolePurpose = z.infer<typeof HolePurposeSchema>

export const FeatureSchema = z.discriminatedUnion('kind', [
  FeatureBaseSchema.extend({
    kind: z.literal('hole'),
    diameter: DimSchema,
    purpose: HolePurposeSchema,
    position: z.string()
  }),
  FeatureBaseSchema.extend({
    kind: z.literal('pocket'),
    width: DimSchema,
    depth: DimSchema,
    position: z.string()
  }),
  FeatureBaseSchema.extend({
    kind: z.literal('boss'),
    diameter: DimSchema,
    height: DimSchema,
    position: z.string()
  }),
  FeatureBaseSchema.extend({
    kind: z.literal('fillet_chamfer'),
    style: z.enum(['fillet', 'chamfer']),
    size: DimSchema,
    edges: z.string()
  }),
  FeatureBaseSchema.extend({
    kind: z.literal('text'),
    content: z.string(),
    depthMm: z.number(),
    position: z.string()
  }),
  FeatureBaseSchema.extend({
    kind: z.literal('insert'),
    insertType: z.string(),
    size: z.string(),
    position: z.string()
  }),
  /**
   * A library-generated involute gear (WS-H, architecture doc §13). `module`/`teeth`/
   * `pressureAngle`/`helix` are engineering parameters (not toleranced `Dim`s); `bore` and the
   * optional `hub` are real diameters/heights that carry fit tolerance like any hole. `meshesWith`
   * points at the `id` of the mating gear feature, which is what turns "make a gear" into a
   * checkable pair spec (matched module/PA, center distance) rather than an unmated shape request.
   */
  FeatureBaseSchema.extend({
    kind: z.literal('gear'),
    /** Gear module in mm (tooth-size unit): pitch diameter = module × teeth. Must match a mate. */
    module: z.number().positive(),
    teeth: z.number().int().positive(),
    /** Pressure angle in degrees (commonly 20). Must match a mate. */
    pressureAngle: z.number().positive(),
    /** Helix angle in degrees; omitted for a spur gear. */
    helix: z.number().optional(),
    /** Center bore diameter (for the shaft/axle). */
    bore: DimSchema,
    /** Optional raised hub around the bore. */
    hub: z.object({ diameter: DimSchema, height: DimSchema }).optional(),
    /** `id` of the Feature this gear meshes with (§13) - makes the pair a checkable spec. */
    meshesWith: z.string().optional()
  })
])
export type Feature = z.infer<typeof FeatureSchema>

export const OrientationSchema = z.enum(['flat', 'vertical', 'angled'])
export type Orientation = z.infer<typeof OrientationSchema>

export const DesignBriefSchema = z.object({
  /** Brief versions are immutable once locked - a new version is written for any further edit. */
  version: z.number().int().min(1),
  /** Set once the brief is locked; generation stamps this onto each iteration as `briefVersion`. */
  lockedAt: z.string().optional(),
  part: z.object({
    name: z.string(),
    purpose: z.string(),
    referenceImages: z.array(ImageRefSchema)
  }),
  printer: PrinterProfileRefSchema.optional(),
  envelope: z.object({
    x: DimSchema,
    y: DimSchema,
    z: DimSchema
  }),
  features: z.array(FeatureSchema),
  materials: z.object({
    requested: z.string().optional(),
    onHand: z.array(z.string())
  }),
  constraints: z.object({
    mustFitBed: z.boolean(),
    allowSplit: z.boolean(),
    maxPieces: z.number().int().min(2).optional(),
    printOrientation: z.union([z.literal('agent-decides'), OrientationSchema]).optional(),
    loadBearing: z.boolean().optional()
  }),
  /** Explicit don't-wants - prompted verbatim to the designer. */
  exclusions: z.array(z.string()),
  /** Human-readable acceptance criteria; the vision critic (M3) reads these. */
  acceptance: z.array(z.string())
})
export type DesignBrief = z.infer<typeof DesignBriefSchema>

/** An empty brief for a project that hasn't started co-authoring one yet - WS-A's brief store
 *  seeds new projects with this shape rather than `null` so panel code has one fewer state to
 *  branch on. */
export function emptyDesignBrief(): DesignBrief {
  return {
    version: 1,
    part: { name: '', purpose: '', referenceImages: [] },
    envelope: {
      x: { value: 0, unit: 'mm', provenance: 'inferred' },
      y: { value: 0, unit: 'mm', provenance: 'inferred' },
      z: { value: 0, unit: 'mm', provenance: 'inferred' }
    },
    features: [],
    materials: { onHand: [] },
    constraints: { mustFitBed: true, allowSplit: false },
    exclusions: [],
    acceptance: []
  }
}

export function isDesignBrief(value: unknown): value is DesignBrief {
  return DesignBriefSchema.safeParse(value).success
}
