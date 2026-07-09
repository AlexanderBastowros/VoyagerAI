import type { Dim, DesignBrief, Feature, Orientation } from '../../../shared/ipc'

/**
 * Pure Design Brief helpers for `BriefPanel.tsx` - kept out of the component so they're testable
 * without React, mirroring `setupSelectors.ts`. Deliberately duplicates (rather than imports) the
 * completeness logic in `packages/agent-core/brief/completeness.ts`: the renderer never imports
 * from `@voyager/agent-core` (a Node-only package with `fs` access elsewhere in its module graph),
 * it only ever reaches main-process state through the `window.voyager` IPC bridge.
 */

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

function featureLocator(feature: Feature): string {
  return feature.kind === 'fillet_chamfer' ? feature.edges : feature.position
}

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
  const checks = [
    ...requiredChecks(brief),
    ...brief.features.map((feature, index) => ({
      label: `Feature ${index + 1} (${feature.kind})`,
      done: featureLocator(feature).trim().length > 0
    }))
  ]
  const filled = checks.filter((c) => c.done).length
  const total = checks.length
  return { checks, filled, total, percent: total === 0 ? 100 : Math.round((filled / total) * 100) }
}

export function isBriefComplete(brief: DesignBrief): boolean {
  return computeBriefCompleteness(brief).checks.every((c) => c.done)
}

/** Splits free text into one trimmed, non-empty entry per line - the brief panel's textarea
 *  format for exclusions/acceptance. */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function linesFromList(items: string[]): string {
  return items.join('\n')
}

/** Splits comma-separated free text into trimmed, non-empty entries - the brief panel's compact
 *  input format for the materials-on-hand list. */
export function parseCsv(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function csvFromList(items: string[]): string {
  return items.join(', ')
}

/** Sets one envelope dimension's numeric value, marking it as user-confirmed - the brief panel's
 *  direct-edit path (as opposed to `update_brief`'s agent-authored, always-inferred path). */
export function withEnvelopeDim(brief: DesignBrief, axis: 'x' | 'y' | 'z', value: number): DesignBrief {
  return {
    ...brief,
    envelope: { ...brief.envelope, [axis]: { ...brief.envelope[axis], value, provenance: 'user' } }
  }
}

/** Marks an already-set envelope dimension as user-confirmed without changing its value - the
 *  brief panel's "confirm" affordance for an AI-suggested (inferred) dimension. */
export function confirmEnvelopeDim(brief: DesignBrief, axis: 'x' | 'y' | 'z'): DesignBrief {
  return {
    ...brief,
    envelope: { ...brief.envelope, [axis]: { ...brief.envelope[axis], provenance: 'user' } }
  }
}

export function hasInferredEnvelopeDims(brief: DesignBrief): boolean {
  const dims: Dim[] = [brief.envelope.x, brief.envelope.y, brief.envelope.z]
  return dims.some((dim) => dim.provenance === 'inferred')
}

/**
 * The brief panel's editable text-buffer state - one plain string/boolean per form control, so
 * typing doesn't fight with array<->text round-tripping on every keystroke (see `formFromBrief`'s
 * doc comment). Fields the panel doesn't expose for direct editing (features, printer, reference
 * images, version/lockedAt) live only on the `DesignBrief` the form was built from - `briefFromForm`
 * carries them forward unchanged.
 */
export interface BriefForm {
  partName: string
  partPurpose: string
  envelopeX: string
  envelopeY: string
  envelopeZ: string
  materialsRequested: string
  materialsOnHand: string
  mustFitBed: boolean
  allowSplit: boolean
  maxPieces: string
  printOrientation: 'agent-decides' | Orientation | ''
  loadBearing: boolean
  exclusions: string
  acceptance: string
}

/** Builds the form's editable-text buffer from a brief. Called once whenever the panel (re)syncs
 *  to a freshly-fetched or freshly-pushed brief - not on every keystroke - so typing a trailing
 *  comma/newline never gets silently collapsed mid-edit by an array round-trip. */
export function formFromBrief(brief: DesignBrief): BriefForm {
  return {
    partName: brief.part.name,
    partPurpose: brief.part.purpose,
    envelopeX: brief.envelope.x.value ? String(brief.envelope.x.value) : '',
    envelopeY: brief.envelope.y.value ? String(brief.envelope.y.value) : '',
    envelopeZ: brief.envelope.z.value ? String(brief.envelope.z.value) : '',
    materialsRequested: brief.materials.requested ?? '',
    materialsOnHand: csvFromList(brief.materials.onHand),
    mustFitBed: brief.constraints.mustFitBed,
    allowSplit: brief.constraints.allowSplit,
    maxPieces: brief.constraints.maxPieces !== undefined ? String(brief.constraints.maxPieces) : '',
    printOrientation: brief.constraints.printOrientation ?? '',
    loadBearing: brief.constraints.loadBearing ?? false,
    exclusions: linesFromList(brief.exclusions),
    acceptance: linesFromList(brief.acceptance)
  }
}

/**
 * Applies the form's buffered edits onto `base` (the brief the form was last synced from),
 * producing a full `DesignBrief` ready for `window.voyager.brief.update()`. Every envelope
 * dimension is stamped `provenance: 'user'` unconditionally - saving from the panel is itself the
 * user's confirmation of whatever is currently on screen, so there's no separate per-field
 * "confirm" step to complete a save (see `confirmEnvelopeDim` for the standalone affordance this
 * still leaves available before a save, e.g. a "confirm without editing" click). Non-editable
 * fields (features, printer, reference images, version, lockedAt) pass through from `base`
 * untouched - `BriefStore` on the main-process side decides version/lockedAt from server state
 * regardless of what's sent, so carrying them forward here is just for a consistent local object.
 */
export function briefFromForm(base: DesignBrief, form: BriefForm): DesignBrief {
  const toNumber = (text: string): number => {
    const n = Number(text)
    return Number.isFinite(n) ? n : 0
  }
  const toDim = (base: Dim, text: string): Dim => ({ ...base, value: toNumber(text), provenance: 'user' })

  return {
    ...base,
    part: { ...base.part, name: form.partName, purpose: form.partPurpose },
    envelope: {
      x: toDim(base.envelope.x, form.envelopeX),
      y: toDim(base.envelope.y, form.envelopeY),
      z: toDim(base.envelope.z, form.envelopeZ)
    },
    materials: {
      requested: form.materialsRequested.trim() ? form.materialsRequested.trim() : undefined,
      onHand: parseCsv(form.materialsOnHand)
    },
    constraints: {
      mustFitBed: form.mustFitBed,
      allowSplit: form.allowSplit,
      maxPieces: form.allowSplit && form.maxPieces.trim() ? toNumber(form.maxPieces) : undefined,
      printOrientation: form.printOrientation || undefined,
      loadBearing: form.loadBearing
    },
    exclusions: parseLines(form.exclusions),
    acceptance: parseLines(form.acceptance)
  }
}

/** One-line, read-only description of a feature for the panel's feature list - features are
 *  agent-authored (via `update_brief`) and shown for review, not directly edited field-by-field. */
export function featureSummary(feature: Feature): string {
  switch (feature.kind) {
    case 'hole':
      return `Hole, Ø${feature.diameter.value}mm (${feature.purpose}) - ${feature.position}`
    case 'pocket':
      return `Pocket, ${feature.width.value}×${feature.depth.value}mm - ${feature.position}`
    case 'boss':
      return `Boss, Ø${feature.diameter.value}×${feature.height.value}mm - ${feature.position}`
    case 'fillet_chamfer':
      return `${feature.style === 'fillet' ? 'Fillet' : 'Chamfer'}, ${feature.size.value}mm - ${feature.edges}`
    case 'text':
      return `Text "${feature.content}", ${feature.depthMm}mm deep - ${feature.position}`
    case 'insert':
      return `${feature.insertType} insert, ${feature.size} - ${feature.position}`
  }
}
