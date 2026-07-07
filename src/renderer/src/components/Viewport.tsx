import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { ModelViewer } from '../three/viewer'

interface ViewportProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

/** Hosts the three.js canvas. Creates a ModelViewer on mount, disposes it on unmount. */
export function Viewport({ viewerRef }: ViewportProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const viewer = new ModelViewer(container)
    viewerRef.current = viewer

    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="viewport" ref={containerRef} />
}
