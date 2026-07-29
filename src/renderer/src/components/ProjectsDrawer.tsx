import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import EditIcon from '@mui/icons-material/Edit'
import HistoryIcon from '@mui/icons-material/History'
import { useAppStore } from '../state/appStore'
import { syncViewportParts } from '../state/syncParts'
import type { ModelViewer } from '../three/viewer'
import type { ProjectSummary } from '../../../shared/ipc'
import { colors } from '../colors'

/** Said in two places that must not drift: the tooltip on the inert trash icon, and `handleDelete`'s
 *  defensive re-check. */
const BUSY_DELETE_REASON = 'Voyager is still working — stop or wait before deleting a project.'

/** Formats an ISO timestamp for the version-history list, e.g. "Jul 7, 3:42 PM". */
function formatIterationTimestamp(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * The delete dialog's "how much you're about to lose" line, or null when the number isn't known.
 * `versions` is null for every project except a single-part active one: the store's `iterations`
 * holds the active project's *active part's* history, while deleting destroys every part's - so for
 * any other project, or a multi-part one, the count would be a guess, and a wrong number inside a
 * "cannot be undone" dialog is worse than no number at all. Zero is also rendered as no line: a
 * project with nothing recorded yet needs no reassurance about versions.
 */
function versionCountLine(versions: number | null): string | null {
  if (versions === null || versions === 0) return null
  return versions === 1
    ? '1 recorded version will be destroyed.'
    : `${versions} recorded versions will be destroyed.`
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
 *
 * Each row also carries a delete button, gated behind a real MUI confirmation dialog rather than
 * the `window.confirm` that PartsPanel/PrinterProfilesPanel use: deleting a project throws away the
 * whole project folder - every version, STL/STEP, generating script and the chat transcript - so it
 * gets a dialog that names the project, spells out what is lost, and defaults to Cancel. Delete is
 * disabled whenever it cannot run - the last remaining project, a turn in flight, another project
 * mutation underway - and the Tooltip names which of those it is, so neither the store's "Cannot
 * delete the only project" guard nor a silently dead button is how the user finds out.
 * `project:delete` answers with a full snapshot whether or not the deleted project was the active
 * one (the main process picks a successor when it was), so success is the same `hydrateProject()` +
 * `syncViewportParts()` pairing as switch/create; the drawer deliberately stays open afterwards so
 * a user tidying up can delete several in a row.
 */
export function ProjectsDrawer({ open, onClose, viewerRef }: ProjectsDrawerProps): React.JSX.Element {
  const projects = useAppStore((state) => state.projects)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const iterations = useAppStore((state) => state.iterations)
  const parts = useAppStore((state) => state.parts)
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
  /** The project the confirmation dialog is asking about (null = closed). Holds the whole summary,
   *  not just the id, so the dialog can name it even as the list re-hydrates underneath. */
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** Any project mutation in flight - all of them re-hydrate the whole renderer, so they must not
   *  overlap each other. */
  const mutating = creating || switchingId !== null || deletingId !== null
  const onlyProject = projects.length === 1

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

  async function handleDelete(): Promise<void> {
    const target = pendingDelete
    // `deletingId` is the double-submit guard - the confirm button is disabled while it's set, but
    // a stray Enter keypress must not fire a second delete either.
    if (!target || deletingId) return
    if (agentBusy) {
      setError(BUSY_DELETE_REASON)
      setPendingDelete(null)
      return
    }
    setDeletingId(target.id)
    setError(null)
    try {
      const snapshot = await window.voyager.project.delete({ id: target.id })
      hydrateProject(snapshot)
      // Always re-sync: deleting the active project moves the store onto a successor whose parts
      // are entirely different, and even deleting an inactive one is cheap to re-sync.
      await syncViewportParts(viewerRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the project')
    } finally {
      setDeletingId(null)
      // Closed on failure too - the reason lands in the drawer's Alert, which this dialog covers.
      setPendingDelete(null)
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

  // Only quotable for the active project, and only while it has exactly one part: `iterations` is
  // that one part's history, and a multi-part project loses every part's versions. `parts` is
  // loaded for the active project by `syncViewportParts` (app mount plus every project mutation),
  // so an empty list reads as "not known yet" and suppresses the number too.
  const deleteVersionLine = versionCountLine(
    pendingDelete !== null && pendingDelete.id === activeProjectId && parts.length === 1
      ? iterations.length
      : null
  )

  return (
    <>
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

            // Every reason the trash icon can be inert, named - one source for both the tooltip and
            // the `disabled` flag so they cannot disagree. Without this a mid-turn hover reads
            // "Delete <name>" on a dead control: the rail's Projects button is never gated on
            // `agentBusy`, so the drawer opens freely while a turn (minutes long) is in flight.
            const deleteBlockedReason = onlyProject
              ? 'A project is always open'
              : agentBusy
                ? BUSY_DELETE_REASON
                : mutating
                  ? 'Another project change is in progress'
                  : null

            return (
              <ListItem
                key={project.id}
                disablePadding
                // MUI reserves 48px of ListItemButton padding for a `secondaryAction` (which is
                // absolutely positioned 16px from the row's edge) - room for one icon button, not
                // two. Pull the action block closer to the edge and widen the reservation to match,
                // so a long `noWrap` name ellipsizes *before* the icons rather than sliding under
                // them.
                sx={{
                  '& .MuiListItemSecondaryAction-root': { right: 4 },
                  '& > .MuiListItemButton-root': { pr: 8.5 }
                }}
                secondaryAction={
                  <Stack direction="row" alignItems="center">
                    <IconButton
                      size="small"
                      aria-label={`Rename ${project.name}`}
                      onClick={() => startRename(project.id, project.name)}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <Tooltip title={deleteBlockedReason ?? `Delete ${project.name}`}>
                      {/* A disabled button fires no events, so the Tooltip needs a live wrapper. */}
                      <span>
                        <IconButton
                          edge="end"
                          size="small"
                          aria-label={`Delete ${project.name}`}
                          disabled={deleteBlockedReason !== null}
                          onClick={() => {
                            setError(null)
                            setPendingDelete(project)
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
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
      {/* Rendered outside the Drawer, not inside it: a temporary Drawer unmounts its children when
          it closes, which would tear the dialog down mid-delete. */}
      <Dialog
        open={pendingDelete !== null}
        onClose={() => {
          if (!deletingId) setPendingDelete(null)
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: 15 }}>Delete “{pendingDelete?.name}”?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 13 }}>
            Deleting <strong>{pendingDelete?.name}</strong> removes its entire project folder: every
            model version with its STL/STEP exports and generating script, and the whole chat
            transcript.
          </DialogContentText>
          {deleteVersionLine && (
            <DialogContentText sx={{ fontSize: 13, mt: 1.25 }}>{deleteVersionLine}</DialogContentText>
          )}
          <DialogContentText sx={{ fontSize: 13, mt: 1.25, color: 'error.main' }}>
            This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          {/* Cancel is the safe default, so it takes focus - Enter on an unread dialog must not
              destroy a project. */}
          <Button autoFocus onClick={() => setPendingDelete(null)} disabled={deletingId !== null}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDelete()}
            disabled={deletingId !== null || agentBusy}
          >
            {deletingId ? 'Deleting…' : 'Delete project'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
