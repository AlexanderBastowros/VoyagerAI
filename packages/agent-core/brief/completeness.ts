import type { DesignBrief, Feature } from '@shared/ipc'

export interface BriefCompletenessCheck {
  label: string
  done: boolean
}

export interface BriefCompleteness {
  checks: BriefCompletenessCheck[]
  filled: number
  total: number
  percent: number
}

/** The feature's "where"/"which edges" free-text field - every kind has exactly one such field,
 *  just under a different name (`position` vs. `fillet_chamfer`'s `edges`). */
function featureLocator(feature: Feature): string {
  return feature.kind === 'fillet_chamfer' ? feature.edges : feature.position
}

function featureCheck(feature: Feature, index: number): BriefCompletenessCheck {
  return {
    label: `Feature ${index + 1} (${feature.kind})`,
    done: featureLocator(feature).trim().length > 0
  }
}

/** Required top-level fields per architecture doc §4.4 ("required fields per feature type;
 *  generation unlocks when the brief validates"). Deliberately excludes fields that are always
 *  legitimately optional (constraints beyond `mustFitBed`, exclusions, printer, reference images). */
function requiredChecks(brief: DesignBrief): BriefCompletenessCheck[] {
  return [
    { label: 'Part name', done: brief.part.name.trim().length > 0 },
    { label: 'Part purpose', done: brief.part.purpose.trim().length > 0 },
    { label: 'Envelope X', done: brief.envelope.x.value > 0 },
    { label: 'Envelope Y', done: brief.envelope.y.value > 0 },
    { label: 'Envelope Z', done: brief.envelope.z.value > 0 },
    {
      label: 'Material',
      done: Boolean(brief.materials.requested?.trim()) || brief.materials.onHand.length > 0
    },
    { label: 'Acceptance criteria', done: brief.acceptance.length > 0 }
  ]
}

export function computeBriefCompleteness(brief: DesignBrief): BriefCompleteness {
  const checks = [...requiredChecks(brief), ...brief.features.map(featureCheck)]
  const filled = checks.filter((c) => c.done).length
  const total = checks.length
  return { checks, filled, total, percent: total === 0 ? 100 : Math.round((filled / total) * 100) }
}

export function isBriefComplete(brief: DesignBrief): boolean {
  return computeBriefCompleteness(brief).checks.every((c) => c.done)
}

export function missingBriefFields(brief: DesignBrief): string[] {
  return computeBriefCompleteness(brief)
    .checks.filter((c) => !c.done)
    .map((c) => c.label)
}
