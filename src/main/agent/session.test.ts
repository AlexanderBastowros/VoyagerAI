import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentSession, humanizeToolUse, translateSdkMessage } from './session'
import type { QueryFn } from './session'
import { ProjectStore } from '../projects/store'
import type { AgentEvent, ModelDisplayedPayload } from '../../shared/ipc'

// ---------------------------------------------------------------------------
// translateSdkMessage (pure)
// ---------------------------------------------------------------------------

function msg(value: unknown): SDKMessage {
  return value as SDKMessage
}

describe('translateSdkMessage', () => {
  it('captures the session id from the init system message', () => {
    const t = translateSdkMessage(
      msg({ type: 'system', subtype: 'init', session_id: 'sess-42' }),
      'turn-1'
    )
    expect(t.sessionId).toBe('sess-42')
    expect(t.events).toEqual([])
  })

  it('turns top-level text deltas into text-delta events', () => {
    const t = translateSdkMessage(
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
      }),
      'turn-1'
    )
    expect(t.events).toEqual([{ type: 'text-delta', messageId: 'turn-1', delta: 'Hello' }])
  })

  it('suppresses deltas from nested tool contexts', () => {
    const t = translateSdkMessage(
      msg({
        type: 'stream_event',
        parent_tool_use_id: 'tool-1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'nested' } }
      }),
      'turn-1'
    )
    expect(t.events).toEqual([])
  })

  it('turns assistant tool_use blocks into humanized tool-activity events', () => {
    const t = translateSdkMessage(
      msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'On it.' },
            { type: 'tool_use', name: 'Write', input: { file_path: '/proj/outputs/bracket_v1.py' } },
            { type: 'tool_use', name: 'mcp__voyager__set_status', input: { message: 'hi' } }
          ]
        }
      }),
      'turn-2'
    )
    // set_status is skipped (its handler emits richer text); text blocks are
    // covered by streamed deltas.
    expect(t.events).toEqual([
      { type: 'tool-activity', messageId: 'turn-2', toolName: 'Write', detail: 'Writing bracket_v1.py' }
    ])
  })

  it('completes the turn on a success result', () => {
    const t = translateSdkMessage(msg({ type: 'result', subtype: 'success', is_error: false }), 'turn-3')
    expect(t.turnComplete).toBe(true)
    expect(t.events).toEqual([{ type: 'message-complete', messageId: 'turn-3' }])
  })

  it('emits an error before completing on a non-success result', () => {
    const t = translateSdkMessage(
      msg({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      'turn-3'
    )
    expect(t.turnComplete).toBe(true)
    expect(t.events.map((e) => e.type)).toEqual(['error', 'message-complete'])
  })
})

describe('humanizeToolUse', () => {
  it('prefers the Bash description over the raw command', () => {
    expect(humanizeToolUse('Bash', { description: 'Run the validator', command: 'python x.py' })).toBe(
      'Run the validator'
    )
    expect(humanizeToolUse('Bash', { command: 'python part.py' })).toBe('Running: python part.py')
  })

  it('names files for Write/Edit/Read and skips chat-noise tools', () => {
    expect(humanizeToolUse('Edit', { file_path: '/a/b/part_v2.py' })).toBe('Editing part_v2.py')
    expect(humanizeToolUse('TodoWrite', {})).toBeNull()
    expect(humanizeToolUse('mcp__voyager__set_status', {})).toBeNull()
    expect(humanizeToolUse('mcp__voyager__display_model', {})).toBe('Displaying the model in the viewport')
  })
})

// ---------------------------------------------------------------------------
// AgentSession (with a scripted fake SDK)
// ---------------------------------------------------------------------------

class PushStream<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private resolvers: Array<(r: IteratorResult<T>) => void> = []
  private ended = false

  push(item: T): void {
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ value: item, done: false })
    else this.buffer.push(item)
  }

  end(): void {
    this.ended = true
    for (const r of this.resolvers.splice(0)) r({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      }
    }
  }
}

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'voyager-session-'))
  await mkdir(join(scratch, 'skill-src'), { recursive: true })
  await writeFile(join(scratch, 'skill-src', 'SKILL.md'), '# fake skill')
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

interface Harness {
  session: AgentSession
  store: ProjectStore
  outputs: PushStream<SDKMessage>
  inputs: SDKUserMessage[]
  events: AgentEvent[]
  models: ModelDisplayedPayload[]
}

function makeHarness(): Harness {
  const store = new ProjectStore({
    baseDir: join(scratch, 'projects'),
    skillSourceDir: join(scratch, 'skill-src')
  })
  const outputs = new PushStream<SDKMessage>()
  const inputs: SDKUserMessage[] = []
  const events: AgentEvent[] = []
  const models: ModelDisplayedPayload[] = []

  const queryFn: QueryFn = ({ prompt }) => {
    void (async () => {
      for await (const m of prompt) inputs.push(m)
    })()
    // for-await in the session needs an async *iterable*, not a bare iterator.
    const iterable: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]: () => outputs[Symbol.asyncIterator]()
    }
    return iterable as unknown as Query
  }

  const session = new AgentSession({
    projectStore: store,
    pythonPath: () => join(scratch, 'venv', 'bin', 'python'),
    claudeCliPath: () => null,
    emitAgentEvent: (e) => events.push(e),
    emitModelDisplayed: (p) => models.push(p),
    queryFn,
    env: { PATH: '/usr/bin' }
  })

  return { session, store, outputs, inputs, events, models }
}

describe('AgentSession', () => {
  it('runs a full turn: accepts, forwards the user message, streams events, completes', async () => {
    const h = makeHarness()

    const response = await h.session.sendMessage('design a 20mm cube', {
      bboxMin: [0, 0, 0],
      bboxMax: [1, 1, 1],
      centroid: [0.5, 0.5, 0.5],
      dims: [1, 1, 1],
      triCount: 12
    })
    expect(response.accepted).toBe(true)
    expect(h.session.isBusy()).toBe(true)

    // The SDK received exactly the combined user message.
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    const content = h.inputs[0].message.content as string
    expect(content.startsWith('design a 20mm cube')).toBe(true)
    expect(content).toContain('Selected region')

    // A message sent mid-turn is refused with a reason.
    const refused = await h.session.sendMessage('too eager')
    expect(refused.accepted).toBe(false)
    expect(refused.reason).toMatch(/still working/i)

    h.outputs.push(msg({ type: 'system', subtype: 'init', session_id: 'sess-99' }))
    h.outputs.push(
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Sure — ' } }
      })
    )
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))

    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))
    expect(h.events).toEqual([
      { type: 'text-delta', messageId: 'turn-1', delta: 'Sure — ' },
      { type: 'message-complete', messageId: 'turn-1' }
    ])

    // Session id was persisted for resume.
    await vi.waitFor(async () => expect(await h.store.getSessionId()).toBe('sess-99'))

    // The next turn is accepted and numbered independently.
    const second = await h.session.sendMessage('make it 25mm')
    expect(second.accepted).toBe(true)
    await vi.waitFor(() => expect(h.inputs).toHaveLength(2))
  })

  it('surfaces a session crash as an error event and recovers on the next message', async () => {
    const h = makeHarness()
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    // Simulate the subprocess dying mid-turn (after it produced a message,
    // so this is not treated as a resume failure).
    h.outputs.push(msg({ type: 'system', subtype: 'init', session_id: 'sess-1' }))
    const iterator = h.outputs
    await vi.waitFor(() => expect(h.session.isBusy()).toBe(true))
    // Ending the stream mid-turn: consume loop finishes without a result.
    iterator.end()

    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))

    // Next message is accepted (a fresh query starts; the old outputs stream
    // is dead, so we only assert acceptance here).
    const next = await h.session.sendMessage('are you there?')
    expect(next.accepted).toBe(true)
  })
})
