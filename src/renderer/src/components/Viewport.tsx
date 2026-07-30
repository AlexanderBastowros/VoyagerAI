import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { ModelViewer } from '../three/viewer'
import { SelectionHighlight } from '../three/selection'
import { SelectionController } from '../three/selectionController'
import { MeasurementOverlay } from '../three/measurement'
import { MeasurementController } from '../three/measurementController'
import { PlacementController } from '../three/placementController'
import { MODEL_UP_TO_WORLD_UP_DEG, arrangeAlongX, type ArrangeItem } from '../three/arrangeAlongX'
import { useAppStore } from '../state/appStore'
import { partColorFor } from '../colors'
import type { PartRecord, Placement } from '../../../shared/ipc'

interface ViewportProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

/**
 * The print-orientation preview's row, as `partId -> Placement`, plus the row's total X extent - or
 * null when there is nothing to preview yet (no geometry loaded, everything hidden).
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION, and this is the load-bearing property of the whole feature:
 * - it reads `mesh.geometry.boundingBox` (local, min-corner-origined bounds) and the store's `parts`
 *   list, and returns a value. It touches no `Placement` in the store, calls no IPC, and its only
 *   consumer applies the result through `viewer.setPartPlacement`, which writes to the three.js mesh
 *   and the viewer's own view record - never to `parts[].placement` or `project.json`;
 * - the row is a pure function of GEOMETRY bounds, never of the parts' current placements, so it
 *   cannot compound across repeated toggles;
 * - therefore turning the preview off simply lets the parts-sync effect below re-apply
 *   `part.placement` from the store, restoring the user's hand-built layout exactly.
 */
function buildPreviewRow(
  viewer: ModelViewer,
  parts: PartRecord[]
): { placements: Map<string, Placement>; rowWidthMm: number } | null {
  const items: ArrangeItem[] = []
  for (const part of parts) {
    if (!part.visible) continue
    // `buildMesh` always computes a bounding box, so this only skips parts whose geometry has not
    // arrived yet - `lazyLoadTick` re-runs the effect when it does, folding them into the row.
    const box = viewer.getPartMesh(part.id)?.geometry.boundingBox
    if (!box) continue
    items.push({ partId: part.id, localMin: box.min, localMax: box.max })
  }
  if (items.length === 0) return null
  // The row math needs no 2+ gate (a single part just gets no gap): the display rotation is
  // meaningful for one part too - it is the only way to see which face sits on the bed. Bed-fit is
  // reported by `PrintSettingsPanel`, which knows the active printer profile, so no verdict here.
  const { placements, rowWidthMm } = arrangeAlongX(items, {
    rotationDeg: MODEL_UP_TO_WORLD_UP_DEG,
    usableXMm: null
  })
  return { placements: new Map(placements.map((p) => [p.partId, p.placement])), rowWidthMm }
}

/** Hosts the three.js canvas and the marquee-select/measurement overlays and controllers.
 *  Creates a ModelViewer on mount, disposes it (and both controllers/overlays) on unmount. */
export function Viewport({ viewerRef }: ViewportProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const marqueeRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<SelectionController | null>(null)
  const measureControllerRef = useRef<MeasurementController | null>(null)
  const placementControllerRef = useRef<PlacementController | null>(null)

  const selectMode = useAppStore((state) => state.selectMode)
  const selection = useAppStore((state) => state.selection)
  const setSelection = useAppStore((state) => state.setSelection)
  const measureMode = useAppStore((state) => state.measureMode)
  const measurement = useAppStore((state) => state.measurement)
  const setMeasurement = useAppStore((state) => state.setMeasurement)
  const showAxes = useAppStore((state) => state.showAxes)
  const wireframe = useAppStore((state) => state.wireframe)
  const model = useAppStore((state) => state.model)
  const paramUpdatePending = useAppStore((state) => state.paramUpdatePending)
  const parts = useAppStore((state) => state.parts)
  const selectedPartId = useAppStore((state) => state.selectedPartId)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const gizmoMode = useAppStore((state) => state.gizmoMode)
  const printPreviewArranged = useAppStore((state) => state.printPreviewArranged)
  const setParts = useAppStore((state) => state.setParts)
  const setSelectedPartId = useAppStore((state) => state.setSelectedPartId)
  /** Part ids with a `part.getModel` fetch in flight (the lazy-load effect below), so a re-run
   *  of the effect can't double-fetch the same part's geometry. */
  const loadingPartIdsRef = useRef<Set<string>>(new Set())
  /** Bumped after each lazy geometry load so the focus/gizmo effects below re-run: a duplicated
   *  part becomes selected BEFORE its mesh exists, making their first pass a no-op - without
   *  this, the copy would show as active in the panel but never receive focus or the gizmo. */
  const [lazyLoadTick, setLazyLoadTick] = useState(0)
  /** Which set of parts the print-orientation preview last framed the camera on (`null` while the
   *  preview is off). Keyed by part id so arming frames once, and a part whose geometry arrives late
   *  re-frames to include it - but a mere color/placement re-sync does not keep yanking the camera. */
  const previewFrameKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    const marquee = marqueeRef.current
    if (!container || !marquee) return

    const viewer = new ModelViewer(container)
    viewerRef.current = viewer

    const highlight = new SelectionHighlight()
    const controller = new SelectionController({
      container,
      marqueeElement: marquee,
      getViewer: () => viewerRef.current,
      highlight,
      onSelectionChange: (next) => setSelection(next)
    })
    controllerRef.current = controller

    const measurementOverlay = new MeasurementOverlay()
    const measureController = new MeasurementController({
      container,
      getViewer: () => viewerRef.current,
      overlay: measurementOverlay,
      onMeasureChange: (distanceMm) => setMeasurement(distanceMm)
    })
    measureControllerRef.current = measureController

    // WS-I placement gizmo: persist a dragged part's ground-clamped placement, then let the store
    // update flow back to the viewer via the parts-sync effect below.
    const placementController = new PlacementController({
      getViewer: () => viewerRef.current,
      onPlacementChange: (partId, placement) => {
        // Optimistically reflect the drag in the store immediately, so a concurrent setParts (e.g.
        // another part's visibility toggle resolving first) can't transiently revert the dragged
        // mesh via the parts-sync effect. Capture the prior placement first so a rejected IPC can
        // roll both the store and the viewer back to the last-persisted value (no divergence).
        const store = useAppStore.getState()
        const prev = store.parts.find((p) => p.id === partId)?.placement
        store.setParts(store.parts.map((p) => (p.id === partId ? { ...p, placement } : p)))
        void window.voyager.part
          .setPlacement({ partId, placement })
          .then(({ parts, activePartId }) => {
            setParts(parts)
            setSelectedPartId(activePartId)
          })
          .catch((err: unknown) => {
            // Say why the part snapped back. Without this the rollback below is a silent, unexplained
            // jump on any axis; the main process already returns human-readable text (e.g. "Voyager
            // is still working — wait for it to finish before rearranging parts.").
            useAppStore.getState().addMessage({
              role: 'system-status',
              text: err instanceof Error ? `⚠ ${err.message}` : '⚠ Could not save the new part position.'
            })
            if (!prev) return
            const cur = useAppStore.getState()
            cur.setParts(cur.parts.map((p) => (p.id === partId ? { ...p, placement: prev } : p)))
            viewerRef.current?.setPartPlacement(partId, prev)
          })
      },
      // The g/r keyboard shortcuts change the controller's mode directly - mirror them into the
      // store so the toolbar's Move/Rotate toggle follows (the reverse direction is the gizmoMode
      // effect below).
      onModeChange: (mode) => useAppStore.getState().setGizmoMode(mode)
    })
    placementControllerRef.current = placementController

    return () => {
      controller.dispose()
      highlight.dispose()
      measureController.dispose()
      measurementOverlay.dispose()
      placementController.dispose()
      viewer.dispose()
      controllerRef.current = null
      measureControllerRef.current = null
      placementControllerRef.current = null
      viewerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep select-mode interaction (and orbit enable/disable) in sync with the toolbar toggle.
  useEffect(() => {
    controllerRef.current?.setActive(selectMode)
  }, [selectMode])

  // Keep measure-mode interaction (and orbit enable/disable) in sync with the toolbar toggle.
  useEffect(() => {
    measureControllerRef.current?.setActive(measureMode)
  }, [measureMode])

  // Any code path that clears the store selection (auto-clear after an accepted
  // send, Escape, a new model iteration arriving) should also hide the visual
  // highlight, regardless of which component triggered the clear.
  useEffect(() => {
    if (selection === null) {
      viewerRef.current?.setHighlightObject(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  // Same idea for measurement: a model swap (setModel) and Escape/toggle-off both clear the
  // store field, and both should also tear down the (now possibly-stale) line/markers.
  useEffect(() => {
    if (measurement === null) {
      measureControllerRef.current?.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measurement])

  // Orientation gizmo visibility follows the toolbar toggle directly - no controller involved.
  useEffect(() => {
    viewerRef.current?.setAxesVisible(showAxes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAxes])

  // Wireframe mode likewise applies straight to the viewer's current material.
  useEffect(() => {
    viewerRef.current?.setWireframe(wireframe)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wireframe])

  // Freeze orbit while a param-panel re-run is in flight - the overlay below also blocks pointer
  // events outright, but this covers scroll-wheel zoom too and matches the semantic "frozen"
  // state even if the overlay's positioning ever changes.
  //
  // Held as a named veto rather than by assigning `controls.enabled`: as a plain boolean this was
  // last-writer-wins, so a re-run RESOLVING while select or measure mode was active silently handed
  // orbit back under an active marquee. Note the inverted polarity vs. the old enable-flag setter -
  // `paramUpdatePending` is now passed straight through as "suppressed", not negated.
  useEffect(() => {
    viewerRef.current?.setOrbitSuppressed('paramUpdate', paramUpdatePending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramUpdatePending])

  // WS-I: the focused part is what selection/measurement/the gizmo act on - keep the viewer in sync
  // with the store's `selectedPartId` (set by the parts panel, hydration, and each display).
  useEffect(() => {
    viewerRef.current?.focusPart(selectedPartId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPartId, lazyLoadTick])

  // WS-I: mirror per-part visibility + placement + color from the store onto the already-loaded
  // meshes (a visibility toggle, a placement persisted from the gizmo, the canonical per-index
  // palette color), and lazily fetch geometry for parts the viewer doesn't have yet - a duplicate
  // just created, or a part recorded from another window. Idempotent - re-applying a placement
  // the gizmo just set (or a color the mesh already wears) is a no-op.
  //
  // This is also where the print-orientation preview is applied and un-applied: while
  // `printPreviewArranged` is on, the arranged row REPLACES each part's stored placement on the
  // meshes; while it is off this effect behaves exactly as it always did, re-applying
  // `part.placement`. That single substitution is the whole preview - which is why it is reversible
  // for free and why nothing needs a snapshot or an undo stack (the app has neither).
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const loaded = new Set(viewer.getPartIds())
    const preview = printPreviewArranged ? buildPreviewRow(viewer, parts) : null

    // Publish the measured row width for `PrintSettingsPanel`'s bed-fit caption (a measurement only -
    // nothing reads it back into the layout), and frame the camera once per previewed part set.
    const store = useAppStore.getState()
    if (store.printPreviewRowWidthMm !== (preview?.rowWidthMm ?? null)) {
      store.setPrintPreviewRowWidthMm(preview?.rowWidthMm ?? null)
    }

    parts.forEach((part, index) => {
      if (loaded.has(part.id)) {
        viewer.setPartVisible(part.id, part.visible)
        viewer.setPartPlacement(part.id, preview?.placements.get(part.id) ?? part.placement)
        viewer.setPartColor(part.id, partColorFor(index))
        return
      }
      if (loadingPartIdsRef.current.has(part.id)) return
      loadingPartIdsRef.current.add(part.id)
      void window.voyager.part
        .getModel({ partId: part.id })
        .then((model) => {
          // Re-check against the CURRENT store list: the project may have switched (viewer
          // cleared) while the fetch was in flight, and this part may no longer belong.
          const current = useAppStore.getState().parts.find((p) => p.id === part.id)
          if (model && current && viewerRef.current) {
            viewerRef.current.loadPart(part.id, model.stlBuffer, current.placement, current.visible, partColorFor(index))
            setLazyLoadTick((t) => t + 1)
          }
        })
        .finally(() => loadingPartIdsRef.current.delete(part.id))
    })

    // Frame the row once when it is (re)composed, so the arrangement is actually in view; re-syncs
    // that don't change which parts are in the row leave the camera alone.
    const frameKey = preview ? [...preview.placements.keys()].join('|') : null
    if (frameKey !== previewFrameKeyRef.current) {
      previewFrameKeyRef.current = frameKey
      if (frameKey !== null) viewer.frameAll()
    }
    // `lazyLoadTick` is a dep because geometry arrives asynchronously: without it a part still
    // loading when the preview arms would be silently left out of the row for good.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, printPreviewArranged, lazyLoadTick])

  // Keep the placement gizmo's mode in step with the store (the toolbar toggle writes it; the
  // controller's keyboard shortcuts write it back via onModeChange above).
  useEffect(() => {
    placementControllerRef.current?.setMode(gizmoMode)
  }, [gizmoMode])

  // WS-I: the placement gizmo is available only for a multi-part project, on the focused part, when
  // neither select nor measure mode is active (they share the canvas), and not while the agent is
  // busy - the `part:setPlacement` handler rejects mid-turn, so dragging then would move the mesh
  // but silently fail to persist. It is also detached while the print-orientation preview is on: the
  // meshes are then showing arranged slots rather than their stored placements, so a drag would
  // persist a preview-derived placement (and the parts-sync effect above would immediately snap the
  // part back to its slot anyway). Otherwise detach it.
  useEffect(() => {
    const placement = placementControllerRef.current
    if (!placement) return
    if (parts.length > 1 && selectedPartId && !selectMode && !measureMode && !agentBusy && !printPreviewArranged) {
      placement.attach(selectedPartId)
    } else {
      placement.detach()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPartId, parts, selectMode, measureMode, agentBusy, printPreviewArranged, lazyLoadTick])

  return (
    <Box
      ref={containerRef}
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        bgcolor: 'background.default',
        cursor: selectMode || measureMode ? 'crosshair' : 'default',
        '& canvas': { display: 'block' }
      }}
    >
      <Box
        ref={marqueeRef}
        sx={{
          display: 'none',
          position: 'absolute',
          zIndex: 5,
          border: '1px dashed',
          borderColor: 'primary.main',
          bgcolor: 'rgba(102, 170, 255, 0.15)',
          pointerEvents: 'none'
        }}
      />
      {!model && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            px: 6,
            pointerEvents: 'none'
          }}
        >
          <Typography color="text.disabled" align="center">
            Ask Voyager for a part and it will appear here
          </Typography>
        </Box>
      )}
      {paramUpdatePending && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 6,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
            bgcolor: 'rgba(0, 0, 0, 0.35)',
            // Blocks clicks/drags/scroll from reaching the canvas underneath - the model view is
            // frozen on its current geometry until the re-run's model:displayed arrives.
            pointerEvents: 'auto',
            cursor: 'wait'
          }}
        >
          <CircularProgress size={32} />
          <Typography color="text.secondary">Updating model…</Typography>
        </Box>
      )}
    </Box>
  )
}
