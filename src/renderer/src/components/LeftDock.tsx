import type { MutableRefObject } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ModelViewer } from '../three/viewer'
import type { LeftView } from './ActivityRail'
import { PartsPanel } from './PartsPanel'
import { PrinterProfilesPanel } from './PrinterProfilesPanel'
import { VersionHistoryPanel } from './VersionHistoryPanel'

interface LeftDockProps {
  view: LeftView
  viewerRef: MutableRefObject<ModelViewer | null>
}

const VIEW_LABEL: Record<LeftView, string> = {
  parts: 'Parts',
  history: 'Version history',
  printer: 'Printer'
}

/**
 * The ~250px left dock body (Studio Workbench): a small header naming the view the activity rail
 * currently has selected, above the corresponding panel rendered `embedded` (always-open, no
 * collapse chrome of its own - the dock itself is the frame).
 */
export function LeftDock({ view, viewerRef }: LeftDockProps): React.JSX.Element {
  return (
    <Box
      sx={{
        width: 250,
        flexShrink: 0,
        height: '100%',
        bgcolor: 'background.paper',
        borderRight: 1,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0
      }}
    >
      <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Typography variant="overline" color="text.secondary">
          {VIEW_LABEL[view]}
        </Typography>
      </Box>
      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {view === 'parts' && <PartsPanel embedded />}
        {view === 'history' && <VersionHistoryPanel viewerRef={viewerRef} />}
        {view === 'printer' && <PrinterProfilesPanel embedded />}
      </Box>
    </Box>
  )
}
