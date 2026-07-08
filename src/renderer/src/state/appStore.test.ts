import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './appStore'
import type { SelectionSummary } from '../../../shared/ipc'

function resetStore(): void {
  useAppStore.setState({
    messages: [],
    model: null,
    agentSettings: { model: 'claude-opus-4-8', effort: 'xhigh' },
    projects: [],
    activeProjectId: null,
    selection: null,
    selectMode: false,
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

  it('clears a stale selection when a new model iteration arrives via setModel', () => {
    useAppStore.getState().setSelection(sampleSelection())
    expect(useAppStore.getState().selection).not.toBeNull()

    useAppStore.getState().setModel({
      name: 'bracket_v2.stl',
      iteration: 2,
      stlPath: '/tmp/bracket_v2.stl',
      stepPath: null,
      scriptPath: '/tmp/bracket_v2.py'
    })

    expect(useAppStore.getState().selection).toBeNull()
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
        }
      })

      const state = useAppStore.getState()
      expect(state.activeProjectId).toBe('proj-b')
      expect(state.projects.map((p) => p.id)).toEqual(['proj-a', 'proj-b'])
      expect(state.agentSettings).toEqual({ model: 'claude-sonnet-5', effort: 'medium' })
      expect(state.model).toMatchObject({ name: 'part_v1.stl', iteration: 1, stepPath: 'outputs/part_v1.step' })
      expect(state.messages).toHaveLength(2)
      expect(state.messages[0]).toMatchObject({ id: 'm1', role: 'user', text: 'hi' })
      expect(state.messages[1].attachments).toEqual([{ name: 'ref.png', mediaType: 'image/png', data: '' }])
    })

    it('resets ephemeral turn state so a stale turn cannot bleed into the newly-hydrated project', () => {
      useAppStore.getState().setAgentBusy(true)
      useAppStore.getState().setSelection(sampleSelection())
      useAppStore.getState().setPendingPermission({ requestId: 'p-1', toolName: 'Write', summary: 'x' })
      useAppStore.getState().applyAgentEvent({ type: 'thinking-delta', messageId: 'turn-1', delta: 'thinking...' })

      useAppStore.getState().hydrateProject({
        activeProjectId: 'proj-a',
        projects: [{ id: 'proj-a', name: 'First', createdAt: '2024-01-01T00:00:00.000Z' }],
        messages: [],
        agentSettings: { model: 'claude-opus-4-8', effort: 'xhigh' },
        model: null
      })

      const state = useAppStore.getState()
      expect(state.agentBusy).toBe(false)
      expect(state.selection).toBeNull()
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
})
