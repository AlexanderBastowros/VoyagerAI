import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Slider from '@mui/material/Slider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import TuneIcon from '@mui/icons-material/Tune'
import { emptyScriptManifest } from '../../../shared/ipc'
import type { ParamEntry } from '../../../shared/ipc'
import { useAppStore } from '../state/appStore'
import { deriveChatDisabledReason } from '../state/setupSelectors'

/** Sliders only render for a bounded range - an entry missing either end falls back to a plain
 *  number field, committed on blur/Enter instead of on every keystroke. */
function hasBounds(entry: ParamEntry): entry is ParamEntry & { min: number; max: number } {
  return entry.min !== undefined && entry.max !== undefined
}

function sliderStep(min: number, max: number): number {
  return max - min > 50 ? 1 : 0.1
}

interface ParamRowProps {
  entry: ParamEntry
  draftValue: number
  disabled: boolean
  error?: string
  onDraftChange: (value: number) => void
  onCommit: (value: number) => void
}

function ParamRow({ entry, draftValue, disabled, error, onDraftChange, onCommit }: ParamRowProps): React.JSX.Element {
  const [textValue, setTextValue] = useState(String(draftValue))

  useEffect(() => {
    setTextValue(String(draftValue))
  }, [draftValue])

  function commitText(): void {
    const parsed = Number(textValue)
    if (Number.isFinite(parsed) && parsed !== entry.value) onCommit(parsed)
    else setTextValue(String(draftValue))
  }

  return (
    <Stack spacing={0.25}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline">
        <Typography variant="body2">{entry.label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {draftValue} {entry.unit}
        </Typography>
      </Stack>
      {hasBounds(entry) ? (
        <Slider
          size="small"
          value={draftValue}
          min={entry.min}
          max={entry.max}
          step={sliderStep(entry.min, entry.max)}
          disabled={disabled}
          onChange={(_e, value) => onDraftChange(value as number)}
          onChangeCommitted={(_e, value) => onCommit(value as number)}
        />
      ) : (
        <TextField
          size="small"
          type="number"
          value={textValue}
          disabled={disabled}
          onChange={(e) => setTextValue(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
          }}
          slotProps={{ htmlInput: { step: 'any' } }}
        />
      )}
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
    </Stack>
  )
}

/**
 * WS-B's parameter panel (architecture doc §7 - instant, free dimension tweaks). Renders one
 * slider/input per entry in the active iteration's PARAMS manifest; committing a value calls
 * `param:update`, which re-runs the script server-side (no agent turn) and broadcasts
 * `model:displayed` exactly like an agent-authored iteration - the viewport/version history pick
 * that up via `App.tsx`'s existing subscription, so this panel only needs to track its own
 * draft/pending/error UI state and refetch the manifest once the active iteration changes.
 */
export function ParamPanel({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const model = useAppStore((state) => state.model)
  const manifest = useAppStore((state) => state.manifest)
  const setManifest = useAppStore((state) => state.setManifest)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const setupStatus = useAppStore((state) => state.setupStatus)
  const setParamUpdatePending = useAppStore((state) => state.setParamUpdatePending)

  const [expanded, setExpanded] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, number>>({})
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})

  const iteration = model?.iteration ?? null

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    void window.voyager.param.getManifest().then((response) => {
      if (cancelled) return
      setManifest(response.manifest ?? emptyScriptManifest())
      setDrafts({})
      setErrors({})
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
    // Re-fetch whenever the displayed iteration changes - both an agent turn and a successful
    // param edit land here via the same `model:displayed` broadcast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iteration, setManifest])

  const disabledReason = deriveChatDisabledReason(setupStatus)
  const anyPending = Object.values(pending).some(Boolean)
  const controlsDisabled = !model || agentBusy || disabledReason !== null || anyPending

  async function commit(entry: ParamEntry, value: number): Promise<void> {
    setPending((p) => ({ ...p, [entry.name]: true }))
    // Global (not per-param) - the panel already disables every control while any one edit is in
    // flight, so at most one re-run runs at a time and the viewport can just key off this flag.
    setParamUpdatePending(true)
    setErrors((e) => ({ ...e, [entry.name]: undefined }))
    try {
      const response = await window.voyager.param.update({ name: entry.name, value })
      if (!response.accepted) {
        setErrors((e) => ({ ...e, [entry.name]: response.reason ?? 'Could not update this parameter.' }))
        setDrafts((d) => ({ ...d, [entry.name]: entry.value }))
      }
      // On success, the model:displayed broadcast bumps `model.iteration`, which re-triggers the
      // effect above to pull the authoritative new manifest - no local success-path update needed.
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [entry.name]: err instanceof Error ? `Failed to reach Voyager: ${err.message}` : 'Failed to reach Voyager.'
      }))
      setDrafts((d) => ({ ...d, [entry.name]: entry.value }))
    } finally {
      setPending((p) => ({ ...p, [entry.name]: false }))
      setParamUpdatePending(false)
    }
  }

  const emptyMessage = !model
    ? 'Generate a model first'
    : loaded && manifest.params.length === 0
      ? 'This version has no tunable parameters'
      : null

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
        <Stack direction="row" alignItems="center" gap={1}>
          <TuneIcon fontSize="small" color={manifest.params.length > 0 ? 'inherit' : 'disabled'} />
          <Typography variant="overline" color="text.secondary">
            Parameters
          </Typography>
        </Stack>
        {!embedded && (
          <IconButton
            size="small"
            aria-label={expanded ? 'Collapse parameters' : 'Expand parameters'}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((prev) => !prev)
            }}
          >
            {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </IconButton>
        )}
      </Stack>
      <Collapse in={open}>
        <Box sx={{ px: 1.75, pb: 1.5 }}>
          {!loaded ? (
            <Stack direction="row" alignItems="center" gap={1}>
              <CircularProgress size={14} />
              <Typography variant="body2" color="text.disabled">
                Loading…
              </Typography>
            </Stack>
          ) : emptyMessage ? (
            <Typography variant="body2" color="text.disabled">
              {emptyMessage}
            </Typography>
          ) : (
            <Stack spacing={1.5}>
              {manifest.params.map((entry) => (
                <ParamRow
                  key={entry.name}
                  entry={entry}
                  draftValue={drafts[entry.name] ?? entry.value}
                  disabled={controlsDisabled}
                  error={errors[entry.name]}
                  onDraftChange={(value) => setDrafts((d) => ({ ...d, [entry.name]: value }))}
                  onCommit={(value) => {
                    setDrafts((d) => ({ ...d, [entry.name]: value }))
                    void commit(entry, value)
                  }}
                />
              ))}
            </Stack>
          )}
        </Box>
      </Collapse>
    </Box>
  )
}
