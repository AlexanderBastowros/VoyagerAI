import { pixelToNdc, raycastPoint, MeasurementOverlay } from './measurement'
import type { Point } from './selection'
import type { ModelViewer } from './viewer'
import type * as THREE from 'three'

export interface MeasurementControllerOptions {
  /** The element pointer listeners attach to (the viewport container). */
  container: HTMLElement
  /** Looked up on demand so the controller tolerates the viewer being recreated. */
  getViewer: () => ModelViewer | null
  /** Reused across measurements; the controller updates and (re)attaches it. */
  overlay: MeasurementOverlay
  /** Called with the completed distance (mm), or null once cleared/reset/in-progress. */
  onMeasureChange: (distanceMm: number | null) => void
}

/**
 * DOM glue for the point-to-point measurement tool: click -> raycast against
 * the displayed mesh (see ./measurement.ts) -> overlay + store update. Two
 * clicks complete a measurement; a third click starts a fresh one. Not unit
 * tested directly (no DOM/WebGL in the vitest environment); the raycasting
 * math it delegates to is covered by measurement.test.ts.
 */
export class MeasurementController {
  private readonly options: MeasurementControllerOptions
  private active = false
  private pointA: THREE.Vector3 | null = null
  private pointB: THREE.Vector3 | null = null

  constructor(options: MeasurementControllerOptions) {
    this.options = options

    this.handlePointerDown = this.handlePointerDown.bind(this)
    this.handleKeyDown = this.handleKeyDown.bind(this)

    this.options.container.addEventListener('pointerdown', this.handlePointerDown)
    window.addEventListener('keydown', this.handleKeyDown)
  }

  /**
   * Turns measure-mode interaction on/off. Orbit is disabled for the whole
   * time measure mode is active (not just mid-click) - same
   * pointerdown-vs-OrbitControls bubbling race as `SelectionController.setActive`,
   * since the canvas is nested inside `container` and events bubble
   * target-first.
   */
  setActive(active: boolean): void {
    this.active = active
    this.options.getViewer()?.setOrbitEnabled(!active)
    if (!active) this.reset()
  }

  dispose(): void {
    this.options.container.removeEventListener('pointerdown', this.handlePointerDown)
    window.removeEventListener('keydown', this.handleKeyDown)
  }

  /**
   * Clears any in-progress or completed measurement and detaches the
   * overlay. Safe to call repeatedly - used on deactivation, Escape, and
   * from Viewport's effect watching the store's `measurement` field so a
   * model swap (which clears `measurement` via `setModel`) also tears down
   * a now-stale line.
   */
  reset(): void {
    this.pointA = null
    this.pointB = null
    this.options.getViewer()?.setMeasurementObject(null)
    this.options.onMeasureChange(null)
  }

  private handlePointerDown(event: PointerEvent): void {
    if (!this.active || event.button !== 0) return

    const viewer = this.options.getViewer()
    const mesh = viewer?.getMesh()
    if (!viewer || !mesh) return

    const containerRect = this.options.container.getBoundingClientRect()
    const point: Point = { x: event.clientX - containerRect.left, y: event.clientY - containerRect.top }
    const ndc = pixelToNdc(point, this.options.container.clientWidth, this.options.container.clientHeight)

    const hit = raycastPoint(viewer.getCamera(), mesh, ndc)
    if (!hit) return

    if (this.pointA && this.pointB) {
      // A third click after a completed measurement starts a fresh one at the new point.
      this.pointA = hit
      this.pointB = null
      this.options.overlay.showFirstPoint(hit)
      viewer.setMeasurementObject(this.options.overlay.object)
      this.options.onMeasureChange(null)
      return
    }

    if (!this.pointA) {
      this.pointA = hit
      this.options.overlay.showFirstPoint(hit)
      viewer.setMeasurementObject(this.options.overlay.object)
      return
    }

    this.pointB = hit
    this.options.overlay.update(this.pointA, this.pointB)
    this.options.onMeasureChange(this.pointA.distanceTo(this.pointB))
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.active) return
    this.reset()
  }
}
