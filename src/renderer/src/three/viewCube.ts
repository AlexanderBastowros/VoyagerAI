import * as THREE from 'three'
import { colors } from '../colors'

/**
 * ViewCube camera gizmo: the small orientation cube (FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM) drawn
 * in a corner of the viewport that tracks the main camera's orientation and, on click, snaps
 * the camera to the clicked face/edge/corner view. Split the same way `selection.ts` and
 * `measurement.ts` are: pure, DOM/WebGL-free math (`regionFromHitPoint`, `upForDirection`,
 * `easeInOutCubic`) lives at the top of this file so it's unit-testable in the node vitest
 * env, and the WebGL-backed `ViewCubeGizmo` overlay (which needs a real `<canvas>`/GL context
 * and so is exercised manually rather than under vitest) lives below it.
 */

/** A direction with each component in {-1,0,1}, not all zero - identifies a face (one non-zero
 *  component), edge (two), or corner (three) of the cube. */
export type ViewRegion = [number, number, number]

/** Face-axis -> label, keyed by `dir.join(',')`. Matches the app's up=+Y convention: the
 *  default camera looks toward the origin from (+X,+Y,+Z)-ish, so +Z is treated as FRONT. */
export const VIEW_LABELS: Record<string, string> = {
  '1,0,0': 'RIGHT',
  '-1,0,0': 'LEFT',
  '0,1,0': 'TOP',
  '0,-1,0': 'BOTTOM',
  '0,0,1': 'FRONT',
  '0,0,-1': 'BACK'
}

/**
 * Quantizes a raycast hit point on a unit cube (half-extent 1, centered at origin) into a
 * face/edge/corner direction: each axis whose magnitude is >= `threshold` snaps to its sign,
 * the rest go to 0. A hit dead-center on a face has its two off-axis coordinates near 0 (well
 * under threshold) and its face-axis coordinate pinned near +-1 (always over threshold), so
 * that's naturally the only case handled above. The explicit fallback below only matters for
 * inputs where every axis is under `threshold` (e.g. loose/synthetic test points) - it forces
 * the single largest-magnitude axis to snap so the result is never all-zero.
 */
export function regionFromHitPoint(point: { x: number; y: number; z: number }, threshold = 0.6): ViewRegion {
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z']
  const region: number[] = [0, 0, 0]

  let dominantIndex = 0
  let dominantMag = -Infinity
  let hasNonZero = false
  axes.forEach((axis, i) => {
    const value = point[axis]
    const mag = Math.abs(value)
    if (mag >= threshold) {
      region[i] = Math.sign(value)
      hasNonZero = true
    }
    if (mag > dominantMag) {
      dominantMag = mag
      dominantIndex = i
    }
  })

  if (!hasNonZero) {
    const dominantValue = point[axes[dominantIndex]]
    // A dominant value of exactly 0 only happens for the origin itself; default to +1 rather
    // than returning an all-zero region.
    region[dominantIndex] = dominantValue === 0 ? 1 : Math.sign(dominantValue)
  }

  return region as ViewRegion
}

/** Camera up-vector for a snapped view direction. Looking straight down +Y or -Y makes the
 *  default (0,1,0) up degenerate (camera forward and up become parallel), so those two cases
 *  use a world axis (+-Z) instead; every other direction (including all edges/corners) keeps
 *  the default. */
export function upForDirection(dir: ViewRegion): [number, number, number] {
  if (dir[0] === 0 && dir[1] === 1 && dir[2] === 0) return [0, 0, -1]
  if (dir[0] === 0 && dir[1] === -1 && dir[2] === 0) return [0, 0, 1]
  return [0, 1, 0]
}

/** Standard cubic ease-in-out, used to shape the camera-snap tween's progress. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** BoxGeometry groups its 6 faces in [+X,-X,+Y,-Y,+Z,-Z] order - this array (and the materials
 *  built from it) must stay in that order so each texture lands on the right face. */
const BOX_FACE_DIRECTIONS: ViewRegion[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
]

const CANVAS_CSS_SIZE = 96
const CUBE_HALF_EXTENT = 1
const CAMERA_DISTANCE = 4.2
const FRUSTUM_HALF_SIZE = 1.9
const FACE_TEXTURE_SIZE = 128

/** Draws a single face's label onto a small canvas texture. */
function makeFaceTexture(label: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = FACE_TEXTURE_SIZE
  canvas.height = FACE_TEXTURE_SIZE

  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = colors.bgPanelRaised
    ctx.fillRect(0, 0, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE)
    ctx.strokeStyle = colors.borderStrong
    ctx.lineWidth = 4
    ctx.strokeRect(2, 2, FACE_TEXTURE_SIZE - 4, FACE_TEXTURE_SIZE - 4)
    ctx.fillStyle = colors.textPrimary
    ctx.font = `600 ${FACE_TEXTURE_SIZE * 0.16}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, FACE_TEXTURE_SIZE / 2, FACE_TEXTURE_SIZE / 2)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * The corner ViewCube overlay: its own tiny scene/camera/renderer rendered into a dedicated
 * transparent canvas so it never disturbs the main viewer's renderer or camera. `syncOrientation`
 * mirrors the main camera's viewing direction each frame so the cube always shows the labeled
 * face the user is currently looking at; `raycast` turns a click on the gizmo canvas into a
 * `ViewRegion` for `ModelViewer.setViewDirection` to snap to.
 */
export class ViewCubeGizmo {
  private readonly scene: THREE.Scene
  private readonly camera: THREE.OrthographicCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly cube: THREE.Mesh
  private readonly materials: THREE.MeshBasicMaterial[]
  private readonly textures: THREE.CanvasTexture[]
  private readonly edges: THREE.LineSegments
  private readonly raycaster = new THREE.Raycaster()

  constructor() {
    this.scene = new THREE.Scene()

    this.camera = new THREE.OrthographicCamera(
      -FRUSTUM_HALF_SIZE,
      FRUSTUM_HALF_SIZE,
      FRUSTUM_HALF_SIZE,
      -FRUSTUM_HALF_SIZE,
      0.1,
      100
    )
    this.camera.position.set(0, 0, CAMERA_DISTANCE)
    this.camera.lookAt(0, 0, 0)

    // Flat ambient lighting - the cube reads via its label textures, not shading.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2))

    this.textures = BOX_FACE_DIRECTIONS.map((dir) => makeFaceTexture(VIEW_LABELS[dir.join(',')]))
    this.materials = this.textures.map((map) => new THREE.MeshBasicMaterial({ map }))

    const size = CUBE_HALF_EXTENT * 2
    const geometry = new THREE.BoxGeometry(size, size, size)
    this.cube = new THREE.Mesh(geometry, this.materials)
    this.scene.add(this.cube)

    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: colors.borderStrong })
    )
    this.scene.add(this.edges)

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(CANVAS_CSS_SIZE, CANVAS_CSS_SIZE)
    this.renderer.domElement.className = 'view-cube'
  }

  /** Orients the gizmo camera to match `mainCamera`'s viewing direction (as seen from `target`),
   *  so the cube face toward the viewer always corresponds to what's on screen. */
  syncOrientation(mainCamera: THREE.PerspectiveCamera, target: THREE.Vector3): void {
    const direction = mainCamera.position.clone().sub(target)
    if (direction.lengthSq() === 0) return
    direction.normalize()

    this.camera.position.copy(direction).multiplyScalar(CAMERA_DISTANCE)
    this.camera.up.copy(mainCamera.up)
    this.camera.lookAt(0, 0, 0)
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  /** Raycasts from the gizmo camera through NDC point (`ndcX`,`ndcY`) against the cube and
   *  returns the hit region, or null on a miss. */
  raycast(ndcX: number, ndcY: number): ViewRegion | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const hits = this.raycaster.intersectObject(this.cube, false)
    if (hits.length === 0) return null

    const local = this.cube.worldToLocal(hits[0].point.clone())
    return regionFromHitPoint({
      x: local.x / CUBE_HALF_EXTENT,
      y: local.y / CUBE_HALF_EXTENT,
      z: local.z / CUBE_HALF_EXTENT
    })
  }

  /** The canvas element to append into the viewport container and attach click listeners to. */
  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  /** Disposes geometries/materials/textures/renderer and detaches the canvas from its parent. */
  dispose(): void {
    this.cube.geometry.dispose()
    this.materials.forEach((material) => material.dispose())
    this.textures.forEach((texture) => texture.dispose())
    this.edges.geometry.dispose()
    ;(this.edges.material as THREE.Material).dispose()
    this.renderer.dispose()

    const canvas = this.renderer.domElement
    canvas.parentElement?.removeChild(canvas)
  }
}
