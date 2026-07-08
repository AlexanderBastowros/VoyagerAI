import { useState } from 'react'
import type { MutableRefObject } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import Snackbar from '@mui/material/Snackbar'
import ToggleButton from '@mui/material/ToggleButton'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import HighlightAltIcon from '@mui/icons-material/HighlightAlt'
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

/** Floating controls over the viewport: sample-model dev action, export, region-selection controls. */
export function ViewportControls({ viewerRef }: ViewportControlsProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const selectMode = useAppStore((state) => state.selectMode)
  const setSelectMode = useAppStore((state) => state.setSelectMode)
  const selection = useAppStore((state) => state.selection)
  const setSelection = useAppStore((state) => state.setSelection)

  function flashStatus(message: string): void {
    setStatus(message)
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
        flashStatus(`Saved ${format.toUpperCase()}${response.path ? ` to ${response.path}` : ''}`)
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

  // The sample model (iteration 0) has no project-recorded STL/STEP to export.
  const hasExportableModel = !!model && model.iteration > 0
  const canExportStep = hasExportableModel && !!model?.stepPath

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
          bgcolor: colors.bgPanelRaised
        }}
      >
        <Button startIcon={<ViewInArIcon />} onClick={() => void handleLoadSample()} disabled={loading}>
          {loading ? 'Loading...' : 'Load sample'}
        </Button>
        {model && <Chip size="small" variant="outlined" label={model.name} sx={{ fontFamily: fontMono }} />}
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
        <Divider orientation="vertical" flexItem />
        <ToggleButton
          value="select"
          size="small"
          selected={selectMode}
          onChange={() => setSelectMode(!selectMode)}
          disabled={!model}
        >
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
          autoHideDuration={4000}
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
