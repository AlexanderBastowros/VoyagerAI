import Box from '@mui/material/Box'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { BriefPanel } from './BriefPanel'
import { ChatPanel } from './ChatPanel'
import { ParamPanel } from './ParamPanel'
import { PrintSettingsPanel } from './PrintSettingsPanel'
import { VerificationPanel } from './VerificationPanel'

/** Which project-detail panel the right-dock Inspector currently shows. */
export type InspectorTab = 'chat' | 'brief' | 'parameters' | 'verify' | 'print'

interface InspectorProps {
  tab: InspectorTab
  onTabChange: (t: InspectorTab) => void
}

/**
 * The right dock (Studio Workbench): a dense segmented tab bar switching between the assistant chat
 * and the four project-detail panels, each rendered `embedded` (always-open, no per-panel collapse
 * chrome - the active tab itself is the "open" state). Chat is a peer tab rather than a separate
 * docked region, so all five surfaces share one panel and one at a time is visible.
 *
 * Chat renders directly (it manages its own scrolling log + pinned composer); the other four render
 * inside a single scroll container.
 */
export function Inspector({ tab, onTabChange }: InspectorProps): React.JSX.Element {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box sx={{ px: 1, py: 0.75, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <ToggleButtonGroup
          value={tab}
          exclusive
          size="small"
          onChange={(_, next: InspectorTab | null) => {
            if (next) onTabChange(next)
          }}
          sx={{ width: '100%', '& .MuiToggleButton-root': { flex: 1, py: 0.25, px: 0.5, fontSize: 11 } }}
        >
          <ToggleButton value="chat">Chat</ToggleButton>
          <ToggleButton value="brief">Brief</ToggleButton>
          <ToggleButton value="parameters">Params</ToggleButton>
          <ToggleButton value="verify">Verify</ToggleButton>
          <ToggleButton value="print">Print</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      {tab === 'chat' ? (
        <ChatPanel />
      ) : (
        <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {tab === 'brief' && <BriefPanel embedded />}
          {tab === 'parameters' && <ParamPanel embedded />}
          {tab === 'verify' && <VerificationPanel embedded />}
          {tab === 'print' && <PrintSettingsPanel embedded />}
        </Box>
      )}
    </Box>
  )
}
