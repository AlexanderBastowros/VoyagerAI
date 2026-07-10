import { describe, expect, it } from 'vitest'
import { identityPlacement, isPartRecord, isPlacement, MAIN_PART_ID, PlacementSchema } from './parts'

describe('identityPlacement', () => {
  it('produces a schema-valid zero placement', () => {
    const placement = identityPlacement()
    expect(PlacementSchema.safeParse(placement).success).toBe(true)
    expect(placement).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] })
  })
})

describe('isPlacement', () => {
  it('accepts a well-formed placement', () => {
    expect(isPlacement({ position: [10, 0, -5], rotation: [0, 90, 0] })).toBe(true)
  })

  it('rejects wrong-length tuples and non-numbers', () => {
    expect(isPlacement({ position: [0, 0], rotation: [0, 0, 0] })).toBe(false)
    expect(isPlacement({ position: [0, 0, 0], rotation: ['x', 0, 0] })).toBe(false)
    expect(isPlacement(null)).toBe(false)
  })
})

describe('isPartRecord', () => {
  it('accepts a well-formed part', () => {
    expect(
      isPartRecord({
        id: MAIN_PART_ID,
        name: 'Main',
        placement: identityPlacement(),
        visible: true,
        activeIteration: 3
      })
    ).toBe(true)
  })

  it('accepts a part with no active iteration yet', () => {
    expect(
      isPartRecord({ id: 'lid', name: 'Lid', placement: identityPlacement(), visible: false, activeIteration: null })
    ).toBe(true)
  })

  it('rejects a non-integer active iteration and missing fields', () => {
    expect(
      isPartRecord({ id: 'lid', name: 'Lid', placement: identityPlacement(), visible: true, activeIteration: 1.5 })
    ).toBe(false)
    expect(isPartRecord({ id: 'lid', name: 'Lid', visible: true, activeIteration: null })).toBe(false)
    expect(isPartRecord(null)).toBe(false)
  })
})
