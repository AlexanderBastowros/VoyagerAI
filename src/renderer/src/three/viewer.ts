import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { Placement } from '../../../shared/ipc'
import { MAIN_PART_ID } from '../../../shared/ipc'
import { colors } from '../colors'
import { applyPlacement, groundSnap } from './placement'
import { easeInOutCubic, upForDirection, ViewCubeGizmo, type ViewRegion } from './viewCube'

const BACKGROUND_COLOR = colors.bgApp
const MODEL_COLOR = colors.accent
/** Length (mm) of each axis line drawn by the orientation gizmo - large enough to read against
 *  the 200mm grid without dwarfing small parts. */
const AXES_SIZE = 35
/** Duration of the camera-snap tween triggered by a ViewCube click. */
const VIEW_TWEEN_MS = 350

/** In-flight `setViewDirection` animation state, advanced by `animate()` each frame. */
interface ViewTween {
  fromPosition: THREE.Vector3
  toPosition: THREE.Vector3
  fromUp: THREE.Vector3
  toUp: THREE.Vector3
  startTime: number
}

/** One rendered part (WS-I): its mesh, current placement, and visibility. The mesh's transform is
 *  the placement (layout only - the geometry itself is never modified). */
interface PartView {
  mesh: THREE.Mesh
  placement: Placement
  visible: boolean
}

/**
 * Thin wrapper around a three.js scene/camera/renderer set up for viewing one
 * or more CAD-style parts (WS-I multi-part, architecture doc §14): a map of
 * part id -> mesh, each positioned by its placement, with one part "focused"
 * for selection/measurement/gizmo interaction. Region-selection highlighting
 * and measurement overlays sit on top of this.
 */
export class ModelViewer {
  private readonly container: HTMLElement
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver

  private readonly viewCube: ViewCubeGizmo
  private readonly handleViewCubePointerDown: (event: PointerEvent) => void

  /** Every rendered part, keyed by part id (WS-I). Iterated in insertion order for camera framing. */
  private readonly parts = new Map<string, PartView>()
  /** The part selection/measurement/the placement gizmo act on; null when nothing is loaded. */
  private focusedPartId: string | null = null
  private highlight: THREE.Object3D | null = null
  private measurementObject: THREE.Object3D | null = null
  private axesHelper: THREE.AxesHelper | null = null
  /** Applied to every material created by `loadSTL` so the mode survives a model swap. */
  private wireframe = false
  private viewTween: ViewTween | null = null
  private rafHandle = 0
  private disposed = false

  constructor(container: HTMLElement) {
    this.container = container

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BACKGROUND_COLOR)

    const width = container.clientWidth || 1
    const height = container.clientHeight || 1

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000)
    this.camera.position.set(80, 65, 80)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(width, height)
    container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.target.set(0, 0, 0)

    this.scene.add(...this.createLights())
    this.scene.add(this.createGrid())

    // Corner orientation gizmo - lives in its own scene/camera/renderer (see viewCube.ts) so it
    // never touches the main render pipeline. It's always visible (independent of `showAxes`)
    // and tracks the camera regardless of whether a model is loaded.
    this.viewCube = new ViewCubeGizmo()
    container.appendChild(this.viewCube.getDomElement())
    this.handleViewCubePointerDown = (event) => this.onViewCubePointerDown(event)
    this.viewCube.getDomElement().addEventListener('pointerdown', this.handleViewCubePointerDown)

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)

    this.animate = this.animate.bind(this)
    this.rafHandle = requestAnimationFrame(this.animate)
  }

  /** Converts a click on the ViewCube canvas to NDC, raycasts it against the cube, and snaps
   *  the main camera to the resulting face/edge/corner direction (if the click hit the cube). */
  private onViewCubePointerDown(event: PointerEvent): void {
    const canvas = this.viewCube.getDomElement()
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1)

    const region = this.viewCube.raycast(ndcX, ndcY)
    if (region) this.setViewDirection(region)
  }

  private createLights(): THREE.Light[] {
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x3a3d42, 1.1)

    const key = new THREE.DirectionalLight(0xffffff, 1.2)
    key.position.set(120, 150, 100)

    const fill = new THREE.DirectionalLight(0xffffff, 0.4)
    fill.position.set(-100, 60, -80)

    return [hemisphere, key, fill]
  }

  private createGrid(): THREE.GridHelper {
    return new THREE.GridHelper(200, 20, 0x4a4d54, 0x2c2e33)
  }

  private animate(): void {
    if (this.disposed) return
    if (this.viewTween) this.advanceViewTween()
    else this.controls.update()
    this.renderer.render(this.scene, this.camera)
    // The gizmo mirrors whatever orientation the main camera ends up at this frame, whether
    // that came from user orbit input or an in-progress/just-applied view-snap tween.
    this.viewCube.syncOrientation(this.camera, this.controls.target)
    this.viewCube.render()
    this.rafHandle = requestAnimationFrame(this.animate)
  }

  /** Advances the in-flight `setViewDirection` tween (if any) by one frame: lerps camera
   *  position/up toward the target, re-derives the look-at, then lets OrbitControls resync its
   *  internal spherical state from the position we just set so damping/orbit behave normally
   *  once the tween finishes. Clears the tween once it reaches t=1. */
  private advanceViewTween(): void {
    const tween = this.viewTween
    if (!tween) return

    const elapsed = performance.now() - tween.startTime
    const t = Math.min(elapsed / VIEW_TWEEN_MS, 1)
    const eased = easeInOutCubic(t)

    this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased)
    this.camera.up.lerpVectors(tween.fromUp, tween.toUp, eased).normalize()
    this.camera.lookAt(this.controls.target)
    this.controls.update()

    if (t >= 1) this.viewTween = null
  }

  private handleResize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  /** Parses `buffer` into an origin-aligned mesh. The minimum corner is baked to the geometry
   *  origin (so an identity-placement part rests on the grid in the +X/+Y/+Z octant and its local
   *  coords equal world coords - what selection/measurement assume); the *placement* is then applied
   *  as the mesh transform, never baked into the geometry (layout != geometry, §14). */
  private buildMesh(buffer: ArrayBuffer): THREE.Mesh {
    const loader = new STLLoader()
    const geometry = loader.parse(buffer)
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    const bounds = geometry.boundingBox
    if (bounds) {
      geometry.translate(-bounds.min.x, -bounds.min.y, -bounds.min.z)
    }
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    const material = new THREE.MeshStandardMaterial({
      color: MODEL_COLOR,
      metalness: 0.1,
      roughness: 0.65,
      wireframe: this.wireframe
    })
    return new THREE.Mesh(geometry, material)
  }

  /**
   * Loads (or replaces) one part's geometry (WS-I). The part keeps its existing placement/visibility
   * when re-displayed (an agent refinement), or takes the supplied ones on first load. The first
   * part loaded becomes focused and frames the camera; additional parts leave the camera put so the
   * view doesn't jump around as a multi-part project fills in.
   */
  loadPart(partId: string, buffer: ArrayBuffer, placement?: Placement, visible = true): void {
    // Selection/measurement overlays refer to the old geometry - drop them on any (re)load.
    this.setHighlightObject(null)
    this.setMeasurementObject(null)

    const existing = this.parts.get(partId)
    const requested = placement ?? existing?.placement ?? { position: [0, 0, 0], rotation: [0, 0, 0] }
    const resolvedVisible = existing ? existing.visible : visible
    if (existing) this.disposeMesh(existing.mesh)

    const mesh = this.buildMesh(buffer)
    // Ground-snap against THIS geometry's bounds: a re-displayed (refined) part reuses its prior
    // placement, whose resting y was computed for the old geometry - re-deriving y here keeps the
    // part resting on the plate instead of floating/sinking. Ground-snap is thus the invariant
    // everywhere a placement is applied (here + setPartPlacement), so the store-sync effect can't
    // un-rest a part either.
    const box = mesh.geometry.boundingBox
    const resolvedPlacement = box ? groundSnap(requested, box.min, box.max) : requested
    applyPlacement(mesh, resolvedPlacement)
    mesh.visible = resolvedVisible
    this.scene.add(mesh)
    this.parts.set(partId, { mesh, placement: resolvedPlacement, visible: resolvedVisible })

    if (!this.focusedPartId || !this.parts.has(this.focusedPartId)) this.focusedPartId = partId
    if (this.parts.size === 1) this.frameCameraOn(mesh.geometry.boundingSphere)
  }

  /** Legacy single-part entrypoint (the sample-model loader): loads `buffer` as the sole `main`
   *  part, clearing any others. Multi-part callers use `loadPart`. */
  loadSTL(buffer: ArrayBuffer): void {
    this.clear()
    this.loadPart(MAIN_PART_ID, buffer)
  }

  /** Loads `stlBuffer` as the sole part if given, otherwise clears the viewport entirely. */
  syncModel(stlBuffer: ArrayBuffer | null): void {
    if (stlBuffer) this.loadSTL(stlBuffer)
    else this.clear()
  }

  /** Updates a part's placement (layout only), ground-snapped so the part rests on the plate for its
   *  current geometry (see `loadPart`). No-op for an unknown part. */
  setPartPlacement(partId: string, placement: Placement): void {
    const view = this.parts.get(partId)
    if (!view) return
    view.mesh.geometry.computeBoundingBox()
    const box = view.mesh.geometry.boundingBox
    const snapped = box ? groundSnap(placement, box.min, box.max) : placement
    view.placement = snapped
    applyPlacement(view.mesh, snapped)
  }

  /** Shows/hides a part. No-op for an unknown part. */
  setPartVisible(partId: string, visible: boolean): void {
    const view = this.parts.get(partId)
    if (!view) return
    view.visible = visible
    view.mesh.visible = visible
  }

  /** Removes and disposes a part's mesh. Refocuses another part if the removed one was focused. */
  removePart(partId: string): void {
    const view = this.parts.get(partId)
    if (!view) return
    this.disposeMesh(view.mesh)
    this.parts.delete(partId)
    if (this.focusedPartId === partId) {
      this.setHighlightObject(null)
      this.focusedPartId = this.parts.keys().next().value ?? null
    }
  }

  /** The part ids currently loaded, in insertion order. */
  getPartIds(): string[] {
    return [...this.parts.keys()]
  }

  /** Marks which part selection/measurement/the placement gizmo act on. */
  focusPart(partId: string | null): void {
    if (partId !== null && !this.parts.has(partId)) return
    if (this.focusedPartId !== partId) this.setHighlightObject(null)
    this.focusedPartId = partId
  }

  /** The focused part id, or null if nothing is loaded. */
  getFocusedPartId(): string | null {
    return this.focusedPartId
  }

  /** A specific part's mesh (for the placement gizmo to attach to), or null. */
  getPartMesh(partId: string): THREE.Mesh | null {
    return this.parts.get(partId)?.mesh ?? null
  }

  private disposeMesh(mesh: THREE.Mesh): void {
    this.scene.remove(mesh)
    mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material.dispose()
  }

  /** Frames the camera on the combined bounds of every visible part (WS-I) - used after multi-part
   *  hydration so the whole arrangement is in view, not just the first-loaded part. */
  frameAll(): void {
    const box = new THREE.Box3()
    let any = false
    for (const view of this.parts.values()) {
      if (!view.visible) continue
      view.mesh.updateMatrixWorld()
      box.expandByObject(view.mesh)
      any = true
    }
    if (!any || box.isEmpty()) return
    this.frameCameraOn(box.getBoundingSphere(new THREE.Sphere()))
  }

  private frameCameraOn(sphere: THREE.Sphere | null): void {
    if (!sphere || sphere.radius <= 0) return

    const fitRadius = Math.max(sphere.radius, 1e-3)
    const verticalFovRad = (this.camera.fov * Math.PI) / 180
    const distance = (fitRadius / Math.sin(verticalFovRad / 2)) * 1.25

    const direction = new THREE.Vector3(1, 0.8, 1).normalize()
    this.camera.position.copy(sphere.center.clone().addScaledVector(direction, distance))
    this.camera.near = Math.max(distance / 100, 0.01)
    this.camera.far = distance * 100
    this.camera.updateProjectionMatrix()

    this.controls.target.copy(sphere.center)
    this.controls.update()
  }

  /**
   * Removes and disposes every loaded part, and detaches (but does not dispose
   * - the caller owns its lifecycle) any active selection highlight or
   * measurement overlay, since both refer to points/triangles on a mesh being
   * cleared. Safe to call repeatedly.
   */
  clear(): void {
    this.setHighlightObject(null)
    this.setMeasurementObject(null)
    for (const view of this.parts.values()) this.disposeMesh(view.mesh)
    this.parts.clear()
    this.focusedPartId = null
  }

  /** The focused part's mesh, or null if nothing is loaded - what selection/measurement act on. */
  getMesh(): THREE.Mesh | null {
    return this.focusedPartId ? (this.parts.get(this.focusedPartId)?.mesh ?? null) : null
  }

  /** The focused part's bounding-box size (X/Y/Z, mm), or null if no model is loaded. */
  getDimensions(): { x: number; y: number; z: number } | null {
    const box = this.getMesh()?.geometry.boundingBox
    if (!box) return null
    return { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z }
  }

  /** The viewer's camera - useful for building a view-projection matrix for selection. */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera
  }

  /** The viewer's scene - so the placement controller can add its `TransformControls` helper (WS-I). */
  getScene(): THREE.Scene {
    return this.scene
  }

  /** The canvas element selection interaction should attach pointer listeners to. */
  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  /** Enables/disables OrbitControls - used while a marquee-select drag is in progress. */
  setOrbitEnabled(enabled: boolean): void {
    this.controls.enabled = enabled
  }

  /**
   * Attaches `object` to the scene as the active selection highlight,
   * detaching whatever highlight object (if any) was previously attached.
   * Pass null to detach without attaching a replacement. Does not dispose
   * the detached object - the caller (which created it) owns disposal.
   */
  setHighlightObject(object: THREE.Object3D | null): void {
    if (this.highlight === object) return
    if (this.highlight?.parent) this.highlight.parent.remove(this.highlight)
    this.highlight = object
    // Parent the highlight under the focused part's mesh (not the scene) so it inherits that part's
    // placement transform - the highlight is built in the mesh's local geometry coords, so a placed
    // part's highlight would otherwise render at the origin instead of on the part.
    if (this.highlight) (this.getMesh() ?? this.scene).add(this.highlight)
  }

  /**
   * Attaches `object` to the scene as the active measurement overlay (the
   * line + point markers built by `MeasurementController`), detaching
   * whatever measurement object (if any) was previously attached. Pass null
   * to detach without attaching a replacement. Mirrors `setHighlightObject`
   * but uses a dedicated slot - measurement and selection can be visible
   * independently of one another. Does not dispose the detached object.
   */
  setMeasurementObject(object: THREE.Object3D | null): void {
    if (this.measurementObject === object) return
    if (this.measurementObject) this.scene.remove(this.measurementObject)
    this.measurementObject = object
    if (this.measurementObject) this.scene.add(this.measurementObject)
  }

  /** Shows/hides the XYZ orientation gizmo. Since it's added directly to the scene (not the
   *  camera), it orbits along with everything else as the user rotates the view. Created lazily
   *  on first enable. */
  setAxesVisible(enabled: boolean): void {
    if (!this.axesHelper) {
      if (!enabled) return
      this.axesHelper = new THREE.AxesHelper(AXES_SIZE)
    }
    this.axesHelper.visible = enabled
    if (enabled && this.axesHelper.parent !== this.scene) this.scene.add(this.axesHelper)
  }

  /** Toggles wireframe rendering on the current mesh (if any) and remembers the setting so it
   *  carries over to the next model loaded via `loadSTL`/`syncModel`. */
  setWireframe(enabled: boolean): void {
    this.wireframe = enabled
    for (const view of this.parts.values()) {
      ;(view.mesh.material as THREE.MeshStandardMaterial).wireframe = enabled
    }
  }

  /**
   * Animates the main camera so its view direction becomes `dir`, as if orbited there by hand:
   * `controls.target` and the current distance-to-target are both preserved, only the camera's
   * position (and, for the straight-up/down cases, its up-vector) change. Driven by `animate()`
   * over `VIEW_TWEEN_MS`; calling this again mid-tween replaces the in-flight one rather than
   * stacking, so rapid ViewCube clicks always animate toward the latest click.
   */
  setViewDirection(dir: [number, number, number] | THREE.Vector3): void {
    const raw: ViewRegion = dir instanceof THREE.Vector3 ? [dir.x, dir.y, dir.z] : dir
    const direction = new THREE.Vector3(raw[0], raw[1], raw[2])
    if (direction.lengthSq() === 0) return
    direction.normalize()

    const target = this.controls.target
    const distance = this.camera.position.distanceTo(target)
    const toPosition = target.clone().addScaledVector(direction, distance)

    const axisSigns = raw.map((component) => Math.sign(component)) as ViewRegion
    const [upX, upY, upZ] = upForDirection(axisSigns)

    this.viewTween = {
      fromPosition: this.camera.position.clone(),
      toPosition,
      fromUp: this.camera.up.clone(),
      toUp: new THREE.Vector3(upX, upY, upZ),
      startTime: performance.now()
    }
  }

  /** Tears down the renderer, controls, and observers. The instance is unusable after this. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    cancelAnimationFrame(this.rafHandle)
    this.resizeObserver.disconnect()
    this.clear()
    if (this.axesHelper) {
      this.axesHelper.geometry.dispose()
      ;(this.axesHelper.material as THREE.Material).dispose()
    }
    this.viewCube.getDomElement().removeEventListener('pointerdown', this.handleViewCubePointerDown)
    this.viewCube.dispose()
    this.controls.dispose()
    this.renderer.dispose()

    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
