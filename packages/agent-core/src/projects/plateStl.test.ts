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
