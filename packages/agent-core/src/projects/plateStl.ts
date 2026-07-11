/**
 * Plate export (§14/WS-F): bakes every visible part's *current placement* into one merged
 * binary STL, matching what the viewport actually shows - as opposed to the per-part/all-parts
 * export paths, which always hand back each part's raw, unplaced geometry. Placement is layout,
 * not geometry (architecture doc §14): a part's own STL is never mutated, so "what the plate
 * looks like" only ever exists at export time, computed here.
 *
 * Pure, dependency-free (no `electron`, no filesystem, no `three` - agent-core has no WebGL
 * dependency) so it unit-tests under plain vitest against hand-built binary STL buffers; `src/
 * main/ipc.ts`'s `model:export` `'plate'` branch reads each part's STL bytes off disk and hands
 * them here.
 *
 * Every generated STL in this app is binary (build123d's `export_stl` defaults `ascii_format` to
 * `False` - see `resources/skills/printable-cad/references/build123d.md`), so only the binary STL
 * format is implemented; a file that doesn't parse as one fails that part's bake with a specific
 * reason rather than silently producing garbage geometry.
 *
 * The transform mirrors `src/renderer/src/three/viewer.ts`/`three/placement.ts` bit-for-bit:
 * `buildMesh()` bakes each part's bounding-box *minimum* corner to its local origin before a
 * placement is ever applied (so an identity placement rests a part in the +X/+Y/+Z octant), then
 * `applyPlacement()` rotates by `Placement.rotation` (XYZ-order Euler degrees) about that local
 * origin and translates by `Placement.position`; `groundClamp()` only ever *raises* `position.y`
 * so the part's lowest rotated point never sinks below the plate. Baking here re-derives the
 * ground-clamp against the geometry actually being exported (not just trusting the persisted
 * `placement.position[1]`, which could have been computed against a since-refined part's old
 * bounds) - the same reasoning `loadPart()`'s doc comment gives for re-clamping on every load.
 */

const DEG2RAD = Math.PI / 180

export type Vec3 = readonly [number, number, number]

export interface StlTriangle {
  normal: Vec3
  vertices: readonly [Vec3, Vec3, Vec3]
}

/** Row-major 3x3 rotation matrix. */
type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

const BINARY_HEADER_SIZE = 80
const TRIANGLE_RECORD_SIZE = 50 // 12 (normal) + 3*12 (vertices) + 2 (attribute byte count)

/**
 * Parses a binary STL buffer into its triangles (normal + 3 vertices each, all in the file's own
 * local coordinate space). Throws with a specific reason on anything that isn't a well-formed
 * binary STL - a truncated/corrupt file must never silently yield partial or garbage geometry
 * merged onto the same plate as every other part.
 */
export function parseBinaryStl(buffer: Uint8Array): StlTriangle[] {
  if (buffer.length < BINARY_HEADER_SIZE + 4) {
    throw new Error(`not a valid binary STL - only ${buffer.length} bytes (need at least 84)`)
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const triangleCount = view.getUint32(BINARY_HEADER_SIZE, true)
  const expectedSize = BINARY_HEADER_SIZE + 4 + triangleCount * TRIANGLE_RECORD_SIZE
  if (buffer.length < expectedSize) {
    throw new Error(
      `malformed binary STL - header declares ${triangleCount} triangles (needs ${expectedSize} bytes) but the file is only ${buffer.length} bytes`
    )
  }

  const triangles: StlTriangle[] = []
  let offset = BINARY_HEADER_SIZE + 4
  for (let i = 0; i < triangleCount; i++) {
    const normal: Vec3 = [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)]
    offset += 12
    const vertices: Vec3[] = []
    for (let v = 0; v < 3; v++) {
      vertices.push([view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)])
      offset += 12
    }
    offset += 2 // attribute byte count - unused, never round-tripped
    triangles.push({ normal, vertices: vertices as [Vec3, Vec3, Vec3] })
  }
  return triangles
}

/** Writes `triangles` as a binary STL buffer. `header` is truncated/zero-padded to the mandatory
 *  80-byte preamble (its content has no semantic meaning in the binary format). */
export function writeBinaryStl(triangles: StlTriangle[], header = 'Voyager AI plate export'): Buffer {
  const buf = Buffer.alloc(BINARY_HEADER_SIZE + 4 + triangles.length * TRIANGLE_RECORD_SIZE)
  buf.write(header.slice(0, BINARY_HEADER_SIZE), 0, 'ascii')
  buf.writeUInt32LE(triangles.length, BINARY_HEADER_SIZE)

  let offset = BINARY_HEADER_SIZE + 4
  for (const tri of triangles) {
    buf.writeFloatLE(tri.normal[0], offset)
    buf.writeFloatLE(tri.normal[1], offset + 4)
    buf.writeFloatLE(tri.normal[2], offset + 8)
    offset += 12
    for (const v of tri.vertices) {
      buf.writeFloatLE(v[0], offset)
      buf.writeFloatLE(v[1], offset + 4)
      buf.writeFloatLE(v[2], offset + 8)
      offset += 12
    }
    buf.writeUInt16LE(0, offset) // attribute byte count
    offset += 2
  }
  return buf
}

/** The rotation matrix for XYZ-order Euler degrees, bit-for-bit the same formula three.js's
 *  `Matrix4.makeRotationFromEuler()` uses for `Euler.order === 'XYZ'` (see that source for the
 *  derivation) - required so a plate export rotates each part exactly as the viewport gizmo does,
 *  without agent-core taking a dependency on `three` (which is renderer/WebGL-only). */
function rotationMatrixXYZDeg(rotationDeg: Vec3): Mat3 {
  const x = rotationDeg[0] * DEG2RAD
  const y = rotationDeg[1] * DEG2RAD
  const z = rotationDeg[2] * DEG2RAD
  const a = Math.cos(x)
  const b = Math.sin(x)
  const c = Math.cos(y)
  const d = Math.sin(y)
  const e = Math.cos(z)
  const f = Math.sin(z)
  return [
    c * e, -c * f, d,
    a * f + b * e * d, a * e - b * f * d, -b * c,
    b * f - a * e * d, b * e + a * f * d, a * c
  ]
}

function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

/** The minimum corner across every triangle's vertices - the translation `buildMesh()` bakes into
 *  the geometry before a placement is ever applied. */
function boundingMin(triangles: StlTriangle[]): Vec3 {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  for (const tri of triangles) {
    for (const v of tri.vertices) {
      if (v[0] < minX) minX = v[0]
      if (v[1] < minY) minY = v[1]
      if (v[2] < minZ) minZ = v[2]
    }
  }
  return [minX, minY, minZ]
}

/** The maximum corner of an already origin-aligned (min corner at `[0,0,0]`) triangle set. */
function boundingMaxFromOrigin(triangles: StlTriangle[]): Vec3 {
  let maxX = 0
  let maxY = 0
  let maxZ = 0
  for (const tri of triangles) {
    for (const v of tri.vertices) {
      if (v[0] > maxX) maxX = v[0]
      if (v[1] > maxY) maxY = v[1]
      if (v[2] > maxZ) maxZ = v[2]
    }
  }
  return [maxX, maxY, maxZ]
}

/** The world-`y` translation that rests an origin-aligned (min corner at local `[0,0,0]`) AABB on
 *  the build plate (`y = 0`) at the given rotation - mirrors `src/renderer/src/three/placement.ts`'s
 *  `groundSnappedY()`: rotates the 8 local-box corners about the local origin and returns
 *  `-min(worldY)`, so the lowest rotated point lands exactly on the plate. */
function restingY(localMax: Vec3, rotationDeg: Vec3): number {
  const m = rotationMatrixXYZDeg(rotationDeg)
  let minY = Infinity
  for (const x of [0, localMax[0]]) {
    for (const y of [0, localMax[1]]) {
      for (const z of [0, localMax[2]]) {
        const worldY = applyMat3(m, [x, y, z])[1]
        if (worldY < minY) minY = worldY
      }
    }
  }
  return Number.isFinite(minY) ? -minY : 0
}

/** The subset of `Placement` this module needs - `position` in mm, `rotation` XYZ-order Euler
 *  degrees (matches `src/shared/parts.ts`'s `Placement`, restated here so this module has no
 *  dependency beyond plain numbers). */
export interface PlacementLike {
  position: Vec3
  rotation: Vec3
}

/**
 * Bakes one part's triangles (in their own local STL coordinates) into world space at
 * `placement`: origin-aligns to the geometry's own minimum corner (mirrors `buildMesh()`),
 * rotates by `placement.rotation` about that origin, ground-clamps `y` against *this* geometry's
 * bounds (mirrors `groundClamp()` - only ever raises `position.y`, never sinks a deliberate lift),
 * then translates. Normals are rotated (not translated) - a pure rotation needs no
 * inverse-transpose to stay correct.
 */
export function bakePartTriangles(triangles: StlTriangle[], placement: PlacementLike): StlTriangle[] {
  if (triangles.length === 0) return []

  const min = boundingMin(triangles)
  const originAligned = triangles.map((tri) => ({
    normal: tri.normal,
    vertices: tri.vertices.map((v) => [v[0] - min[0], v[1] - min[1], v[2] - min[2]] as Vec3) as [Vec3, Vec3, Vec3]
  }))

  const localMax = boundingMaxFromOrigin(originAligned)
  const rot = rotationMatrixXYZDeg(placement.rotation)
  const groundY = restingY(localMax, placement.rotation)
  const clampedY = Math.max(placement.position[1], groundY)
  const translation: Vec3 = [placement.position[0], clampedY, placement.position[2]]

  return originAligned.map((tri) => ({
    normal: applyMat3(rot, tri.normal),
    vertices: tri.vertices.map((v) => {
      const r = applyMat3(rot, v)
      return [r[0] + translation[0], r[1] + translation[1], r[2] + translation[2]] as Vec3
    }) as [Vec3, Vec3, Vec3]
  }))
}

export interface PlatePart {
  /** Display name, used only in error messages. */
  name: string
  /** Raw binary STL bytes as recorded for this part's active iteration. */
  stlBuffer: Uint8Array
  placement: PlacementLike
}

export type PlateBuildResult =
  | { ok: true; stlBuffer: Buffer; triangleCount: number }
  | { ok: false; reason: string }

/**
 * Merges every given part's baked triangles into one binary STL - the plate export. Callers
 * filter to *visible* parts with a recorded iteration before calling (invisible parts, and parts
 * with nothing generated yet, aren't part of "the viewport arrangement"); an empty `parts` list or
 * one where every STL fails to parse is reported as a friendly failure rather than writing a
 * zero-triangle STL.
 */
export function buildPlateStl(parts: PlatePart[]): PlateBuildResult {
  if (parts.length === 0) {
    return { ok: false, reason: 'No visible parts have a model to plate.' }
  }

  const merged: StlTriangle[] = []
  for (const part of parts) {
    let triangles: StlTriangle[]
    try {
      triangles = parseBinaryStl(part.stlBuffer)
    } catch (err) {
      return {
        ok: false,
        reason: `Could not read "${part.name}"'s STL for the plate: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    merged.push(...bakePartTriangles(triangles, part.placement))
  }

  if (merged.length === 0) {
    return { ok: false, reason: 'No visible parts have a model to plate.' }
  }

  return { ok: true, stlBuffer: writeBinaryStl(merged), triangleCount: merged.length }
}
