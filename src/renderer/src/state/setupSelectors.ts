import type { SetupStatus } from '../../../shared/ipc'

/**
 * Pure derivations over `SetupStatus`, kept separate from the zustand store
 * so they're trivially unit-testable without React/jsdom.
 *
 * As of M3 all three checks are real and blocking: the Claude Code CLI must
 * be found, the user must be signed in, and the Python environment must be
 * provisioned before chat unlocks.
 */

export function isSetupComplete(status: SetupStatus): boolean {
  return (
    status.claudeCli.state === 'ready' &&
    status.claudeAuth.state === 'ready' &&
    status.pythonEnv.state === 'ready'
  )
}

export function hasSetupError(status: SetupStatus): boolean {
  return (
    status.claudeCli.state === 'error' ||
    status.claudeAuth.state === 'error' ||
    status.pythonEnv.state === 'error'
  )
}

/** Derives ChatPanel's disabled-input reason from setup status, or null once ready. */
export function deriveChatDisabledReason(status: SetupStatus): string | null {
  if (status.claudeCli.state === 'error') return `Setup failed: ${status.claudeCli.detail}`
  if (status.claudeAuth.state === 'error') return `Setup failed: ${status.claudeAuth.detail}`
  if (status.pythonEnv.state === 'error') return `Setup failed: ${status.pythonEnv.detail}`

  if (status.claudeCli.state !== 'ready') return 'Locating the Claude Code CLI before chat can start…'
  if (status.claudeAuth.state !== 'ready') return 'Checking Claude sign-in before chat can start…'
  if (status.pythonEnv.state !== 'ready') return 'Setting up the Python environment before chat can start…'
  return null
}
