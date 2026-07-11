import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { applyPlacement, eulerToRotationDeg, groundClamp, groundSnap, groundSnappedY, placementEuler, readPlacement } from './placement'

const box = { min: new THREE.Vector3(0, 0, 0), max: new THREE.Vector3(10, 6, 4) }

describe('placementEuler / eulerToRotationDeg', () => {
  it('round-trips degrees through a three.js Euler', () => {
    const euler = placementEuler([0, 90, 0])
    expect(euler.y).toBeCloseTo(Math.PI / 2)
    expect(eulerToRotationDeg(euler).map((d) => Math.round(d))).toEqual([0, 90, 0])
  })
})

describe('groundSnappedY', () => {
  it('is zero for an unrotated origin-aligned part (already resting on the plate)', () => {
    expect(groundSnappedY(box.min, box.max, [0, 0, 0])).toBeCloseTo(0)
  })

  it('lifts a part rotated about Y by nothing (footprint still on the plate)', () => {
    // Rotating about Y (the up axis) never dips the part below the plate.
    expect(groundSnappedY(box.min, box.max, [0, 45, 0])).toBeCloseTo(0)
  })

  it('rests a part flipped 90° about X so its lowest rotated corner touches y=0', () => {
    // +90° about X maps local +z (extent 0..4) to world -y, so the part would dip to y = -4;
    // ground-snap lifts it by 4 so it rests on the plate.
    expect(groundSnappedY(box.min, box.max, [90, 0, 0])).toBeCloseTo(4)
  })

  it('rests a part flipped 180° about X (its top, local y=6, becomes the bottom)', () => {
    expect(groundSnappedY(box.min, box.max, [180, 0, 0])).toBeCloseTo(6)
  })
})

describe('groundSnap', () => {
  it('keeps x/z + rotation and derives a resting y', () => {
    const snapped = groundSnap({ position: [12, 99, -5], rotation: [90, 0, 0] }, box.min, box.max)
    expect(snapped.position[0]).toBe(12)
    expect(snapped.position[2]).toBe(-5)
    expect(snapped.position[1]).toBeCloseTo(4)
    expect(snapped.rotation).toEqual([90, 0, 0])
  })
})

describe('groundClamp', () => {
  it('raises a part that would sink below the plate to its resting height', () => {
    const clamped = groundClamp({ position: [12, 0, -5], rotation: [90, 0, 0] }, box.min, box.max)
    expect(clamped.position).toEqual([12, 4, -5])
    expect(clamped.rotation).toEqual([90, 0, 0])
  })

  it('preserves a deliberate vertical lift above the resting height', () => {
    const lifted = { position: [12, 30, -5] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] }
    expect(groundClamp(lifted, box.min, box.max)).toBe(lifted)
  })

  it('leaves a part exactly at its resting height untouched', () => {
    const resting = { position: [0, 4, 0] as [number, number, number], rotation: [90, 0, 0] as [number, number, number] }
    expect(groundClamp(resting, box.min, box.max)).toBe(resting)
  })
})

describe('applyPlacement / readPlacement', () => {
  it('round-trips a placement through a three.js object', () => {
    const obj = new THREE.Object3D()
    const placement = { position: [10, 0, -5] as [number, number, number], rotation: [0, 90, 0] as [number, number, number] }
    applyPlacement(obj, placement)
    expect(obj.position.toArray()).toEqual([10, 0, -5])
    const read = readPlacement(obj)
    expect(read.position).toEqual([10, 0, -5])
    expect(read.rotation[1]).toBeCloseTo(90)
  })
})
