import * as THREE from 'three'
import type { SelectionSummary } from '../../../shared/ipc'

/**
 * Pure, DOM-free viewport region selection engine.
 *
 * Coordinate space note: `ModelViewer.loadSTL` adds the parsed mesh straight
 * to the scene with no position/rotation/scale applied, so the mesh's local
 * geometry coordinates already equal both world space and "model coordinates
 * (mm)" as sent to Claude. Every function below therefore operates directly
 * on `geometry`'s position attribute without a `matrixWorld` parameter. If a
 * later milestone starts transforming the mesh, that assumption needs to be
 * revisited (pass `mesh.matrixWorld` through and apply it before projecting).
 *
 * Design choices called out in the M4 spec:
 *  - Selection test is "triangle centroid projects into the marquee rect",
 *    not full triangle/rect clipping - simpler and good enough for MVP.
 *  - No back-face culling: a centroid that lands in the rect is selected
 *    whether or not its face points at the camera. Skipping this keeps the
 *    math simple and one-sided/thin-walled prints still select sensibly.
 *  - We *do* reject triangles behind the camera (clip-space w <= 0) - that's
 *    a basic frustum check, not back-face culling, and without it a
 *    perspective camera's divide-by-negative-w can flip a behind-camera
 *    point into the marquee rect by coincidence.
 *  - `summarizeSelection`'s centroid is the simple (unweighted) average of
 *    each selected triangle's own centroid, not an area-weighted average -
 *    cheaper and plenty precise for the chip/prompt context we show.
 */

export interface NdcRect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Builds a normalized (non-negative width/height) pixel rect from two drag points. */
export function rectFromPoints(a: Point, b: Point): PixelRect {
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  return { left, top, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/**
 * Grows a pixel rect (about its own center) so it is at least `minSize` wide
 * and tall. Used so a near-zero-size drag (a plain click) still tests a
 * small hit area around the pointer instead of a literal single point.
 */
export function padRectToMinSize(rect: PixelRect, minSize: number): PixelRect {
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const width = Math.max(rect.width, minSize)
  const height = Math.max(rect.height, minSize)
  return { left: cx - width / 2, top: cy - height / 2, width, height }
}

/**
 * Converts a pixel rect (relative to the viewport container, y-down) into an
 * NDC rect (-1..1, y-up), given the container's current CSS pixel size.
 */
export function pixelRectToNdc(rect: PixelRect, containerWidth: number, containerHeight: number): NdcRect {
  const ndcX = (px: number): number => (px / containerWidth) * 2 - 1
  const ndcY = (py: number): number => -((py / containerHeight) * 2 - 1)

  const ndcX0 = ndcX(rect.left)
  const ndcX1 = ndcX(rect.left + rect.width)
  const ndcY0 = ndcY(rect.top)
  const ndcY1 = ndcY(rect.top + rect.height)

  return {
    minX: Math.min(ndcX0, ndcX1),
    maxX: Math.max(ndcX0, ndcX1),
    minY: Math.min(ndcY0, ndcY1),
    maxY: Math.max(ndcY0, ndcY1)
  }
}

function assertNonIndexed(geometry: THREE.BufferGeometry): void {
  if (geometry.index !== null) {
    throw new Error('selection engine expects a non-indexed geometry (as produced by STLLoader)')
  }
}

/**
 * Returns the indices (0-based, one per triangle) of every triangle in
 * `geometry` whose centroid projects inside `rect` under `viewProjectionMatrix`.
 * `geometry` must be non-indexed, three-vertices-per-triangle (STLLoader's
 * output shape).
 */
export function selectTrianglesInRect(
  geometry: THREE.BufferGeometry,
  viewProjectionMatrix: THREE.Matrix4,
  rect: NdcRect
): number[] {
  assertNonIndexed(geometry)

  const position = geometry.getAttribute('position')
  const triCount = Math.floor(position.count / 3)
  const selected: number[] = []

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const centroid = new THREE.Vector3()
  const clip = new THREE.Vector4()

  for (let tri = 0; tri < triCount; tri++) {
    const base = tri * 3
    a.fromBufferAttribute(position, base)
    b.fromBufferAttribute(position, base + 1)
    c.fromBufferAttribute(position, base + 2)

    centroid.set((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3)
    clip.set(centroid.x, centroid.y, centroid.z, 1).applyMatrix4(viewProjectionMatrix)

    if (clip.w <= 0) continue // behind the camera - not a back-face test, a frustum test

    const ndcX = clip.x / clip.w
    const ndcY = clip.y / clip.w
    if (ndcX < rect.minX || ndcX > rect.maxX || ndcY < rect.minY || ndcY > rect.maxY) continue

    selected.push(tri)
  }

  return selected
}

/**
 * Summarizes selected triangles into the exact `SelectionSummary` shape
 * consumed by the main process / printable-cad skill. See the module-level
 * comment for the coordinate-space and centroid-averaging assumptions.
 */
export function summarizeSelection(geometry: THREE.BufferGeometry, selectedTriIndices: number[]): SelectionSummary {
  assertNonIndexed(geometry)

  const position = geometry.getAttribute('position')
  const bboxMin = new THREE.Vector3(Infinity, Infinity, Infinity)
  const bboxMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  const centroidSum = new THREE.Vector3()
  const v = new THREE.Vector3()

  for (const tri of selectedTriIndices) {
    const base = tri * 3
    const triCentroid = new THREE.Vector3()
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(position, base + k)
      bboxMin.min(v)
      bboxMax.max(v)
      triCentroid.add(v)
    }
    triCentroid.divideScalar(3)
    centroidSum.add(triCentroid)
  }

  const triCount = selectedTriIndices.length
  const centroid = triCount > 0 ? centroidSum.divideScalar(triCount) : new THREE.Vector3()
  if (triCount === 0) {
    bboxMin.set(0, 0, 0)
    bboxMax.set(0, 0, 0)
  }

  const dims = new THREE.Vector3().subVectors(bboxMax, bboxMin)

  return {
    bboxMin: [bboxMin.x, bboxMin.y, bboxMin.z],
    bboxMax: [bboxMax.x, bboxMax.y, bboxMax.z],
    centroid: [centroid.x, centroid.y, centroid.z],
    dims: [dims.x, dims.y, dims.z],
    triCount
  }
}

const HIGHLIGHT_COLOR = 0xffa64d

/**
 * Renders the currently-selected triangles as a translucent overlay mesh.
 * Reused across selections: call `update` with a fresh triangle list each
 * time, `dispose` once when the highlight is torn down for good.
 *
 * Z-fighting with the base mesh is avoided via depth-aware polygon offset on
 * the material rather than nudging vertices along face normals - it's robust
 * to the base mesh's own normals/geometry and needs no extra per-triangle math.
 */
export class SelectionHighlight {
  readonly object: THREE.Mesh

  constructor() {
    const geometry = new THREE.BufferGeometry()
    const material = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    })
    this.object = new THREE.Mesh(geometry, material)
    this.object.renderOrder = 10
    this.object.frustumCulled = false
  }

  /** Rebuilds the highlight geometry from `selectedTriIndices` of `sourceGeometry`. */
  update(sourceGeometry: THREE.BufferGeometry, selectedTriIndices: number[]): void {
    assertNonIndexed(sourceGeometry)

    const position = sourceGeometry.getAttribute('position')
    const positions = new Float32Array(selectedTriIndices.length * 3 * 3)
    const v = new THREE.Vector3()

    let offset = 0
    for (const tri of selectedTriIndices) {
      const base = tri * 3
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(position, base + k)
        positions[offset++] = v.x
        positions[offset++] = v.y
        positions[offset++] = v.z
      }
    }

    const geometry = this.object.geometry
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
  }

  dispose(): void {
    this.object.geometry.dispose()
    const material = this.object.material
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose())
    } else {
      material.dispose()
    }
  }
}
