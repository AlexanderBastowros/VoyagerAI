import { useEffect, useState } from 'react'
import type { MutableRefObject } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import PrintOutlinedIcon from '@mui/icons-material/PrintOutlined'
import type { AgentEffort, AgentModel, AgentSettings } from '../../../shared/ipc'
import type { ModelViewer } from '../three/viewer'
import { colors, fontMono } from '../colors'
import { useAppStore } from '../state/appStore'
import { badgeLabel, badgeTone } from '../state/verificationSelectors'

interface StatusBarProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

/** Friendly labels for the model picker's `AgentModel` values - matches the option labels in
 *  `ChatPanel.tsx`'s `MODEL_OPTIONS`, minus the "— deepest/balanced/fastest" suffix (too long for
 *  a status-bar segment). */
const MODEL_LABEL: Record<AgentModel, string> = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5': 'Haiku 4.5'
}

const EFFORT_LABEL: Record<AgentEffort, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'X-high',
  max: 'Max'
}

/** Haiku's API rejects the `effort` option outright (mirrors `EFFORT_UNSUPPORTED_MODELS` in
 *  `ChatPanel.tsx`/`packages/agent-core/src/agent/session.ts`), so its segment omits the effort
 *  suffix rather than showing a value that was never actually sent. */
function formatModelEffort(settings: AgentSettings): string {
  const modelLabel = MODEL_LABEL[settings.model]
  if (settings.model === 'claude-haiku-4-5') return modelLabel
  return `${modelLabel} · ${EFFORT_LABEL[settings.effort]}`
}

function formatDims(dims: { x: number; y: number; z: number }): string {
  const fmt = (n: number): string => n.toFixed(1)
  return `${fmt(dims.x)} × ${fmt(dims.y)} × ${fmt(dims.z)} mm`
}

/**
 * Full-width bottom bar (Studio Workbench): read-only/presentational live status - the
 * verification badge, the displayed model's size + triangle count, the active printer, the
 * model/effort choice, and whether the agent (or a parameter re-run) is currently working.
 * Segments are hidden individually when their underlying data is absent; nothing here writes to
 * the store.
 */
export function StatusBar({ viewerRef }: StatusBarProps): React.JSX.Element {
  const verificationReport = useAppStore((state) => state.verificationReport)
  const agentSettings = useAppStore((state) => state.agentSettings)
  const printerProfiles = useAppStore((state) => state.printerProfiles)
  const activePrinterProfileId = useAppStore((state) => state.activePrinterProfileId)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const paramUpdatePending = useAppStore((state) => state.paramUpdatePending)
  const model = useAppStore((state) => state.model)
  const parts = useAppStore((state) => state.parts)
  const selectedPartId = useAppStore((state) => state.selectedPartId)

  const [dims, setDims] = useState<{ x: number; y: number; z: number } | null>(null)
  const [triCount, setTriCount] = useState<number | null>(null)

  // Mirrors ViewportControls' dims effect: the viewer loads geometry synchronously, so by the
  // time this runs after a change the new bounds/triangle count are already computed. Also keyed
  // on `parts`/`selectedPartId` - the focused part's own `model` already changes on refocus, but a
  // part being added/removed changes the all-parts triangle sum even when the focused part (and
  // therefore `model`) doesn't.
  useEffect(() => {
    setDims(viewerRef.current?.getDimensions() ?? null)
    setTriCount(viewerRef.current?.getTriangleCount() ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, parts, selectedPartId])

  const activePrinterName = printerProfiles.find((p) => p.id === activePrinterProfileId)?.name ?? null

  const stateLabel = agentBusy ? 'Working…' : paramUpdatePending ? 'Updating…' : 'Ready'
  const stateDotColor = agentBusy ? 'warning.main' : paramUpdatePending ? 'info.main' : 'success.main'

  const leftItems = [
    verificationReport && (
      <Chip
        key="verify"
        size="small"
        label={badgeLabel(verificationReport.badge)}
        color={badgeTone(verificationReport.badge)}
        sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
      />
    ),
    dims && (
      <Typography key="dims" variant="caption" sx={{ fontFamily: fontMono, color: colors.textSecondary }}>
        {formatDims(dims)}
      </Typography>
    ),
    triCount !== null && (
      <Typography key="tris" variant="caption" sx={{ fontFamily: fontMono, color: colors.textSecondary }}>
        {triCount.toLocaleString()} tris
      </Typography>
    )
  ].filter((item): item is React.JSX.Element => Boolean(item))

  const rightItems = [
    activePrinterName && (
      <Stack key="printer" direction="row" alignItems="center" gap={0.5}>
        <PrintOutlinedIcon sx={{ fontSize: 13 }} color="action" />
        <Typography variant="caption" color="text.secondary">
          {activePrinterName}
        </Typography>
      </Stack>
    ),
    <Typography key="model-effort" variant="caption" color="text.secondary">
      {formatModelEffort(agentSettings)}
    </Typography>,
    <Stack key="state" direction="row" alignItems="center" gap={0.5}>
      <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: stateDotColor, flexShrink: 0 }} />
      <Typography variant="caption" color="text.secondary">
        {stateLabel}
      </Typography>
    </Stack>
  ].filter((item): item is React.JSX.Element => Boolean(item))

  return (
    <Box
      sx={{
        height: 26,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        bgcolor: 'background.paper',
        borderTop: 1,
        borderColor: 'divider',
        px: 1.25,
        fontSize: 11,
        color: 'text.secondary'
      }}
    >
      <Stack direction="row" alignItems="center" gap={1.25}>
        {leftItems.map((item, i) => (
          <Stack key={i} direction="row" alignItems="center" gap={1.25}>
            {i > 0 && <Divider orientation="vertical" flexItem sx={{ borderColor: 'divider' }} />}
            {item}
          </Stack>
        ))}
      </Stack>
      <Box sx={{ flex: 1 }} />
      <Stack direction="row" alignItems="center" gap={1.25}>
        {rightItems.map((item, i) => (
          <Stack key={i} direction="row" alignItems="center" gap={1.25}>
            {i > 0 && <Divider orientation="vertical" flexItem sx={{ borderColor: 'divider' }} />}
            {item}
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}
