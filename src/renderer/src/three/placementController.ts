import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { Placement } from '../../../shared/ipc'
import { dragFloorY, groundClamp, readPlacement } from './placement'
import type { ModelViewer } from './viewer'

/** Placement equality for "did this drag actually change anything?". Deliberately a tolerance
 *  compare, not `===`: `readPlacement` rounds to 1e-3 but `groundClamp` substitutes an unrounded
 *  `restingY`, so a rotated part's clamped `y` is never bit-equal to its snapshot even when the
 *  drag was fully rejected. A false negative just costs the redundant IPC write we already do
 *  today, so erring towards "changed" is the safe direction. */
const PLACEMENT_EPSILON = 1e-3

function placementsMatch(a: Placement, b: Placement): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.position[i] - b.position[i]) > PLACEMENT_EPSILON) return false
    if (Math.abs(a.rotation[i] - b.rotation[i]) > PLACEMENT_EPSILON) return false
  }
  return true
}

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
 * lifted vertically (world `y`, which is also the *model's* own y - `buildMesh` only translates
 * geometry and never re-orients it, so nothing here maps to the print Z direction; lifting is for
 * assembly preview and stacking), and rotated, but can never sink below the bed (world `y = 0`).
 *
 * The vertical floor is enforced **live** during a translate drag - `TransformControls.minY` on the
 * pivot, from `dragFloorY` - as well as on release by `groundClamp`. Clamping only on release used
 * to render an illegal pose for the whole gesture and then throw the entire delta away, which read
 * as "the part snaps back" for any downward drag of a part already resting on the plate (i.e. the
 * steady state for every part).
 *
 * Both the floor and the release clamp take their resting height from `ModelViewer.getRestingY`,
 * which is vertex-accurate and memoised per part+rotation. Never compute it here: this controller
 * runs inside pointer handlers, and the height is a function of (geometry, rotation) only - a
 * translate drag cannot change it, so it is sampled once per gesture.
 *
 * `g`/`r` toggle translate/rotate while a part is attached, mirrored by the toolbar's Move/Rotate
 * toggle. Sits alongside the selection/measurement controllers; `Viewport.tsx` only attaches it
 * when a part is focused and neither of those modes is active.
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
    /** The pre-drag placement, so `commit` can skip persisting a drag that changed nothing. */
    placement: Placement
  } | null = null
  /** True only for the instant `abortDrag` clears `TransformControls.dragging`. That property is a
   *  `defineProperty` accessor whose setter dispatches `dragging-changed`, so the assignment
   *  re-enters our own handler; without this flag the rolled-back pose would be committed and
   *  persisted, and the orbit veto abortDrag deliberately keeps held would be released early. */
  private aborting = false
  /** Tears down the one-shot pointer listeners that release the `'gizmo'` orbit veto after an
   *  aborted drag; null while none are armed. See `armOrbitReleaseAfterAbort`. */
  private disarmOrbitRelease: (() => void) | null = null

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
      if (dragging) {
        viewer.setOrbitSuppressed('gizmo', true)
        this.beginDrag()
      } else {
        // Re-entrancy: `abortDrag` clears `dragging` itself, which lands right here. That is a
        // rollback, not a release - it must neither commit the rolled-back pose nor hand orbit back
        // mid-gesture (abortDrag keeps the veto and releases it on the real pointer release).
        if (this.aborting) return
        viewer.setOrbitSuppressed('gizmo', false)
        // On release, ground-clamp the moved part and persist its placement.
        this.commit()
      }
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
    // `minY` is sticky control state - clear it unconditionally so an aborted drag can never leave
    // a floor behind that pins a LATER drag (possibly of a different part, or a horizontal one).
    if (this.control) this.control.minY = -Infinity
    if (!this.control || !this.control.dragging) return
    const viewer = this.options.getViewer()
    const mesh = this.attachedPartId ? viewer?.getPartMesh(this.attachedPartId) : null
    if (mesh && start) {
      mesh.position.copy(start.meshPosition)
      mesh.quaternion.copy(start.meshQuaternion)
    }
    // The assignment re-enters `dragging-changed`; `aborting` makes that handler skip commit (we are
    // rolling back, not persisting) and skip the orbit release (see below).
    this.aborting = true
    this.control.dragging = false
    this.aborting = false
    this.armOrbitReleaseAfterAbort()
  }

  /**
   * Keeps the `'gizmo'` orbit veto held past an aborted drag, releasing it only when the pointer
   * gesture actually ends. Handing orbit back here (as this used to) leaves OrbitControls' latched
   * ROTATE state un-gated for the rest of the gesture with a stale rotate-start, so the camera
   * spins: its `pointerdown` listener is registered before TransformControls' on the same canvas,
   * so a gizmo-handle press always latches ROTATE, captures the pointer and registers document
   * move/up listeners - normally inert only because `onPointerMove` is gated on `enabled`.
   *
   * TransformControls' own `onPointerUp` early-returns once the control is disabled, which is why
   * the release is never observed through it. The listeners go on the canvas, which still holds the
   * pointer capture, so a release anywhere on screen is seen. `pointerdown` is in the list as the
   * fallback for a release that never arrives at all (window blur mid-drag) - without it orbit
   * could stay frozen forever. OrbitControls' `onPointerUp` is *not* gated on `enabled`, so by the
   * time we re-enable, its state is back to NONE and the next gesture starts clean.
   */
  private armOrbitReleaseAfterAbort(): void {
    this.disarmOrbitRelease?.()
    const viewer = this.options.getViewer()
    const dom = viewer?.getDomElement()
    if (!dom) {
      // Nothing to listen on (viewer already gone) - release now rather than risk a stuck veto.
      viewer?.setOrbitSuppressed('gizmo', false)
      return
    }
    const types = ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerdown'] as const
    const release = (): void => {
      this.disarmOrbitRelease?.()
      // Re-read the viewer: it may have been recreated between abort and release.
      this.options.getViewer()?.setOrbitSuppressed('gizmo', false)
    }
    for (const type of types) dom.addEventListener(type, release)
    this.disarmOrbitRelease = () => {
      for (const type of types) dom.removeEventListener(type, release)
      this.disarmOrbitRelease = null
    }
  }

  /** Switches between move and rotate. */
  setMode(mode: 'translate' | 'rotate'): void {
    this.mode = mode
    if (!this.control) return
    // Third and last place the live translate floor is dropped (with `commit`/`abortDrag`): between
    // drags this is a no-op, and in the one path that can switch mode mid-drag (the toolbar effect -
    // `g`/`r` are blocked while dragging) rotate must not inherit translate's floor.
    this.control.minY = -Infinity
    this.control.setMode(mode)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    this.disarmOrbitRelease?.()
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
    const partId = this.attachedPartId
    const mesh = viewer && partId ? viewer.getPartMesh(partId) : null
    if (!viewer || !partId || !mesh) return
    const placement = readPlacement(mesh)
    this.dragStart = {
      pivotPosition: this.pivot.position.clone(),
      meshPosition: mesh.position.clone(),
      meshQuaternion: mesh.quaternion.clone(),
      placement
    }
    // Install the live vertical floor for this one drag. Set ONCE here, never per-frame in
    // `objectChange`: `minY` is installed by three's `defineProperty` helper, so each assignment
    // dispatches `minY-changed` plus a `change` event.
    //
    // Keyed off `placement.rotation` (the rounded read-back) rather than `mesh.rotation`, so this
    // lookup and `commit`'s share one memo entry and a whole translate drag costs exactly one
    // O(vertices) pass.
    if (this.control) {
      this.control.minY = this.dragFloorForPivot(viewer, partId, mesh.position.y, placement.rotation)
    }
  }

  /**
   * The lowest world `y` the *pivot* may be dragged to this gesture, for `TransformControls.minY`.
   *
   * Clamping the pivot rather than the mesh inside `applyPivotDelta` is deliberate: the gizmo helper
   * renders at the pivot, so clamping only the mesh would let the arrows slide below the plate while
   * the body stopped - a new visual disconnect. Because `applyPivotDelta` re-derives the mesh from
   * `dragStart` every frame, flooring the pivot floors the body too, and handles and part stop
   * together. The pivot is added to the scene directly, so its position is already world space.
   *
   * The arithmetic itself lives in `dragFloorY` (unit-tested in `placement.test.ts`) so the
   * resting-height rule has exactly one definition shared with `groundClamp`.
   *
   * Translate only. In rotate mode `applyPivotDelta` re-derives the pivot-relative position every
   * frame, so a live floor would make the part creep upward as it spins; rotate keeps its
   * clamp-on-release, which is correct there. The mode check comes first so a rotate grab never even
   * asks for a resting height.
   */
  private dragFloorForPivot(
    viewer: ModelViewer,
    partId: string,
    meshY: number,
    rotationDeg: readonly [number, number, number]
  ): number {
    if (this.mode !== 'translate') return -Infinity
    const restingY = viewer.getRestingY(partId, rotationDeg)
    if (restingY === null) return -Infinity
    // `pivot.position.y - mesh.position.y` is constant for a whole translate drag (both move by the
    // same delta), so sampling it once at grab time is exact.
    return dragFloorY(restingY, this.pivot.position.y - meshY)
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
    // The live floor belongs to the drag that just ended - clear it before anything can early-return
    // past this point, or a mode switch / later drag inherits a stale height.
    if (this.control) this.control.minY = -Infinity
    const start = this.dragStart
    this.dragStart = null
    const viewer = this.options.getViewer()
    const partId = this.attachedPartId
    if (!viewer || !partId) return
    const mesh = viewer.getPartMesh(partId)
    if (!mesh) return

    const raw = readPlacement(mesh)
    // Same memo the live floor used (same rounded rotation for a translate drag, so a cache hit); a
    // rotate drag lands on a new rotation and pays one O(vertices) pass here, once, on release.
    const restingY = viewer.getRestingY(partId, raw.rotation)
    const clamped = restingY === null ? raw : groundClamp(raw, restingY)

    viewer.setPartPlacement(partId, clamped)
    // A drag the clamp fully absorbed (or a click on a handle with no movement) leaves the placement
    // where it was: persisting it would write a value already on disk and broadcast a store update
    // that re-runs Viewport's parts-sync and gizmo-attach effects for nothing. The viewer apply and
    // the pivot re-centre above/below stay unconditional - they are local and idempotent.
    if (!start || !placementsMatch(clamped, start.placement)) {
      this.options.onPlacementChange(partId, clamped)
    }
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
