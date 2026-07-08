import * as THREE from 'three'
import type { Point } from './selection'

/**
 * Pure, DOM-free half of the point-to-point measurement tool - the raycasting
 * math and the overlay geometry, split out from `measurementController.ts`
 * the same way `selection.ts` is split from `selectionController.ts`.
 *
 * Unlike marquee selection (a projected-centroid test against a screen rect),
 * measurement needs an actual surface point per click, so it uses a real
 * `THREE.Raycaster` against the displayed mesh rather than the view-projection
 * math in `selection.ts`.
 */

/** Converts a single pixel point (relative to the viewport container, y-down) into NDC
 *  (-1..1, y-up) - the format `THREE.Raycaster.setFromCamera` expects. */
export function pixelToNdc(point: Point, containerWidth: number, containerHeight: number): Point {
  return {
    x: (point.x / containerWidth) * 2 - 1,
    y: -((point.y / containerHeight) * 2 - 1)
  }
}

/**
 * Casts a ray from `ndc` through `camera` and returns the closest point where
 * it hits `mesh`'s surface (in world/model mm, per the coordinate-space note
 * in `selection.ts`), or null if the ray misses.
 */
export function raycastPoint(camera: THREE.Camera, mesh: THREE.Mesh, ndc: Point): THREE.Vector3 | null {
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
  const hits = raycaster.intersectObject(mesh, false)
  return hits.length > 0 ? hits[0].point.clone() : null
}

const LINE_COLOR = 0xffa64d
const MARKER_RADIUS = 1.2

/**
 * Renders the in-progress/completed measurement as a line between two points
 * plus a small sphere marker at each. Reused across measurements: `update`
 * repositions everything, `setPointBVisible` toggles the second point/line
 * on while only one point has been picked, `dispose` tears it down for good.
 */
export class MeasurementOverlay {
  readonly object: THREE.Group
  private readonly line: THREE.Line
  private readonly markerA: THREE.Mesh
  private readonly markerB: THREE.Mesh

  constructor() {
    const lineGeometry = new THREE.BufferGeometry()
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
    const lineMaterial = new THREE.LineBasicMaterial({ color: LINE_COLOR })
    this.line = new THREE.Line(lineGeometry, lineMaterial)
    this.line.frustumCulled = false

    const markerGeometry = new THREE.SphereGeometry(MARKER_RADIUS, 12, 12)
    const markerMaterial = new THREE.MeshBasicMaterial({ color: LINE_COLOR })
    this.markerA = new THREE.Mesh(markerGeometry, markerMaterial)
    this.markerB = new THREE.Mesh(markerGeometry, markerMaterial.clone())
    this.markerA.frustumCulled = false
    this.markerB.frustumCulled = false
    this.markerB.visible = false
    this.line.visible = false

    this.object = new THREE.Group()
    this.object.renderOrder = 10
    this.object.add(this.line, this.markerA, this.markerB)
  }

  /** Places the first marker only - shown while the user has picked point A but not yet B. */
  showFirstPoint(pointA: THREE.Vector3): void {
    this.markerA.position.copy(pointA)
    this.markerA.visible = true
    this.markerB.visible = false
    this.line.visible = false
  }

  /** Positions the line and both markers between the two picked points. */
  update(pointA: THREE.Vector3, pointB: THREE.Vector3): void {
    const position = this.line.geometry.getAttribute('position') as THREE.BufferAttribute
    position.setXYZ(0, pointA.x, pointA.y, pointA.z)
    position.setXYZ(1, pointB.x, pointB.y, pointB.z)
    position.needsUpdate = true
    this.line.geometry.computeBoundingSphere()

    this.markerA.position.copy(pointA)
    this.markerB.position.copy(pointB)
    this.markerA.visible = true
    this.markerB.visible = true
    this.line.visible = true
  }

  dispose(): void {
    this.line.geometry.dispose()
    ;(this.line.material as THREE.Material).dispose()
    this.markerA.geometry.dispose()
    ;(this.markerA.material as THREE.Material).dispose()
    ;(this.markerB.material as THREE.Material).dispose()
  }
}
