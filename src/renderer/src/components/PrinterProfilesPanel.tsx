import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Radio from '@mui/material/Radio'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import PrintIcon from '@mui/icons-material/Print'
import type { PrinterProfileRef } from '../../../shared/ipc'
import { useAppStore } from '../state/appStore'
import { colors } from '../colors'

const fieldSx = { '& .MuiInputBase-input': { fontSize: 13 }, '& .MuiFormLabel-root': { fontSize: 13 } }

/** The form buffers everything as strings; validation happens on save. */
interface ProfileDraft {
  /** Empty for a brand-new profile - the main-process store derives a slug id from the name. */
  id: string
  name: string
  bedX: string
  bedY: string
  bedZ: string
  nozzle: string
  /** Comma-separated in the form; split/trimmed on save. */
  materials: string
}

const EMPTY_DRAFT: ProfileDraft = { id: '', name: '', bedX: '', bedY: '', bedZ: '', nozzle: '0.4', materials: '' }

function draftFromProfile(profile: PrinterProfileRef): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    bedX: String(profile.bedXMm),
    bedY: String(profile.bedYMm),
    bedZ: String(profile.bedZMm),
    nozzle: String(profile.nozzleDiameterMm),
    materials: profile.materials.join(', ')
  }
}

/** Client-side mirror of the store's sanity checks so most mistakes never cross IPC. Returns the
 *  profile to save, or a message describing the first problem. */
function draftToProfile(draft: ProfileDraft): { profile: PrinterProfileRef } | { error: string } {
  const name = draft.name.trim()
  if (!name) return { error: 'Give the printer a name.' }

  const dims: Array<[string, string]> = [
    ['Bed X', draft.bedX],
    ['Bed Y', draft.bedY],
    ['Bed Z', draft.bedZ],
    ['Nozzle diameter', draft.nozzle]
  ]
  const values: number[] = []
  for (const [label, raw] of dims) {
    const value = Number(raw)
    if (!raw.trim() || !Number.isFinite(value) || value <= 0) {
      return { error: `${label} must be a positive number of millimeters.` }
    }
    values.push(value)
  }

  return {
    profile: {
      id: draft.id,
      name,
      bedXMm: values[0],
      bedYMm: values[1],
      bedZMm: values[2],
      nozzleDiameterMm: values[3],
      materials: draft.materials
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
    }
  }
}

/**
 * The printer-profiles settings panel (WS-E, product doc §4.4): bed size, nozzle diameter, and
 * materials on hand are per-printer user settings, not per-project questions. Profiles are
 * app-level - they survive project switches - and the active one pre-answers the agent's Phase-1
 * printer questions and feeds verification's bed-fit check. Everything here round-trips through
 * `window.voyager.printerProfile.*`; the `printerProfile:updated` push (this panel's own saves,
 * other windows, or the agent's `save_printer_profile` tool) keeps the list in sync.
 */
export function PrinterProfilesPanel({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const profiles = useAppStore((state) => state.printerProfiles)
  const activeId = useAppStore((state) => state.activePrinterProfileId)
  const setPrinterProfiles = useAppStore((state) => state.setPrinterProfiles)

  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Profiles are app-global: fetch once on mount (no project dependency), then follow pushes.
  useEffect(() => {
    let cancelled = false
    void window.voyager.printerProfile.list().then((response) => {
      if (!cancelled) setPrinterProfiles(response.profiles, response.activeId)
    })
    return () => {
      cancelled = true
    }
  }, [setPrinterProfiles])

  useEffect(
    () =>
      window.voyager.printerProfile.onUpdated((response) =>
        setPrinterProfiles(response.profiles, response.activeId)
      ),
    [setPrinterProfiles]
  )

  const active = profiles.find((profile) => profile.id === activeId) ?? null

  async function saveDraft(): Promise<void> {
    if (!draft || busy) return
    const result = draftToProfile(draft)
    if ('error' in result) {
      setError(result.error)
      return
    }

    setBusy(true)
    setError(null)
    try {
      const response = await window.voyager.printerProfile.save({ profile: result.profile })
      setPrinterProfiles(response.profiles, response.activeId)
      setDraft(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the printer profile.')
    } finally {
      setBusy(false)
    }
  }

  async function activate(id: string): Promise<void> {
    if (busy || id === activeId) return
    setBusy(true)
    setError(null)
    try {
      const response = await window.voyager.printerProfile.setActive({ id })
      setPrinterProfiles(response.profiles, response.activeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch the active printer.')
    } finally {
      setBusy(false)
    }
  }

  async function deleteProfile(profile: PrinterProfileRef): Promise<void> {
    if (busy) return
    if (!window.confirm(`Delete the printer profile "${profile.name}"? This can't be undone.`)) return
    setBusy(true)
    setError(null)
    try {
      const response = await window.voyager.printerProfile.delete({ id: profile.id })
      setPrinterProfiles(response.profiles, response.activeId)
      // The form was open on the profile just deleted - drop it rather than leave a stale edit
      // buffer pointing at an id that no longer exists.
      setDraft((prev) => (prev?.id === profile.id ? null : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the printer profile.')
    } finally {
      setBusy(false)
    }
  }

  function openForm(profile: PrinterProfileRef | null): void {
    setDraft(profile ? draftFromProfile(profile) : EMPTY_DRAFT)
    setError(null)
    setExpanded(true)
  }

  const setField = (key: keyof ProfileDraft, value: string): void =>
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))

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
        <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
          <PrintIcon fontSize="small" color={profiles.length > 0 ? 'inherit' : 'disabled'} />
          <Typography variant="overline" color="text.secondary">
            Printer
          </Typography>
          {active && (
            <Typography variant="caption" color="text.disabled" noWrap>
              {active.name}
            </Typography>
          )}
        </Stack>
        {!embedded && (
          <IconButton
            size="small"
            aria-label={expanded ? 'Collapse printer profiles' : 'Expand printer profiles'}
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
          <Stack spacing={1}>
            {profiles.length === 0 && !draft && (
              <Typography variant="body2" color="text.disabled">
                Save your printer (bed size, nozzle, materials) once and Voyager stops asking at the
                start of every project.
              </Typography>
            )}

            {profiles.length > 0 && (
              <Stack spacing={0.25} sx={{ bgcolor: colors.bgPanelRaised, borderRadius: 1, px: 0.75, py: 0.5 }}>
                {profiles.map((profile) => (
                  <Stack
                    key={profile.id}
                    direction="row"
                    alignItems="center"
                    gap={0.5}
                    sx={{ cursor: 'pointer', borderRadius: 1 }}
                    onClick={() => void activate(profile.id)}
                  >
                    <Radio
                      size="small"
                      checked={profile.id === activeId}
                      disabled={busy}
                      value={profile.id}
                      // The row's onClick covers pointer users; this covers keyboard (Space/arrows
                      // on the focused radio), which never bubbles a click to the row.
                      onChange={() => void activate(profile.id)}
                      slotProps={{ input: { 'aria-label': `Use ${profile.name}` } }}
                      sx={{ p: 0.5 }}
                    />
                    <Stack sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" noWrap>
                        {profile.name}
                      </Typography>
                      <Typography variant="caption" color="text.disabled" noWrap>
                        {profile.bedXMm} × {profile.bedYMm} × {profile.bedZMm} mm · Ø{profile.nozzleDiameterMm} mm
                      </Typography>
                    </Stack>
                    <Tooltip title={`Edit ${profile.name}`}>
                      <span>
                        <IconButton
                          size="small"
                          aria-label={`Edit ${profile.name}`}
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation()
                            openForm(profile)
                          }}
                        >
                          <EditOutlinedIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title={`Delete ${profile.name}`}>
                      <span>
                        <IconButton
                          size="small"
                          aria-label={`Delete ${profile.name}`}
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation()
                            void deleteProfile(profile)
                          }}
                        >
                          <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
            )}

            {draft ? (
              <Stack spacing={1}>
                <TextField
                  size="small"
                  label="Printer name"
                  placeholder="e.g. Prusa MK4"
                  value={draft.name}
                  disabled={busy}
                  onChange={(e) => setField('name', e.target.value)}
                  sx={fieldSx}
                />
                <Stack direction="row" spacing={1}>
                  {(
                    [
                      ['bedX', 'Bed X (mm)'],
                      ['bedY', 'Bed Y (mm)'],
                      ['bedZ', 'Bed Z (mm)']
                    ] as const
                  ).map(([key, label]) => (
                    <TextField
                      key={key}
                      size="small"
                      type="number"
                      label={label}
                      value={draft[key]}
                      disabled={busy}
                      onChange={(e) => setField(key, e.target.value)}
                      sx={fieldSx}
                    />
                  ))}
                </Stack>
                <TextField
                  size="small"
                  type="number"
                  label="Nozzle Ø (mm)"
                  value={draft.nozzle}
                  disabled={busy}
                  onChange={(e) => setField('nozzle', e.target.value)}
                  sx={fieldSx}
                />
                <TextField
                  size="small"
                  label="Materials on hand"
                  helperText="Comma-separated, e.g. PLA, PETG"
                  value={draft.materials}
                  disabled={busy}
                  onChange={(e) => setField('materials', e.target.value)}
                  sx={fieldSx}
                />
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="contained" disabled={busy} onClick={() => void saveDraft()}>
                    {draft.id ? 'Save changes' : 'Save printer'}
                  </Button>
                  <Button size="small" disabled={busy} onClick={() => setDraft(null)}>
                    Cancel
                  </Button>
                </Stack>
              </Stack>
            ) : (
              <Box>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<AddIcon fontSize="small" />}
                  disabled={busy}
                  onClick={() => openForm(null)}
                >
                  Add printer
                </Button>
              </Box>
            )}

            {error && (
              <Typography variant="caption" sx={{ color: colors.danger }}>
                {error}
              </Typography>
            )}
          </Stack>
        </Box>
      </Collapse>
    </Box>
  )
}
