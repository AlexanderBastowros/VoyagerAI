import { useState } from 'react'
import type { MutableRefObject } from 'react'
import type { ModelViewer } from '../three/viewer'
import { useAppStore } from '../state/appStore'

interface ToolbarProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

function formatSelectionChip(dims: [number, number, number], triCount: number): string {
  const fmt = (n: number): string => n.toFixed(1)
  return `~${fmt(dims[0])}×${fmt(dims[1])}×${fmt(dims[2])} mm · ${triCount} tris`
}

/** Slim toolbar over the viewport: sample-model dev action, region-selection controls. */
export function Toolbar({ viewerRef }: ToolbarProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const selectMode = useAppStore((state) => state.selectMode)
  const setSelectMode = useAppStore((state) => state.setSelectMode)
  const selection = useAppStore((state) => state.selection)
  const setSelection = useAppStore((state) => state.setSelection)

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

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button type="button" className="toolbar-button" onClick={() => void handleLoadSample()} disabled={loading}>
          {loading ? 'Loading...' : 'Load sample'}
        </button>
        {model && <span className="toolbar-model-name">{model.name}</span>}
        {error && <span className="toolbar-error">{error}</span>}
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
    </div>
  )
}
