import Box from '@mui/material/Box'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { BriefPanel } from './BriefPanel'
import { ParamPanel } from './ParamPanel'
import { PrintSettingsPanel } from './PrintSettingsPanel'
import { VerificationPanel } from './VerificationPanel'

/** Which project-detail panel the right-dock Inspector currently shows. */
export type InspectorTab = 'brief' | 'parameters' | 'verify' | 'print'

interface InspectorProps {
  tab: InspectorTab
  onTabChange: (t: InspectorTab) => void
}

/**
 * The right dock's top region (Studio Workbench): a dense segmented tab bar switching between the
 * four project-detail panels, each rendered `embedded` (always-open, no per-panel collapse chrome -
 * the active tab itself is the "open" state). Sits above the chat dock in `App.tsx`'s right column.
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
          sx={{ width: '100%', '& .MuiToggleButton-root': { flex: 1, py: 0.25, fontSize: 11 } }}
        >
          <ToggleButton value="brief">Brief</ToggleButton>
          <ToggleButton value="parameters">Parameters</ToggleButton>
          <ToggleButton value="verify">Verify</ToggleButton>
          <ToggleButton value="print">Print</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {tab === 'brief' && <BriefPanel embedded />}
        {tab === 'parameters' && <ParamPanel embedded />}
        {tab === 'verify' && <VerificationPanel embedded />}
        {tab === 'print' && <PrintSettingsPanel embedded />}
      </Box>
    </Box>
  )
}
