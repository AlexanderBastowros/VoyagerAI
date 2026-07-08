import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { colors } from '../colors'

const BACKGROUND_COLOR = colors.bgApp
const MODEL_COLOR = colors.accent
/** Length (mm) of each axis line drawn by the orientation gizmo - large enough to read against
 *  the 200mm grid without dwarfing small parts. */
const AXES_SIZE = 35

/**
 * Thin wrapper around a three.js scene/camera/renderer set up for viewing a
 * single CAD-style model at a time. Later milestones will add region
 * selection highlighting and refinement overlays on top of this.
 */
export class ModelViewer {
  private readonly container: HTMLElement
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver

  private mesh: THREE.Mesh | null = null
  private highlight: THREE.Object3D | null = null
  private measurementObject: THREE.Object3D | null = null
  private axesHelper: THREE.AxesHelper | null = null
  /** Applied to every material created by `loadSTL` so the mode survives a model swap. */
  private wireframe = false
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

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)

    this.animate = this.animate.bind(this)
    this.rafHandle = requestAnimationFrame(this.animate)
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
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.rafHandle = requestAnimationFrame(this.animate)
  }

  private handleResize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  /** Parses `buffer` as an STL and displays it, replacing any current model. */
  loadSTL(buffer: ArrayBuffer): void {
    this.clear()

    const loader = new STLLoader()
    const geometry = loader.parse(buffer)
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
    geometry.computeBoundingBox()

    const material = new THREE.MeshStandardMaterial({
      color: MODEL_COLOR,
      metalness: 0.1,
      roughness: 0.65,
      wireframe: this.wireframe
    })

    const mesh = new THREE.Mesh(geometry, material)
    this.mesh = mesh
    this.scene.add(mesh)

    this.frameCameraOn(geometry.boundingSphere)
  }

  /** Loads `stlBuffer` if given, otherwise clears the viewport entirely - the shared sync
   *  point for both the live `model:displayed` event and project-switch/create hydration,
   *  where a freshly-switched-to project may have no model yet. */
  syncModel(stlBuffer: ArrayBuffer | null): void {
    if (stlBuffer) this.loadSTL(stlBuffer)
    else this.clear()
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
   * Removes and disposes the current model, if any, and detaches (but does
   * not dispose - the caller owns its lifecycle) any active selection
   * highlight or measurement overlay, since both refer to points/triangles
   * on the mesh being cleared. Safe to call repeatedly.
   */
  clear(): void {
    this.setHighlightObject(null)
    this.setMeasurementObject(null)

    if (!this.mesh) return

    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()

    const material = this.mesh.material
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose())
    } else {
      material.dispose()
    }

    this.mesh = null
  }

  /** The currently displayed mesh, or null if no model is loaded. */
  getMesh(): THREE.Mesh | null {
    return this.mesh
  }

  /** The current mesh's bounding-box size (X/Y/Z, mm), or null if no model is loaded. */
  getDimensions(): { x: number; y: number; z: number } | null {
    const box = this.mesh?.geometry.boundingBox
    if (!box) return null
    return { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z }
  }

  /** The viewer's camera - useful for building a view-projection matrix for selection. */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera
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
    if (this.highlight) this.scene.remove(this.highlight)
    this.highlight = object
    if (this.highlight) this.scene.add(this.highlight)
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
    if (this.mesh) (this.mesh.material as THREE.MeshStandardMaterial).wireframe = enabled
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
    this.controls.dispose()
    this.renderer.dispose()

    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}
