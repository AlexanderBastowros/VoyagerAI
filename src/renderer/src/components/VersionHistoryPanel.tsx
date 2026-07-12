import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useAppStore } from '../state/appStore'
import { syncViewportParts } from '../state/syncParts'
import type { ModelViewer } from '../three/viewer'
import { colors } from '../colors'

/** Formats an ISO timestamp for the version-history list, e.g. "Jul 7, 3:42 PM" - copied from
 *  `ProjectsDrawer.tsx` (this panel is extracted from that file's version-history section; kept
 *  duplicated rather than shared so neither file depends on the other). */
function formatIterationTimestamp(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

interface VersionHistoryPanelProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

/**
 * The left-dock "History" view (Studio Workbench): the active project's recorded iterations
 * newest-first, each with a thumbnail (WS-D), version label, timestamp, and a "Current" marker.
 * Clicking any other version reverts to it via `project:revertTo`, mirroring
 * `handleSwitch`/`handleCreate`'s `hydrateProject` + `syncViewportParts` pairing. Extracted from
 * `ProjectsDrawer.tsx`'s version-history section (see there for the combined project-switcher +
 * history drawer this dock view replaces); reverting is blocked while a turn is in flight for the
 * same reason switching projects is. Always open - no collapse chrome of its own.
 */
export function VersionHistoryPanel({ viewerRef }: VersionHistoryPanelProps): React.JSX.Element {
  const iterations = useAppStore((state) => state.iterations)
  const activeIteration = useAppStore((state) => state.activeIteration)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const selectedPartId = useAppStore((state) => state.selectedPartId)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const hydrateProject = useAppStore((state) => state.hydrateProject)

  /** WS-D: version-row thumbnails, keyed `project/part/n` (never bare `n` - every project has a
   *  v1, so an unscoped key would show the previous project's model on the new project's rows
   *  during a switch). Entries are only ever fetched-and-kept; rows without a render set
   *  (previews toggled off, matplotlib not installed, pre-WS-D iterations) simply stay absent. */
  const [renderThumbs, setRenderThumbs] = useState<Record<string, string>>({})
  /** Keys already fetched (skip) or currently fetching (don't double-fetch) - refs so the
   *  fetch effect doesn't need the state map in its closure/deps. */
  const knownThumbKeysRef = useRef<Set<string>>(new Set())
  const inFlightThumbKeysRef = useRef<Set<string>>(new Set())

  const [revertingN, setRevertingN] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const thumbKey = (n: number): string => `${activeProjectId ?? 'none'}/${selectedPartId ?? 'active'}/${n}`

  // Leaving a project drops its cached thumbnails - keys are project-scoped (no visual bleed
  // either way), this just keeps long multi-project sessions from accumulating every project's
  // full-size data URLs in renderer memory. Mirrors ProjectsDrawer's identical effect.
  useEffect(() => {
    setRenderThumbs({})
    knownThumbKeysRef.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  // Fetch only keys not already fetched, newest rows first, surfacing each thumbnail as it
  // resolves. A render set can lag its iteration by a few seconds (renderIteration is
  // fire-and-forget in the main process, and no render-updated push exists), so rows still
  // missing after a pass get a few spaced retries - mirrors ProjectsDrawer's identical effect,
  // minus the `open` gate (this dock view has no closed state).
  useEffect(() => {
    if (iterations.length === 0) return
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
  }, [iterations, activeProjectId, selectedPartId])

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

  if (iterations.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1 }}>
        No versions yet.
      </Typography>
    )
  }

  return (
    <Box>
      {error && (
        <Alert severity="warning" variant="outlined" sx={{ mx: 1, mt: 1, fontSize: 11.5 }}>
          {error}
        </Alert>
      )}
      <List dense sx={{ px: 1 }}>
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
                      width: 26,
                      height: 26,
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
    </Box>
  )
}
