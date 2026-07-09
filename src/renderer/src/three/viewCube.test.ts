import { describe, expect, it } from 'vitest'
import { easeInOutCubic, regionFromHitPoint, upForDirection } from './viewCube'

describe('regionFromHitPoint', () => {
  it('quantizes a face-center hit to a single non-zero axis', () => {
    expect(regionFromHitPoint({ x: 0, y: 0, z: 1 })).toEqual([0, 0, 1])
    expect(regionFromHitPoint({ x: 1, y: 0.02, z: -0.01 })).toEqual([1, 0, 0])
  })

  it('quantizes a near-corner hit (all three axes over threshold) to three non-zero axes', () => {
    expect(regionFromHitPoint({ x: 0.9, y: 0.9, z: 0.9 })).toEqual([1, 1, 1])
    expect(regionFromHitPoint({ x: -0.8, y: 0.75, z: -1 })).toEqual([-1, 1, -1])
  })

  it('quantizes a near-edge hit (two axes over threshold) to two non-zero axes', () => {
    expect(regionFromHitPoint({ x: 0.9, y: 0.9, z: 0.1 })).toEqual([1, 1, 0])
    expect(regionFromHitPoint({ x: 0, y: -0.85, z: 0.7 })).toEqual([0, -1, 1])
  })

  it('preserves sign per axis', () => {
    expect(regionFromHitPoint({ x: -1, y: 0, z: 0 })).toEqual([-1, 0, 0])
    expect(regionFromHitPoint({ x: 0, y: -1, z: 0 })).toEqual([0, -1, 0])
    expect(regionFromHitPoint({ x: 0, y: 0, z: -1 })).toEqual([0, 0, -1])
  })

  it('respects a custom threshold', () => {
    // 0.5 is under the default 0.6 threshold but over a relaxed 0.4 one.
    expect(regionFromHitPoint({ x: 0.5, y: 0, z: 1 })).toEqual([0, 0, 1])
    expect(regionFromHitPoint({ x: 0.5, y: 0, z: 1 }, 0.4)).toEqual([1, 0, 1])
  })

  it('guarantees at least one non-zero axis even when every component is under threshold', () => {
    // Nothing here clears the default 0.6 threshold; the dominant (largest-magnitude) axis - z -
    // still snaps so the result isn't the degenerate all-zero region.
    expect(regionFromHitPoint({ x: 0.3, y: 0.2, z: -0.5 })).toEqual([0, 0, -1])
  })

  it('defaults the degenerate origin point to a +1 dominant axis rather than all-zero', () => {
    expect(regionFromHitPoint({ x: 0, y: 0, z: 0 })).toEqual([1, 0, 0])
  })
})

describe('upForDirection', () => {
  it('uses a world-Z up vector for the straight-up direction to avoid the gimbal case', () => {
    expect(upForDirection([0, 1, 0])).toEqual([0, 0, -1])
  })

  it('uses the opposite world-Z up vector for the straight-down direction', () => {
    expect(upForDirection([0, -1, 0])).toEqual([0, 0, 1])
  })

  it('defaults to +Y up for every other face/edge/corner direction', () => {
    expect(upForDirection([1, 0, 0])).toEqual([0, 1, 0])
    expect(upForDirection([-1, 0, 0])).toEqual([0, 1, 0])
    expect(upForDirection([0, 0, 1])).toEqual([0, 1, 0])
    expect(upForDirection([0, 0, -1])).toEqual([0, 1, 0])
    expect(upForDirection([1, 1, 1])).toEqual([0, 1, 0])
    expect(upForDirection([1, 1, 0])).toEqual([0, 1, 0])
  })
})

describe('easeInOutCubic', () => {
  it('maps the endpoints to themselves', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
  })

  it('is symmetric about the midpoint', () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5)
  })

  it('is monotonically increasing across a sample of points', () => {
    const samples = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1]
    const values = samples.map(easeInOutCubic)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
    }
  })

  it('eases in slower and out slower than a linear ramp near the endpoints', () => {
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1)
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9)
  })
})
