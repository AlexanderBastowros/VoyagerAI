import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { Placement } from '../../../shared/ipc'
import { groundClamp, readPlacement } from './placement'
import type { ModelViewer } from './viewer'

export interface PlacementControllerOptions {
  /** Looked up on demand so the controller tolerates the viewer being recreated. */
  getViewer: () => ModelViewer | null
  /** Called once per gizmo drag (on release), with the ground-clamped placement to persist. */
  onPlacementChange: (partId: string, placement: Placement) => void
  /** Called when the gizmo mode changes from the keyboard shortcuts (`g`/`t`/`r`), so a UI toggle
   *  mirroring the mode can follow. Not called for `setMode()` - the UI initiated that itself. */
  onModeChange?: (mode: 'translate' | 'rotate') => void
}

/**
 * The viewport move/rotate gizmo for multi-part layout (WS-I, architecture doc §14). Wraps three's
 * `TransformControls`, attached to an invisible **pivot proxy at the focused part's bounding-box
 * center** - part meshes are min-corner-origined (see `viewer.buildMesh`), so attaching to the
 * mesh itself would draw the handles at a corner and spin the part about it; instead the handles
 * render on the middle of the body and rotation pivots about the body's center, with each drag's
 * pivot delta re-applied to the mesh. Placement is **layout only** - it moves the mesh transform,
 * never the geometry - and every edit is **ground-clamped**: a part can be slid on the plate,
 * lifted vertically (the print Z direction - assembly preview, stacking), and rotated, but can
 * never sink below the bed (world `y = 0`). `g`/`r` toggle translate/rotate while a part is
 * attached, mirrored by the toolbar's Move/Rotate toggle. Sits alongside the selection/
 * measurement controllers; `Viewport.tsx` only attaches it when a part is focused and neither of
 * those modes is active.
 */
export class PlacementController {
  private readonly options: PlacementControllerOptions
  private control: TransformControls | null = null
  private helper: THREE.Object3D | null = null
  /** The proxy the gizmo attaches to, kept at the focused part's world bounding-box center with
   *  an identity rotation between drags - so a drag's transform IS the world-space delta. */
  private readonly pivot = new THREE.Object3D()
  private attachedPartId: string | null = null
  private mode: 'translate' | 'rotate' = 'translate'
  /** Snapshot taken when a drag grabs a handle, for re-deriving the mesh transform from the
   *  pivot's delta on every `objectChange` during that drag. */
  private dragStart: {
    pivotPosition: THREE.Vector3
    meshPosition: THREE.Vector3
    meshQuaternion: THREE.Quaternion
  } | null = null

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

    // Freeze orbit while a gizmo handle is being dragged (TransformControls emits this on grab/release).
    control.addEventListener('dragging-changed', (event) => {
      const dragging = (event as unknown as { value: boolean }).value
      viewer.setOrbitEnabled(!dragging)
      if (dragging) this.beginDrag()
      // On release, ground-clamp the moved part and persist its placement.
      else this.commit()
    })
    // The gizmo drives the pivot proxy; mirror every change onto the attached part's mesh.
    control.addEventListener('objectChange', () => this.applyPivotDelta())

    this.control = control
    this.helper = control.getHelper()
    viewer.getScene().add(this.helper)
    viewer.getScene().add(this.pivot)
    return control
  }

  /** Attaches the gizmo to a part (via the centered pivot) so it can be arranged. Detaches first
   *  if needed. */
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
    this.attachedPartId = partId
    this.syncPivotTo(mesh)
    control.attach(this.pivot)
    control.enabled = true
    if (this.helper) this.helper.visible = true
  }

  /** Hides/detaches the gizmo (e.g. entering select/measure mode, or nothing focused). */
  detach(): void {
    this.abortDrag()
    this.attachedPartId = null
    this.dragStart = null
    if (this.helper) this.helper.visible = false
    if (!this.control) return
    this.control.detach()
    this.control.enabled = false
  }

  /** Force-ends an in-flight drag before detaching. A mid-drag detach (e.g. the agent turn
   *  starting re-runs Viewport's attach effect while a handle is held) would otherwise latch
   *  TransformControls' internal `dragging` flag: with the control disabled its pointerup never
   *  fires, so orbit stays frozen for the whole turn and the next canvas click would commit the
   *  abandoned drag's displacement. Roll the mesh back to its pre-drag pose and clear the latch. */
  private abortDrag(): void {
    const start = this.dragStart
    this.dragStart = null
    if (!this.control || !this.control.dragging) return
    const viewer = this.options.getViewer()
    const mesh = this.attachedPartId ? viewer?.getPartMesh(this.attachedPartId) : null
    if (mesh && start) {
      mesh.position.copy(start.meshPosition)
      mesh.quaternion.copy(start.meshQuaternion)
    }
    this.control.dragging = false
    viewer?.setOrbitEnabled(true)
  }

  /** Switches between move and rotate. */
  setMode(mode: 'translate' | 'rotate'): void {
    this.mode = mode
    if (!this.control) return
    this.control.setMode(mode)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    if (this.control) {
      this.control.detach()
      if (this.helper?.parent) this.helper.parent.remove(this.helper)
      this.control.dispose()
    }
    if (this.pivot.parent) this.pivot.parent.remove(this.pivot)
    this.control = null
    this.helper = null
    this.attachedPartId = null
    this.dragStart = null
  }

  /** Re-centers the pivot on the mesh's world bounding box and resets its rotation, so the next
   *  drag starts from an identity transform at the body's center. */
  private syncPivotTo(mesh: THREE.Mesh): void {
    mesh.updateMatrixWorld()
    new THREE.Box3().setFromObject(mesh).getCenter(this.pivot.position)
    this.pivot.quaternion.identity()
    this.pivot.updateMatrixWorld()
  }

  private beginDrag(): void {
    const viewer = this.options.getViewer()
    const mesh = this.attachedPartId ? viewer?.getPartMesh(this.attachedPartId) : null
    if (!mesh) return
    this.dragStart = {
      pivotPosition: this.pivot.position.clone(),
      meshPosition: mesh.position.clone(),
      meshQuaternion: mesh.quaternion.clone()
    }
  }

  /** Mirrors the pivot's in-drag delta onto the mesh: translation carries over directly; rotation
   *  (the pivot starts each drag at identity, so its quaternion IS the world-space delta) spins
   *  the mesh about the pivot point - the body's center - not the mesh's min-corner origin. */
  private applyPivotDelta(): void {
    const start = this.dragStart
    const viewer = this.options.getViewer()
    const mesh = this.attachedPartId ? viewer?.getPartMesh(this.attachedPartId) : null
    if (!start || !mesh) return

    if (this.mode === 'translate') {
      const delta = this.pivot.position.clone().sub(start.pivotPosition)
      mesh.position.copy(start.meshPosition).add(delta)
    } else {
      const q = this.pivot.quaternion
      mesh.quaternion.copy(q).multiply(start.meshQuaternion)
      mesh.position.copy(start.meshPosition).sub(start.pivotPosition).applyQuaternion(q).add(start.pivotPosition)
    }
  }

  /** Reads the attached mesh's transform, ground-clamps it, applies + persists the result, then
   *  re-centers the pivot for the next drag. */
  private commit(): void {
    this.dragStart = null
    const viewer = this.options.getViewer()
    const partId = this.attachedPartId
    if (!viewer || !partId) return
    const mesh = viewer.getPartMesh(partId)
    if (!mesh) return

    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox
    const raw = readPlacement(mesh)
    const clamped = box ? groundClamp(raw, box.min, box.max) : raw

    viewer.setPartPlacement(partId, clamped)
    this.options.onPlacementChange(partId, clamped)
    this.syncPivotTo(mesh)
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.attachedPartId || !this.control?.enabled) return
    // Never switch modes mid-drag: applyPivotDelta would reinterpret the in-flight drag's state
    // under the other mode's math (snapping the mesh back / erratic motion) and commit it.
    if (this.control.dragging) return
    // Don't hijack g/r/t while the user is typing (e.g. composing a chat message) - these are
    // plain letters, so a global listener would otherwise flip the gizmo mode mid-word.
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'g' || event.key === 't') this.setModeFromKeyboard('translate')
    else if (event.key === 'r') this.setModeFromKeyboard('rotate')
  }

  private setModeFromKeyboard(mode: 'translate' | 'rotate'): void {
    if (this.mode === mode) return
    this.setMode(mode)
    this.options.onModeChange?.(mode)
  }
}
