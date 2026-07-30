import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { applyMat3, rotationMatrixXYZDeg, type Vec3 } from '../../../shared/placementMath'
import {
  applyPlacement,
  dragFloorY,
  eulerToRotationDeg,
  geometryRestingY,
  groundClamp,
  placementEuler,
  readPlacement,
  rotatedLocalBounds
} from './placement'

const box = { min: new THREE.Vector3(0, 0, 0), max: new THREE.Vector3(10, 6, 4) }

/** The `box` fixture as real geometry: its 8 corners as a position attribute. A box IS its own AABB,
 *  so this is the one shape where the vertex-accurate resting height and the old rotated-corner
 *  formula agree - which is exactly why a box-only suite could not see the bug fixed below. */
function boxGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) positions.push(x, y, z)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

/**
 * THE WORKED EXAMPLE, and the first NON-BOX fixture in this suite. A bicone ("spindle") inscribed in
 * the 30 mm cube: a regular octagon of radius 15 in the plane `x = 15`, centred on `(15, 15)` in y/z,
 * plus an apex at each end of X. Its AABB is exactly the 30 mm cube, and it shares the 30 mm sphere's
 * great circle in the YZ plane, so at `[45, 0, 0]` its lowest point is the sphere's:
 *
 * - vertex-accurate resting height: **15.000** (the octagon has a vertex at theta = 135 degrees,
 *   which is precisely the extremal direction for this rotation, so this is exact, not sampled);
 * - the 8 rotated AABB corners: 30 * sin(45) = **21.213**, i.e. a 6.213 mm phantom gap under the part
 *   that no downward drag could close, because the release-time clamp re-lifted it every time.
 *
 * Before O6 this suite pinned 21.213 as "today's wrong answer, correct is 15.000". It now pins
 * 15.000, and `rotatedLocalBounds` is still asserted to give 21.213 so both halves of the worked
 * example stay on the record.
 *
 * DUPLICATED DELIBERATELY (a test fixture, not production code) in `src/shared/placementMath.test.ts`
 * and `packages/agent-core/src/projects/plateStl.test.ts`: those three suites pinning the same number
 * from the same geometry is the guard that the viewport and the plate exporter cannot drift apart.
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

function biconeGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(biconeVertices(), 3))
  return geometry
}

const biconeAabb = { min: new THREE.Vector3(0, 0, 0), max: new THREE.Vector3(30, 30, 30) }

describe('placementEuler / eulerToRotationDeg', () => {
  it('round-trips degrees through a three.js Euler', () => {
    const euler = placementEuler([0, 90, 0])
    expect(euler.y).toBeCloseTo(Math.PI / 2)
    expect(eulerToRotationDeg(euler).map((d) => Math.round(d))).toEqual([0, 90, 0])
  })
})

describe('geometryRestingY', () => {
  it('is zero for an unrotated origin-aligned part (already resting on the plate)', () => {
    expect(geometryRestingY(boxGeometry(), [0, 0, 0])).toBeCloseTo(0)
  })

  it('lifts a part rotated about Y by nothing (footprint still on the plate)', () => {
    // Rotating about Y (the up axis) never dips the part below the plate.
    expect(geometryRestingY(boxGeometry(), [0, 45, 0])).toBeCloseTo(0)
  })

  it('rests a part flipped 90° about X so its lowest rotated vertex touches y=0', () => {
    // +90° about X maps local +z (extent 0..4) to world -y, so the part would dip to y = -4;
    // resting it lifts by 4 so it sits on the plate.
    expect(geometryRestingY(boxGeometry(), [90, 0, 0])).toBeCloseTo(4)
  })

  it('rests a part flipped 180° about X (its top, local y=6, becomes the bottom)', () => {
    expect(geometryRestingY(boxGeometry(), [180, 0, 0])).toBeCloseTo(6)
  })

  it('rests a non-box solid at 45° on its GEOMETRY (15.000), not on its bounding box (21.213)', () => {
    // The two halves of the worked example, side by side. See `biconeVertices`.
    expect(geometryRestingY(biconeGeometry(), [45, 0, 0])).toBeCloseTo(15, 4)
    expect(-rotatedLocalBounds(biconeAabb.min, biconeAabb.max, [45, 0, 0]).min.y).toBeCloseTo(21.213, 3)
  })

  it('matches what three itself measures after rotating the geometry', () => {
    // Independent cross-check of the shared plain-number math against three's own transform: rotate
    // the vertices for real and read the bounding box, rather than trusting our matrix row.
    const rotations: Array<[number, number, number]> = [
      [45, 0, 0],
      [0, 45, 0],
      [30, 40, 50],
      [-90, 0, 0]
    ]
    for (const rotation of rotations) {
      const rotated = biconeGeometry()
      rotated.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(placementEuler(rotation)))
      rotated.computeBoundingBox()
      expect(geometryRestingY(biconeGeometry(), rotation)).toBeCloseTo(-(rotated.boundingBox?.min.y ?? NaN), 4)
    }
  })

  it('falls back to the plate for geometry with no readable position attribute', () => {
    // Unreachable in the app (`STLLoader` always produces a plain itemSize-3 attribute and
    // `buildMesh` only translates it) - asserted so the fallback is 0 rather than NaN, and
    // deliberately NOT the AABB over-estimate this function exists to remove.
    expect(geometryRestingY(new THREE.BufferGeometry(), [45, 0, 0])).toBe(0)
  })
})

describe('rotatedLocalBounds', () => {
  it('returns the input box verbatim for the identity rotation', () => {
    const bounds = rotatedLocalBounds(box.min, box.max, [0, 0, 0])
    expect(bounds.min.toArray()).toEqual(box.min.toArray())
    expect(bounds.max.toArray()).toEqual(box.max.toArray())
  })

  it('maps (x,y,z) -> (x,z,-y) for -90° about X (the print-orientation preview rotation, O5)', () => {
    // -90° about X is the display rotation the print-orientation preview applies, so the part's real
    // bed face lands on the grid. Derived from the fixture: local y (0..6) becomes world z (-6..0)
    // and local z (0..4) becomes world y (0..4); rotation is about the local origin, so the bounds
    // are offsets from `Placement.position`, not world coordinates.
    const bounds = rotatedLocalBounds(box.min, box.max, [-90, 0, 0])
    expect(bounds.min.x).toBeCloseTo(box.min.x) // 0
    expect(bounds.min.y).toBeCloseTo(box.min.z) // 0
    expect(bounds.min.z).toBeCloseTo(-box.max.y) // -6
    expect(bounds.max.x).toBeCloseTo(box.max.x) // 10
    expect(bounds.max.y).toBeCloseTo(box.max.z) // 4
    expect(bounds.max.z).toBeCloseTo(-box.min.y) // 0
  })

  it('agrees with the vertex-accurate resting height for a BOX, at every rotation', () => {
    // A box is its own AABB, so `-rotatedLocalBounds().min.y` and `geometryRestingY` coincide here.
    // This is the invariant that made the AABB shortcut look correct - and it is why
    // `arrangeAlongX`, whose only fixture-shaped need is *spacing*, may keep using these bounds.
    const rotations: Array<[number, number, number]> = [
      [0, 0, 0],
      [0, 45, 0],
      [90, 0, 0],
      [180, 0, 0],
      [-90, 0, 0],
      [30, 40, 50]
    ]
    const geometry = boxGeometry()
    for (const rotation of rotations) {
      expect(geometryRestingY(geometry, rotation)).toBeCloseTo(-rotatedLocalBounds(box.min, box.max, rotation).min.y, 4)
    }
  })

  it('OVER-estimates the resting height for a non-box solid - never use it for one', () => {
    expect(-rotatedLocalBounds(biconeAabb.min, biconeAabb.max, [45, 0, 0]).min.y).toBeGreaterThan(
      geometryRestingY(biconeGeometry(), [45, 0, 0]) + 6
    )
  })
})

describe('dragFloorY', () => {
  // `pivotOffsetY` is `pivot.position.y - mesh.position.y` sampled at drag start. The gizmo's pivot
  // proxy sits at the centre of the mesh's WORLD bounding box (`Box3.setFromObject`), which is the
  // rotated AABB's centre - so it is derived from `rotatedLocalBounds`, not from the vertex hull.
  // That is unchanged by the vertex-accurate resting height: the offset is measured live from the
  // real pivot and mesh positions, and only the floor's `restingY` term comes from the geometry.
  const pivotOffsetFor = (rotation: [number, number, number]): number => {
    const bounds = rotatedLocalBounds(box.min, box.max, rotation)
    return (bounds.min.y + bounds.max.y) / 2
  }

  it('leaves zero downward room for an unrotated part already resting on the plate', () => {
    const pivotOffsetY = pivotOffsetFor([0, 0, 0])
    expect(pivotOffsetY).toBeCloseTo(3) // half the fixture's 6 mm height, pivot above the min corner
    const restingY = geometryRestingY(boxGeometry(), [0, 0, 0]) // 0
    const meshY = restingY // resting
    expect(dragFloorY(restingY, pivotOffsetY)).toBeCloseTo(meshY + pivotOffsetY)
  })

  it('opens exactly the lift as downward room for a part raised to y=30', () => {
    const pivotOffsetY = pivotOffsetFor([0, 0, 0])
    const pivotY = 30 + pivotOffsetY
    expect(pivotY - dragFloorY(geometryRestingY(boxGeometry(), [0, 0, 0]), pivotOffsetY)).toBeCloseTo(30)
  })

  it('leaves zero downward room at a NON-ZERO floor for a rotated part at its resting height', () => {
    const rotation: [number, number, number] = [90, 0, 0]
    const pivotOffsetY = pivotOffsetFor(rotation)
    expect(pivotOffsetY).toBeCloseTo(-2) // +90° about X puts the centre below the mesh origin
    const meshY = geometryRestingY(boxGeometry(), rotation) // 4
    const floor = dragFloorY(meshY, pivotOffsetY)
    expect(floor).toBeCloseTo(2)
    expect(meshY + pivotOffsetY - floor).toBeCloseTo(0)
  })

  it('drops the floor to the GEOMETRY for a 45° part, so the last 6.213 mm are draggable', () => {
    // The regression this fix is for: with the AABB height the floor sat 6.213 mm too high, so the
    // part could not be brought down onto the plate no matter how far the handle was dragged.
    const pivotOffsetY = 0
    const fromGeometry = dragFloorY(geometryRestingY(biconeGeometry(), [45, 0, 0]), pivotOffsetY)
    const fromAabb = dragFloorY(-rotatedLocalBounds(biconeAabb.min, biconeAabb.max, [45, 0, 0]).min.y, pivotOffsetY)
    expect(fromGeometry).toBeCloseTo(15, 4)
    expect(fromAabb - fromGeometry).toBeCloseTo(6.213, 3)
  })
})

describe('groundClamp', () => {
  it('raises a part that would sink below the plate to its resting height', () => {
    const clamped = groundClamp({ position: [12, 0, -5], rotation: [90, 0, 0] }, 4)
    expect(clamped.position).toEqual([12, 4, -5])
    expect(clamped.rotation).toEqual([90, 0, 0])
  })

  it('preserves a deliberate vertical lift above the resting height', () => {
    const lifted = { position: [12, 30, -5] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] }
    expect(groundClamp(lifted, 0)).toBe(lifted)
  })

  it('leaves a part exactly at its resting height untouched', () => {
    const resting = { position: [0, 4, 0] as [number, number, number], rotation: [90, 0, 0] as [number, number, number] }
    expect(groundClamp(resting, 4)).toBe(resting)
  })

  it('still enforces the plate as a floor for a 45° part - at the correct height', () => {
    // The clamp POLICY is unchanged: parts rest on the plate and cannot be dragged below it. Only
    // the height it clamps TO is corrected (15.000, not 21.213).
    const restingY = geometryRestingY(biconeGeometry(), [45, 0, 0])
    const sunk = groundClamp({ position: [0, -40, 0], rotation: [45, 0, 0] }, restingY)
    expect(sunk.position[1]).toBeCloseTo(15, 4)
    const floating = { position: [0, 40, 0] as [number, number, number], rotation: [45, 0, 0] as [number, number, number] }
    expect(groundClamp(floating, restingY)).toBe(floating)
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

describe('shared placementMath vs three (the plate exporter cross-check)', () => {
  it("rotationMatrixXYZDeg is entry-for-entry three's makeRotationFromEuler for XYZ order", () => {
    // `plateStl.ts` bakes and rests parts with the shared plain-number matrix because agent-core
    // cannot import three; the viewport uses three. This is the only file where both are importable,
    // so it is where that "bit-for-bit" claim is actually pinned. Shared `Mat3` is row-major; three's
    // `Matrix4.elements` is column-major, hence the index map.
    const columnMajorIndex = [0, 4, 8, 1, 5, 9, 2, 6, 10]
    const rotations: Vec3[] = [
      [0, 0, 0],
      [45, 0, 0],
      [-90, 0, 0],
      [0, 90, 0],
      [30, 40, 50],
      [180, -37.5, 12.25]
    ]
    for (const rotation of rotations) {
      const shared = rotationMatrixXYZDeg(rotation)
      const three = new THREE.Matrix4().makeRotationFromEuler(placementEuler(rotation))
      shared.forEach((value, i) => expect(value).toBeCloseTo(three.elements[columnMajorIndex[i]], 12))
    }
  })

  it('applyMat3 rotates a vector the same way three does', () => {
    const rotation: Vec3 = [30, 40, 50]
    const shared = applyMat3(rotationMatrixXYZDeg(rotation), [7, -3, 11])
    const viaThree = new THREE.Vector3(7, -3, 11).applyEuler(placementEuler(rotation))
    expect(shared[0]).toBeCloseTo(viaThree.x, 10)
    expect(shared[1]).toBeCloseTo(viaThree.y, 10)
    expect(shared[2]).toBeCloseTo(viaThree.z, 10)
  })
})
