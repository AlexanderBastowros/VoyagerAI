import { describe, expect, it } from 'vitest'
import {
  briefFromForm,
  computeBriefCompleteness,
  confirmEnvelopeDim,
  csvFromList,
  featureSummary,
  formFromBrief,
  hasInferredEnvelopeDims,
  isBriefComplete,
  linesFromList,
  parseCsv,
  parseLines,
  withEnvelopeDim
} from './briefSelectors'
import { emptyDesignBrief } from '../../../shared/ipc'
import type { DesignBrief, Feature } from '../../../shared/ipc'

function filledBrief(): DesignBrief {
  const brief = emptyDesignBrief()
  return {
    ...brief,
    part: { ...brief.part, name: 'Bracket', purpose: 'Mounts a sensor' },
    envelope: {
      x: { value: 40, unit: 'mm', provenance: 'user' },
      y: { value: 30, unit: 'mm', provenance: 'user' },
      z: { value: 10, unit: 'mm', provenance: 'user' }
    },
    materials: { requested: 'PLA', onHand: [] },
    acceptance: ['Fits the sensor without wobble']
  }
}

describe('computeBriefCompleteness / isBriefComplete', () => {
  it('is 0% and incomplete for a brand-new brief', () => {
    const result = computeBriefCompleteness(emptyDesignBrief())
    expect(result.percent).toBe(0)
    expect(isBriefComplete(emptyDesignBrief())).toBe(false)
  })

  it('is 100% and complete once every required field is filled', () => {
    const brief = filledBrief()
    expect(computeBriefCompleteness(brief).percent).toBe(100)
    expect(isBriefComplete(brief)).toBe(true)
  })

  it('adds one check per feature', () => {
    const hole: Feature = {
      kind: 'hole',
      id: 'f1',
      diameter: { value: 3.4, unit: 'mm', provenance: 'inferred' },
      purpose: 'clearance',
      position: ''
    }
    const brief: DesignBrief = { ...filledBrief(), features: [hole] }
    expect(isBriefComplete(brief)).toBe(false)
    expect(computeBriefCompleteness(brief).checks.at(-1)).toEqual({ label: 'Feature 1 (hole)', done: false })
  })
})

describe('parseLines / linesFromList', () => {
  it('round-trips a list of lines, dropping blanks', () => {
    const text = 'First rule\n\n  Second rule  \n'
    expect(parseLines(text)).toEqual(['First rule', 'Second rule'])
    expect(linesFromList(['First rule', 'Second rule'])).toBe('First rule\nSecond rule')
  })
})

describe('parseCsv / csvFromList', () => {
  it('round-trips a comma-separated list, trimming and dropping blanks', () => {
    expect(parseCsv('PLA scraps,  PETG , ,')).toEqual(['PLA scraps', 'PETG'])
    expect(csvFromList(['PLA scraps', 'PETG'])).toBe('PLA scraps, PETG')
  })
})

describe('withEnvelopeDim / confirmEnvelopeDim', () => {
  it('sets the value and marks it user-confirmed', () => {
    const brief = emptyDesignBrief()
    const next = withEnvelopeDim(brief, 'x', 42)
    expect(next.envelope.x).toEqual({ value: 42, unit: 'mm', provenance: 'user' })
    // Other axes and the original brief are untouched.
    expect(next.envelope.y).toBe(brief.envelope.y)
    expect(brief.envelope.x.provenance).toBe('inferred')
  })

  it('confirms provenance without changing the value', () => {
    const brief: DesignBrief = {
      ...emptyDesignBrief(),
      envelope: {
        x: { value: 40, unit: 'mm', provenance: 'inferred' },
        y: { value: 0, unit: 'mm', provenance: 'inferred' },
        z: { value: 0, unit: 'mm', provenance: 'inferred' }
      }
    }
    const next = confirmEnvelopeDim(brief, 'x')
    expect(next.envelope.x).toEqual({ value: 40, unit: 'mm', provenance: 'user' })
  })
})

describe('hasInferredEnvelopeDims', () => {
  it('is true when any axis is still inferred', () => {
    expect(hasInferredEnvelopeDims(emptyDesignBrief())).toBe(true)
    expect(hasInferredEnvelopeDims(filledBrief())).toBe(false)
  })
})

describe('formFromBrief / briefFromForm', () => {
  it('round-trips a filled brief through the form unchanged', () => {
    const brief = filledBrief()
    const form = formFromBrief(brief)
    expect(form).toMatchObject({
      partName: 'Bracket',
      partPurpose: 'Mounts a sensor',
      envelopeX: '40',
      envelopeY: '30',
      envelopeZ: '10',
      materialsRequested: 'PLA',
      materialsOnHand: '',
      acceptance: 'Fits the sensor without wobble'
    })

    const rebuilt = briefFromForm(brief, form)
    expect(rebuilt.part).toEqual(brief.part)
    expect(rebuilt.envelope.x).toEqual({ value: 40, unit: 'mm', provenance: 'user' })
    expect(rebuilt.materials).toEqual({ requested: 'PLA', onHand: [] })
    expect(rebuilt.acceptance).toEqual(['Fits the sensor without wobble'])
  })

  it('marks every envelope dim user-confirmed on save, even if the value did not change', () => {
    const brief: DesignBrief = {
      ...filledBrief(),
      envelope: {
        x: { value: 40, unit: 'mm', provenance: 'inferred' },
        y: { value: 30, unit: 'mm', provenance: 'inferred' },
        z: { value: 10, unit: 'mm', provenance: 'inferred' }
      }
    }
    const rebuilt = briefFromForm(brief, formFromBrief(brief))
    expect(rebuilt.envelope.x.provenance).toBe('user')
    expect(rebuilt.envelope.y.provenance).toBe('user')
    expect(rebuilt.envelope.z.provenance).toBe('user')
  })

  it('carries features, printer, and reference images forward untouched', () => {
    const hole: Feature = {
      kind: 'hole',
      id: 'f1',
      diameter: { value: 3.4, unit: 'mm', provenance: 'inferred' },
      purpose: 'clearance',
      position: 'top-left'
    }
    const brief: DesignBrief = { ...filledBrief(), features: [hole] }
    const rebuilt = briefFromForm(brief, formFromBrief(brief))
    expect(rebuilt.features).toEqual([hole])
  })

  it('clears maxPieces when allowSplit is unchecked, and omits an empty requested material', () => {
    const brief = filledBrief()
    const form = formFromBrief(brief)
    const rebuilt = briefFromForm(brief, { ...form, allowSplit: false, maxPieces: '3', materialsRequested: '  ' })
    expect(rebuilt.constraints.maxPieces).toBeUndefined()
    expect(rebuilt.materials.requested).toBeUndefined()
  })

  it('parses materialsOnHand and exclusions/acceptance back into arrays', () => {
    const brief = filledBrief()
    const form = { ...formFromBrief(brief), materialsOnHand: 'PLA scraps, PETG', exclusions: 'No sharp edges' }
    const rebuilt = briefFromForm(brief, form)
    expect(rebuilt.materials.onHand).toEqual(['PLA scraps', 'PETG'])
    expect(rebuilt.exclusions).toEqual(['No sharp edges'])
  })
})

describe('featureSummary', () => {
  it('describes every feature kind in one line', () => {
    const hole: Feature = {
      kind: 'hole',
      id: 'f1',
      diameter: { value: 3.4, unit: 'mm', provenance: 'inferred' },
      purpose: 'clearance',
      position: 'top-left corner'
    }
    expect(featureSummary(hole)).toBe('Hole, Ø3.4mm (clearance) - top-left corner')

    const chamfer: Feature = {
      kind: 'fillet_chamfer',
      id: 'f2',
      style: 'chamfer',
      size: { value: 0.5, unit: 'mm', provenance: 'inferred' },
      edges: 'bottom outer edges'
    }
    expect(featureSummary(chamfer)).toBe('Chamfer, 0.5mm - bottom outer edges')

    const text: Feature = { kind: 'text', id: 'f3', content: 'HELLO', depthMm: 0.4, position: 'top face' }
    expect(featureSummary(text)).toBe('Text "HELLO", 0.4mm deep - top face')
  })
})
