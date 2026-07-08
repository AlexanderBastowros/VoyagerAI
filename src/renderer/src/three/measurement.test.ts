import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { pixelToNdc, raycastPoint, MeasurementOverlay } from './measurement'

/** Builds a single-triangle mesh in the z=0 plane, large enough to be hit by a
 *  straight-down-the-Z-axis ray through the NDC origin. */
function planeMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array([-10, -10, 0, 10, -10, 0, 0, 10, 0])
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

function cameraLookingAtOrigin(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  return camera
}

describe('pixelToNdc', () => {
  it('converts a pixel point (y-down) into NDC (-1..1, y-up)', () => {
    // Container center maps to the NDC origin (toBeCloseTo, not toBe/toEqual - the y sign flip
    // can produce -0, which fails strict equality against +0 despite being numerically equal).
    const ndc = pixelToNdc({ x: 100, y: 50 }, 200, 100)
    expect(ndc.x).toBeCloseTo(0)
    expect(ndc.y).toBeCloseTo(0)
  })

  it('flips the Y axis (pixel top -> NDC +1, pixel bottom -> NDC -1)', () => {
    expect(pixelToNdc({ x: 0, y: 0 }, 200, 100)).toEqual({ x: -1, y: 1 })
    expect(pixelToNdc({ x: 200, y: 100 }, 200, 100)).toEqual({ x: 1, y: -1 })
  })
})

describe('raycastPoint', () => {
  it('returns the world-space hit point when the ray intersects the mesh', () => {
    const mesh = planeMesh()
    const camera = cameraLookingAtOrigin()

    const hit = raycastPoint(camera, mesh, { x: 0, y: 0 })

    expect(hit).not.toBeNull()
    expect(hit!.x).toBeCloseTo(0)
    expect(hit!.y).toBeCloseTo(0)
    expect(hit!.z).toBeCloseTo(0)
  })

  it('returns null when the ray misses the mesh entirely', () => {
    const mesh = planeMesh()
    const camera = cameraLookingAtOrigin()

    // Far outside the triangle in NDC space (camera FOV is 90deg, mesh only spans +-10 at z=0).
    const hit = raycastPoint(camera, mesh, { x: 0.99, y: 0.99 })

    expect(hit).toBeNull()
  })
})

describe('MeasurementOverlay', () => {
  it('positions the line endpoints and both markers on update()', () => {
    const overlay = new MeasurementOverlay()
    const a = new THREE.Vector3(0, 0, 0)
    const b = new THREE.Vector3(3, 4, 0)

    overlay.update(a, b)

    const line = overlay.object.children.find((c) => c instanceof THREE.Line) as THREE.Line
    const position = line.geometry.getAttribute('position')
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([0, 0, 0])
    expect([position.getX(1), position.getY(1), position.getZ(1)]).toEqual([3, 4, 0])
    expect(line.visible).toBe(true)

    overlay.dispose()
  })

  it('shows only the first marker via showFirstPoint()', () => {
    const overlay = new MeasurementOverlay()
    overlay.showFirstPoint(new THREE.Vector3(1, 2, 3))

    const [line, markerA, markerB] = overlay.object.children as [THREE.Line, THREE.Mesh, THREE.Mesh]
    expect(line.visible).toBe(false)
    expect(markerA.visible).toBe(true)
    expect(markerB.visible).toBe(false)
    expect(markerA.position.toArray()).toEqual([1, 2, 3])

    overlay.dispose()
  })
})
