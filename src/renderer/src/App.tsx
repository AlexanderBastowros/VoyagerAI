import { useEffect, useRef, useState } from 'react'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import MuiToolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import { ActivityRail } from './components/ActivityRail'
import type { LeftView } from './components/ActivityRail'
import { DockResizeHandle } from './components/DockResizeHandle'
import { ImportDialog } from './components/ImportDialog'
import { Inspector } from './components/Inspector'
import type { InspectorTab } from './components/Inspector'
import { LeftDock } from './components/LeftDock'
import { ProjectsDrawer } from './components/ProjectsDrawer'
import { SetupScreen } from './components/SetupScreen'
import { StatusBar } from './components/StatusBar'
import { ViewportControls } from './components/ViewportControls'
import { Viewport } from './components/Viewport'
import { MAIN_PART_ID } from '../../shared/ipc'
import { toModelInfo, useAppStore } from './state/appStore'
import {
  DEFAULT_INSPECTOR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  clampInspectorWidth,
  clampRequestedInspectorWidth,
  maxInspectorWidth,
  readStoredInspectorWidth,
  writeStoredInspectorWidth
} from './state/dockWidth'
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
  const setAvailableModels = useAppStore((state) => state.setAvailableModels)
  const setImportDialogOpen = useAppStore((state) => state.setImportDialogOpen)
  const projects = useAppStore((state) => state.projects)
  const activeProjectId = useAppStore((state) => state.activeProjectId)

  const [projectsOpen, setProjectsOpen] = useState(false)
  // Studio Workbench layout state (renderer-local, purely presentational - no store/IPC surface):
  // which docks are open, which project-detail tab the right-dock Inspector shows, and which view
  // the left dock shows.
  const [leftDockOpen, setLeftDockOpen] = useState(true)
  const [rightDockOpen, setRightDockOpen] = useState(true)
  const [leftView, setLeftView] = useState<LeftView>('parts')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('chat')
  // The Inspector width the user last *asked* for. Same posture as the dock-open flags above -
  // presentational renderer state, persisted to localStorage (see `dockWidth.ts`) rather than to the
  // store/IPC. Deliberately the request rather than what paints: the window-derived cap is applied
  // when rendering instead, so a temporarily narrow window squeezes the dock without overwriting the
  // preference. Lazy initializer so localStorage is touched once on mount, not on every render.
  const [requestedInspectorWidth, setRequestedInspectorWidth] = useState(() => readStoredInspectorWidth())
  // The live window width, in state so both the painted width below and the cap the handle
  // advertises via `aria-valuemax` stay truthful as the window resizes.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  // What actually paints: the request narrowed to fit *this* window, so a width saved on a wider
  // display can never squeeze the 3D viewport to nothing. Derived during render rather than stored,
  // which is what makes the narrowing reversible.
  const inspectorWidth = clampInspectorWidth(requestedInspectorWidth, windowWidth)

  const activeProject = projects.find((project) => project.id === activeProjectId)

  // Clicking a rail view opens the dock on that view; clicking the already-open view collapses it.
  function handleSelectView(view: LeftView): void {
    setLeftDockOpen((open) => !(open && view === leftView))
    setLeftView(view)
  }

  // The resize handle reports a raw requested width (pointer delta or keyboard step); clamping to
  // the absolute band lives here so every explicit path - drag, keyboard, reset - goes through the
  // one pure rule set. The window-derived cap is *not* applied to the request: that belongs to what
  // paints, so a narrow window never rewrites what the user asked for.
  function handleInspectorResize(requested: number): void {
    setRequestedInspectorWidth(clampRequestedInspectorWidth(requested))
  }

  // Track the window width so the painted Inspector width is re-derived on resize: shrinking the
  // window must never let a wide Inspector squeeze the 3D viewport to zero. Nothing here touches
  // the requested width, so widening the window back restores the user's dock instead of leaving it
  // stuck at the narrow window's cap.
  useEffect(() => {
    function handleResize(): void {
      setWindowWidth(window.innerWidth)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  // Persist the *settled request*, not the painted width - a window that happens to be narrow right
  // now must not be what gets saved. Debounced rather than written per pointermove frame: a drag
  // otherwise fires dozens of synchronous localStorage writes and only the value the user let go on
  // matters. Debouncing (rather than a commit callback on pointer-up) also covers keyboard nudges
  // and the double-click reset with one mechanism.
  useEffect(() => {
    const timer = setTimeout(() => writeStoredInspectorWidth(requestedInspectorWidth), 300)
    return () => {
      clearTimeout(timer)
    }
  }, [requestedInspectorWidth])

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

  // The model picker's rows. Fetched separately from project hydration and deliberately not
  // awaited alongside it: building the catalog can involve probing a model the CLI doesn't list
  // yet, which costs a turn on a cold cache, and the viewport must not wait on that. Until it
  // resolves the picker shows the project's persisted model on its own.
  useEffect(() => {
    let cancelled = false
    void window.voyager.agent.listModels().then((models) => {
      if (!cancelled) setAvailableModels(models)
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
        <MuiToolbar variant="dense" disableGutters sx={{ minHeight: 40, height: 40, px: 1.5 }}>
          <Typography variant="body2" fontWeight={600}>
            Voyager AI
          </Typography>
          {activeProject && (
            <Typography variant="body2" color="text.secondary" noWrap sx={{ ml: 1 }}>
              · {activeProject.name}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          <Tooltip title="Import a model">
            <IconButton
              className="app-region-no-drag"
              aria-label="Import model"
              onClick={() => setImportDialogOpen(true)}
            >
              <UploadFileIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={rightDockOpen ? 'Hide inspector' : 'Show inspector'}>
            <IconButton
              className="app-region-no-drag"
              aria-label={rightDockOpen ? 'Hide inspector' : 'Show inspector'}
              color={rightDockOpen ? 'primary' : 'default'}
              onClick={() => setRightDockOpen((open) => !open)}
            >
              {rightDockOpen ? <ChevronRightIcon fontSize="small" /> : <ChatBubbleOutlineIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </MuiToolbar>
      </AppBar>

      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <ActivityRail
          view={leftView}
          onSelectView={handleSelectView}
          onOpenProjects={() => setProjectsOpen(true)}
          leftDockOpen={leftDockOpen}
        />
        {leftDockOpen && <LeftDock view={leftView} viewerRef={viewerRef} />}

        <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <Viewport viewerRef={viewerRef} />
          <ViewportControls viewerRef={viewerRef} />
        </Box>

        {/* Right dock: a single tabbed Inspector - Chat and the four project-detail panels
            (Brief / Params / Verify / Print) are peer tabs, one visible at a time. Its width is
            user-resizable by dragging the handle on its left seam (defaulting to the old fixed
            372px), which is why the dock is measured from state rather than hard-coded. The dock
            itself stays mounted when collapsed - `display: none`, not unmounted, so the Inspector
            keeps its per-panel state across a hide/show - but the handle must not linger over a
            hidden dock, so only the handle is conditionally rendered. */}
        {rightDockOpen && (
          <DockResizeHandle
            width={inspectorWidth}
            min={MIN_INSPECTOR_WIDTH}
            max={maxInspectorWidth(windowWidth)}
            onChange={handleInspectorResize}
            onReset={() => handleInspectorResize(DEFAULT_INSPECTOR_WIDTH)}
          />
        )}
        <Box
          sx={{
            width: inspectorWidth,
            flexShrink: 0,
            borderLeft: 1,
            borderColor: 'divider',
            display: rightDockOpen ? 'flex' : 'none',
            flexDirection: 'column',
            minWidth: 0
          }}
        >
          <Inspector tab={inspectorTab} onTabChange={setInspectorTab} />
        </Box>
      </Box>

      <StatusBar viewerRef={viewerRef} />

      <ProjectsDrawer open={projectsOpen} onClose={() => setProjectsOpen(false)} viewerRef={viewerRef} />
      {/* WS-G import flow; renders a closed dialog until opened via the store's importDialogOpen. */}
      <ImportDialog />
      {/* Full-viewport overlay; renders null once setup is complete (see SetupScreen). */}
      <SetupScreen />
    </Box>
  )
}
