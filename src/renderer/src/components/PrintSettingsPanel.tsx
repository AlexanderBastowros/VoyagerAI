import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Collapse from '@mui/material/Collapse'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import PrintIcon from '@mui/icons-material/Print'
import { useAppStore } from '../state/appStore'
import { deriveChatDisabledReason } from '../state/setupSelectors'
import { PLATE_MARGIN_MM, PART_GAP_MM } from '../three/arrangeAlongX'
import { colors } from '../colors'

/** Sent as an ordinary chat turn - the printable-cad skill's Phase 7 instructs the agent to
 *  respond by calling the `recommend_print_settings` MCP tool rather than replying in prose. */
const PROMPT = 'Recommend print settings for the current model.'

function mm(value: number): string {
  return `${Math.round(value * 10) / 10} mm`
}

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
  const printPreviewArranged = useAppStore((state) => state.printPreviewArranged)
  const setPrintPreviewArranged = useAppStore((state) => state.setPrintPreviewArranged)
  const printPreviewRowWidthMm = useAppStore((state) => state.printPreviewRowWidthMm)
  const [expanded, setExpanded] = useState(false)
  /** The active printer's usable bed width, or null for "no active profile / could not check". Only
   *  fetched while the preview is armed - most sessions never open the Printer panel, so the store's
   *  `printerProfiles` slice is usually empty and cannot be read instead. */
  const [bed, setBed] = useState<{ name: string; usableXMm: number } | null>(null)

  const disabledReason = deriveChatDisabledReason(setupStatus)
  const isDisabled = disabledReason !== null || agentBusy
  const canRecommend = !!model && !isDisabled

  // Auto-reveal the panel the moment a fresh recommendation arrives, so the user doesn't have to
  // notice and click to expand it themselves. Stays collapsed by default when there's nothing yet.
  useEffect(() => {
    if (printSettings) setExpanded(true)
  }, [printSettings])

  // Bed-fit is a REPORT, not a constraint: the row is never shrunk or wrapped to fit, so this only
  // decides which caption is shown. Fetched when the preview arms (and re-fetched on each re-arm, so
  // a profile saved in between is picked up); a missing/failed profile just means "not checked".
  useEffect(() => {
    if (!printPreviewArranged) return
    let cancelled = false
    void window.voyager.printerProfile
      .list()
      .then(({ profiles, activeId }) => {
        if (cancelled) return
        const active = profiles.find((p) => p.id === activeId)
        setBed(active ? { name: active.name, usableXMm: active.bedXMm - 2 * PLATE_MARGIN_MM } : null)
      })
      .catch(() => {
        if (!cancelled) setBed(null)
      })
    return () => {
      cancelled = true
    }
  }, [printPreviewArranged])

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

  // The preview toggle stays ENABLED while the agent is busy on purpose: it is renderer-only (no
  // IPC, nothing persisted), so unlike every other part-moving control it cannot collide with a
  // turn in flight - which is also why it can arm itself mid-turn the moment a recommendation lands.
  const previewToggle = printSettings !== null && (
    <Tooltip title="Show every part in a single row along the grid's X axis, rotated so the face that prints on the bed sits on the grid. Preview only - nothing is saved and exports are unaffected.">
      <FormControlLabel
        sx={{ mr: 0, ml: 0 }}
        control={
          <Switch
            size="small"
            checked={printPreviewArranged}
            onChange={(e) => setPrintPreviewArranged(e.target.checked)}
          />
        }
        label={
          <Typography variant="caption" color="text.secondary">
            Preview layout
          </Typography>
        }
      />
    </Tooltip>
  )

  const overflow =
    bed !== null && printPreviewRowWidthMm !== null && printPreviewRowWidthMm > bed.usableXMm
      ? { rowWidthMm: printPreviewRowWidthMm, usableXMm: bed.usableXMm, name: bed.name }
      : null

  const previewStatus = printPreviewArranged && (
    <Stack spacing={0.5} sx={{ bgcolor: colors.bgPanelRaised, borderRadius: 1, px: 1.25, py: 1 }}>
      <Typography variant="caption" color="text.secondary">
        <strong>Print-orientation preview is on.</strong> Parts are shown in one row along X, each
        rotated so its bed face rests on the grid (so the vertical extent you see is the print
        height), {PART_GAP_MM} mm between neighbours for brim/skirt clearance.
      </Typography>
      {printPreviewRowWidthMm !== null ? (
        <Typography variant="caption" color="text.secondary">
          Row width {mm(printPreviewRowWidthMm)}
          {bed ? ` · ${bed.name} usable bed X ${mm(bed.usableXMm)}` : ' · bed width not checked (no active printer profile)'}
        </Typography>
      ) : (
        <Typography variant="caption" color="text.disabled">
          No part geometry to arrange yet.
        </Typography>
      )}
      {overflow && (
        <Typography variant="caption" color="warning.main">
          The row is {mm(overflow.rowWidthMm)} wide but {overflow.name}&apos;s usable bed is only{' '}
          {mm(overflow.usableXMm)} across (bed X minus {PLATE_MARGIN_MM} mm per side). Nothing was
          moved to make it fit - print these parts in more than one batch.
        </Typography>
      )}
      <Typography variant="caption" color="text.disabled">
        Nothing is saved: this moves the parts on screen only. <strong>Export plate (STL)</strong>{' '}
        still uses the placements you arranged and saved yourself, and the placement gizmo is
        detached while the preview is on. Turn it off to get your own layout back.
      </Typography>
      <Typography variant="caption" color="text.disabled">
        The viewport grid is a fixed 200 mm decoration, not your bed - a row that legitimately fits a
        256 mm bed will still overhang it.
      </Typography>
    </Stack>
  )

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
          {previewToggle}
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
              {previewStatus}
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
