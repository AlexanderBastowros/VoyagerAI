import { useEffect, useRef } from 'react'
import { ChatPanel } from './components/ChatPanel'
import { ProjectSidebar } from './components/ProjectSidebar'
import { SetupScreen } from './components/SetupScreen'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { toModelInfo, useAppStore } from './state/appStore'
import type { ModelViewer } from './three/viewer'

export function App(): React.JSX.Element {
  const viewerRef = useRef<ModelViewer | null>(null)
  const applyAgentEvent = useAppStore((state) => state.applyAgentEvent)
  const addMessage = useAppStore((state) => state.addMessage)
  const setModel = useAppStore((state) => state.setModel)
  const setPendingPermission = useAppStore((state) => state.setPendingPermission)
  const hydrateProject = useAppStore((state) => state.hydrateProject)

  // One-time hydration of whichever project was active at last quit (or the sole project on a
  // fresh install). ProjectSidebar's create/switch handlers mirror this same
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
  // shared with Toolbar/Viewport), and permission requests surface the
  // Allow/Deny card in ChatPanel.
  useEffect(() => {
    const unsubscribeEvents = window.voyager.agent.onEvent(applyAgentEvent)
    const unsubscribeModel = window.voyager.model.onDisplayed((payload) => {
      viewerRef.current?.loadSTL(payload.stlBuffer)
      setModel(toModelInfo(payload))
      addMessage({ role: 'system-status', text: `Model v${payload.iteration} displayed: ${payload.summary}` })
    })
    const unsubscribePermission = window.voyager.agent.onPermissionRequest(setPendingPermission)
    return () => {
      unsubscribeEvents()
      unsubscribeModel()
      unsubscribePermission()
    }
  }, [applyAgentEvent, addMessage, setModel, setPendingPermission])

  return (
    <div className="app-shell">
      <header className="app-titlebar">Voyager AI</header>
      <div className="app-body">
        <ChatPanel />
        <div className="viewport-column">
          <Toolbar viewerRef={viewerRef} />
          <Viewport viewerRef={viewerRef} />
        </div>
        <ProjectSidebar viewerRef={viewerRef} />
      </div>
      {/* Full-viewport overlay; renders null once setup is complete (see SetupScreen). */}
      <SetupScreen />
    </div>
  )
}
