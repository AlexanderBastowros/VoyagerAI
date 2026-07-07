import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { ExportFormat } from '../../../shared/ipc'
import type { ModelViewer } from '../three/viewer'
import { useAppStore } from '../state/appStore'

interface ToolbarProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

const STATUS_CLEAR_MS = 4000

function formatSelectionChip(dims: [number, number, number], triCount: number): string {
  const fmt = (n: number): string => n.toFixed(1)
  return `~${fmt(dims[0])}×${fmt(dims[1])}×${fmt(dims[2])} mm · ${triCount} tris`
}

/** Slim toolbar over the viewport: sample-model dev action, export, region-selection controls. */
export function Toolbar({ viewerRef }: ToolbarProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const selectMode = useAppStore((state) => state.selectMode)
  const setSelectMode = useAppStore((state) => state.setSelectMode)
  const selection = useAppStore((state) => state.selection)
  const setSelection = useAppStore((state) => state.setSelection)

  useEffect(() => {
    return () => {
      if (statusTimer.current) clearTimeout(statusTimer.current)
    }
  }, [])

  function flashStatus(message: string): void {
    if (statusTimer.current) clearTimeout(statusTimer.current)
    setStatus(message)
    statusTimer.current = setTimeout(() => setStatus(null), STATUS_CLEAR_MS)
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
    <div className="toolbar">
      <div className="toolbar-group">
        <button type="button" className="toolbar-button" onClick={() => void handleLoadSample()} disabled={loading}>
          {loading ? 'Loading...' : 'Load sample'}
        </button>
        {model && <span className="toolbar-model-name">{model.name}</span>}
      </div>
      <div className="toolbar-group">
        <button
          type="button"
          className="toolbar-button"
          onClick={() => void handleExport('stl')}
          disabled={!hasExportableModel || exporting !== null}
        >
          {exporting === 'stl' ? 'Exporting…' : 'Export STL'}
        </button>
        <button
          type="button"
          className="toolbar-button"
          onClick={() => void handleExport('step')}
          disabled={!canExportStep || exporting !== null}
        >
          {exporting === 'step' ? 'Exporting…' : 'Export STEP'}
        </button>
      </div>
      <div className="toolbar-group">
        <button
          type="button"
          className={selectMode ? 'toolbar-button toolbar-button-active' : 'toolbar-button'}
          onClick={() => setSelectMode(!selectMode)}
          disabled={!model}
          aria-pressed={selectMode}
        >
          Select region
        </button>
        {selection && (
          <>
            <span className="toolbar-selection-chip">{formatSelectionChip(selection.dims, selection.triCount)}</span>
            <button type="button" className="toolbar-button" onClick={() => setSelection(null)}>
              Clear
            </button>
          </>
        )}
      </div>
      {status && <span className="toolbar-status">{status}</span>}
      {error && <span className="toolbar-error">{error}</span>}
    </div>
  )
}
