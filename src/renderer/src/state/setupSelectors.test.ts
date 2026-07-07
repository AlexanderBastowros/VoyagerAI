import { describe, expect, it } from 'vitest'
import { deriveChatDisabledReason, hasSetupError, isSetupComplete } from './setupSelectors'
import type { SetupStatus } from '../../../shared/ipc'

function status(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    claudeCli: { state: 'unchecked', detail: 'Not checked yet' },
    claudeAuth: { state: 'unchecked', detail: 'Not checked yet' },
    pythonEnv: { state: 'unchecked', detail: 'Not checked yet' },
    ...overrides
  }
}

function allReady(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    claudeCli: { state: 'ready', detail: 'Claude Code 2.1.0' },
    claudeAuth: { state: 'ready', detail: 'Signed in' },
    pythonEnv: { state: 'ready', detail: 'Ready' },
    ...overrides
  }
}

describe('isSetupComplete', () => {
  it('is false until every check is ready', () => {
    expect(isSetupComplete(status())).toBe(false)
    expect(isSetupComplete(allReady({ claudeCli: { state: 'in_progress', detail: 'Locating…' } }))).toBe(false)
    expect(isSetupComplete(allReady({ claudeAuth: { state: 'unchecked', detail: '…' } }))).toBe(false)
    expect(isSetupComplete(allReady({ pythonEnv: { state: 'in_progress', detail: 'Installing…' } }))).toBe(false)
  })

  it('is true once claudeCli, claudeAuth, and pythonEnv are all ready', () => {
    expect(isSetupComplete(allReady())).toBe(true)
  })

  it('is false if any check errored', () => {
    expect(isSetupComplete(allReady({ pythonEnv: { state: 'error', detail: 'boom' } }))).toBe(false)
    expect(isSetupComplete(allReady({ claudeCli: { state: 'error', detail: 'not found' } }))).toBe(false)
  })
})

describe('hasSetupError', () => {
  it('is true when any of the three checks is in the error state', () => {
    expect(hasSetupError(allReady({ pythonEnv: { state: 'error', detail: 'boom' } }))).toBe(true)
    expect(hasSetupError(allReady({ claudeCli: { state: 'error', detail: 'not found' } }))).toBe(true)
    expect(hasSetupError(allReady({ claudeAuth: { state: 'error', detail: 'signed out' } }))).toBe(true)
  })

  it('is false when no check errored', () => {
    expect(hasSetupError(allReady())).toBe(false)
    expect(hasSetupError(status())).toBe(false)
  })
})

describe('deriveChatDisabledReason', () => {
  it('reports the first errored check with its failure detail', () => {
    expect(
      deriveChatDisabledReason(allReady({ claudeCli: { state: 'error', detail: 'CLI not found.' } }))
    ).toContain('CLI not found.')
    expect(
      deriveChatDisabledReason(
        allReady({ pythonEnv: { state: 'error', detail: 'Install Python 3.10+ or uv, then retry.' } })
      )
    ).toContain('Install Python 3.10+ or uv, then retry.')
  })

  it('reports an in-progress reason naming the first unfinished check', () => {
    expect(deriveChatDisabledReason(status())).toMatch(/claude code cli/i)
    expect(deriveChatDisabledReason(allReady({ claudeAuth: { state: 'in_progress', detail: '…' } }))).toMatch(
      /sign-in/i
    )
    expect(deriveChatDisabledReason(allReady({ pythonEnv: { state: 'in_progress', detail: '…' } }))).toMatch(
      /python environment/i
    )
  })

  it('returns null (chat enabled) only when all three checks are ready', () => {
    expect(deriveChatDisabledReason(allReady())).toBeNull()
  })
})
