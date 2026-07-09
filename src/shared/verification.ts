/**
 * The Verification Report (architecture doc §5): the trust artifact produced per iteration by
 * `packages/verify`. Layers 1-2 need no brief; layer 3 needs a locked `DesignBrief` (WS-A).
 * Later milestones append layers 4-6 (render rig, vision critique, cross-model review) as
 * additional `VerificationFinding[]` under new `layer` values - the shape here already allows
 * that without a breaking change.
 *
 * This module defines shape + validation only - WS-C owns the real layer 1-3 implementations
 * in `packages/verify` and the `VerificationPanel.tsx` that renders this report.
 */

import { z } from 'zod'

export const VerificationLayerSchema = z.enum([
  'static-script',
  'geometry',
  'brief-conformance',
  'render-rig',
  'vision-critique',
  'cross-model-review'
])
export type VerificationLayer = z.infer<typeof VerificationLayerSchema>

export const FindingSeveritySchema = z.enum(['info', 'suggestion', 'blocking'])
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>

export const VerificationFindingSchema = z.object({
  layer: VerificationLayerSchema,
  severity: FindingSeveritySchema,
  message: z.string(),
  /** Back-reference into the `DesignBrief` field this finding concerns, if any (e.g. `"envelope.x"`). */
  briefField: z.string().optional()
})
export type VerificationFinding = z.infer<typeof VerificationFindingSchema>

/** One row of layer 3's spec/measured/pass conformance table. */
export const ConformanceRowSchema = z.object({
  briefField: z.string(),
  spec: z.string(),
  measured: z.string(),
  pass: z.boolean()
})
export type ConformanceRow = z.infer<typeof ConformanceRowSchema>

export const VerificationBadgeSchema = z.enum(['pass', 'warning', 'fail', 'pending'])
export type VerificationBadge = z.infer<typeof VerificationBadgeSchema>

export const VerificationReportSchema = z.object({
  iteration: z.number().int().min(1),
  badge: VerificationBadgeSchema,
  findings: z.array(VerificationFindingSchema),
  conformance: z.array(ConformanceRowSchema),
  generatedAt: z.string()
})
export type VerificationReport = z.infer<typeof VerificationReportSchema>

export function isVerificationReport(value: unknown): value is VerificationReport {
  return VerificationReportSchema.safeParse(value).success
}
