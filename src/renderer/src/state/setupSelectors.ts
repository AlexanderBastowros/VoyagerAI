import type { SetupStatus } from '../../../shared/ipc'

/**
 * Pure derivations over `SetupStatus`, kept separate from the zustand store
 * so they're trivially unit-testable without React/jsdom.
 *
 * M2 note: `pythonEnv` is the only real, implemented check right now -
 * `claudeCli` and `claudeAuth` are Milestone 3 stubs that always report
 * 'unchecked' and must NOT block the app from becoming usable. Once M3
 * implements them for real, extend `isSetupComplete` and `hasSetupError`
 * below to include them too (e.g. also require
 * `status.claudeCli.state === 'ready' && status.claudeAuth.state === 'ready'`,
 * and check their `'error'` states), at which point they become blocking.
 */

export function isSetupComplete(status: SetupStatus): boolean {
  return status.pythonEnv.state === 'ready'
}

export function hasSetupError(status: SetupStatus): boolean {
  return status.pythonEnv.state === 'error'
}

/** Derives ChatPanel's disabled-input reason from setup status, or null once ready. */
export function deriveChatDisabledReason(status: SetupStatus): string | null {
  const { pythonEnv } = status
  if (pythonEnv.state === 'error') {
    return `Setup failed: ${pythonEnv.detail}`
  }
  if (pythonEnv.state !== 'ready') {
    return 'Setting up the Python environment before chat can start…'
  }
  return null
}
