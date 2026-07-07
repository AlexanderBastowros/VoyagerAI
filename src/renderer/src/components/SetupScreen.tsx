import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { hasSetupError, isSetupComplete } from '../state/setupSelectors'
import type { SetupCheck, SetupStatus } from '../../../shared/ipc'

interface CheckRowConfig {
  key: keyof SetupStatus
  label: string
}

const CHECK_ROWS: CheckRowConfig[] = [
  { key: 'claudeCli', label: 'Claude CLI' },
  { key: 'claudeAuth', label: 'Claude sign-in' },
  { key: 'pythonEnv', label: 'Python environment' }
]

function StatusIcon({ state }: { state: SetupCheck['state'] }): React.JSX.Element {
  switch (state) {
    case 'ready':
      return (
        <span className="setup-icon setup-icon-ready" aria-hidden="true">
          ✓
        </span>
      )
    case 'error':
      return (
        <span className="setup-icon setup-icon-error" aria-hidden="true">
          ✕
        </span>
      )
    case 'in_progress':
      return <span className="setup-icon setup-icon-spinner" aria-hidden="true" />
    case 'unchecked':
      return (
        <span className="setup-icon setup-icon-pending" aria-hidden="true">
          •
        </span>
      )
  }
}

/**
 * Full-viewport overlay shown on launch while first-run setup is
 * incomplete. Always mounted (see App.tsx); renders null once every
 * blocking check is ready. For M2, `pythonEnv` alone gates dismissal - see
 * src/renderer/src/state/setupSelectors.ts for the M3 TODO that makes
 * claudeCli/claudeAuth blocking too.
 */
export function SetupScreen(): React.JSX.Element | null {
  const setupStatus = useAppStore((state) => state.setupStatus)
  const setSetupStatus = useAppStore((state) => state.setSetupStatus)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.voyager.setup.getStatus().then((status) => {
      if (!cancelled) setSetupStatus(status)
    })
    const unsubscribe = window.voyager.setup.onProgress((status) => {
      setSetupStatus(status)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const complete = isSetupComplete(setupStatus)
  const errored = hasSetupError(setupStatus)

  if (complete && !errored) return null

  async function handleRetry(): Promise<void> {
    setRetrying(true)
    try {
      const status = await window.voyager.setup.retry()
      setSetupStatus(status)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        <h1 className="setup-title">Setting up Voyager AI</h1>
        <p className="setup-subtitle">
          First launch installs a managed Python environment (build123d, trimesh, numpy) used to
          generate and validate 3D models. This can take a few minutes.
        </p>
        <ul className="setup-checklist">
          {CHECK_ROWS.map((row) => {
            const check = setupStatus[row.key]
            return (
              <li key={row.key} className={`setup-row setup-row-${check.state}`}>
                <StatusIcon state={check.state} />
                <div className="setup-row-body">
                  <div className="setup-row-label">{row.label}</div>
                  <div className="setup-row-detail">{check.detail}</div>
                </div>
              </li>
            )
          })}
        </ul>
        {errored && (
          <button
            type="button"
            className="setup-retry-button"
            onClick={() => void handleRetry()}
            disabled={retrying}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
    </div>
  )
}
