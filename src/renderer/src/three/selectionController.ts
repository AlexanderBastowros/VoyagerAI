import * as THREE from 'three'
import type { SelectionSummary } from '../../../shared/ipc'
import {
  padRectToMinSize,
  pixelRectToNdc,
  rectFromPoints,
  selectTrianglesInRect,
  summarizeSelection,
  SelectionHighlight
} from './selection'
import type { Point } from './selection'
import type { ModelViewer } from './viewer'

/** Drags shorter than this (in either axis) are treated as a plain click. */
const MIN_HIT_SIZE_PX = 6

export interface SelectionControllerOptions {
  /** The element pointer/keyboard listeners attach to (the viewport container). */
  container: HTMLElement
  /** Absolutely-positioned element this controller shows/hides/resizes as the marquee. */
  marqueeElement: HTMLElement
  /** Looked up on demand so the controller tolerates the viewer being recreated. */
  getViewer: () => ModelViewer | null
  /** Reused across selections; the controller updates and (re)attaches it. */
  highlight: SelectionHighlight
  /** Called with the new selection summary, or null to clear. */
  onSelectionChange: (selection: SelectionSummary | null) => void
}

/**
 * DOM glue for viewport region selection: marquee drag -> NDC rect -> pure
 * triangle selection (see ./selection.ts) -> highlight + store update.
 * Not unit tested directly (no DOM in the vitest environment); the math it
 * delegates to is covered by selection.test.ts.
 */
export class SelectionController {
  private readonly options: SelectionControllerOptions
  private active = false
  private dragging = false
  private dragStart: Point | null = null

  constructor(options: SelectionControllerOptions) {
    this.options = options

    this.handlePointerDown = this.handlePointerDown.bind(this)
    this.handlePointerMove = this.handlePointerMove.bind(this)
    this.handlePointerUp = this.handlePointerUp.bind(this)
    this.handleKeyDown = this.handleKeyDown.bind(this)

    this.options.container.addEventListener('pointerdown', this.handlePointerDown)
    window.addEventListener('keydown', this.handleKeyDown)
  }

  /**
   * Turns select-mode interaction on/off. Orbit is disabled for the whole
   * time select mode is active (not just mid-drag) - toggling it only at
   * pointerdown would race OrbitControls' own pointerdown listener on the
   * canvas, which fires first since the canvas is nested inside `container`
   * and events bubble target-first.
   */
  setActive(active: boolean): void {
    this.active = active
    this.options.getViewer()?.setOrbitEnabled(!active)
    if (!active) this.cancelDrag()
  }

  dispose(): void {
    this.options.container.removeEventListener('pointerdown', this.handlePointerDown)
    this.options.container.removeEventListener('pointermove', this.handlePointerMove)
    this.options.container.removeEventListener('pointerup', this.handlePointerUp)
    window.removeEventListener('keydown', this.handleKeyDown)
  }

  private handlePointerDown(event: PointerEvent): void {
    if (!this.active || event.button !== 0) return

    const containerRect = this.options.container.getBoundingClientRect()
    this.dragStart = { x: event.clientX - containerRect.left, y: event.clientY - containerRect.top }
    this.dragging = true

    this.options.container.setPointerCapture(event.pointerId)
    this.options.container.addEventListener('pointermove', this.handlePointerMove)
    this.options.container.addEventListener('pointerup', this.handlePointerUp)
    this.showMarquee(this.dragStart, this.dragStart)
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.dragging || !this.dragStart) return
    const current = this.pointFromEvent(event)
    this.showMarquee(this.dragStart, current)
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.dragging || !this.dragStart) return
    const current = this.pointFromEvent(event)
    const start = this.dragStart

    this.options.container.releasePointerCapture(event.pointerId)
    this.endDrag()
    this.finishSelection(start, current)
  }

  private pointFromEvent(event: PointerEvent): Point {
    const containerRect = this.options.container.getBoundingClientRect()
    return { x: event.clientX - containerRect.left, y: event.clientY - containerRect.top }
  }

  private finishSelection(start: Point, end: Point): void {
    const viewer = this.options.getViewer()
    const mesh = viewer?.getMesh()
    if (!viewer || !mesh) {
      this.options.onSelectionChange(null)
      return
    }

    const container = this.options.container
    const pixelRect = padRectToMinSize(rectFromPoints(start, end), MIN_HIT_SIZE_PX)
    const ndcRect = pixelRectToNdc(pixelRect, container.clientWidth, container.clientHeight)

    const camera = viewer.getCamera()
    camera.updateMatrixWorld()
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

    const triIndices = selectTrianglesInRect(mesh.geometry, viewProjection, ndcRect)

    if (triIndices.length === 0) {
      viewer.setHighlightObject(null)
      this.options.onSelectionChange(null)
      return
    }

    this.options.highlight.update(mesh.geometry, triIndices)
    viewer.setHighlightObject(this.options.highlight.object)
    this.options.onSelectionChange(summarizeSelection(mesh.geometry, triIndices))
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.active) return
    this.cancelDrag()
    this.options.getViewer()?.setHighlightObject(null)
    this.options.onSelectionChange(null)
  }

  private cancelDrag(): void {
    if (!this.dragging) return
    this.endDrag()
  }

  private endDrag(): void {
    this.dragging = false
    this.dragStart = null
    this.options.container.removeEventListener('pointermove', this.handlePointerMove)
    this.options.container.removeEventListener('pointerup', this.handlePointerUp)
    this.hideMarquee()
  }

  private showMarquee(a: Point, b: Point): void {
    const rect = rectFromPoints(a, b)
    const style = this.options.marqueeElement.style
    style.display = 'block'
    style.left = `${rect.left}px`
    style.top = `${rect.top}px`
    style.width = `${rect.width}px`
    style.height = `${rect.height}px`
  }

  private hideMarquee(): void {
    this.options.marqueeElement.style.display = 'none'
  }
}
