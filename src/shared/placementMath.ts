/**
 * Placement math shared by the viewport and the plate exporter: the XYZ-Euler rotation matrix, and
 * the **vertex-accurate resting height** of a placed part. Plain numbers only - zero imports, no
 * `three`, no DOM, no Node, no filesystem.
 *
 * ## Why this is one module and not two copies
 *
 * A plate export is *defined* as "what the viewport shows, baked" (see `plateStl.ts`'s header), so
 * the two sides must agree to the last micron or the exported arrangement is not the one the user
 * placed. Until now the resting-height formula was written twice - once in
 * `src/renderer/src/three/placement.ts` against `three`, once in
 * `packages/agent-core/src/projects/plateStl.ts` against plain numbers - and both copies were wrong
 * the same way (below). One definition, imported by both, is the only structural fix for that.
 *
 * `src/shared` is the one directory both sides can reach without a layering violation: the renderer
 * must not import `@voyager/agent-core` (a Node package with `fs` in its module graph - see
 * `renderer/src/state/briefSelectors.ts`), and agent-core must not import `three` (renderer/WebGL
 * only - see `plateStl.ts`). `src/shared/**` is compiled into the web project (`tsconfig.web.json`)
 * and into the node project (`tsconfig.node.json`), and agent-core reaches it through its
 * `@shared/*` path mapping (mirrored by `electron.vite.config.ts` and `vitest.config.ts`);
 * `src/shared/stlAscii.ts` is the precedent for a pure, three-free geometry helper living here.
 * Renderer files import it by relative path (the renderer build has no `@shared` alias).
 *
 * ## Resting height: the formula, and the bug it replaces
 *
 * Parts are min-corner-origined (`buildMesh`/`bakePartTriangles` translate the geometry by
 * `-bounds.min` before any placement is applied) and `Placement.rotation` is applied **about that
 * local origin**, so the height at which a part's lowest point touches the build plate (world
 * `y = 0`) is `-min over the part's vertices of (R · v).y`.
 *
 * Both previous copies instead rotated the **8 corners of the local AABB**. A solid is a subset of
 * its AABB, so for any rotation that is not a multiple of 90 degrees the corner minimum is <= the
 * solid's and the part was lifted to where the rotated *box* would touch the plate, not where the
 * geometry does. Worked example, pinned in `placementMath.test.ts` and in both callers' suites: a
 * 30 mm sphere at `[45, 0, 0]` was lifted 21.213 mm where it in fact touches at 15.000 - a 6.213 mm
 * gap under the part that no downward drag could ever close, because the release-time ground clamp
 * re-applied the same over-estimate every time.
 *
 * The AABB-of-the-rotated-AABB is still the right tool for *spacing* parts on the plate
 * (`three/arrangeAlongX.ts` uses `rotatedLocalBounds` for row widths, where over-estimating is the
 * conservative direction). It is never the right tool for resting height.
 *
 * ## Cost
 *
 * `restingYFromVertices` is O(vertices) and exact. Callers must not call it per animation frame -
 * resting height depends only on (geometry, rotation), so it is memoised per part+rotation in
 * `ModelViewer.getRestingY` for the viewport, and computed once per part per export in
 * `bakePartTriangles`. A convex hull would let a rotation change be O(hull) instead of O(vertices),
 * but it only pays off if the value is recomputed often, and it is not: memoising is both simpler
 * and cheaper than building and storing a hull.
 */

export type Vec3 = readonly [number, number, number]

/** Row-major 3x3 rotation matrix. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

const DEG2RAD = Math.PI / 180

/**
 * The rotation matrix for XYZ-order Euler degrees, bit-for-bit the same formula three.js's
 * `Matrix4.makeRotationFromEuler()` uses for `Euler.order === 'XYZ'` (see that source for the
 * derivation) - required so a plate export rotates each part exactly as the viewport gizmo does,
 * without agent-core taking a dependency on `three`. The agreement is pinned against three itself in
 * `src/renderer/src/three/placement.test.ts` (the one place both are importable).
 */
export function rotationMatrixXYZDeg(rotationDeg: Vec3): Mat3 {
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

export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

/**
 * The world-`y` translation that rests a part on the build plate (`y = 0`) at `rotationDeg`:
 * `-min over vertices of (R · v).y`, computed from the part's **actual vertices**, which must be
 * min-corner-origined local coordinates (what `buildMesh` and `bakePartTriangles` both produce).
 * `vertices` is a flat `x, y, z, x, y, z, ...` list - a three.js position attribute's `array`, or a
 * flattened triangle soup; any trailing partial triple is ignored. Independent of x/z translation,
 * which never changes the vertical extent.
 *
 * The projection row is taken straight out of `rotationMatrixXYZDeg` rather than re-derived, so the
 * height a part is rested at is guaranteed to come from the same rotation the caller then bakes or
 * renders with.
 *
 * An empty vertex list (or one that is entirely non-finite) leaves the minimum non-finite; falls
 * back to the plate (`0`) rather than returning NaN, which would poison the placement.
 */
export function restingYFromVertices(vertices: ArrayLike<number>, rotationDeg: Vec3): number {
  const m = rotationMatrixXYZDeg(rotationDeg)
  const ry0 = m[3]
  const ry1 = m[4]
  const ry2 = m[5]
  let minY = Infinity
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    // NaN vertices compare false and are skipped, so one bad triangle can't poison a whole part.
    const worldY = ry0 * vertices[i] + ry1 * vertices[i + 1] + ry2 * vertices[i + 2]
    if (worldY < minY) minY = worldY
  }
  return Number.isFinite(minY) ? -minY : 0
}
