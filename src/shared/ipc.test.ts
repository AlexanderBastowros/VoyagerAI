import { describe, expect, it } from 'vitest'
import { IPC, isAgentEvent, isSetupCheckState } from './ipc'

describe('isAgentEvent', () => {
  it('accepts every known agent event shape', () => {
    expect(isAgentEvent({ type: 'text-delta', messageId: 'a', delta: 'hi' })).toBe(true)
    expect(
      isAgentEvent({ type: 'tool-activity', messageId: 'a', toolName: 'display_model', detail: 'x' })
    ).toBe(true)
    expect(isAgentEvent({ type: 'message-complete', messageId: 'a' })).toBe(true)
    expect(isAgentEvent({ type: 'error', message: 'boom' })).toBe(true)
  })

  it('rejects malformed or unrelated payloads', () => {
    expect(isAgentEvent(null)).toBe(false)
    expect(isAgentEvent(undefined)).toBe(false)
    expect(isAgentEvent('text-delta')).toBe(false)
    expect(isAgentEvent({ type: 'unknown-type' })).toBe(false)
    expect(isAgentEvent({})).toBe(false)
  })
})

describe('isSetupCheckState', () => {
  it('accepts the four defined states', () => {
    for (const state of ['unchecked', 'in_progress', 'ready', 'error']) {
      expect(isSetupCheckState(state)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isSetupCheckState('done')).toBe(false)
    expect(isSetupCheckState(undefined)).toBe(false)
    expect(isSetupCheckState(42)).toBe(false)
  })
})

describe('IPC channel names', () => {
  it('are stable, unique string constants', () => {
    const names = Object.values(IPC)
    expect(new Set(names).size).toBe(names.length)
    expect(IPC.modelLoadSample).toBe('model:loadSample')
  })
})
