import { useState } from 'react'
import type { MutableRefObject } from 'react'
import type { ModelViewer } from '../three/viewer'
import { useAppStore } from '../state/appStore'

interface ToolbarProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

/** Slim toolbar over the viewport. Milestone 1 only has the sample-model dev action. */
export function Toolbar({ viewerRef }: ToolbarProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)

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
    </div>
  )
}
