import * as THREE from 'three'
import type { Placement } from '../../../shared/ipc'

/**
 * Pure, WebGL-free placement math for multi-part layout (WS-I, architecture doc §14). Split out of
 * `viewer.ts`/`placementController.ts` so the fiddly ground-snap and Euler-conversion math is
 * unit-testable without a renderer. `Placement.rotation` is XYZ Euler degrees (see `parts.ts`); the
 * viewport's build plate is the world `y = 0` plane (parts are origin-aligned in `loadPart`, so a
 * part with the identity placement already rests on it).
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
 * The world-`y` translation that rests a part on the build plate (`y = 0`), given its local
 * axis-aligned bounds (as produced by `loadPart`, min corner at the local origin) and its rotation.
 * Rotates the 8 local-box corners about the local origin and returns `-min(worldY)`, so the lowest
 * point of the rotated part lands exactly on the plate. Independent of x/z translation (which never
 * changes the vertical extent).
 */
export function groundSnappedY(
  localMin: THREE.Vector3,
  localMax: THREE.Vector3,
  rotationDeg: readonly [number, number, number]
): number {
  const rot = new THREE.Matrix4().makeRotationFromEuler(placementEuler(rotationDeg))
  let minY = Infinity
  for (const x of [localMin.x, localMax.x]) {
    for (const y of [localMin.y, localMax.y]) {
      for (const z of [localMin.z, localMax.z]) {
        const worldY = new THREE.Vector3(x, y, z).applyMatrix4(rot).y
        if (worldY < minY) minY = worldY
      }
    }
  }
  return Number.isFinite(minY) ? -minY : 0
}

/**
 * Ground-snaps a placement: preserves x/z translation and rotation, but derives `y` so the part
 * rests on the plate. Called after every gizmo edit so parts never float or sink into the bed.
 */
export function groundSnap(placement: Placement, localMin: THREE.Vector3, localMax: THREE.Vector3): Placement {
  return {
    position: [placement.position[0], groundSnappedY(localMin, localMax, placement.rotation), placement.position[2]],
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
