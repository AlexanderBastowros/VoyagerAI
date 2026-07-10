import { useEffect, useRef, useState } from 'react'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import MuiToolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import MenuIcon from '@mui/icons-material/Menu'
import { BriefPanel } from './components/BriefPanel'
import { ChatPanel } from './components/ChatPanel'
import { ImportDialog } from './components/ImportDialog'
import { ParamPanel } from './components/ParamPanel'
import { PartsPanel } from './components/PartsPanel'
import { PrinterProfilesPanel } from './components/PrinterProfilesPanel'
import { PrintSettingsPanel } from './components/PrintSettingsPanel'
import { ProjectsDrawer } from './components/ProjectsDrawer'
import { SetupScreen } from './components/SetupScreen'
import { VerificationPanel } from './components/VerificationPanel'
import { ViewportControls } from './components/ViewportControls'
import { Viewport } from './components/Viewport'
import { MAIN_PART_ID } from '../../shared/ipc'
import { toModelInfo, useAppStore } from './state/appStore'
import { syncViewportParts } from './state/syncParts'
import type { ModelViewer } from './three/viewer'

export function App(): React.JSX.Element {
  const viewerRef = useRef<ModelViewer | null>(null)
  // Monotonic token for model:displayed refetches - drops a stale part/iteration refetch whose
  // async result resolves after a newer display's (rapid consecutive display_model calls).
  const displaySeqRef = useRef(0)
  const applyAgentEvent = useAppStore((state) => state.applyAgentEvent)
  const addMessage = useAppStore((state) => state.addMessage)
  const setModel = useAppStore((state) => state.setModel)
  const setIterations = useAppStore((state) => state.setIterations)
  const setActiveIteration = useAppStore((state) => state.setActiveIteration)
  const setParts = useAppStore((state) => state.setParts)
  const setSelectedPartId = useAppStore((state) => state.setSelectedPartId)
  const setPrintSettings = useAppStore((state) => state.setPrintSettings)
  const setPendingPermission = useAppStore((state) => state.setPendingPermission)
  const hydrateProject = useAppStore((state) => state.hydrateProject)
  const projects = useAppStore((state) => state.projects)
  const activeProjectId = useAppStore((state) => state.activeProjectId)

  const [projectsOpen, setProjectsOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)

  const activeProject = projects.find((project) => project.id === activeProjectId)

  // One-time hydration of whichever project was active at last quit (or the sole project on a
  // fresh install). ProjectsDrawer's create/switch handlers mirror this same
  // hydrateProject + syncModel pairing for the same reason.
  useEffect(() => {
    let cancelled = false
    void window.voyager.project.getState().then(async (snapshot) => {
      if (cancelled) return
      hydrateProject(snapshot)
      // Render every part at its placement (WS-I) - replaces the old single-model syncModel.
      await syncViewportParts(viewerRef.current)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Top-level subscriptions to main-process pushes: streamed agent events
  // feed the chat, model:displayed feeds the viewer (which lives in a ref
  // shared with ViewportControls/Viewport), and permission requests surface the
  // Allow/Deny card in ChatPanel.
  useEffect(() => {
    const unsubscribeEvents = window.voyager.agent.onEvent(applyAgentEvent)
    const unsubscribeModel = window.voyager.model.onDisplayed((payload) => {
      // WS-I: a display belongs to a part (default `main`). Load it into that part's mesh slot and
      // focus it (it just became the active part), rather than replacing "the" single model.
      const partId = payload.partId ?? MAIN_PART_ID
      viewerRef.current?.loadPart(partId, payload.stlBuffer)
      viewerRef.current?.focusPart(partId)
      setModel(toModelInfo(payload))
      addMessage({ role: 'system-status', text: `Model v${payload.iteration} displayed: ${payload.summary}` })
      // The display may have created a new part and/or switched the active one; refresh the parts
      // list and the (now active part's) version history so every panel follows. Guard against a
      // stale refetch (an earlier display's result resolving after a later one's).
      const seq = ++displaySeqRef.current
      void Promise.all([window.voyager.part.list(), window.voyager.project.listIterations()]).then(
        ([partList, iterations]) => {
          if (seq !== displaySeqRef.current) return
          setParts(partList.parts)
          setSelectedPartId(partList.activePartId)
          setIterations(iterations)
          setActiveIteration(payload.iteration)
        }
      )
    })
    const unsubscribePermission = window.voyager.agent.onPermissionRequest(setPendingPermission)
    const unsubscribePrintSettings = window.voyager.model.onPrintSettings(setPrintSettings)
    return () => {
      unsubscribeEvents()
      unsubscribeModel()
      unsubscribePermission()
      unsubscribePrintSettings()
    }
  }, [
    applyAgentEvent,
    addMessage,
    setModel,
    setIterations,
    setActiveIteration,
    setParts,
    setSelectedPartId,
    setPendingPermission,
    setPrintSettings
  ])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <AppBar
        position="static"
        elevation={0}
        className="app-region-drag"
        sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
      >
        <MuiToolbar variant="dense" disableGutters sx={{ minHeight: 40, height: 40, px: 1 }}>
          <IconButton
            className="app-region-no-drag"
            aria-label="Open projects"
            onClick={() => setProjectsOpen(true)}
          >
            <MenuIcon fontSize="small" />
          </IconButton>
          <Typography variant="body2" fontWeight={600} sx={{ ml: 1 }}>
            Voyager AI
          </Typography>
          {activeProject && (
            <Typography variant="body2" color="text.secondary" noWrap sx={{ ml: 1 }}>
              · {activeProject.name}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          <IconButton
            className="app-region-no-drag"
            aria-label={chatOpen ? 'Close chat panel' : 'Open chat panel'}
            onClick={() => setChatOpen(!chatOpen)}
          >
            {chatOpen ? <ChevronRightIcon fontSize="small" /> : <ChatBubbleOutlineIcon fontSize="small" />}
          </IconButton>
        </MuiToolbar>
      </AppBar>
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <Viewport viewerRef={viewerRef} />
          <ViewportControls viewerRef={viewerRef} />
        </Box>
        <Box
          sx={{
            width: 380,
            flexShrink: 0,
            borderLeft: 1,
            borderColor: 'divider',
            display: chatOpen ? 'flex' : 'none',
            flexDirection: 'column',
            minWidth: 0
          }}
        >
          <BriefPanel />
          <PartsPanel />
          <ParamPanel />
          <VerificationPanel />
          <PrintSettingsPanel />
          <PrinterProfilesPanel />
          <ChatPanel />
        </Box>
      </Box>
      <ProjectsDrawer open={projectsOpen} onClose={() => setProjectsOpen(false)} viewerRef={viewerRef} />
      {/* WS-G import flow; renders a closed dialog until opened via the store's importDialogOpen. */}
      <ImportDialog />
      {/* Full-viewport overlay; renders null once setup is complete (see SetupScreen). */}
      <SetupScreen />
    </Box>
  )
}
