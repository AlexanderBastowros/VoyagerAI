import { useState } from 'react'
import type { MutableRefObject } from 'react'
import Alert from '@mui/material/Alert'
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
