import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  padRectToMinSize,
  pixelRectToNdc,
  rectFromPoints,
  selectTrianglesInRect,
  summarizeSelection,
  SelectionHighlight
} from './selection'

/** Builds a non-indexed BufferGeometry from a flat list of triangles (each 3 [x,y,z] tuples). */
function geometryFromTriangles(triangles: Array<[number, number, number][]>): THREE.BufferGeometry {
  const positions = new Float32Array(triangles.length * 9)
  let offset = 0
  for (const tri of triangles) {
    for (const [x, y, z] of tri) {
      positions[offset++] = x
      positions[offset++] = y
      positions[offset++] = z
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geometry
}

describe('rectFromPoints', () => {
  it('normalizes width/height and top-left regardless of drag direction', () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 50, y: 40 })).toEqual({
      left: 10,
      top: 10,
      width: 40,
      height: 30
    })
    // dragged up-left instead of down-right - same resulting rect
    expect(rectFromPoints({ x: 50, y: 40 }, { x: 10, y: 10 })).toEqual({
      left: 10,
      top: 10,
      width: 40,
      height: 30
    })
  })
})

describe('padRectToMinSize', () => {
  it('grows a near-zero rect about its center up to minSize', () => {
    const padded = padRectToMinSize({ left: 100, top: 100, width: 0, height: 0 }, 6)
    expect(padded).toEqual({ left: 97, top: 97, width: 6, height: 6 })
  })

  it('leaves a rect already >= minSize untouched', () => {
    const rect = { left: 5, top: 5, width: 40, height: 30 }
    expect(padRectToMinSize(rect, 6)).toEqual(rect)
  })
})

describe('pixelRectToNdc', () => {
  it('converts a pixel rect (y-down) into an NDC rect (y-up, -1..1)', () => {
    // 200x100 container; rect spans the full container.
    const ndc = pixelRectToNdc({ left: 0, top: 0, width: 200, height: 100 }, 200, 100)
    expect(ndc.minX).toBeCloseTo(-1)
    expect(ndc.maxX).toBeCloseTo(1)
    expect(ndc.minY).toBeCloseTo(-1)
    expect(ndc.maxY).toBeCloseTo(1)
  })

  it('flips the Y axis (pixel top -> NDC max, pixel bottom -> NDC min)', () => {
    // Top-left quadrant in pixel space (y-down) is the top-left quadrant on
    // screen, which is the top-LEFT in NDC too (x still low, but y is HIGH
    // since NDC y grows upward while pixel y grows downward).
    const ndc = pixelRectToNdc({ left: 0, top: 0, width: 100, height: 50 }, 200, 100)
    expect(ndc.minX).toBeCloseTo(-1)
    expect(ndc.maxX).toBeCloseTo(0)
    expect(ndc.minY).toBeCloseTo(0)
    expect(ndc.maxY).toBeCloseTo(1)
  })
})

describe('selectTrianglesInRect', () => {
  it('throws on an indexed geometry (only non-indexed STLLoader output is supported)', () => {
    const geometry = geometryFromTriangles([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
      ]
    ])
    geometry.setIndex([0, 1, 2])
    const identity = new THREE.Matrix4()
    expect(() => selectTrianglesInRect(geometry, identity, { minX: -1, maxX: 1, minY: -1, maxY: 1 })).toThrow()
  })

  it('selects only triangles whose centroid projects inside the rect, and rejects triangles behind the camera', () => {
    const geometry = geometryFromTriangles([
      // 0: front-center - centroid near (0, -0.33, 0)
      [
        [-1, -1, 0],
        [1, -1, 0],
        [0, 1, 0]
      ],
      // 1: front, but out toward the frustum edge - centroid ~ (7.67, 7.67, 0)
      [
        [7, 7, 0],
        [9, 7, 0],
        [7, 9, 0]
      ],
      // 2: behind the camera (camera sits at world z=10 looking toward -Z)
      [
        [0, 0, 15],
        [1, 0, 15],
        [0, 1, 15]
      ]
    ])

    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()

    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

    // A tight rect around the NDC origin should hit only triangle 0.
    const tightRect = { minX: -0.3, maxX: 0.3, minY: -0.3, maxY: 0.3 }
    expect(selectTrianglesInRect(geometry, viewProjection, tightRect)).toEqual([0])

    // A rect covering the whole NDC space should hit 0 and 1, but never the
    // behind-camera triangle 2, even though its raw x/y would otherwise land
    // inside this generous rect.
    const wholeScreen = { minX: -1, maxX: 1, minY: -1, maxY: 1 }
    expect(selectTrianglesInRect(geometry, viewProjection, wholeScreen)).toEqual([0, 1])
  })

  it('returns an empty array when nothing falls inside the rect', () => {
    const geometry = geometryFromTriangles([
      [
        [50, 50, 0],
        [52, 50, 0],
        [50, 52, 0]
      ]
    ])
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

    expect(selectTrianglesInRect(geometry, viewProjection, { minX: -0.2, maxX: 0.2, minY: -0.2, maxY: 0.2 })).toEqual(
      []
    )
  })
})

describe('summarizeSelection', () => {
  it('computes exact bbox/centroid/dims/triCount for a crafted two-triangle selection', () => {
    const geometry = geometryFromTriangles([
      [
        [0, 0, 0],
        [2, 0, 0],
        [0, 2, 0]
      ],
      [
        [4, 4, 4],
        [6, 4, 4],
        [4, 6, 4]
      ]
    ])

    const summary = summarizeSelection(geometry, [0, 1])

    expect(summary.bboxMin).toEqual([0, 0, 0])
    expect(summary.bboxMax).toEqual([6, 6, 4])
    expect(summary.dims).toEqual([6, 6, 4])
    expect(summary.triCount).toBe(2)

    // centroid = simple average of each triangle's own centroid, not an
    // area-weighted average or a flat average of all 6 vertices.
    const tri0Centroid = [2 / 3, 2 / 3, 0]
    const tri1Centroid = [14 / 3, 14 / 3, 4]
    expect(summary.centroid[0]).toBeCloseTo((tri0Centroid[0] + tri1Centroid[0]) / 2)
    expect(summary.centroid[1]).toBeCloseTo((tri0Centroid[1] + tri1Centroid[1]) / 2)
    expect(summary.centroid[2]).toBeCloseTo((tri0Centroid[2] + tri1Centroid[2]) / 2)
  })

  it('returns an all-zero summary for an empty selection', () => {
    const geometry = geometryFromTriangles([
      [
        [0, 0, 0],
        [2, 0, 0],
        [0, 2, 0]
      ]
    ])

    const summary = summarizeSelection(geometry, [])

    expect(summary).toEqual({
      bboxMin: [0, 0, 0],
      bboxMax: [0, 0, 0],
      centroid: [0, 0, 0],
      dims: [0, 0, 0],
      triCount: 0
    })
  })
})

describe('SelectionHighlight', () => {
  it('builds a geometry containing exactly the selected triangles vertices', () => {
    const geometry = geometryFromTriangles([
      [
        [0, 0, 0],
        [2, 0, 0],
        [0, 2, 0]
      ],
      [
        [4, 4, 4],
        [6, 4, 4],
        [4, 6, 4]
      ]
    ])

    const highlight = new SelectionHighlight()
    highlight.update(geometry, [1])

    const position = highlight.object.geometry.getAttribute('position')
    expect(position.count).toBe(3)
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([4, 4, 4])

    highlight.dispose()
  })
})
