import { describe, expect, it } from 'vitest'
import {
  bakePartTriangles,
  buildPlateStl,
  parseBinaryStl,
  writeBinaryStl,
  type StlTriangle,
  type Vec3
} from './plateStl'

function triangle(normal: Vec3, v1: Vec3, v2: Vec3, v3: Vec3): StlTriangle {
  return { normal, vertices: [v1, v2, v3] }
}

function expectVec3Close(actual: Vec3, expected: Vec3, precision = 4): void {
  expect(actual[0]).toBeCloseTo(expected[0], precision)
  expect(actual[1]).toBeCloseTo(expected[1], precision)
  expect(actual[2]).toBeCloseTo(expected[2], precision)
}

/**
 * A bicone ("spindle") inscribed in the 30 mm cube - the first NON-BOX fixture in this suite, and the
 * worked example for vertex-accurate resting height. A regular octagon of radius 15 in the plane
 * `x = 15` centred on `(15, 15)` in y/z, closed with an apex at each end of X (triangle 0's first
 * vertex is the low-X apex). Its AABB is exactly the 30 mm cube, and it shares the 30 mm sphere's
 * great circle in the YZ plane, so at `[45, 0, 0]`:
 *
 * - resting height from the real vertices: **15.000** - the part sits flush on the plate;
 * - resting height from the 8 rotated AABB corners (what this module used to compute):
 *   30 * sin(45) = **21.213**, which floated the part 6.213 mm above the bed in the exported plate.
 *
 * MUST STAY IN LOCKSTEP with the identical fixture in `src/renderer/src/three/placement.test.ts` (and
 * `src/shared/placementMath.test.ts`): the exported plate is defined as "what the viewport shows,
 * baked", so all three suites pinning the same number from the same geometry is what stops the
 * viewport and this exporter drifting apart. Duplicated rather than shared because it is a test
 * fixture and the two suites live in different packages.
 */
function biconeTriangles(): StlTriangle[] {
  const ring: Vec3[] = []
  for (let k = 0; k < 8; k++) {
    const theta = (k * Math.PI) / 4
    ring.push([15, 15 + 15 * Math.cos(theta), 15 + 15 * Math.sin(theta)])
  }
  const apexLow: Vec3 = [0, 15, 15]
  const apexHigh: Vec3 = [30, 15, 15]
  const tris: StlTriangle[] = []
  for (let k = 0; k < 8; k++) {
    const a = ring[k]
    const b = ring[(k + 1) % 8]
    // Normals are irrelevant to resting height (and are only rotated, never translated) - the shape
    // is here for its vertex set.
    tris.push(triangle([0, 1, 0], apexLow, a, b))
    tris.push(triangle([0, 1, 0], apexHigh, b, a))
  }
  return tris
}

function bakedYs(triangles: StlTriangle[]): number[] {
  return triangles.flatMap((tri) => tri.vertices.map((v) => v[1]))
}

describe('parseBinaryStl / writeBinaryStl', () => {
  it('round-trips a single triangle', () => {
    const tris = [triangle([0, 0, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0])]
    const buf = writeBinaryStl(tris)
    // 80-byte header + 4-byte count + 50 bytes for one triangle.
    expect(buf.length).toBe(80 + 4 + 50)
    const parsed = parseBinaryStl(buf)
    expect(parsed).toHaveLength(1)
    expectVec3Close(parsed[0].normal, [0, 0, 1])
    expectVec3Close(parsed[0].vertices[0], [0, 0, 0])
    expectVec3Close(parsed[0].vertices[1], [1, 0, 0])
    expectVec3Close(parsed[0].vertices[2], [0, 1, 0])
  })

  it('round-trips multiple triangles and an empty triangle list', () => {
    const tris = [
      triangle([1, 0, 0], [0, 0, 0], [0, 1, 0], [0, 0, 1]),
      triangle([0, 1, 0], [2, 2, 2], [3, 2, 2], [2, 3, 2])
    ]
    const parsed = parseBinaryStl(writeBinaryStl(tris))
    expect(parsed).toHaveLength(2)
    expectVec3Close(parsed[1].vertices[1], [3, 2, 2])

    expect(parseBinaryStl(writeBinaryStl([]))).toHaveLength(0)
  })

  it('rejects a buffer too small to be a binary STL', () => {
    expect(() => parseBinaryStl(new Uint8Array(10))).toThrow(/not a valid binary STL/)
  })

  it('rejects a header whose declared triangle count exceeds the buffer size', () => {
    const buf = Buffer.alloc(84)
    buf.writeUInt32LE(5, 80) // claims 5 triangles but supplies zero bytes of triangle data
    expect(() => parseBinaryStl(buf)).toThrow(/malformed binary STL/)
  })
})

describe('bakePartTriangles', () => {
  it('origin-aligns to the min corner, then translates by an identity-rotation placement', () => {
    // Min corner is (2, 3, 4); origin-aligned local vertices become (0,0,0), (1,0,0), (0,1,0).
    const tris = [triangle([0, 0, 1], [2, 3, 4], [3, 3, 4], [2, 4, 4])]
    const baked = bakePartTriangles(tris, { position: [10, 0, 5], rotation: [0, 0, 0] })
    expect(baked).toHaveLength(1)
    expectVec3Close(baked[0].vertices[0], [10, 0, 5])
    expectVec3Close(baked[0].vertices[1], [11, 0, 5])
    expectVec3Close(baked[0].vertices[2], [10, 1, 5])
    // A pure rotation of the identity matrix leaves the normal untouched.
    expectVec3Close(baked[0].normal, [0, 0, 1])
  })

  it('rotates 90° about X to match the three.js XYZ-Euler convention', () => {
    // A flat triangle in the local XZ plane (y=0 everywhere), already origin-aligned.
    const tris = [triangle([0, 1, 0], [0, 0, 0], [2, 0, 0], [0, 0, 3])]
    const baked = bakePartTriangles(tris, { position: [0, 0, 0], rotation: [90, 0, 0] })
    // world = (x, -z, y) for a +90 deg rotation about X; ground-clamp then lifts the whole
    // triangle by 3 (the deepest rotated point, at local z=3, lands at world y=-3 pre-clamp).
    expectVec3Close(baked[0].vertices[0], [0, 3, 0])
    expectVec3Close(baked[0].vertices[1], [2, 3, 0])
    expectVec3Close(baked[0].vertices[2], [0, 0, 0])
  })

  it('ground-clamps only when the rotated geometry would sink below the plate', () => {
    const tris = [triangle([0, 1, 0], [0, 0, 0], [2, 0, 0], [0, 0, 3])]
    // Same rotation as above (resting height 3), but the placement already lifts it to y=10 -
    // clamping must preserve the deliberate lift, not override it down to the resting height.
    const baked = bakePartTriangles(tris, { position: [0, 10, 0], rotation: [90, 0, 0] })
    expectVec3Close(baked[0].vertices[0], [0, 10, 0])
    expectVec3Close(baked[0].vertices[2], [0, 7, 0])
  })

  it('returns no triangles for an empty input', () => {
    expect(bakePartTriangles([], { position: [0, 0, 0], rotation: [0, 0, 0] })).toEqual([])
  })

  it('rests a non-box solid rotated 45° flush on the plate, not on its bounding box', () => {
    const baked = bakePartTriangles(biconeTriangles(), { position: [0, 0, 0], rotation: [45, 0, 0] })
    // Flush: the lowest baked vertex is exactly on the plate. Before the vertex-accurate resting
    // height this was 6.213 (the part hovered), and it agreed with the viewport only in being wrong.
    expect(Math.min(...bakedYs(baked))).toBeCloseTo(0, 6)
    // The lift applied was 15.000 - the number `placement.test.ts` pins for the same geometry. The
    // low-X apex is triangle 0's first vertex: local (0,15,15) -> world y = 15·cos45 − 15·sin45 = 0,
    // + the 15.000 lift; world z = 15·sin45 + 15·cos45 = 21.213.
    expectVec3Close(baked[0].vertices[0], [0, 15, 21.2132])
  })

  it('preserves a deliberate lift above the corrected resting height, and never sinks below it', () => {
    // The plate-clamp POLICY is unchanged - only the height it clamps to is corrected.
    const lifted = bakePartTriangles(biconeTriangles(), { position: [0, 40, 0], rotation: [45, 0, 0] })
    expect(Math.min(...bakedYs(lifted))).toBeCloseTo(25, 6) // 40 requested - 15 resting
    const sunk = bakePartTriangles(biconeTriangles(), { position: [0, -40, 0], rotation: [45, 0, 0] })
    expect(Math.min(...bakedYs(sunk))).toBeCloseTo(0, 6)
  })

  it('is unaffected for rotations that ARE multiples of 90° (the preview rotation included)', () => {
    // Corners map to corners there, so the old formula was exact - this pins that the fix did not
    // move the axis-aligned cases, including the print-orientation preview's [-90, 0, 0].
    const axisAligned: Vec3[] = [[0, 0, 0], [90, 0, 0], [-90, 0, 0], [180, 0, 0], [0, 90, 0]]
    for (const rotation of axisAligned) {
      const baked = bakePartTriangles(biconeTriangles(), { position: [0, 0, 0], rotation })
      expect(Math.min(...bakedYs(baked))).toBeCloseTo(0, 6)
    }
  })
})

describe('buildPlateStl', () => {
  function quad(originX: number): StlTriangle[] {
    return [
      triangle([0, 1, 0], [originX, 0, 0], [originX + 1, 0, 0], [originX, 0, 1]),
      triangle([0, 1, 0], [originX + 1, 0, 0], [originX + 1, 0, 1], [originX, 0, 1])
    ]
  }

  it('merges every part into one STL at its own placement', () => {
    const partA = { name: 'Bracket', stlBuffer: writeBinaryStl(quad(0)), placement: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 } }
    const partB = { name: 'Lid', stlBuffer: writeBinaryStl(quad(0)), placement: { position: [50, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 } }
    const result = buildPlateStl([partA, partB])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.triangleCount).toBe(4)
    const parsed = parseBinaryStl(result.stlBuffer)
    expect(parsed).toHaveLength(4)
    // Part B's triangles were shifted 50mm in X by its placement.
    const xs = parsed.flatMap((t) => t.vertices.map((v) => v[0]))
    expect(Math.max(...xs)).toBeCloseTo(51, 4)
  })

  it('fails with a friendly reason when there are no parts to plate', () => {
    const result = buildPlateStl([])
    expect(result).toEqual({ ok: false, reason: 'No visible parts have a model to plate.' })
  })

  it('fails with the part name when a part\'s STL cannot be parsed', () => {
    const result = buildPlateStl([
      { name: 'Corrupt', stlBuffer: new Uint8Array(4), placement: { position: [0, 0, 0], rotation: [0, 0, 0] } }
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/"Corrupt"/)
  })
})
