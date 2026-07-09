import { describe, expect, it } from 'vitest'
import { mergeAgentPatch } from './agentPatch'
import { emptyDesignBrief } from '@shared/ipc'

describe('mergeAgentPatch', () => {
  it('sets scalar fields and wraps envelope dims as inferred', () => {
    const next = mergeAgentPatch(emptyDesignBrief(), {
      part_name: 'Bracket',
      part_purpose: 'Mounts a sensor',
      envelope_x_mm: 40,
      envelope_y_mm: 30,
      envelope_z_mm: 10
    })

    expect(next.part.name).toBe('Bracket')
    expect(next.part.purpose).toBe('Mounts a sensor')
    expect(next.envelope.x).toEqual({ value: 40, unit: 'mm', tolerance: undefined, provenance: 'inferred' })
    expect(next.envelope.y.provenance).toBe('inferred')
  })

  it('overwrites provenance to inferred even if the field was previously user-confirmed', () => {
    const base = emptyDesignBrief()
    base.envelope.x = { value: 40, unit: 'mm', provenance: 'user' }
    const next = mergeAgentPatch(base, { envelope_x_mm: 45 })
    expect(next.envelope.x).toEqual({ value: 45, unit: 'mm', tolerance: undefined, provenance: 'inferred' })
  })

  it('leaves fields untouched when absent from the patch', () => {
    const base = { ...emptyDesignBrief(), part: { name: 'Existing', purpose: 'Existing purpose', referenceImages: [] } }
    const next = mergeAgentPatch(base, { part_purpose: 'Updated purpose' })
    expect(next.part.name).toBe('Existing')
    expect(next.part.purpose).toBe('Updated purpose')
  })

  it('replaces materials, exclusions, and acceptance arrays wholesale', () => {
    const next = mergeAgentPatch(emptyDesignBrief(), {
      materials_on_hand: ['PLA scraps'],
      exclusions: ['No sharp edges'],
      acceptance: ['Snaps onto the rail without tools']
    })
    expect(next.materials.onHand).toEqual(['PLA scraps'])
    expect(next.exclusions).toEqual(['No sharp edges'])
    expect(next.acceptance).toEqual(['Snaps onto the rail without tools'])
  })

  it('appends a new feature and upserts an existing one by id', () => {
    const withHole = mergeAgentPatch(emptyDesignBrief(), {
      features: [{ kind: 'hole', id: 'f1', diameter_mm: 3.4, purpose: 'clearance', position: 'top-left corner' }]
    })
    expect(withHole.features).toHaveLength(1)
    expect(withHole.features[0]).toMatchObject({ kind: 'hole', id: 'f1', position: 'top-left corner' })
    expect(withHole.features[0]).toMatchObject({ diameter: { value: 3.4, provenance: 'inferred' } })

    const revised = mergeAgentPatch(withHole, {
      features: [{ kind: 'hole', id: 'f1', diameter_mm: 3.6, purpose: 'tapped', position: 'top-left corner, 5mm in' }]
    })
    expect(revised.features).toHaveLength(1) // same id replaces, does not duplicate
    expect(revised.features[0]).toMatchObject({ purpose: 'tapped', position: 'top-left corner, 5mm in' })
  })

  it('converts every feature kind to its domain shape', () => {
    const next = mergeAgentPatch(emptyDesignBrief(), {
      features: [
        { kind: 'pocket', id: 'p1', width_mm: 10, depth_mm: 2, position: 'center' },
        { kind: 'boss', id: 'b1', diameter_mm: 6, height_mm: 4, position: 'back face' },
        { kind: 'fillet_chamfer', id: 'c1', style: 'chamfer', size_mm: 0.5, edges: 'bottom outer edges' },
        { kind: 'text', id: 't1', content: 'HELLO', depth_mm: 0.4, position: 'top face' },
        { kind: 'insert', id: 'i1', insert_type: 'heat-set', size: 'M3', position: 'each corner boss' }
      ]
    })

    expect(next.features).toHaveLength(5)
    expect(next.features.find((f) => f.id === 'p1')).toMatchObject({ kind: 'pocket', width: { value: 10 }, depth: { value: 2 } })
    expect(next.features.find((f) => f.id === 'b1')).toMatchObject({ kind: 'boss', diameter: { value: 6 }, height: { value: 4 } })
    expect(next.features.find((f) => f.id === 'c1')).toMatchObject({ kind: 'fillet_chamfer', style: 'chamfer', size: { value: 0.5 } })
    expect(next.features.find((f) => f.id === 't1')).toMatchObject({ kind: 'text', content: 'HELLO', depthMm: 0.4 })
    expect(next.features.find((f) => f.id === 'i1')).toMatchObject({ kind: 'insert', insertType: 'heat-set', size: 'M3' })
  })

  it('does not mutate the base brief', () => {
    const base = emptyDesignBrief()
    const baseSnapshot = JSON.parse(JSON.stringify(base))
    mergeAgentPatch(base, { part_name: 'Bracket', features: [{ kind: 'hole', id: 'f1', diameter_mm: 3, purpose: 'clearance', position: 'x' }] })
    expect(base).toEqual(baseSnapshot)
  })
})
