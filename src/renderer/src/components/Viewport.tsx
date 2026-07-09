import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { ModelViewer } from '../three/viewer'
import { SelectionHighlight } from '../three/selection'
import { SelectionController } from '../three/selectionController'
import { MeasurementOverlay } from '../three/measurement'
import { MeasurementController } from '../three/measurementController'
import { useAppStore } from '../state/appStore'

interface ViewportProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

/** Hosts the three.js canvas and the marquee-select/measurement overlays and controllers.
 *  Creates a ModelViewer on mount, disposes it (and both controllers/overlays) on unmount. */
export function Viewport({ viewerRef }: ViewportProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const marqueeRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<SelectionController | null>(null)
  const measureControllerRef = useRef<MeasurementController | null>(null)

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

    return () => {
      controller.dispose()
      highlight.dispose()
      measureController.dispose()
      measurementOverlay.dispose()
      viewer.dispose()
      controllerRef.current = null
      measureControllerRef.current = null
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
  useEffect(() => {
    viewerRef.current?.setOrbitEnabled(!paramUpdatePending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramUpdatePending])

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
