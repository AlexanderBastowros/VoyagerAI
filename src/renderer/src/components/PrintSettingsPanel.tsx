import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import PrintIcon from '@mui/icons-material/Print'
import { useAppStore } from '../state/appStore'
import { deriveChatDisabledReason } from '../state/setupSelectors'
import { colors } from '../colors'

/** Sent as an ordinary chat turn - the printable-cad skill's Phase 7 instructs the agent to
 *  respond by calling the `recommend_print_settings` MCP tool rather than replying in prose. */
const PROMPT = 'Recommend print settings for the current model.'

/** One label/value row in the settings list. */
function SettingRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between" gap={2}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={600} sx={{ textAlign: 'right' }}>
        {value}
      </Typography>
    </Stack>
  )
}

/**
 * Collapsible panel, above `ChatPanel`, that shows the most recent on-demand print-settings
 * recommendation (`recommend_print_settings` MCP tool -> `printSettings:updated` push - mirrors
 * the `display_model` -> `model:displayed` pattern end to end). Settings are fetched on demand
 * via the "Recommend" button rather than generated automatically, since they're only useful once
 * a model is print-ready.
 */
export function PrintSettingsPanel({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const printSettings = useAppStore((state) => state.printSettings)
  const model = useAppStore((state) => state.model)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const setAgentBusy = useAppStore((state) => state.setAgentBusy)
  const setupStatus = useAppStore((state) => state.setupStatus)
  const addMessage = useAppStore((state) => state.addMessage)
  const [expanded, setExpanded] = useState(false)

  const disabledReason = deriveChatDisabledReason(setupStatus)
  const isDisabled = disabledReason !== null || agentBusy
  const canRecommend = !!model && !isDisabled

  // Auto-reveal the panel the moment a fresh recommendation arrives, so the user doesn't have to
  // notice and click to expand it themselves. Stays collapsed by default when there's nothing yet.
  useEffect(() => {
    if (printSettings) setExpanded(true)
  }, [printSettings])

  async function requestRecommendation(): Promise<void> {
    if (!model || agentBusy || isDisabled) return

    addMessage({ role: 'user', text: PROMPT })
    setAgentBusy(true)

    try {
      const response = await window.voyager.agent.sendMessage({ text: PROMPT })
      if (!response.accepted) {
        setAgentBusy(false)
        addMessage({
          role: 'system-status',
          text: response.reason ?? 'The agent could not accept the message.'
        })
      }
      // On accept, streamed agent:event messages (and the print-settings push) drive the UI from
      // here; agentBusy clears on message-complete / error like any other turn.
    } catch (err) {
      setAgentBusy(false)
      addMessage({
        role: 'system-status',
        text: err instanceof Error ? `Failed to reach agent: ${err.message}` : 'Failed to reach agent'
      })
    }
  }

  const recommendDisabledTitle = !model
    ? 'Generate a model first'
    : agentBusy
      ? 'Voyager is still working — wait for it to finish'
      : (disabledReason ?? '')

  const recommendButton = (
    <Tooltip title={canRecommend ? '' : recommendDisabledTitle}>
      <span>
        <Button
          size="small"
          variant="outlined"
          startIcon={<PrintIcon fontSize="small" />}
          disabled={!canRecommend}
          onClick={() => void requestRecommendation()}
        >
          {printSettings ? 'Refresh' : 'Recommend'}
        </Button>
      </span>
    </Tooltip>
  )

  const isStale = printSettings !== null && printSettings.iteration !== model?.iteration
  const open = embedded || expanded

  return (
    <Box
      sx={{
        borderBottom: embedded ? 0 : 1,
        borderColor: 'divider',
        bgcolor: embedded ? 'transparent' : 'background.paper',
        flexShrink: 0
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        gap={1}
        sx={{ px: 1.75, py: 1, cursor: embedded ? 'default' : 'pointer' }}
        onClick={embedded ? undefined : () => setExpanded((prev) => !prev)}
      >
        <Typography variant="overline" color="text.secondary">
          Print settings
        </Typography>
        <Stack direction="row" alignItems="center" gap={0.5} onClick={(e) => e.stopPropagation()}>
          {recommendButton}
          {!embedded && (
            <IconButton
              size="small"
              aria-label={expanded ? 'Collapse print settings' : 'Expand print settings'}
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </IconButton>
          )}
        </Stack>
      </Stack>
      <Collapse in={open}>
        <Box sx={{ px: 1.75, pb: 1.5 }}>
          {printSettings ? (
            <Stack spacing={0.75}>
              <Typography variant="caption" color="text.disabled">
                For model v{printSettings.iteration}
                {isStale && ' (settings are for an earlier version)'}
              </Typography>
              <Stack spacing={0.5} sx={{ bgcolor: colors.bgPanelRaised, borderRadius: 1, px: 1.25, py: 1 }}>
                <SettingRow label="Material" value={printSettings.material} />
                <SettingRow label="Layer height" value={`${printSettings.layerHeightMm} mm`} />
                <SettingRow label="Walls" value={String(printSettings.wallCount)} />
                <SettingRow label="Top & bottom layers" value={String(printSettings.topBottomLayers)} />
                <SettingRow
                  label="Infill"
                  value={`${printSettings.infillPercent}%${
                    printSettings.infillPattern ? ` · ${printSettings.infillPattern}` : ''
                  }`}
                />
                <SettingRow label="Supports" value={printSettings.supports} />
                <SettingRow label="Build-plate adhesion" value={printSettings.adhesion} />
                <SettingRow label="Nozzle temp" value={`${printSettings.nozzleTempC}°C`} />
                <SettingRow label="Bed temp" value={`${printSettings.bedTempC}°C`} />
                <SettingRow label="Print speed" value={`${printSettings.printSpeedMmS} mm/s`} />
                <SettingRow label="Orientation" value={printSettings.orientation} />
              </Stack>
              {printSettings.notes && (
                <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                  {printSettings.notes}
                </Typography>
              )}
            </Stack>
          ) : (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.disabled">
                Get recommended slicer settings for the current model.
              </Typography>
              {recommendButton}
            </Stack>
          )}
        </Box>
      </Collapse>
    </Box>
  )
}
