import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import HistoryIcon from '@mui/icons-material/History'
import { useAppStore } from '../state/appStore'
import { syncViewportParts } from '../state/syncParts'
import type { ModelViewer } from '../three/viewer'
import { colors } from '../colors'

/** Formats an ISO timestamp for the version-history list, e.g. "Jul 7, 3:42 PM". */
function formatIterationTimestamp(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

interface ProjectsDrawerProps {
  open: boolean
  onClose: () => void
  viewerRef: MutableRefObject<ModelViewer | null>
}

/**
 * Left-hand project switcher: lists every project, creates new ones, switches the active one,
 * and supports inline rename. Create/switch are blocked while a turn is in flight - there is
 * exactly one shared agent session/subprocess, so "switch without stopping" can't mean "keep
 * the old turn running in the background" (the main process enforces this too; see
 * `project:switch`/`project:create` in `src/main/ipc.ts` - this is defense in depth, not the
 * only guard).
 *
 * Below the project list, a version-history section (R4) lists the *active* project's recorded
 * iterations newest-first, with the current one highlighted. Clicking any other version calls
 * `project:revertTo`, which points the project's `activeIteration` at that generation (no STL is
 * ever deleted or rewritten) and returns a full snapshot - the same `hydrateProject()` +
 * `viewerRef.current?.syncModel(...)` pairing `handleSwitch`/`handleCreate` already use. Reverting
 * is blocked while a turn is in flight for the same reason switching is.
 */
export function ProjectsDrawer({ open, onClose, viewerRef }: ProjectsDrawerProps): React.JSX.Element {
  const projects = useAppStore((state) => state.projects)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const iterations = useAppStore((state) => state.iterations)
  const selectedPartId = useAppStore((state) => state.selectedPartId)
  /** WS-D: version-row thumbnails, keyed `project/part/n` (never bare `n` - every project has a
   *  v1, so an unscoped key would show the previous project's model on the new project's rows
   *  during a switch). Entries are only ever fetched-and-kept; rows without a render set
   *  (previews toggled off, matplotlib not installed, pre-WS-D iterations) simply stay absent. */
  const [renderThumbs, setRenderThumbs] = useState<Record<string, string>>({})
  /** Keys already fetched (skip) or currently fetching (don't double-fetch) - refs so the
   *  fetch effect doesn't need the state map in its closure/deps. */
  const knownThumbKeysRef = useRef<Set<string>>(new Set())
  const inFlightThumbKeysRef = useRef<Set<string>>(new Set())

  const thumbKey = (n: number): string => `${activeProjectId ?? 'none'}/${selectedPartId ?? 'active'}/${n}`

  // Leaving a project drops its cached thumbnails: keys are project-scoped (no visual bleed
  // either way), this just keeps long multi-project sessions from accumulating every project's
  // full-size data URLs in renderer memory.
  useEffect(() => {
    setRenderThumbs({})
    knownThumbKeysRef.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  // Fetch only when the drawer is actually open, only keys not already fetched, newest rows
  // first, surfacing each thumbnail as it resolves rather than after the whole list. A render
  // set can lag its iteration by a few seconds (renderIteration is fire-and-forget in the main
  // process, and no render-updated push exists), so rows still missing after a pass get a few
  // spaced retries instead of polling forever - previews toggled off must stay cheap.
  useEffect(() => {
    if (!open || iterations.length === 0) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retriesLeft = 3

    const fetchMissing = async (): Promise<void> => {
      let anyMissing = false
      for (const iteration of [...iterations].reverse()) {
        if (cancelled) return
        const key = thumbKey(iteration.n)
        if (knownThumbKeysRef.current.has(key) || inFlightThumbKeysRef.current.has(key)) continue
        inFlightThumbKeysRef.current.add(key)
        try {
          const { dataUrl } = await window.voyager.render.get({ n: iteration.n, view: 'iso1' })
          if (cancelled) return
          if (dataUrl) {
            knownThumbKeysRef.current.add(key)
            setRenderThumbs((prev) => ({ ...prev, [key]: dataUrl }))
          } else {
            anyMissing = true
          }
        } finally {
          inFlightThumbKeysRef.current.delete(key)
        }
      }
      if (anyMissing && !cancelled && retriesLeft > 0) {
        retriesLeft -= 1
        retryTimer = setTimeout(() => void fetchMissing(), 12_000)
      }
    }

    void fetchMissing()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iterations, open, activeProjectId, selectedPartId])
  const activeIteration = useAppStore((state) => state.activeIteration)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const hydrateProject = useAppStore((state) => state.hydrateProject)
  const updateProject = useAppStore((state) => state.updateProject)

  const [creating, setCreating] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [revertingN, setRevertingN] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(): Promise<void> {
    if (agentBusy || creating) return
    setCreating(true)
    setError(null)
    try {
      const snapshot = await window.voyager.project.create({})
      hydrateProject(snapshot)
      await syncViewportParts(viewerRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create a new project')
    } finally {
      setCreating(false)
    }
  }

  async function handleSwitch(id: string): Promise<void> {
    if (id === activeProjectId || switchingId) return
    if (agentBusy) {
      setError('Voyager is still working — stop or wait before switching projects.')
      return
    }
    setSwitchingId(id)
    setError(null)
    try {
      const snapshot = await window.voyager.project.switch({ id })
      hydrateProject(snapshot)
      await syncViewportParts(viewerRef.current)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch projects')
    } finally {
      setSwitchingId(null)
    }
  }

  async function handleRevert(n: number): Promise<void> {
    if (n === activeIteration || revertingN !== null) return
    if (agentBusy) {
      setError('Voyager is still working — stop or wait before reverting.')
      return
    }
    setRevertingN(n)
    setError(null)
    try {
      const snapshot = await window.voyager.project.revertTo({ n })
      hydrateProject(snapshot)
      await syncViewportParts(viewerRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revert to that version')
    } finally {
      setRevertingN(null)
    }
  }

  function startRename(id: string, currentName: string): void {
    setError(null)
    setRenamingId(id)
    setRenameDraft(currentName)
  }

  async function commitRename(): Promise<void> {
    const id = renamingId
    if (!id) return
    setRenamingId(null)
    const trimmed = renameDraft.trim()
    if (!trimmed) return
    try {
      const summary = await window.voyager.project.rename({ id, name: trimmed })
      updateProject(summary)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename the project')
    }
  }

  return (
    <Drawer
      anchor="left"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: 260, bgcolor: 'background.paper', display: 'flex', flexDirection: 'column' } } }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ px: 1.5, py: 1.25, borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography variant="overline" color="text.secondary">
          Projects
        </Typography>
        <Button
          startIcon={<AddIcon />}
          onClick={() => void handleCreate()}
          disabled={agentBusy || creating}
        >
          {creating ? '…' : 'New'}
        </Button>
      </Stack>
      {error && (
        <Alert severity="warning" variant="outlined" sx={{ mx: 1, mt: 1, fontSize: 11.5 }}>
          {error}
        </Alert>
      )}
      <List dense sx={{ flex: '1 1 45%', minHeight: 0, overflowY: 'auto', px: 1 }}>
        {projects.map((project) => {
          const isActive = project.id === activeProjectId

          if (renamingId === project.id) {
            return (
              <ListItem key={project.id} disablePadding sx={{ py: 0.25 }}>
                <TextField
                  size="small"
                  autoFocus
                  fullWidth
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onBlur={() => void commitRename()}
                />
              </ListItem>
            )
          }

          return (
            <ListItem
              key={project.id}
              disablePadding
              secondaryAction={
                <IconButton
                  edge="end"
                  size="small"
                  aria-label={`Rename ${project.name}`}
                  onClick={() => startRename(project.id, project.name)}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              }
            >
              <ListItemButton
                selected={isActive}
                disabled={agentBusy && !isActive}
                onClick={() => void handleSwitch(project.id)}
                sx={{
                  '&.Mui-selected': {
                    bgcolor: colors.accentDim,
                    color: colors.textPrimary,
                    '&:hover': { bgcolor: colors.accentDim }
                  }
                }}
              >
                <ListItemText
                  primary={switchingId === project.id ? 'Switching…' : project.name}
                  slotProps={{ primary: { noWrap: true, fontSize: 12.5 } }}
                />
              </ListItemButton>
            </ListItem>
          )
        })}
      </List>
      <Divider />
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.75}
        sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        <HistoryIcon fontSize="small" sx={{ color: colors.textSecondary }} />
        <Typography variant="overline" color="text.secondary">
          Versions
        </Typography>
      </Stack>
      {iterations.length === 0 ? (
        <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
          No versions yet
        </Typography>
      ) : (
        <List dense sx={{ flex: '1 1 55%', minHeight: 0, overflowY: 'auto', px: 1 }}>
          {[...iterations].reverse().map((iteration) => {
            const isActive = iteration.n === activeIteration
            return (
              <ListItem key={iteration.n} disablePadding sx={{ py: 0.25 }}>
                <ListItemButton
                  selected={isActive}
                  disabled={agentBusy && !isActive}
                  onClick={() => void handleRevert(iteration.n)}
                  sx={{
                    alignItems: 'flex-start',
                    '&.Mui-selected': {
                      bgcolor: colors.accentDim,
                      color: colors.textPrimary,
                      '&:hover': { bgcolor: colors.accentDim }
                    }
                  }}
                >
                  {renderThumbs[thumbKey(iteration.n)] && (
                    <Box
                      component="img"
                      src={renderThumbs[thumbKey(iteration.n)]}
                      alt={`v${iteration.n} render preview`}
                      sx={{
                        width: 40,
                        height: 40,
                        mr: 1,
                        mt: 0.25,
                        flexShrink: 0,
                        borderRadius: 0.5,
                        border: 1,
                        borderColor: colors.borderSubtle,
                        bgcolor: colors.bgApp,
                        objectFit: 'cover'
                      }}
                    />
                  )}
                  <ListItemText
                    primary={
                      <Stack direction="row" alignItems="center" spacing={0.75}>
                        <Typography variant="body2" fontWeight={600} fontSize={12.5}>
                          v{iteration.n}
                        </Typography>
                        {isActive && (
                          <Chip
                            label={revertingN === iteration.n ? 'Reverting…' : 'Current'}
                            size="small"
                            sx={{ height: 16, fontSize: 10, bgcolor: colors.accent, color: colors.onAccent }}
                          />
                        )}
                        {!isActive && revertingN === iteration.n && (
                          <Typography variant="caption" color="text.secondary">
                            Reverting…
                          </Typography>
                        )}
                      </Stack>
                    }
                    secondary={
                      <>
                        <Typography component="span" variant="caption" color="text.secondary" display="block" noWrap>
                          {iteration.summary}
                        </Typography>
                        <Typography component="span" variant="caption" color="text.secondary" display="block">
                          {formatIterationTimestamp(iteration.at)}
                        </Typography>
                      </>
                    }
                  />
                </ListItemButton>
              </ListItem>
            )
          })}
        </List>
      )}
    </Drawer>
  )
}
