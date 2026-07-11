import { useEffect, useState } from 'react'
import type { MutableRefObject } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import Snackbar from '@mui/material/Snackbar'
import ToggleButton from '@mui/material/ToggleButton'
import ExploreIcon from '@mui/icons-material/Explore'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import GridOnIcon from '@mui/icons-material/GridOn'
import HighlightAltIcon from '@mui/icons-material/HighlightAlt'
import OpenWithIcon from '@mui/icons-material/OpenWith'
import RotateRightIcon from '@mui/icons-material/RotateRight'
import StraightenIcon from '@mui/icons-material/Straighten'
import ViewInArIcon from '@mui/icons-material/ViewInAr'
import type { ExportFormat } from '../../../shared/ipc'
import type { ModelViewer } from '../three/viewer'
import { colors, fontMono } from '../colors'
import { useAppStore } from '../state/appStore'

interface ViewportControlsProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

function formatSelectionChip(dims: [number, number, number], triCount: number): string {
  const fmt = (n: number): string => n.toFixed(1)
  return `~${fmt(dims[0])}×${fmt(dims[1])}×${fmt(dims[2])} mm · ${triCount} tris`
}

function formatDimensions(dims: { x: number; y: number; z: number }): string {
  const fmt = (n: number): string => n.toFixed(1)
  return `Size: ${fmt(dims.x)}×${fmt(dims.y)}×${fmt(dims.z)} mm`
}

function formatDistanceChip(distanceMm: number): string {
  return `Distance: ${distanceMm.toFixed(1)} mm`
}

/** Floating controls over the viewport: sample-model dev action, export, region-selection,
 *  measurement, and view-mode (axes/wireframe) controls. */
export function ViewportControls({ viewerRef }: ViewportControlsProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [dims, setDims] = useState<{ x: number; y: number; z: number } | null>(null)
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const selectMode = useAppStore((state) => state.selectMode)
  const setSelectMode = useAppStore((state) => state.setSelectMode)
  const selection = useAppStore((state) => state.selection)
  const setSelection = useAppStore((state) => state.setSelection)
  const measureMode = useAppStore((state) => state.measureMode)
  const setMeasureMode = useAppStore((state) => state.setMeasureMode)
  const measurement = useAppStore((state) => state.measurement)
  const setMeasurement = useAppStore((state) => state.setMeasurement)
  const showAxes = useAppStore((state) => state.showAxes)
  const setShowAxes = useAppStore((state) => state.setShowAxes)
  const wireframe = useAppStore((state) => state.wireframe)
  const setWireframe = useAppStore((state) => state.setWireframe)
  const parts = useAppStore((state) => state.parts)
  const selectedPartId = useAppStore((state) => state.selectedPartId)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const gizmoMode = useAppStore((state) => state.gizmoMode)
  const setGizmoMode = useAppStore((state) => state.setGizmoMode)

  function flashStatus(message: string): void {
    setStatus(message)
  }

  // The viewer loads the STL synchronously (see App.tsx/ProjectsDrawer/handleLoadSample below),
  // so by the time this effect runs after a `model` change the new geometry's bounding box is
  // already computed - read it straight from the viewer rather than threading dims through
  // every load call site.
  useEffect(() => {
    setDims(viewerRef.current?.getDimensions() ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  function handleSelectModeChange(): void {
    const next = !selectMode
    setSelectMode(next)
    if (next) setMeasureMode(false)
  }

  function handleMeasureModeChange(): void {
    const next = !measureMode
    setMeasureMode(next)
    if (next) setSelectMode(false)
  }

  async function handleLoadSample(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const buffer = await window.voyager.model.loadSample()
      viewerRef.current?.loadSTL(buffer)
      setModel({
        name: 'cube.stl (sample)',
        iteration: 0,
        stlPath: 'resources/sample/cube.stl',
        stepPath: null,
        scriptPath: null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sample model')
    } finally {
      setLoading(false)
    }
  }

  async function handleExport(format: ExportFormat): Promise<void> {
    setExporting(format)
    setError(null)
    try {
      const response = await window.voyager.model.export({ format })
      if (response.saved) {
        // A multi-part project saves every part as separate files in one zip; parts the
        // main process had to leave out (no iterations, or no STEP) are named here.
        const isZip = !!response.path?.endsWith('.zip')
        const skipped = response.skippedParts?.length
          ? ` (left out - no ${format.toUpperCase()} yet: ${response.skippedParts.join(', ')})`
          : ''
        flashStatus(`Saved ${format.toUpperCase()}${isZip ? ' zip' : ''}${response.path ? ` to ${response.path}` : ''}${skipped}`)
      } else if (response.reason) {
        setError(response.reason)
      }
      // Canceled dialog with no reason: silent, matches the main-process contract.
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to export ${format.toUpperCase()}`)
    } finally {
      setExporting(null)
    }
  }

  // The sample model (iteration 0) has no project-recorded STL/STEP to export. On a multi-part
  // project the buttons trigger the all-parts zip, so they gate on ANY part having an iteration -
  // not on whichever part happens to be focused. STEP availability per part isn't known renderer-
  // side (PartRecord carries no stepPath), so multi-part STEP stays enabled and the main process
  // reports skipped/absent STEPs itself (skippedParts / a helpful error).
  const multiPart = parts.length > 1
  const hasExportableModel = multiPart
    ? parts.some((p) => p.activeIteration !== null)
    : !!model && model.iteration > 0
  const canExportStep = multiPart ? hasExportableModel : hasExportableModel && !!model?.stepPath
  // The placement gizmo only exists for multi-part projects and detaches during select/measure
  // (they share the canvas) and while the agent is busy - mirror that in the toggle.
  const gizmoAvailable = multiPart && !!selectedPartId && !selectMode && !measureMode && !agentBusy

  return (
    <>
      <Paper
        elevation={4}
        sx={{
          position: 'absolute',
          top: 12,
          left: 12,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.5,
          bgcolor: colors.bgPanelRaised,
          flexWrap: 'wrap'
        }}
      >
        <Button startIcon={<ViewInArIcon />} onClick={() => void handleLoadSample()} disabled={loading}>
          {loading ? 'Loading...' : 'Load sample'}
        </Button>
        {model && <Chip size="small" variant="outlined" label={model.name} sx={{ fontFamily: fontMono }} />}
        {dims && <Chip size="small" variant="outlined" label={formatDimensions(dims)} sx={{ fontFamily: fontMono }} />}
        <Divider orientation="vertical" flexItem />
        <Button
          startIcon={<FileDownloadIcon />}
          onClick={() => void handleExport('stl')}
          disabled={!hasExportableModel || exporting !== null}
        >
          {exporting === 'stl' ? 'Exporting…' : 'Export STL'}
        </Button>
        <Button
          startIcon={<FileDownloadIcon />}
          onClick={() => void handleExport('step')}
          disabled={!canExportStep || exporting !== null}
        >
          {exporting === 'step' ? 'Exporting…' : 'Export STEP'}
        </Button>
        {multiPart && (
          <>
            <Divider orientation="vertical" flexItem />
            {/* Placement gizmo mode for the focused part (also the g/r keyboard shortcuts):
                Move slides on the plate and lifts vertically; Rotate spins on any axis. */}
            <ToggleButton
              value="translate"
              size="small"
              selected={gizmoMode === 'translate'}
              onChange={() => setGizmoMode('translate')}
              disabled={!gizmoAvailable}
            >
              <OpenWithIcon fontSize="small" sx={{ mr: 0.5 }} />
              Move
            </ToggleButton>
            <ToggleButton
              value="rotate"
              size="small"
              selected={gizmoMode === 'rotate'}
              onChange={() => setGizmoMode('rotate')}
              disabled={!gizmoAvailable}
            >
              <RotateRightIcon fontSize="small" sx={{ mr: 0.5 }} />
              Rotate
            </ToggleButton>
          </>
        )}
        <Divider orientation="vertical" flexItem />
        <ToggleButton value="select" size="small" selected={selectMode} onChange={handleSelectModeChange} disabled={!model}>
          <HighlightAltIcon fontSize="small" sx={{ mr: 0.5 }} />
          Select region
        </ToggleButton>
        {selection && (
          <Chip
            size="small"
            label={formatSelectionChip(selection.dims, selection.triCount)}
            onDelete={() => setSelection(null)}
            sx={{ fontFamily: fontMono }}
          />
        )}
        <ToggleButton
          value="measure"
          size="small"
          selected={measureMode}
          onChange={handleMeasureModeChange}
          disabled={!model}
        >
          <StraightenIcon fontSize="small" sx={{ mr: 0.5 }} />
          Measure
        </ToggleButton>
        {measurement !== null && (
          <Chip
            size="small"
            label={formatDistanceChip(measurement)}
            onDelete={() => setMeasurement(null)}
            sx={{ fontFamily: fontMono }}
          />
        )}
        <Divider orientation="vertical" flexItem />
        <ToggleButton value="axes" size="small" selected={showAxes} onChange={() => setShowAxes(!showAxes)}>
          <ExploreIcon fontSize="small" sx={{ mr: 0.5 }} />
          Axes
        </ToggleButton>
        <ToggleButton
          value="wireframe"
          size="small"
          selected={wireframe}
          onChange={() => setWireframe(!wireframe)}
          disabled={!model}
        >
          <GridOnIcon fontSize="small" sx={{ mr: 0.5 }} />
          Wireframe
        </ToggleButton>
      </Paper>
      {error ? (
        <Alert
          severity="error"
          variant="outlined"
          onClose={() => setError(null)}
          sx={{ position: 'absolute', bottom: 12, left: 12 }}
        >
          {error}
        </Alert>
      ) : (
        <Snackbar
          open={!!status}
          // The skipped-parts notice is the only place the user learns a part was left out of an
          // all-parts zip - give it long enough to actually read.
          autoHideDuration={status?.includes('left out') ? 10000 : 4000}
          onClose={() => setStatus(null)}
          sx={{ position: 'absolute', bottom: 12, left: 12 }}
        >
          <Alert severity="success" variant="outlined" onClose={() => setStatus(null)}>
            {status}
          </Alert>
        </Snackbar>
      )}
    </>
  )
}
