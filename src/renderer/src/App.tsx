import { useEffect, useRef } from 'react'
import { ChatPanel } from './components/ChatPanel'
import { SetupScreen } from './components/SetupScreen'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { useAppStore } from './state/appStore'
import type { ModelViewer } from './three/viewer'

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

export function App(): React.JSX.Element {
  const viewerRef = useRef<ModelViewer | null>(null)
  const applyAgentEvent = useAppStore((state) => state.applyAgentEvent)
  const addMessage = useAppStore((state) => state.addMessage)
  const setModel = useAppStore((state) => state.setModel)
  const setPendingPermission = useAppStore((state) => state.setPendingPermission)

  // Top-level subscriptions to main-process pushes: streamed agent events
  // feed the chat, model:displayed feeds the viewer (which lives in a ref
  // shared with Toolbar/Viewport), and permission requests surface the
  // Allow/Deny card in ChatPanel.
  useEffect(() => {
    const unsubscribeEvents = window.voyager.agent.onEvent(applyAgentEvent)
    const unsubscribeModel = window.voyager.model.onDisplayed((payload) => {
      viewerRef.current?.loadSTL(payload.stlBuffer)
      setModel({
        name: fileName(payload.stlPath),
        iteration: payload.iteration,
        stlPath: payload.stlPath,
        stepPath: payload.stepPath ?? null,
        scriptPath: payload.scriptPath
      })
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
      </div>
      {/* Full-viewport overlay; renders null once setup is complete (see SetupScreen). */}
      <SetupScreen />
    </div>
  )
}
