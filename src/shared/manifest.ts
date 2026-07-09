/**
 * The per-iteration script `manifest.json` (architecture doc §5, §7): the PARAMS block a
 * generated script declares, plus feature→parameter bindings for direct manipulation. Emitted
 * by the skill (WS-B owns the emission + extraction), read by the parameter panel (no-LLM
 * re-run) and by verification layer 3 (manifest claims vs. independent measurement).
 *
 * This module defines shape + validation only - WS-B owns the `packages/agent-core/params/`
 * extraction code and `ParamPanel.tsx` that give it real behavior.
 */

import { z } from 'zod'

/**
 * One entry of the PARAMS convention:
 * `NAME = value  # unit=mm min=.. max=.. label=".." brief=envelope.x`
 * Extracted by a trivial Python `ast` parse - no LLM.
 */
export const ParamEntrySchema = z.object({
  name: z.string(),
  value: z.number(),
  unit: z.string(),
  min: z.number().optional(),
  max: z.number().optional(),
  label: z.string(),
  /** Back-reference into the locked `DesignBrief`, e.g. `"envelope.x"` - keeps brief and
   *  parameters bidirectionally consistent (editing a brief-bound param proposes a brief patch). */
  brief: z.string().optional()
})
export type ParamEntry = z.infer<typeof ParamEntrySchema>

/** How a viewport face-drag maps onto a parameter delta for direct manipulation (M4). */
export const DragAxisSchema = z.enum(['x', 'y', 'z'])
export type DragAxis = z.infer<typeof DragAxisSchema>

export const FeatureBindingSchema = z.object({
  /** Matches a `DesignBrief` feature `id`. */
  featureId: z.string(),
  /** Matches a `ParamEntry.name` this feature's geometry is driven by. */
  paramName: z.string(),
  dragAxis: DragAxisSchema.optional()
})
export type FeatureBinding = z.infer<typeof FeatureBindingSchema>

export const ScriptManifestSchema = z.object({
  params: z.array(ParamEntrySchema),
  featureBindings: z.array(FeatureBindingSchema)
})
export type ScriptManifest = z.infer<typeof ScriptManifestSchema>

export function emptyScriptManifest(): ScriptManifest {
  return { params: [], featureBindings: [] }
}

export function isScriptManifest(value: unknown): value is ScriptManifest {
  return ScriptManifestSchema.safeParse(value).success
}
