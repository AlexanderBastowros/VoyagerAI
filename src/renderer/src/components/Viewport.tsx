import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { ModelViewer } from '../three/viewer'
import { SelectionHighlight } from '../three/selection'
import { SelectionController } from '../three/selectionController'
import { useAppStore } from '../state/appStore'

interface ViewportProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

/** Hosts the three.js canvas and the marquee-select overlay/controller. Creates a
 *  ModelViewer on mount, disposes it (and the selection controller/highlight) on unmount. */
export function Viewport({ viewerRef }: ViewportProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const marqueeRef = useRef<HTMLDivElement | null>(null)
  const controllerRef = useRef<SelectionController | null>(null)

  const selectMode = useAppStore((state) => state.selectMode)
  const selection = useAppStore((state) => state.selection)
  const setSelection = useAppStore((state) => state.setSelection)
  const model = useAppStore((state) => state.model)

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

    return () => {
      controller.dispose()
      highlight.dispose()
      viewer.dispose()
      controllerRef.current = null
      viewerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep select-mode interaction (and orbit enable/disable) in sync with the toolbar toggle.
  useEffect(() => {
    controllerRef.current?.setActive(selectMode)
  }, [selectMode])

  // Any code path that clears the store selection (auto-clear after an accepted
  // send, Escape, a new model iteration arriving) should also hide the visual
  // highlight, regardless of which component triggered the clear.
  useEffect(() => {
    if (selection === null) {
      viewerRef.current?.setHighlightObject(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  return (
    <Box
      ref={containerRef}
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        bgcolor: 'background.default',
        cursor: selectMode ? 'crosshair' : 'default',
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
    </Box>
  )
}
