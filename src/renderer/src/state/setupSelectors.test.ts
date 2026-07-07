import { describe, expect, it } from 'vitest'
import { deriveChatDisabledReason, hasSetupError, isSetupComplete } from './setupSelectors'
import type { SetupStatus } from '../../../shared/ipc'

function status(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    claudeCli: { state: 'unchecked', detail: 'Claude CLI check arrives in Milestone 3' },
    claudeAuth: { state: 'unchecked', detail: 'Claude auth check arrives in Milestone 3' },
    pythonEnv: { state: 'unchecked', detail: 'Not checked yet' },
    ...overrides
  }
}

describe('isSetupComplete', () => {
  it('is false while pythonEnv is not ready, even if it is unchecked/in_progress', () => {
    expect(isSetupComplete(status())).toBe(false)
    expect(isSetupComplete(status({ pythonEnv: { state: 'in_progress', detail: 'Installing…' } }))).toBe(false)
  })

  it('is true once pythonEnv is ready, regardless of the still-stubbed M3 checks', () => {
    expect(isSetupComplete(status({ pythonEnv: { state: 'ready', detail: 'Ready' } }))).toBe(true)
  })

  it('is false if pythonEnv errored', () => {
    expect(isSetupComplete(status({ pythonEnv: { state: 'error', detail: 'boom' } }))).toBe(false)
  })
})

describe('hasSetupError', () => {
  it('is true only when pythonEnv is in the error state', () => {
    expect(hasSetupError(status({ pythonEnv: { state: 'error', detail: 'boom' } }))).toBe(true)
    expect(hasSetupError(status({ pythonEnv: { state: 'ready', detail: 'Ready' } }))).toBe(false)
    expect(hasSetupError(status())).toBe(false)
  })

  it('ignores errors on the still-stubbed M3 checks (they never actually error in M2)', () => {
    expect(
      hasSetupError(
        status({
          claudeCli: { state: 'error', detail: 'not real yet' },
          pythonEnv: { state: 'ready', detail: 'Ready' }
        })
      )
    ).toBe(false)
  })
})

describe('deriveChatDisabledReason', () => {
  it('disables chat with a setup-in-progress reason while pythonEnv is not ready', () => {
    const reason = deriveChatDisabledReason(status())
    expect(reason).not.toBeNull()
    expect(reason).toMatch(/python environment/i)
  })

  it('disables chat with the failure detail when pythonEnv errored', () => {
    const reason = deriveChatDisabledReason(
      status({ pythonEnv: { state: 'error', detail: 'Install Python 3.10+ or uv, then retry.' } })
    )
    expect(reason).toContain('Install Python 3.10+ or uv, then retry.')
  })

  it('enables chat (null reason) once pythonEnv is ready', () => {
    expect(deriveChatDisabledReason(status({ pythonEnv: { state: 'ready', detail: 'Ready' } }))).toBeNull()
  })
})
