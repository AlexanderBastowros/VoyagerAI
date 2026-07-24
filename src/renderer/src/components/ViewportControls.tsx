import { useEffect, useState } from 'react'
import type { MutableRefObject } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import ListSubheader from '@mui/material/ListSubheader'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Snackbar from '@mui/material/Snackbar'
import ToggleButton from '@mui/material/ToggleButton'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
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

/** Display label for each single-file export format - used in menu items and status/error text
 *  (`'plate'`/`'package'` read oddly upper-cased, unlike the other three). */
const FORMAT_LABEL: Record<ExportFormat, string> = {
  stl: 'STL',
  step: 'STEP',
  '3mf': '3MF',
  plate: 'Plate',
  package: 'Package'
}

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
  // Label of the export currently in flight (e.g. `'STL'`, `'Plate'`, `'Package'`) - drives the
  // "Exporting …" button text and disables the whole Export control against re-entrant clicks;
  // no longer keyed by `ExportFormat` now that one menu covers per-part/all-parts/plate/package.
  const [exporting, setExporting] = useState<string | null>(null)
  const [exportMenuAnchor, setExportMenuAnchor] = useState<HTMLElement | null>(null)
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
        scriptPath: null,
        partId: 'main'
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sample model')
    } finally {
      setLoading(false)
    }
  }

  /** Renders the shared "Saved …" success snackbar text for both `model.export` and
   *  `exportPackage.export` - same template, just a different label/zip-ness/skip list. */
  function flashSaved(label: string, path: string | undefined, isZip: boolean, skippedNames?: string[]): void {
    const skipped = skippedNames?.length ? ` (left out: ${skippedNames.join(', ')})` : ''
    flashStatus(`Saved ${label}${isZip ? ' zip' : ''}${path ? ` to ${path}` : ''}${skipped}`)
  }

  /** Per-part (with `partId`), all-parts (`partId` omitted on a multi-part project), or plate
   *  (`format: 'plate'`, `partId` ignored by the main process) export - one STL/STEP/3MF/plate
   *  request/response shape covers all three (`ExportModelRequest`/`Response`). */
  async function handleExport(format: ExportFormat, partId?: string): Promise<void> {
    setExportMenuAnchor(null)
    setExporting(FORMAT_LABEL[format])
    setError(null)
    try {
      const response = await window.voyager.model.export({ format, partId })
      if (response.saved) {
        // A multi-part/plate export can leave parts out (no iterations, no STEP/3MF, hidden) -
        // the main process names them here rather than silently dropping them.
        const isZip = !!response.path?.endsWith('.zip')
        flashSaved(FORMAT_LABEL[format], response.path, isZip, response.skippedParts)
      } else if (response.reason) {
        setError(response.reason)
      }
      // Canceled dialog with no reason: silent, matches the main-process contract.
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to export ${FORMAT_LABEL[format]}`)
    } finally {
      setExporting(null)
    }
  }

  /** Graduation package (§12.1): a zip of every part's STEP/3MF/STL/script, the locked brief, a
   *  combined PARAMS manifest, and a generated README - a distinct request/response shape
   *  (`ExportPackageRequest`/`Response`) from `model.export`, so it's a separate handler. */
  async function handleExportPackage(): Promise<void> {
    setExportMenuAnchor(null)
    setExporting(FORMAT_LABEL.package)
    setError(null)
    try {
      const response = await window.voyager.exportPackage.export({})
      if (response.saved) {
        flashSaved(FORMAT_LABEL.package, response.path, true)
      } else if (response.reason) {
        setError(response.reason)
      }
      // Canceled dialog with no reason: silent, matches the main-process contract.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export package')
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
  // The focused part for the "This part" export section - always populated once any part exists
  // (see `syncParts.ts`/`PartsPanel.tsx`), guarded anyway since a menu item needs a concrete id.
  const selectedPart = parts.find((p) => p.id === selectedPartId) ?? null
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
          endIcon={<ArrowDropDownIcon />}
          onClick={(e) => setExportMenuAnchor(e.currentTarget)}
          disabled={!hasExportableModel || exporting !== null}
        >
          {exporting ? `Exporting ${exporting}…` : 'Export'}
        </Button>
        <Menu anchorEl={exportMenuAnchor} open={!!exportMenuAnchor} onClose={() => setExportMenuAnchor(null)}>
          {multiPart && selectedPart
            ? [
                <ListSubheader key="this-part-header" disableSticky>
                  This part — {selectedPart.name}
                </ListSubheader>,
                <MenuItem key="this-stl" onClick={() => void handleExport('stl', selectedPart.id)}>
                  Export STL
                </MenuItem>,
                <MenuItem key="this-step" onClick={() => void handleExport('step', selectedPart.id)}>
                  Export STEP
                </MenuItem>,
                <MenuItem key="this-3mf" onClick={() => void handleExport('3mf', selectedPart.id)}>
                  Export 3MF
                </MenuItem>,
                <Divider key="this-part-divider" />,
                <ListSubheader key="all-parts-header" disableSticky>
                  All parts
                </ListSubheader>,
                <MenuItem key="all-stl" onClick={() => void handleExport('stl')}>
                  Export STL (zip)
                </MenuItem>,
                <MenuItem key="all-step" onClick={() => void handleExport('step')}>
                  Export STEP (zip)
                </MenuItem>,
                <MenuItem key="all-3mf" onClick={() => void handleExport('3mf')}>
                  Export 3MF (zip)
                </MenuItem>,
                <Divider key="all-parts-divider" />
              ]
            : [
                <MenuItem key="stl" onClick={() => void handleExport('stl')}>
                  Export STL
                </MenuItem>,
                <MenuItem key="step" disabled={!canExportStep} onClick={() => void handleExport('step')}>
                  Export STEP
                </MenuItem>,
                <MenuItem key="3mf" onClick={() => void handleExport('3mf')}>
                  Export 3MF
                </MenuItem>,
                <Divider key="single-part-divider" />
              ]}
          <MenuItem onClick={() => void handleExport('plate')}>Export plate (STL)</MenuItem>
          <Divider />
          <MenuItem onClick={() => void handleExportPackage()}>Export package (zip)</MenuItem>
        </Menu>
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
