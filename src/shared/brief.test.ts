import { describe, expect, it } from 'vitest'
import { DesignBriefSchema, emptyDesignBrief, isDesignBrief } from './brief'

describe('emptyDesignBrief', () => {
  it('produces a schema-valid brief', () => {
    expect(DesignBriefSchema.safeParse(emptyDesignBrief()).success).toBe(true)
  })
})

describe('isDesignBrief', () => {
  it('accepts a fully populated brief', () => {
    const brief = {
      version: 2,
      lockedAt: '2026-01-01T00:00:00.000Z',
      part: { name: 'Bracket', purpose: 'Mounts a shelf', referenceImages: [{ path: 'ref.png' }] },
      printer: {
        id: 'p1',
        name: 'Ender 3',
        bedXMm: 220,
        bedYMm: 220,
        bedZMm: 250,
        nozzleDiameterMm: 0.4,
        materials: ['PLA']
      },
      envelope: {
        x: { value: 40, unit: 'mm', provenance: 'user' },
        y: { value: 20, unit: 'mm', provenance: 'user' },
        z: { value: 5, unit: 'mm', provenance: 'inferred' }
      },
      features: [
        { id: 'f1', kind: 'hole', diameter: { value: 5, unit: 'mm', provenance: 'user' }, purpose: 'clearance', position: 'center' }
      ],
      materials: { requested: 'PLA', onHand: ['PLA', 'PETG'] },
      constraints: { mustFitBed: true, allowSplit: false },
      exclusions: ['no sharp edges'],
      acceptance: ['fits the shelf bracket without wobble']
    }
    expect(isDesignBrief(brief)).toBe(true)
  })

  it('rejects a malformed brief', () => {
    expect(isDesignBrief(null)).toBe(false)
    expect(isDesignBrief({})).toBe(false)
    expect(isDesignBrief({ ...emptyDesignBrief(), version: 0 })).toBe(false)
  })

  it('rejects an unknown feature kind', () => {
    const brief = { ...emptyDesignBrief(), features: [{ id: 'f1', kind: 'gadget' }] }
    expect(isDesignBrief(brief)).toBe(false)
  })
})
