import { useRef } from 'react'
import { ChatPanel } from './components/ChatPanel'
import { SetupScreen } from './components/SetupScreen'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import type { ModelViewer } from './three/viewer'

export function App(): React.JSX.Element {
  const viewerRef = useRef<ModelViewer | null>(null)

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
