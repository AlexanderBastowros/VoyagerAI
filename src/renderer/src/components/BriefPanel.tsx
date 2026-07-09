import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Collapse from '@mui/material/Collapse'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import LockIcon from '@mui/icons-material/Lock'
import { useAppStore } from '../state/appStore'
import { deriveChatDisabledReason } from '../state/setupSelectors'
import { briefFromForm, computeBriefCompleteness, featureSummary, formFromBrief } from '../state/briefSelectors'
import type { BriefForm } from '../state/briefSelectors'
import type { DesignBrief } from '../../../shared/ipc'
import { colors } from '../colors'

/** Sent as an ordinary chat turn once the brief is locked - mirrors `PrintSettingsPanel`'s
 *  "send a prompt, let the agent's streamed reply drive the rest" pattern. This is the concrete
 *  mechanism behind product doc §5.1's "one click to lock and generate" and the skill-prompt's
 *  instruction (see `prompts.ts`) not to generate before this message arrives. */
const LOCK_MESSAGE = "I've locked the design brief — please generate the model now."

const ORIENTATION_OPTIONS: Array<{ value: BriefForm['printOrientation']; label: string }> = [
  { value: '', label: 'Not set' },
  { value: 'agent-decides', label: 'Let the agent decide' },
  { value: 'flat', label: 'Flat' },
  { value: 'vertical', label: 'Vertical' },
  { value: 'angled', label: 'Angled' }
]

const fieldSx = { '& .MuiInputBase-input': { fontSize: 13 }, '& .MuiFormLabel-root': { fontSize: 13 } }

/**
 * The Design Brief panel (WS-A, architecture doc §6, product doc §4.4/§5.2): the co-authored,
 * machine-checkable spec that gates generation and later verification. Fields fill in live as the
 * agent calls `update_brief` during Phase 2, or the user edits and saves them directly here.
 *
 * Editing model: the form buffers edits locally (see `briefSelectors.ts`'s `BriefForm`) and only
 * writes them back via `brief:update` when the user clicks "Save" - an incoming push (the agent's
 * own edits, or a project switch) re-seeds the form from the latest brief, discarding any
 * not-yet-saved local edits. Saving from the panel stamps every envelope dimension
 * `provenance: 'user'` unconditionally, since reviewing-then-saving *is* the confirmation.
 *
 * "Lock & Generate" locks the brief (throws - surfaced as an error banner - if required fields
 * are still missing) and, on success, sends the agent a chat message telling it to proceed to
 * Phase 4. Editing a locked brief server-side starts a new draft version and clears the lock,
 * which this panel picks up the next time `brief` changes and simply shows the Lock button again.
 *
 * No version-history browsing yet: `BriefStore.listVersions()` (agent-core) is implemented and
 * tested, but the frozen `brief:*` IPC contract (WS-0b) has no channel to fetch it from the
 * renderer - see the contract-change request in `agents/production-roadmap.md`.
 */
export function BriefPanel(): React.JSX.Element {
  const brief = useAppStore((state) => state.brief)
  const setBrief = useAppStore((state) => state.setBrief)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const setAgentBusy = useAppStore((state) => state.setAgentBusy)
  const addMessage = useAppStore((state) => state.addMessage)
  const setupStatus = useAppStore((state) => state.setupStatus)

  const [expanded, setExpanded] = useState(true)
  const [form, setForm] = useState<BriefForm>(() => formFromBrief(brief))
  const [saving, setSaving] = useState(false)
  const [locking, setLocking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The brief isn't part of ProjectStateSnapshot (frozen shared contract), so it's fetched
  // independently on mount and re-fetched whenever the active project changes.
  useEffect(() => {
    let cancelled = false
    void window.voyager.brief.get().then((fetched) => {
      if (!cancelled) setBrief(fetched)
    })
    return () => {
      cancelled = true
    }
  }, [activeProjectId, setBrief])

  // Live pushes: the agent's update_brief tool, and this panel's own save/lock round-trips.
  useEffect(() => window.voyager.brief.onUpdated(setBrief), [setBrief])

  // Re-seed the editable form whenever the underlying brief changes. Any not-yet-saved local
  // edits are discarded in favor of the latest state - see the component doc comment above.
  useEffect(() => {
    setForm(formFromBrief(brief))
    setError(null)
  }, [brief])

  const completeness = useMemo(() => computeBriefCompleteness(briefFromForm(brief, form)), [brief, form])
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(formFromBrief(brief)), [form, brief])
  const disabledReason = deriveChatDisabledReason(setupStatus)
  const locked = Boolean(brief.lockedAt)
  const missingLabels = completeness.checks.filter((c) => !c.done).map((c) => c.label)

  function setField<K extends keyof BriefForm>(key: K, value: BriefForm[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function save(): Promise<DesignBrief | null> {
    setSaving(true)
    setError(null)
    try {
      const response = await window.voyager.brief.update({ brief: briefFromForm(brief, form) })
      setBrief(response.brief)
      return response.brief
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the brief.')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function lockAndGenerate(): Promise<void> {
    setLocking(true)
    setError(null)
    try {
      if (dirty) {
        const savedBrief = await save()
        if (!savedBrief) return
      }
      const response = await window.voyager.brief.lock()
      setBrief(response.brief)

      if (!agentBusy && !disabledReason) {
        addMessage({ role: 'user', text: LOCK_MESSAGE })
        setAgentBusy(true)
        const sent = await window.voyager.agent.sendMessage({ text: LOCK_MESSAGE })
        if (!sent.accepted) {
          setAgentBusy(false)
          addMessage({ role: 'system-status', text: sent.reason ?? 'The agent could not accept the message.' })
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not lock the brief.')
    } finally {
      setLocking(false)
    }
  }

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', flexShrink: 0 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        gap={1}
        sx={{ px: 1.75, py: 1, cursor: 'pointer' }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <Stack direction="row" alignItems="center" gap={1}>
          <DescriptionOutlinedIcon fontSize="small" color={locked ? 'success' : 'action'} />
          <Typography variant="overline" color="text.secondary">
            Design brief
          </Typography>
          <Chip
            size="small"
            label={locked ? `Locked v${brief.version}` : `Draft v${brief.version} · ${completeness.percent}%`}
            color={locked ? 'success' : completeness.percent === 100 ? 'warning' : 'default'}
            variant={locked ? 'filled' : 'outlined'}
            sx={{ fontSize: 10, height: 20 }}
          />
        </Stack>
        <IconButton
          size="small"
          aria-label={expanded ? 'Collapse design brief' : 'Expand design brief'}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((prev) => !prev)
          }}
        >
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
      </Stack>

      <Collapse in={expanded}>
        <Stack spacing={1.25} sx={{ px: 1.75, pb: 1.5, maxHeight: 420, overflowY: 'auto' }}>
          {error && (
            <Alert severity="error" onClose={() => setError(null)} sx={{ fontSize: 12 }}>
              {error}
            </Alert>
          )}

          <LinearProgress
            variant="determinate"
            value={completeness.percent}
            color={completeness.percent === 100 ? 'success' : 'primary'}
            sx={{ height: 5, borderRadius: 3 }}
          />

          <TextField
            size="small"
            label="Part name"
            value={form.partName}
            onChange={(e) => setField('partName', e.target.value)}
            sx={fieldSx}
          />
          <TextField
            size="small"
            label="Purpose"
            value={form.partPurpose}
            onChange={(e) => setField('partPurpose', e.target.value)}
            multiline
            minRows={2}
            sx={fieldSx}
          />

          <Stack direction="row" spacing={1}>
            {(['envelopeX', 'envelopeY', 'envelopeZ'] as const).map((key, i) => {
              const axis = (['x', 'y', 'z'] as const)[i]
              const inferred = brief.envelope[axis].provenance === 'inferred'
              return (
                <TextField
                  key={key}
                  size="small"
                  type="number"
                  label={`${axis.toUpperCase()} (mm)`}
                  value={form[key]}
                  onChange={(e) => setField(key, e.target.value)}
                  sx={fieldSx}
                  slotProps={{
                    input: inferred ? { endAdornment: <Chip label="AI" size="small" sx={{ height: 16, fontSize: 9 }} /> } : {}
                  }}
                />
              )
            })}
          </Stack>

          <TextField
            size="small"
            label="Requested material"
            value={form.materialsRequested}
            onChange={(e) => setField('materialsRequested', e.target.value)}
            sx={fieldSx}
          />
          <TextField
            size="small"
            label="Materials on hand"
            helperText="Comma-separated"
            value={form.materialsOnHand}
            onChange={(e) => setField('materialsOnHand', e.target.value)}
            sx={fieldSx}
          />

          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <FormControlLabel
              sx={{ mr: 0 }}
              control={
                <Switch
                  size="small"
                  checked={form.mustFitBed}
                  onChange={(e) => setField('mustFitBed', e.target.checked)}
                />
              }
              label={<Typography variant="caption">Must fit bed</Typography>}
            />
            <FormControlLabel
              sx={{ mr: 0 }}
              control={
                <Switch
                  size="small"
                  checked={form.allowSplit}
                  onChange={(e) => setField('allowSplit', e.target.checked)}
                />
              }
              label={<Typography variant="caption">Allow split</Typography>}
            />
          </Stack>

          {form.allowSplit && (
            <TextField
              size="small"
              type="number"
              label="Max pieces"
              value={form.maxPieces}
              onChange={(e) => setField('maxPieces', e.target.value)}
              sx={fieldSx}
            />
          )}

          <Select
            size="small"
            value={form.printOrientation}
            onChange={(e) => setField('printOrientation', e.target.value as BriefForm['printOrientation'])}
            sx={{ fontSize: 13 }}
          >
            {ORIENTATION_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value} sx={{ fontSize: 13 }}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>

          <FormControlLabel
            control={
              <Switch size="small" checked={form.loadBearing} onChange={(e) => setField('loadBearing', e.target.checked)} />
            }
            label={<Typography variant="caption">Load-bearing</Typography>}
          />

          <TextField
            size="small"
            label="Exclusions"
            helperText="One per line"
            value={form.exclusions}
            onChange={(e) => setField('exclusions', e.target.value)}
            multiline
            minRows={2}
            sx={fieldSx}
          />
          <TextField
            size="small"
            label="Acceptance criteria"
            helperText="One per line"
            value={form.acceptance}
            onChange={(e) => setField('acceptance', e.target.value)}
            multiline
            minRows={2}
            sx={fieldSx}
          />

          {brief.features.length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                Features ({brief.features.length})
              </Typography>
              <Stack spacing={0.5} sx={{ bgcolor: colors.bgPanelRaised, borderRadius: 1, px: 1.25, py: 1, mt: 0.5 }}>
                {brief.features.map((feature) => (
                  <Typography key={feature.id} variant="caption" color="text.secondary">
                    {featureSummary(feature)}
                  </Typography>
                ))}
              </Stack>
            </Box>
          )}

          {!locked && missingLabels.length > 0 && (
            <Typography variant="caption" color="text.disabled">
              Missing: {missingLabels.join(', ')}
            </Typography>
          )}

          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button size="small" variant="outlined" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {locked ? (
              <Chip
                size="small"
                icon={<CheckCircleIcon fontSize="small" />}
                label={`Locked ${new Date(brief.lockedAt as string).toLocaleString()}`}
                color="success"
                variant="outlined"
              />
            ) : (
              <Tooltip title={completeness.percent < 100 ? 'Fill in every required field first' : ''}>
                <span>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<LockIcon fontSize="small" />}
                    disabled={completeness.percent < 100 || locking}
                    onClick={() => void lockAndGenerate()}
                  >
                    {locking ? 'Locking…' : 'Lock & generate'}
                  </Button>
                </span>
              </Tooltip>
            )}
          </Stack>
        </Stack>
      </Collapse>
    </Box>
  )
}
