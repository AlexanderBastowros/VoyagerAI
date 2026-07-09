import type { FindingSeverity, VerificationBadge, VerificationFinding, VerificationLayer, VerificationReport } from '../../../shared/ipc'

/** Pure `VerificationReport` helpers for `VerificationPanel.tsx` - kept out of the component so
 *  they're testable without React, mirroring `setupSelectors.ts`/`briefSelectors.ts`. */

export type BadgeTone = 'success' | 'warning' | 'error' | 'default'

export function badgeLabel(badge: VerificationBadge): string {
  switch (badge) {
    case 'pass':
      return 'Pass'
    case 'warning':
      return 'Warnings'
    case 'fail':
      return 'Fail'
    case 'pending':
      return 'Pending'
  }
}

export function badgeTone(badge: VerificationBadge): BadgeTone {
  switch (badge) {
    case 'pass':
      return 'success'
    case 'warning':
      return 'warning'
    case 'fail':
      return 'error'
    case 'pending':
      return 'default'
  }
}

const LAYER_LABELS: Record<VerificationLayer, string> = {
  'static-script': 'Static script',
  geometry: 'Geometry',
  'brief-conformance': 'Brief conformance',
  'render-rig': 'Render rig',
  'vision-critique': 'Vision critique',
  'cross-model-review': 'Cross-model review'
}

export function layerLabel(layer: VerificationLayer): string {
  return LAYER_LABELS[layer]
}

/** Severities in the order they should render within a layer's finding list - most severe first. */
const SEVERITY_ORDER: FindingSeverity[] = ['blocking', 'suggestion', 'info']

export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_ORDER.indexOf(severity)
}

export interface FindingGroup {
  layer: VerificationLayer
  label: string
  findings: VerificationFinding[]
}

/** Groups findings by layer (only layers that actually produced findings appear), each group's
 *  findings sorted most-severe first, groups themselves ordered by their most severe finding. */
export function groupFindingsByLayer(findings: VerificationFinding[]): FindingGroup[] {
  const byLayer = new Map<VerificationLayer, VerificationFinding[]>()
  for (const finding of findings) {
    const bucket = byLayer.get(finding.layer)
    if (bucket) bucket.push(finding)
    else byLayer.set(finding.layer, [finding])
  }

  const groups: FindingGroup[] = Array.from(byLayer.entries()).map(([layer, layerFindings]) => ({
    layer,
    label: layerLabel(layer),
    findings: [...layerFindings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  }))

  groups.sort((a, b) => severityRank(a.findings[0].severity) - severityRank(b.findings[0].severity))
  return groups
}

export function hasAnyContent(report: VerificationReport | null): boolean {
  if (!report) return false
  return report.findings.length > 0 || report.conformance.length > 0
}

/**
 * Guards a `verification:updated` push against a stale-iteration race: a slower verification run
 * (e.g. a heavy layer-3 ray-cast) for an older iteration can resolve after a newer, faster one
 * already pushed its own report - only a push matching what's currently displayed should replace
 * the panel's state, or it would clobber the current report with a stale one.
 */
export function isUpdateForCurrentIteration(update: VerificationReport, currentIteration: number | null): boolean {
  return update.iteration === currentIteration
}
