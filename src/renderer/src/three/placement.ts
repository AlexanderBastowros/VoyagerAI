import * as THREE from 'three'
import type { Placement } from '../../../shared/ipc'
import { restingYFromVertices } from '../../../shared/placementMath'

/**
 * Pure, WebGL-free placement math for multi-part layout (WS-I, architecture doc §14). Split out of
 * `viewer.ts`/`placementController.ts` so the fiddly ground-clamp and Euler-conversion math is
 * unit-testable without a renderer. `Placement.rotation` is XYZ Euler degrees (see `parts.ts`); the
 * viewport's build plate is the world `y = 0` plane (parts are origin-aligned in `loadPart`, so a
 * part with the identity placement already rests on it).
 *
 * The resting-height arithmetic itself lives one level down, in `src/shared/placementMath.ts`, so the
 * plate exporter (`packages/agent-core/src/projects/plateStl.ts`, which cannot import `three`) rests
 * parts at exactly the height the viewport does - see that module's header for why they must match.
 */

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** A part's placement rotation as a three.js Euler (XYZ order, radians). */
export function placementEuler(rotationDeg: readonly [number, number, number]): THREE.Euler {
  return new THREE.Euler(rotationDeg[0] * DEG2RAD, rotationDeg[1] * DEG2RAD, rotationDeg[2] * DEG2RAD, 'XYZ')
}

/** A three.js Euler back to `Placement` rotation degrees (XYZ). */
export function eulerToRotationDeg(euler: THREE.Euler): [number, number, number] {
  return [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG]
}

/**
 * The extent of a part's local axis-aligned box once its placement rotation is applied, expressed
 * **relative to the local origin**. Parts are min-corner-origined (`buildMesh` translates the
 * geometry by `-bounds.min`), and rotation happens about that local origin - so a rotated part's
 * `Placement.position` is neither its centre nor its world-AABB min. These bounds are exactly what
 * you add to `Placement.position` to get world bounds:
 * `worldMin = position + min`, `worldMax = position + max`.
 *
 * Computed from the 8 corners of the local box, i.e. this is the AABB *of the rotated AABB*. For any
 * rotation that is not a multiple of 90° it therefore over-estimates the rotated solid's extent
 * (a solid is a subset of its AABB) - see the pinning test in `placement.test.ts`.
 *
 * That over-estimate is fine, and deliberately conservative, for the one thing this is used for:
 * *spacing* parts on the plate (`arrangeAlongX`'s row widths and depth centring). It must NEVER be
 * used for a part's resting height - lifting a part to where its rotated *box* touches the plate
 * leaves a visible gap under the geometry that no downward drag can close. Use `geometryRestingY`
 * (via `ModelViewer.getRestingY`, which memoises it) for that.
 */
export function rotatedLocalBounds(
  localMin: THREE.Vector3,
  localMax: THREE.Vector3,
  rotationDeg: readonly [number, number, number]
): { min: THREE.Vector3; max: THREE.Vector3 } {
  const rot = new THREE.Matrix4().makeRotationFromEuler(placementEuler(rotationDeg))
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const x of [localMin.x, localMax.x]) {
    for (const y of [localMin.y, localMax.y]) {
      for (const z of [localMin.z, localMax.z]) {
        const corner = new THREE.Vector3(x, y, z).applyMatrix4(rot)
        min.min(corner)
        max.max(corner)
      }
    }
  }
  return { min, max }
}

/**
 * The world-`y` translation that rests a part on the build plate (`y = 0`) at `rotationDeg`,
 * computed from the geometry's **actual vertices** (see `src/shared/placementMath.ts` for the
 * formula, the 21.213-vs-15.000 worked example it fixes, and why the exporter shares it). The
 * geometry must be min-corner-origined local coordinates - which is exactly what `buildMesh`
 * produces, and it never mutates the vertices afterwards.
 *
 * O(vertices), so callers MUST memoise: use `ModelViewer.getRestingY(partId, rotationDeg)`, which
 * caches per part+rotation. Every in-app caller goes through it; this is exported for that method
 * and for tests.
 *
 * NO AABB FALLBACK, deliberately: every caller holds the very mesh whose geometry this is, and an
 * AABB fallback would silently reintroduce the phantom-gap over-estimate this function exists to
 * remove. The only unreadable-geometry cases are "no `position` attribute at all" and an interleaved
 * attribute (three's `STLLoader` produces neither, and `buildMesh` only translates what it produced);
 * both fall back to `0`, i.e. "don't lift", which still keeps the part out of the bed via
 * `groundClamp`.
 */
export function geometryRestingY(
  geometry: THREE.BufferGeometry,
  rotationDeg: readonly [number, number, number]
): number {
  const position = geometry.getAttribute('position')
  if (!position || position.itemSize !== 3 || 'isInterleavedBufferAttribute' in position) return 0
  return restingYFromVertices(position.array, rotationDeg)
}

/**
 * The lowest `y` a *pivot proxy* may be dragged to without sinking its part into the plate, given the
 * part's `restingY` (from `ModelViewer.getRestingY`) at the rotation it holds for this drag.
 *
 * The placement gizmo is attached to an invisible pivot proxy at the part's bounding-box **centre**,
 * not to the mesh; during a translate drag the mesh is re-derived as
 * `start.meshPosition + (pivot.position - start.pivotPosition)`, so `mesh.position.y -
 * pivot.position.y` is constant for the whole drag. Hence `mesh.position.y >= restingY` iff
 * `pivot.position.y >= restingY + pivotOffsetY`, where `pivotOffsetY` is that constant
 * `pivot.position.y - mesh.position.y` sampled at drag start (positive for an unrotated part, whose
 * centre sits above its min-corner origin). The return value is the floor to apply to the PIVOT.
 */
export function dragFloorY(restingY: number, pivotOffsetY: number): number {
  return restingY + pivotOffsetY
}

/**
 * Ground-*clamps* a placement to a known resting height (`ModelViewer.getRestingY`): preserves x/z
 * translation and rotation, and only raises `y` when the part's lowest rotated *vertex* would dip
 * below the plate - a `y` above the resting height is preserved. This is the invariant applied on
 * every placement edit/load: parts can be lifted vertically (assembly preview, stacking - the
 * gizmo's vertical handle), but can never sink into the bed.
 *
 * Takes the height rather than computing it so the O(vertices) pass can be memoised once per
 * part+rotation instead of running on every placement re-sync.
 */
export function groundClamp(placement: Placement, restingY: number): Placement {
  if (placement.position[1] >= restingY) return placement
  return {
    position: [placement.position[0], restingY, placement.position[2]],
    rotation: placement.rotation
  }
}

/** Applies a placement to a three.js object (position + XYZ-Euler rotation). */
export function applyPlacement(object: THREE.Object3D, placement: Placement): void {
  object.position.set(placement.position[0], placement.position[1], placement.position[2])
  object.rotation.copy(placementEuler(placement.rotation))
}

/** Reads a placement back off a three.js object (inverse of `applyPlacement`), rounded to a
 *  sensible precision so persisted values don't accumulate float noise across gizmo edits. */
export function readPlacement(object: THREE.Object3D): Placement {
  const round = (n: number): number => Math.round(n * 1000) / 1000
  return {
    position: [round(object.position.x), round(object.position.y), round(object.position.z)],
    rotation: eulerToRotationDeg(object.rotation).map(round) as [number, number, number]
  }
}
