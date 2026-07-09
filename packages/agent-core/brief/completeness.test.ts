import { describe, expect, it } from 'vitest'
import { computeBriefCompleteness, isBriefComplete, missingBriefFields } from './completeness'
import { emptyDesignBrief } from '@shared/ipc'
import type { DesignBrief, Feature } from '@shared/ipc'

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

describe('computeBriefCompleteness', () => {
  it('reports 0% for a brand-new empty brief', () => {
    const result = computeBriefCompleteness(emptyDesignBrief())
    expect(result.filled).toBe(0)
    expect(result.percent).toBe(0)
  })

  it('reports 100% once every required field is set and there are no features', () => {
    const result = computeBriefCompleteness(filledBrief())
    expect(result.percent).toBe(100)
    expect(result.checks.every((c) => c.done)).toBe(true)
  })

  it('treats a requested material or on-hand materials as equally satisfying the check', () => {
    const brief = filledBrief()
    const withOnHandOnly: DesignBrief = { ...brief, materials: { onHand: ['PETG scraps'] } }
    expect(computeBriefCompleteness(withOnHandOnly).percent).toBe(100)
  })

  it('adds one check per feature, keyed off position (or edges for fillet/chamfer)', () => {
    const hole: Feature = {
      kind: 'hole',
      id: 'f1',
      diameter: { value: 3.4, unit: 'mm', provenance: 'inferred' },
      purpose: 'clearance',
      position: 'center of the top face'
    }
    const unlocatedChamfer: Feature = {
      kind: 'fillet_chamfer',
      id: 'f2',
      style: 'chamfer',
      size: { value: 0.5, unit: 'mm', provenance: 'inferred' },
      edges: ''
    }
    const brief: DesignBrief = { ...filledBrief(), features: [hole, unlocatedChamfer] }
    const result = computeBriefCompleteness(brief)

    expect(result.total).toBe(9) // 7 required + 2 features
    expect(result.checks.find((c) => c.label.includes('hole'))?.done).toBe(true)
    expect(result.checks.find((c) => c.label.includes('fillet_chamfer'))?.done).toBe(false)
    expect(isBriefComplete(brief)).toBe(false)
    expect(missingBriefFields(brief)).toEqual(['Feature 2 (fillet_chamfer)'])
  })
})

describe('isBriefComplete / missingBriefFields', () => {
  it('lists every unmet required field by label', () => {
    expect(missingBriefFields(emptyDesignBrief())).toEqual([
      'Part name',
      'Part purpose',
      'Envelope X',
      'Envelope Y',
      'Envelope Z',
      'Material',
      'Acceptance criteria'
    ])
    expect(isBriefComplete(emptyDesignBrief())).toBe(false)
  })
})
