import { useEffect, useRef, useState } from 'react'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import MuiToolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import MenuIcon from '@mui/icons-material/Menu'
import { ChatPanel } from './components/ChatPanel'
import { PrintSettingsPanel } from './components/PrintSettingsPanel'
import { ProjectsDrawer } from './components/ProjectsDrawer'
import { SetupScreen } from './components/SetupScreen'
import { ViewportControls } from './components/ViewportControls'
import { Viewport } from './components/Viewport'
import { toModelInfo, useAppStore } from './state/appStore'
import type { ModelViewer } from './three/viewer'

export function App(): React.JSX.Element {
  const viewerRef = useRef<ModelViewer | null>(null)
  const applyAgentEvent = useAppStore((state) => state.applyAgentEvent)
  const addMessage = useAppStore((state) => state.addMessage)
  const setModel = useAppStore((state) => state.setModel)
  const addIteration = useAppStore((state) => state.addIteration)
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
    void window.voyager.project.getState().then((snapshot) => {
      if (cancelled) return
      hydrateProject(snapshot)
      viewerRef.current?.syncModel(snapshot.model?.stlBuffer ?? null)
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
      viewerRef.current?.loadSTL(payload.stlBuffer)
      setModel(toModelInfo(payload))
      addIteration(payload)
      addMessage({ role: 'system-status', text: `Model v${payload.iteration} displayed: ${payload.summary}` })
    })
    const unsubscribePermission = window.voyager.agent.onPermissionRequest(setPendingPermission)
    const unsubscribePrintSettings = window.voyager.model.onPrintSettings(setPrintSettings)
    return () => {
      unsubscribeEvents()
      unsubscribeModel()
      unsubscribePermission()
      unsubscribePrintSettings()
    }
  }, [applyAgentEvent, addMessage, addIteration, setModel, setPendingPermission, setPrintSettings])

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
          <PrintSettingsPanel />
          <ChatPanel />
        </Box>
      </Box>
      <ProjectsDrawer open={projectsOpen} onClose={() => setProjectsOpen(false)} viewerRef={viewerRef} />
      {/* Full-viewport overlay; renders null once setup is complete (see SetupScreen). */}
      <SetupScreen />
    </Box>
  )
}
