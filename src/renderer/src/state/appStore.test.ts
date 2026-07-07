import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './appStore'

function resetStore(): void {
  useAppStore.setState({
    messages: [],
    model: null,
    selection: null,
    setupStatus: {
      claudeCli: { state: 'unchecked', detail: 'Not checked yet' },
      claudeAuth: { state: 'unchecked', detail: 'Not checked yet' },
      pythonEnv: { state: 'unchecked', detail: 'Not checked yet' }
    }
  })
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
})
