import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { Placement } from '../../../shared/ipc'
import { groundSnap, readPlacement } from './placement'
import type { ModelViewer } from './viewer'

export interface PlacementControllerOptions {
  /** Looked up on demand so the controller tolerates the viewer being recreated. */
  getViewer: () => ModelViewer | null
  /** Called once per gizmo drag (on release), with the ground-snapped placement to persist. */
  onPlacementChange: (partId: string, placement: Placement) => void
}

/**
 * The viewport move/rotate gizmo for multi-part layout (WS-I, architecture doc §14). Wraps three's
 * `TransformControls`, attaching it to the focused part's mesh so the user can arrange parts on the
 * build plate. Placement is **layout only** - it moves the mesh transform, never the geometry - and
 * every edit is **ground-snapped** so a part always rests on the plate (world `y = 0`). Translate
 * mode hides the Y handle (parts slide on the plate; ground-snap owns their height); `g`/`r` toggle
 * translate/rotate while a part is attached. Sits alongside the selection/measurement controllers;
 * `Viewport.tsx` only attaches it when a part is focused and neither of those modes is active.
 */
export class PlacementController {
  private readonly options: PlacementControllerOptions
  private control: TransformControls | null = null
  private helper: THREE.Object3D | null = null
  private attachedPartId: string | null = null
  private mode: 'translate' | 'rotate' = 'translate'

  constructor(options: PlacementControllerOptions) {
    this.options = options
    this.handleKeyDown = this.handleKeyDown.bind(this)
    window.addEventListener('keydown', this.handleKeyDown)
  }

  /** Lazily builds the `TransformControls` against the current viewer (camera + canvas + scene). */
  private ensureControl(viewer: ModelViewer): TransformControls | null {
    if (this.control) return this.control

    const control = new TransformControls(viewer.getCamera(), viewer.getDomElement())
    control.setMode(this.mode)
    control.setSpace('world')
    this.applyAxisVisibility(control)

    // Freeze orbit while a gizmo handle is being dragged (TransformControls emits this on grab/release).
    control.addEventListener('dragging-changed', (event) => {
      const dragging = (event as unknown as { value: boolean }).value
      viewer.setOrbitEnabled(!dragging)
      // On release, ground-snap the moved part and persist its placement.
      if (!dragging) this.commit()
    })

    this.control = control
    this.helper = control.getHelper()
    viewer.getScene().add(this.helper)
    return control
  }

  /** Attaches the gizmo to a part's mesh so it can be arranged. Detaches first if needed. */
  attach(partId: string): void {
    const viewer = this.options.getViewer()
    if (!viewer) return
    const mesh = viewer.getPartMesh(partId)
    if (!mesh) {
      this.detach()
      return
    }
    const control = this.ensureControl(viewer)
    if (!control) return
    control.attach(mesh)
    control.enabled = true
    if (this.helper) this.helper.visible = true
    this.attachedPartId = partId
  }

  /** Hides/detaches the gizmo (e.g. entering select/measure mode, or nothing focused). */
  detach(): void {
    this.attachedPartId = null
    if (this.helper) this.helper.visible = false
    if (!this.control) return
    this.control.detach()
    this.control.enabled = false
  }

  /** Switches between move and rotate. */
  setMode(mode: 'translate' | 'rotate'): void {
    this.mode = mode
    if (!this.control) return
    this.control.setMode(mode)
    this.applyAxisVisibility(this.control)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    if (this.control) {
      this.control.detach()
      if (this.helper?.parent) this.helper.parent.remove(this.helper)
      this.control.dispose()
    }
    this.control = null
    this.helper = null
    this.attachedPartId = null
  }

  /** Translate hides the Y handle (parts slide on the plate; ground-snap owns height); rotate shows
   *  all rings so a part can be reoriented for printing. */
  private applyAxisVisibility(control: TransformControls): void {
    const translating = this.mode === 'translate'
    control.showX = true
    control.showZ = true
    control.showY = !translating
  }

  /** Reads the attached mesh's transform, ground-snaps it, applies + persists the result. */
  private commit(): void {
    const viewer = this.options.getViewer()
    const partId = this.attachedPartId
    if (!viewer || !partId) return
    const mesh = viewer.getPartMesh(partId)
    if (!mesh) return

    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox
    const raw = readPlacement(mesh)
    const snapped = box ? groundSnap(raw, box.min, box.max) : raw

    viewer.setPartPlacement(partId, snapped)
    this.options.onPlacementChange(partId, snapped)
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.attachedPartId || !this.control?.enabled) return
    // Don't hijack g/r/t while the user is typing (e.g. composing a chat message) - these are
    // plain letters, so a global listener would otherwise flip the gizmo mode mid-word.
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'g' || event.key === 't') this.setMode('translate')
    else if (event.key === 'r') this.setMode('rotate')
  }
}
