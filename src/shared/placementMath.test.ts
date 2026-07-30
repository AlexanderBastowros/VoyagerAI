import { describe, expect, it } from 'vitest'
import { applyMat3, restingYFromVertices, rotationMatrixXYZDeg, type Vec3 } from './placementMath'

/**
 * A bicone ("spindle") inscribed in the 30 mm cube: a regular octagon of radius 15 in the plane
 * `x = 15` centred on `(15, 15)` in y/z, plus an apex at each end of X. Its AABB is exactly the
 * 30 mm cube, and it shares the 30 mm sphere's great circle in the YZ plane - so at `[45, 0, 0]` its
 * lowest point is the sphere's, at a resting height of exactly 15.000 (the octagon has a vertex at
 * theta = 135 degrees, which is precisely the extremal direction for that rotation), while the 8 AABB
 * corners give 21.213. That is the worked example the whole vertex-accurate resting-Y fix is about.
 *
 * DUPLICATED DELIBERATELY (a test fixture, not production code) in
 * `src/renderer/src/three/placement.test.ts` and `packages/agent-core/src/projects/plateStl.test.ts`
 * so all three suites pin the same number from the same geometry.
 */
function biconeVertices(): number[] {
  const out: number[] = []
  for (let k = 0; k < 8; k++) {
    const theta = (k * Math.PI) / 4
    out.push(15, 15 + 15 * Math.cos(theta), 15 + 15 * Math.sin(theta))
  }
  out.push(0, 15, 15)
  out.push(30, 15, 15)
  return out
}

describe('rotationMatrixXYZDeg', () => {
  it('is the identity for a zero rotation', () => {
    // Element-wise: the formula produces a signed zero for the off-diagonal terms, which `toEqual`
    // distinguishes from 0 and no consumer does.
    rotationMatrixXYZDeg([0, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i]))
  })

  it('maps (x,y,z) -> (x,-z,y) for +90 degrees about X', () => {
    const m = rotationMatrixXYZDeg([90, 0, 0])
    const r = applyMat3(m, [1, 2, 3])
    expect(r[0]).toBeCloseTo(1)
    expect(r[1]).toBeCloseTo(-3)
    expect(r[2]).toBeCloseTo(2)
  })

  it('maps (x,y,z) -> (x,z,-y) for -90 degrees about X (the print-orientation preview rotation)', () => {
    const r = applyMat3(rotationMatrixXYZDeg([-90, 0, 0]), [1, 2, 3])
    expect(r[0]).toBeCloseTo(1)
    expect(r[1]).toBeCloseTo(3)
    expect(r[2]).toBeCloseTo(-2)
  })
})

describe('restingYFromVertices', () => {
  it('is zero for an already-resting unrotated part', () => {
    // Min-corner-origined vertices: the lowest local y is 0, so no lift is needed.
    expect(restingYFromVertices([0, 0, 0, 10, 6, 4, 5, 3, 2], [0, 0, 0])).toBeCloseTo(0)
  })

  it('lifts a part by its deepest rotated vertex', () => {
    // +90 about X maps local +z to world -y, so the vertex at z=4 lands at y=-4 and needs a 4 mm lift.
    expect(restingYFromVertices([0, 0, 0, 10, 6, 4], [90, 0, 0])).toBeCloseTo(4)
  })

  it('uses the real vertices, not their bounding box: the 45-degree worked example rests at 15.000', () => {
    // The AABB-corner formula this replaced returned 30 * sin(45) = 21.213 here - a 6.213 mm phantom
    // gap under the part. See `biconeVertices`.
    expect(restingYFromVertices(biconeVertices(), [45, 0, 0])).toBeCloseTo(15, 6)
  })

  it('agrees with the bounding box exactly when the rotation IS a multiple of 90 degrees', () => {
    // The over-estimate is zero for axis-aligned rotations (corners map to corners), which is why the
    // old formula survived so long - and why the print-orientation preview's [-90,0,0] is unaffected.
    const axisAligned: Vec3[] = [[0, 0, 0], [90, 0, 0], [180, 0, 0], [-90, 0, 0], [0, 90, 0]]
    for (const rotation of axisAligned) {
      const fromVertices = restingYFromVertices(biconeVertices(), rotation)
      const fromCorners = restingYFromVertices(cubeCorners(30), rotation)
      expect(fromVertices).toBeCloseTo(fromCorners, 6)
    }
  })

  it('falls back to the plate rather than NaN for an empty or all-NaN vertex list', () => {
    expect(restingYFromVertices([], [45, 0, 0])).toBe(0)
    expect(restingYFromVertices([NaN, NaN, NaN], [45, 0, 0])).toBe(0)
  })

  it('ignores a trailing partial triple instead of reading undefined', () => {
    const complete = restingYFromVertices([0, 0, 0, 10, 6, 4], [90, 0, 0])
    expect(restingYFromVertices([0, 0, 0, 10, 6, 4, 99, 99], [90, 0, 0])).toBeCloseTo(complete)
  })
})

/** The 8 corners of the origin-aligned `size` cube, flattened - i.e. what the replaced
 *  AABB-of-the-rotated-AABB formula effectively looked at. */
function cubeCorners(size: number): number[] {
  const out: number[] = []
  for (const x of [0, size]) {
    for (const y of [0, size]) {
      for (const z of [0, size]) out.push(x, y, z)
    }
  }
  return out
}
