import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './appStore'
import type { PrintSettings, SelectionSummary } from '../../../shared/ipc'

function resetStore(): void {
  useAppStore.setState({
    messages: [],
    model: null,
    agentSettings: { model: 'claude-opus-4-8', effort: 'xhigh' },
    projects: [],
    activeProjectId: null,
    iterations: [],
    activeIteration: null,
    printSettings: null,
    selection: null,
    selectMode: false,
    measureMode: false,
    measurement: null,
    showAxes: true,
    wireframe: false,
    pendingPermission: null,
    thinkingText: '',
    setupStatus: {
      claudeCli: { state: 'unchecked', detail: 'Not checked yet' },
      claudeAuth: { state: 'unchecked', detail: 'Not checked yet' },
      pythonEnv: { state: 'unchecked', detail: 'Not checked yet' }
    }
  })
}

function sampleSelection(): SelectionSummary {
  return {
    bboxMin: [0, 0, 0],
    bboxMax: [2, 2, 2],
    centroid: [1, 1, 1],
    dims: [2, 2, 2],
    triCount: 4
  }
}

function samplePrintSettings(): PrintSettings {
  return {
    iteration: 1,
    material: 'PLA',
    layerHeightMm: 0.2,
    wallCount: 3,
    topBottomLayers: 4,
    infillPercent: 20,
    infillPattern: 'gyroid',
    supports: 'None',
    adhesion: 'Brim',
    nozzleTempC: 210,
    bedTempC: 60,
    printSpeedMmS: 50,
    orientation: 'Flat face down',
    notes: 'Brim helps the small footprint stay put.'
  }
}

describe('appStore', () => {
  beforeEach(resetStore)

  it('appends chat messages with a generated id, role, and text preserved', () => {
    const id = useAppStore.getState().addMessage({ role: 'user', text: 'hello' })
    const { messages } = useAppStore.getState()

    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe(id)
    expect(messages[0].role).toBe('user')
    expect(messages[0].text).toBe('hello')
    expect(typeof messages[0].createdAt).toBe('number')
  })

  it('streams deltas into the targeted message without touching other messages', () => {
    const firstId = useAppStore.getState().addMessage({ role: 'assistant', text: '', streaming: true })
    useAppStore.getState().addMessage({ role: 'system-status', text: 'unrelated' })

    useAppStore.getState().appendToMessage(firstId, 'Hel')
    useAppStore.getState().appendToMessage(firstId, 'lo')
    useAppStore.getState().completeMessage(firstId)

    const { messages } = useAppStore.getState()
    const streamed = messages.find((m) => m.id === firstId)

    expect(streamed?.text).toBe('Hello')
    expect(streamed?.streaming).toBe(false)
    expect(messages[1].text).toBe('unrelated')
  })

  it('replaces setup status wholesale via setSetupStatus', () => {
    useAppStore.getState().setSetupStatus({
      claudeCli: { state: 'ready', detail: 'Found claude CLI' },
      claudeAuth: { state: 'error', detail: 'Not logged in' },
      pythonEnv: { state: 'in_progress', detail: 'Creating venv' }
    })

    const { setupStatus } = useAppStore.getState()
    expect(setupStatus.claudeCli.state).toBe('ready')
    expect(setupStatus.claudeAuth.state).toBe('error')
    expect(setupStatus.pythonEnv.state).toBe('in_progress')
  })

  it('stores and clears the current model info', () => {
    useAppStore.getState().setModel({
      name: 'cube.stl',
      iteration: 0,
      stlPath: '/tmp/cube.stl',
      stepPath: null,
      scriptPath: null
    })
    expect(useAppStore.getState().model?.name).toBe('cube.stl')

    useAppStore.getState().setModel(null)
    expect(useAppStore.getState().model).toBeNull()
  })

  it('replaces the model/effort choice wholesale via setAgentSettings', () => {
    expect(useAppStore.getState().agentSettings).toEqual({ model: 'claude-opus-4-8', effort: 'xhigh' })

    useAppStore.getState().setAgentSettings({ model: 'claude-sonnet-5', effort: 'medium' })
    expect(useAppStore.getState().agentSettings).toEqual({ model: 'claude-sonnet-5', effort: 'medium' })
  })

  it('toggles selectMode independently of other state', () => {
    expect(useAppStore.getState().selectMode).toBe(false)

    useAppStore.getState().setSelectMode(true)
    expect(useAppStore.getState().selectMode).toBe(true)

    useAppStore.getState().setSelectMode(false)
    expect(useAppStore.getState().selectMode).toBe(false)
  })

  it('sets and clears the current selection', () => {
    const selection = sampleSelection()
    useAppStore.getState().setSelection(selection)
    expect(useAppStore.getState().selection).toEqual(selection)

    useAppStore.getState().setSelection(null)
    expect(useAppStore.getState().selection).toBeNull()
  })

  it('clears a stale selection and measurement when a new model iteration arrives via setModel', () => {
    useAppStore.getState().setSelection(sampleSelection())
    useAppStore.getState().setMeasurement(12.3)
    expect(useAppStore.getState().selection).not.toBeNull()
    expect(useAppStore.getState().measurement).not.toBeNull()

    useAppStore.getState().setModel({
      name: 'bracket_v2.stl',
      iteration: 2,
      stlPath: '/tmp/bracket_v2.stl',
      stepPath: null,
      scriptPath: '/tmp/bracket_v2.py'
    })

    expect(useAppStore.getState().selection).toBeNull()
    expect(useAppStore.getState().measurement).toBeNull()
  })

  it('sets and clears the current print-settings recommendation via setPrintSettings', () => {
    expect(useAppStore.getState().printSettings).toBeNull()

    const settings = samplePrintSettings()
    useAppStore.getState().setPrintSettings(settings)
    expect(useAppStore.getState().printSettings).toEqual(settings)

    useAppStore.getState().setPrintSettings(null)
    expect(useAppStore.getState().printSettings).toBeNull()
  })

  it('clears a stale print-settings recommendation when a new model iteration arrives via setModel', () => {
    useAppStore.getState().setPrintSettings(samplePrintSettings())
    expect(useAppStore.getState().printSettings).not.toBeNull()

    useAppStore.getState().setModel({
      name: 'bracket_v2.stl',
      iteration: 2,
      stlPath: '/tmp/bracket_v2.stl',
      stepPath: null,
      scriptPath: '/tmp/bracket_v2.py'
    })

    expect(useAppStore.getState().printSettings).toBeNull()
  })

  it('toggles measureMode independently of other state', () => {
    expect(useAppStore.getState().measureMode).toBe(false)

    useAppStore.getState().setMeasureMode(true)
    expect(useAppStore.getState().measureMode).toBe(true)

    useAppStore.getState().setMeasureMode(false)
    expect(useAppStore.getState().measureMode).toBe(false)
  })

  it('sets and clears the current measurement distance', () => {
    useAppStore.getState().setMeasurement(42.5)
    expect(useAppStore.getState().measurement).toBe(42.5)

    useAppStore.getState().setMeasurement(null)
    expect(useAppStore.getState().measurement).toBeNull()
  })

  it('toggles showAxes and wireframe independently of other state', () => {
    expect(useAppStore.getState().showAxes).toBe(true)
    expect(useAppStore.getState().wireframe).toBe(false)

    useAppStore.getState().setShowAxes(false)
    useAppStore.getState().setWireframe(true)

    expect(useAppStore.getState().showAxes).toBe(false)
    expect(useAppStore.getState().wireframe).toBe(true)
  })

  it('sets and clears the pending permission request', () => {
    expect(useAppStore.getState().pendingPermission).toBeNull()

    useAppStore.getState().setPendingPermission({
      requestId: 'perm-1-1',
      toolName: 'Write',
      summary: 'Write to /Users/x/Desktop/foo.py (outside the project folder)'
    })

    expect(useAppStore.getState().pendingPermission).toEqual({
      requestId: 'perm-1-1',
      toolName: 'Write',
      summary: 'Write to /Users/x/Desktop/foo.py (outside the project folder)'
    })

    useAppStore.getState().setPendingPermission(null)
    expect(useAppStore.getState().pendingPermission).toBeNull()
  })

  it('accumulates thinking-delta text as ephemeral state and clears it on message-complete', () => {
    expect(useAppStore.getState().thinkingText).toBe('')

    useAppStore.getState().applyAgentEvent({ type: 'thinking-delta', messageId: 'turn-1', delta: 'abc' })
    expect(useAppStore.getState().thinkingText).toBe('abc')
    expect(useAppStore.getState().messages).toHaveLength(0)

    useAppStore.getState().applyAgentEvent({ type: 'thinking-delta', messageId: 'turn-1', delta: 'def' })
    expect(useAppStore.getState().thinkingText).toBe('abcdef')
    expect(useAppStore.getState().messages).toHaveLength(0)

    useAppStore.getState().applyAgentEvent({ type: 'message-complete', messageId: 'turn-1' })
    expect(useAppStore.getState().thinkingText).toBe('')
  })

  it('completes the streaming message, adds a status line, and clears turn state on stopped', () => {
    useAppStore.getState().setPendingPermission({
      requestId: 'perm-1-1',
      toolName: 'Write',
      summary: 'Write to /Users/x/Desktop/foo.py (outside the project folder)'
    })
    useAppStore.getState().setAgentBusy(true)

    useAppStore.getState().applyAgentEvent({ type: 'text-delta', messageId: 'turn-1', delta: 'Hel' })
    useAppStore.getState().applyAgentEvent({ type: 'text-delta', messageId: 'turn-1', delta: 'lo' })

    useAppStore.getState().applyAgentEvent({ type: 'stopped', messageId: 'turn-1' })

    const { messages, agentBusy, thinkingText, pendingPermission } = useAppStore.getState()
    const streamed = messages.find((m) => m.text === 'Hello')

    expect(streamed?.streaming).toBe(false)
    expect(messages.at(-1)?.role).toBe('system-status')
    expect(messages.at(-1)?.text).toBe('Stopped.')
    expect(agentBusy).toBe(false)
    expect(thinkingText).toBe('')
    expect(pendingPermission).toBeNull()
  })

  it('handles stopped for an unknown messageId without crashing', () => {
    useAppStore.getState().setAgentBusy(true)

    expect(() =>
      useAppStore.getState().applyAgentEvent({ type: 'stopped', messageId: 'turn-unknown' })
    ).not.toThrow()

    const { messages, agentBusy } = useAppStore.getState()
    expect(messages.at(-1)?.role).toBe('system-status')
    expect(messages.at(-1)?.text).toBe('Stopped.')
    expect(agentBusy).toBe(false)
  })

  describe('hydrateProject', () => {
    it('replaces messages/model/agentSettings/projects/activeProjectId from a snapshot', () => {
      useAppStore.getState().hydrateProject({
        activeProjectId: 'proj-b',
        projects: [
          { id: 'proj-a', name: 'First', createdAt: '2024-01-01T00:00:00.000Z' },
          { id: 'proj-b', name: 'Second', createdAt: '2024-01-02T00:00:00.000Z' }
        ],
        messages: [
          { id: 'm1', role: 'user', text: 'hi', createdAt: '2024-01-02T00:00:00.000Z' },
          {
            id: 'm2',
            role: 'assistant',
            text: 'hello back',
            createdAt: '2024-01-02T00:00:01.000Z',
            attachments: [{ name: 'ref.png', mediaType: 'image/png' }]
          }
        ],
        agentSettings: { model: 'claude-sonnet-5', effort: 'medium' },
        model: {
          stlPath: 'outputs/part_v1.stl',
          stepPath: 'outputs/part_v1.step',
          scriptPath: 'outputs/part_v1.py',
          summary: 'a part',
          iteration: 1,
          stlBuffer: new ArrayBuffer(8)
        },
        iterations: [{ n: 1, summary: 'a part', at: '2024-01-02T00:00:01.000Z', hasStep: true }],
        activeIteration: 1
      })

      const state = useAppStore.getState()
      expect(state.activeProjectId).toBe('proj-b')
      expect(state.projects.map((p) => p.id)).toEqual(['proj-a', 'proj-b'])
      expect(state.agentSettings).toEqual({ model: 'claude-sonnet-5', effort: 'medium' })
      expect(state.model).toMatchObject({ name: 'part_v1.stl', iteration: 1, stepPath: 'outputs/part_v1.step' })
      expect(state.messages).toHaveLength(2)
      expect(state.messages[0]).toMatchObject({ id: 'm1', role: 'user', text: 'hi' })
      expect(state.messages[1].attachments).toEqual([{ name: 'ref.png', mediaType: 'image/png', data: '' }])
      expect(state.iterations).toEqual([{ n: 1, summary: 'a part', at: '2024-01-02T00:00:01.000Z', hasStep: true }])
      expect(state.activeIteration).toBe(1)
    })

    it('resets ephemeral turn state so a stale turn cannot bleed into the newly-hydrated project', () => {
      useAppStore.getState().setAgentBusy(true)
      useAppStore.getState().setSelection(sampleSelection())
      useAppStore.getState().setMeasurement(9.9)
      useAppStore.getState().setPrintSettings(samplePrintSettings())
      useAppStore.getState().setPendingPermission({ requestId: 'p-1', toolName: 'Write', summary: 'x' })
      useAppStore.getState().applyAgentEvent({ type: 'thinking-delta', messageId: 'turn-1', delta: 'thinking...' })

      useAppStore.getState().hydrateProject({
        activeProjectId: 'proj-a',
        projects: [{ id: 'proj-a', name: 'First', createdAt: '2024-01-01T00:00:00.000Z' }],
        messages: [],
        agentSettings: { model: 'claude-opus-4-8', effort: 'xhigh' },
        model: null,
        iterations: [],
        activeIteration: null
      })

      const state = useAppStore.getState()
      expect(state.agentBusy).toBe(false)
      expect(state.selection).toBeNull()
      expect(state.measurement).toBeNull()
      expect(state.printSettings).toBeNull()
      expect(state.pendingPermission).toBeNull()
      expect(state.thinkingText).toBe('')
      expect(state.agentStreamIds).toEqual({})
      expect(state.model).toBeNull()
    })
  })

  describe('updateProject', () => {
    it('updates an existing project entry in place', () => {
      useAppStore.setState({
        projects: [
          { id: 'proj-a', name: 'First', createdAt: '2024-01-01T00:00:00.000Z' },
          { id: 'proj-b', name: 'Second', createdAt: '2024-01-02T00:00:00.000Z' }
        ]
      })

      useAppStore.getState().updateProject({ id: 'proj-a', name: 'Renamed', createdAt: '2024-01-01T00:00:00.000Z' })

      const { projects } = useAppStore.getState()
      expect(projects.find((p) => p.id === 'proj-a')?.name).toBe('Renamed')
      expect(projects.find((p) => p.id === 'proj-b')?.name).toBe('Second')
    })

    it('appends the project if it is not already known', () => {
      useAppStore.setState({ projects: [] })
      useAppStore.getState().updateProject({ id: 'proj-c', name: 'Third', createdAt: '2024-01-03T00:00:00.000Z' })
      expect(useAppStore.getState().projects).toEqual([
        { id: 'proj-c', name: 'Third', createdAt: '2024-01-03T00:00:00.000Z' }
      ])
    })
  })

  describe('R4 version history: setIterations / setActiveIteration / addIteration', () => {
    it('replaces the iteration list and active pointer wholesale', () => {
      useAppStore.getState().setIterations([{ n: 1, summary: 'first', at: '2024-01-01T00:00:00.000Z', hasStep: false }])
      useAppStore.getState().setActiveIteration(1)

      expect(useAppStore.getState().iterations).toEqual([
        { n: 1, summary: 'first', at: '2024-01-01T00:00:00.000Z', hasStep: false }
      ])
      expect(useAppStore.getState().activeIteration).toBe(1)

      useAppStore.getState().setActiveIteration(null)
      expect(useAppStore.getState().activeIteration).toBeNull()
    })

    it('appends a new iteration from a live model:displayed push and marks it active', () => {
      useAppStore.getState().setIterations([{ n: 1, summary: 'first', at: '2024-01-01T00:00:00.000Z', hasStep: false }])
      useAppStore.getState().setActiveIteration(1)

      useAppStore.getState().addIteration({
        stlPath: 'outputs/part_v2.stl',
        stepPath: 'outputs/part_v2.step',
        scriptPath: 'outputs/part_v2.py',
        summary: 'second',
        iteration: 2,
        stlBuffer: new ArrayBuffer(8)
      })

      const { iterations, activeIteration } = useAppStore.getState()
      expect(iterations).toHaveLength(2)
      expect(iterations[1]).toMatchObject({ n: 2, summary: 'second', hasStep: true })
      expect(activeIteration).toBe(2)
    })
  })
})
