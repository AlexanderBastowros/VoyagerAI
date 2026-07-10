import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import { toModelInfo, useAppStore } from '../state/appStore'

/** Subtle tint for the focused part row - matches the viewport marquee's accent fill. */
const SELECTED_BG = 'rgba(102, 170, 255, 0.15)'

/**
 * The parts panel (WS-I, architecture doc §14 / product doc §5.3): lists a project's parts with
 * per-part visibility toggles and click-to-focus. Focusing a part makes it the active part (via
 * `part.setActive`), so the parameter/verification/version-history panels and the placement gizmo
 * all follow it - those panels stay unchanged because they already track the active iteration.
 *
 * Renders nothing for a single-part project (the common case): the parts UI only earns its space
 * once a project actually has more than one part (a box AND its lid, a gear pair). The full
 * per-part version history is the existing history view (`ProjectsDrawer`), which shows the focused
 * part's history once it's active.
 */
export function PartsPanel(): React.JSX.Element | null {
  const parts = useAppStore((state) => state.parts)
  const selectedPartId = useAppStore((state) => state.selectedPartId)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const setParts = useAppStore((state) => state.setParts)
  const setSelectedPartId = useAppStore((state) => state.setSelectedPartId)
  const setModel = useAppStore((state) => state.setModel)
  const setIterations = useAppStore((state) => state.setIterations)
  const setActiveIteration = useAppStore((state) => state.setActiveIteration)

  const [expanded, setExpanded] = useState(true)
  const [pending, setPending] = useState(false)

  // Fetch the parts list on mount and whenever the active project changes, and keep it live via the
  // `part:updated` push (the agent creating a part, a placement/visibility edit from another window).
  useEffect(() => {
    let cancelled = false
    void window.voyager.part.list().then(({ parts, activePartId }) => {
      if (cancelled) return
      setParts(parts)
      setSelectedPartId(activePartId)
    })
    const unsubscribe = window.voyager.part.onUpdated(({ parts, activePartId }) => {
      setParts(parts)
      setSelectedPartId(activePartId)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeProjectId, setParts, setSelectedPartId])

  // No parts UI for a single-part project - the parts model is invisible until a project has ≥2.
  if (parts.length <= 1) return null

  async function focusPart(partId: string): Promise<void> {
    if (agentBusy || pending || partId === selectedPartId) return
    setPending(true)
    try {
      const { parts: next, activePartId } = await window.voyager.part.setActive({ partId })
      setParts(next)
      setSelectedPartId(activePartId)
      // Point the parameter/verification/history panels at the newly-active part. They watch the
      // displayed model + iteration list, so refreshing those is all it takes - no panel changes.
      const [model, iterations] = await Promise.all([
        window.voyager.part.getModel({ partId }),
        window.voyager.project.listIterations()
      ])
      setModel(model ? toModelInfo(model) : null)
      setIterations(iterations)
      setActiveIteration(model?.iteration ?? null)
    } catch {
      // Busy backstop (the main process rejects part ops mid-turn) - leave the list as-is.
    } finally {
      setPending(false)
    }
  }

  async function toggleVisibility(partId: string, visible: boolean): Promise<void> {
    if (agentBusy || pending) return
    setPending(true)
    try {
      const { parts: next, activePartId } = await window.voyager.part.setVisibility({ partId, visible })
      setParts(next)
      setSelectedPartId(activePartId)
    } catch {
      // Busy backstop - ignore.
    } finally {
      setPending(false)
    }
  }

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Box
        onClick={() => setExpanded((v) => !v)}
        sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.25, cursor: 'pointer' }}
      >
        <ViewInArOutlinedIcon fontSize="small" color="action" />
        <Typography variant="body2" fontWeight={600}>
          Parts
        </Typography>
        <Chip size="small" label={parts.length} sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: 11 } }} />
        <Box sx={{ flex: 1 }} />
        {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
      </Box>
      <Collapse in={expanded}>
        <Stack sx={{ px: 1, pb: 1 }} gap={0.5}>
          {parts.map((part) => {
            const selected = part.id === selectedPartId
            return (
              <Stack
                key={part.id}
                direction="row"
                alignItems="center"
                gap={0.5}
                onClick={() => void focusPart(part.id)}
                sx={{
                  px: 1,
                  py: 0.75,
                  borderRadius: 1,
                  cursor: 'pointer',
                  bgcolor: selected ? SELECTED_BG : 'transparent',
                  border: 1,
                  borderColor: selected ? 'primary.main' : 'transparent',
                  opacity: part.visible ? 1 : 0.55,
                  '&:hover': { bgcolor: selected ? SELECTED_BG : 'action.hover' }
                }}
              >
                <Tooltip title={part.visible ? 'Hide part' : 'Show part'}>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation()
                      void toggleVisibility(part.id, !part.visible)
                    }}
                  >
                    {part.visible ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
                  </IconButton>
                </Tooltip>
                <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: selected ? 600 : 400 }}>
                  {part.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {part.activeIteration !== null ? `v${part.activeIteration}` : '—'}
                </Typography>
              </Stack>
            )
          })}
        </Stack>
      </Collapse>
    </Box>
  )
}
