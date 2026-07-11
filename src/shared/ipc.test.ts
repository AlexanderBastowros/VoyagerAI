import { describe, expect, it } from 'vitest'
import { IPC, isAgentEvent, isSetupCheckState } from './ipc'

describe('isAgentEvent', () => {
  it('accepts every known agent event shape', () => {
    expect(isAgentEvent({ type: 'text-delta', messageId: 'a', delta: 'hi' })).toBe(true)
    expect(isAgentEvent({ type: 'thinking-delta', messageId: 'a', delta: 'hmm' })).toBe(true)
    expect(
      isAgentEvent({ type: 'tool-activity', messageId: 'a', toolName: 'display_model', detail: 'x' })
    ).toBe(true)
    expect(isAgentEvent({ type: 'message-complete', messageId: 'a' })).toBe(true)
    expect(isAgentEvent({ type: 'stopped', messageId: 'turn-1' })).toBe(true)
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
    expect(IPC.printSettingsUpdated).toBe('printSettings:updated')
    expect(IPC.agentGetSettings).toBe('agent:getSettings')
    expect(IPC.agentSetSettings).toBe('agent:setSettings')
    expect(IPC.projectListIterations).toBe('project:listIterations')
    expect(IPC.projectRevertTo).toBe('project:revertTo')
    expect(IPC.briefGet).toBe('brief:get')
    expect(IPC.briefUpdate).toBe('brief:update')
    expect(IPC.briefLock).toBe('brief:lock')
    expect(IPC.briefUpdated).toBe('brief:updated')
    expect(IPC.paramUpdate).toBe('param:update')
    expect(IPC.paramGetManifest).toBe('param:getManifest')
    expect(IPC.verificationGet).toBe('verification:get')
    expect(IPC.verificationUpdated).toBe('verification:updated')
    expect(IPC.printerProfileList).toBe('printerProfile:list')
    expect(IPC.printerProfileSave).toBe('printerProfile:save')
    expect(IPC.printerProfileSetActive).toBe('printerProfile:setActive')
    expect(IPC.printerProfileDelete).toBe('printerProfile:delete')
    expect(IPC.printerProfileUpdated).toBe('printerProfile:updated')
    expect(IPC.modelExportPackage).toBe('model:exportPackage')
    expect(IPC.modelImport).toBe('model:import')
    expect(IPC.partList).toBe('part:list')
    expect(IPC.partGetModel).toBe('part:getModel')
    expect(IPC.partSetPlacement).toBe('part:setPlacement')
    expect(IPC.partSetVisibility).toBe('part:setVisibility')
    expect(IPC.partSetActive).toBe('part:setActive')
    expect(IPC.partUpdated).toBe('part:updated')
    expect(IPC.briefListVersions).toBe('brief:listVersions')
  })
})
