import { z } from 'zod'
import type { DesignBrief, Feature } from '@shared/ipc'

/**
 * The `update_brief` MCP tool's input shape (see `tools/updateBrief.ts`). Every numeric field the
 * agent can set is a bare number here, not the domain `Dim` shape - `mergeAgentPatch` wraps each
 * one into `{ value, unit: 'mm', provenance: 'inferred' }` itself, so the agent never gets to
 * claim a value is user-confirmed (see `src/shared/brief.ts`'s provenance doc comment). Features
 * are upserted by `id`: the agent re-sends the same `id` to revise a feature it already proposed.
 */
const AgentFeatureShape = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hole'),
    id: z.string(),
    label: z.string().optional(),
    diameter_mm: z.number(),
    diameter_tolerance_mm: z.number().optional(),
    purpose: z.enum(['clearance', 'tapped', 'press_fit']),
    position: z.string()
  }),
  z.object({
    kind: z.literal('pocket'),
    id: z.string(),
    label: z.string().optional(),
    width_mm: z.number(),
    width_tolerance_mm: z.number().optional(),
    depth_mm: z.number(),
    depth_tolerance_mm: z.number().optional(),
    position: z.string()
  }),
  z.object({
    kind: z.literal('boss'),
    id: z.string(),
    label: z.string().optional(),
    diameter_mm: z.number(),
    diameter_tolerance_mm: z.number().optional(),
    height_mm: z.number(),
    height_tolerance_mm: z.number().optional(),
    position: z.string()
  }),
  z.object({
    kind: z.literal('fillet_chamfer'),
    id: z.string(),
    label: z.string().optional(),
    style: z.enum(['fillet', 'chamfer']),
    size_mm: z.number(),
    size_tolerance_mm: z.number().optional(),
    edges: z.string()
  }),
  z.object({
    kind: z.literal('text'),
    id: z.string(),
    label: z.string().optional(),
    content: z.string(),
    depth_mm: z.number(),
    position: z.string()
  }),
  z.object({
    kind: z.literal('insert'),
    id: z.string(),
    label: z.string().optional(),
    insert_type: z.string(),
    size: z.string(),
    position: z.string()
  })
])
export type AgentFeatureInput = z.infer<typeof AgentFeatureShape>

/** Raw zod shape (not wrapped in `z.object`) so `tools/updateBrief.ts` can pass it straight to the
 *  SDK's `tool()` the same way every other Voyager MCP tool declares its args. */
export const briefAgentPatchShape = {
  part_name: z.string().optional().describe("The part's short name, e.g. \"Sensor mounting bracket\"."),
  part_purpose: z.string().optional().describe('What the part is for, in one sentence.'),
  envelope_x_mm: z.number().optional().describe('Overall bounding-box width (X) in millimeters.'),
  envelope_y_mm: z.number().optional().describe('Overall bounding-box depth (Y) in millimeters.'),
  envelope_z_mm: z.number().optional().describe('Overall bounding-box height (Z) in millimeters.'),
  materials_requested: z.string().optional().describe('The material the user asked for, if any.'),
  materials_on_hand: z
    .array(z.string())
    .optional()
    .describe('Replaces the full list of materials the user already has on hand.'),
  must_fit_bed: z.boolean().optional().describe('Whether the part must fit the printer bed as one piece.'),
  allow_split: z.boolean().optional().describe('Whether the part may be split into multiple printed pieces.'),
  max_pieces: z.number().int().min(2).optional().describe('Maximum number of pieces if splitting is allowed.'),
  print_orientation: z
    .enum(['agent-decides', 'flat', 'vertical', 'angled'])
    .optional()
    .describe('The intended print orientation, or "agent-decides" to leave it to you.'),
  load_bearing: z.boolean().optional().describe('Whether the part needs to bear meaningful mechanical load.'),
  exclusions: z
    .array(z.string())
    .optional()
    .describe('Replaces the full list of explicit don\'t-wants the user stated.'),
  acceptance: z
    .array(z.string())
    .optional()
    .describe('Replaces the full list of human-readable acceptance criteria.'),
  features: z
    .array(AgentFeatureShape)
    .optional()
    .describe('Features to add or revise (matched by `id`) - holes, pockets, bosses, fillets/chamfers, text, inserts.')
}

const BriefAgentPatchSchema = z.object(briefAgentPatchShape)
export type BriefAgentPatch = z.infer<typeof BriefAgentPatchSchema>

function toInferredDim(value: number, tolerance?: number): { value: number; unit: 'mm'; tolerance?: number; provenance: 'inferred' } {
  return { value, unit: 'mm', tolerance, provenance: 'inferred' }
}

function toDomainFeature(input: AgentFeatureInput): Feature {
  switch (input.kind) {
    case 'hole':
      return {
        kind: 'hole',
        id: input.id,
        label: input.label,
        diameter: toInferredDim(input.diameter_mm, input.diameter_tolerance_mm),
        purpose: input.purpose,
        position: input.position
      }
    case 'pocket':
      return {
        kind: 'pocket',
        id: input.id,
        label: input.label,
        width: toInferredDim(input.width_mm, input.width_tolerance_mm),
        depth: toInferredDim(input.depth_mm, input.depth_tolerance_mm),
        position: input.position
      }
    case 'boss':
      return {
        kind: 'boss',
        id: input.id,
        label: input.label,
        diameter: toInferredDim(input.diameter_mm, input.diameter_tolerance_mm),
        height: toInferredDim(input.height_mm, input.height_tolerance_mm),
        position: input.position
      }
    case 'fillet_chamfer':
      return {
        kind: 'fillet_chamfer',
        id: input.id,
        label: input.label,
        style: input.style,
        size: toInferredDim(input.size_mm, input.size_tolerance_mm),
        edges: input.edges
      }
    case 'text':
      return {
        kind: 'text',
        id: input.id,
        label: input.label,
        content: input.content,
        depthMm: input.depth_mm,
        position: input.position
      }
    case 'insert':
      return {
        kind: 'insert',
        id: input.id,
        label: input.label,
        insertType: input.insert_type,
        size: input.size,
        position: input.position
      }
  }
}

/**
 * Merges an agent-authored patch into `base`, returning a new `DesignBrief`. Every `Dim`-typed
 * field the patch touches is tagged `provenance: 'inferred'` unconditionally, regardless of what
 * the field previously held - the agent proposes, the user (via the brief panel) confirms. Plain
 * scalar/array fields (name, purpose, materials, constraints, exclusions, acceptance) have no
 * provenance concept and are simply overwritten when present in the patch. Features are upserted
 * by `id`: an existing id is replaced in place (preserving its position in the list), a new id is
 * appended.
 */
export function mergeAgentPatch(base: DesignBrief, patch: BriefAgentPatch): DesignBrief {
  const next: DesignBrief = {
    ...base,
    part: { ...base.part },
    envelope: { ...base.envelope },
    materials: { ...base.materials },
    constraints: { ...base.constraints },
    features: [...base.features],
    exclusions: [...base.exclusions],
    acceptance: [...base.acceptance]
  }

  if (patch.part_name !== undefined) next.part.name = patch.part_name
  if (patch.part_purpose !== undefined) next.part.purpose = patch.part_purpose
  if (patch.envelope_x_mm !== undefined) next.envelope.x = toInferredDim(patch.envelope_x_mm)
  if (patch.envelope_y_mm !== undefined) next.envelope.y = toInferredDim(patch.envelope_y_mm)
  if (patch.envelope_z_mm !== undefined) next.envelope.z = toInferredDim(patch.envelope_z_mm)
  if (patch.materials_requested !== undefined) next.materials.requested = patch.materials_requested
  if (patch.materials_on_hand !== undefined) next.materials.onHand = patch.materials_on_hand
  if (patch.must_fit_bed !== undefined) next.constraints.mustFitBed = patch.must_fit_bed
  if (patch.allow_split !== undefined) next.constraints.allowSplit = patch.allow_split
  if (patch.max_pieces !== undefined) next.constraints.maxPieces = patch.max_pieces
  if (patch.print_orientation !== undefined) next.constraints.printOrientation = patch.print_orientation
  if (patch.load_bearing !== undefined) next.constraints.loadBearing = patch.load_bearing
  if (patch.exclusions !== undefined) next.exclusions = patch.exclusions
  if (patch.acceptance !== undefined) next.acceptance = patch.acceptance

  if (patch.features) {
    for (const featureInput of patch.features) {
      const domain = toDomainFeature(featureInput)
      const index = next.features.findIndex((existing) => existing.id === domain.id)
      if (index >= 0) next.features[index] = domain
      else next.features.push(domain)
    }
  }

  return next
}
