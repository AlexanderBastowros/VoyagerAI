import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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
  /** Returns the `canUseTool` handler the session actually passed to `queryFn`'s options. */
  getCanUseTool: () => CanUseTool
}

interface HarnessOptions {
  approvalTimeoutMs?: number
  requestUserApproval?: (request: { requestId: string; toolName: string; summary: string }) => Promise<boolean>
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const store = new ProjectStore({
    baseDir: join(scratch, 'projects'),
    skillSourceDir: join(scratch, 'skill-src')
  })
  const outputs = new PushStream<SDKMessage>()
  const inputs: SDKUserMessage[] = []
  const events: AgentEvent[] = []
  const models: ModelDisplayedPayload[] = []
  let capturedOptions: Options | undefined

  const queryFn: QueryFn = ({ prompt, options }) => {
    capturedOptions = options
    void (async () => {
      for await (const m of prompt) inputs.push(m)
    })()
    // for-await in the session needs an async *iterable*, not a bare iterator.
    const iterable: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]: () => outputs[Symbol.asyncIterator]()
    }
    return iterable as unknown as Query
  }

  // Default: the approver must never be invoked unless a test explicitly
  // wires one up - a call here means a policy-allow test regressed into
  // asking the user, which should fail loudly rather than hang.
  const requestUserApproval =
    opts.requestUserApproval ??
    (async (): Promise<boolean> => {
      throw new Error('requestUserApproval was called unexpectedly - this test did not expect an ask-path')
    })

  const session = new AgentSession({
    projectStore: store,
    pythonPath: () => join(scratch, 'venv', 'bin', 'python'),
    claudeCliPath: () => null,
    emitAgentEvent: (e) => events.push(e),
    emitModelDisplayed: (p) => models.push(p),
    queryFn,
    env: { PATH: '/usr/bin' },
    requestUserApproval,
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {})
  })

  return {
    session,
    store,
    outputs,
    inputs,
    events,
    models,
    getCanUseTool: () => {
      if (!capturedOptions?.canUseTool) throw new Error('canUseTool was not set on the query() options')
      return capturedOptions.canUseTool
    }
  }
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

// ---------------------------------------------------------------------------
// canUseTool wiring (the permission gate that replaced bypassPermissions)
// ---------------------------------------------------------------------------

/** `CanUseTool`'s return type is `Promise<PermissionResult | null>`; our handler never actually
 *  resolves null, so tests narrow through this helper instead of repeating the null-check. */
function expectDenied(result: Awaited<ReturnType<CanUseTool>>): { message: string } {
  if (!result || result.behavior !== 'deny') throw new Error(`expected a deny result, got ${JSON.stringify(result)}`)
  return result
}

describe('canUseTool', () => {
  it('resolves a policy-allow decision immediately without invoking the approver', async () => {
    const h = makeHarness()
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    const canUseTool = h.getCanUseTool()
    const controller = new AbortController()
    const result = await canUseTool(
      'Read',
      { file_path: 'outputs/x.py' },
      { signal: controller.signal, toolUseID: 'tu-1', requestId: 'sdk-req-1' }
    )

    // The default harness approver throws if called at all - reaching here
    // without a thrown error confirms it was never invoked. `updatedInput`
    // must echo the input: the CLI's control protocol requires it on allow.
    expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: 'outputs/x.py' } })
  })

  it('allows an in-project Write without asking the user', async () => {
    const h = makeHarness()
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    const projectDir = h.store.getProjectDir()

    const canUseTool = h.getCanUseTool()
    const controller = new AbortController()
    const result = await canUseTool(
      'Write',
      { file_path: `${projectDir}/outputs/part_v1.py` },
      { signal: controller.signal, toolUseID: 'tu-2', requestId: 'sdk-req-2' }
    )

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: `${projectDir}/outputs/part_v1.py` }
    })
  })

  it('asks the user for an out-of-policy write and allows once approved', async () => {
    const approvalCalls: Array<{ requestId: string; toolName: string; summary: string }> = []
    const h = makeHarness({
      requestUserApproval: async (request) => {
        approvalCalls.push(request)
        return true
      }
    })
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    const canUseTool = h.getCanUseTool()
    const controller = new AbortController()
    const result = await canUseTool(
      'Write',
      { file_path: '/Users/x/Desktop/foo.py' },
      { signal: controller.signal, toolUseID: 'tu-3', requestId: 'sdk-req-3' }
    )

    expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: '/Users/x/Desktop/foo.py' } })
    expect(approvalCalls).toHaveLength(1)
    expect(approvalCalls[0].toolName).toBe('Write')
    expect(approvalCalls[0].summary).toContain('/Users/x/Desktop/foo.py')

    // The chat shows why Claude paused while the request was in flight.
    expect(
      h.events.some((e) => e.type === 'tool-activity' && e.detail.includes('Waiting for your approval'))
    ).toBe(true)
  })

  it('denies with a message steering Claude back to ./outputs/ when the user declines', async () => {
    const h = makeHarness({ requestUserApproval: async () => false })
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    const canUseTool = h.getCanUseTool()
    const controller = new AbortController()
    const result = await canUseTool(
      'Write',
      { file_path: '/Users/x/Desktop/foo.py' },
      { signal: controller.signal, toolUseID: 'tu-4', requestId: 'sdk-req-4' }
    )

    expect(expectDenied(result).message).toContain('./outputs/')
  })

  it('denies after the approval timeout elapses without a response', async () => {
    const h = makeHarness({
      approvalTimeoutMs: 20,
      requestUserApproval: () => new Promise(() => {}) // never resolves - only the timeout can end this
    })
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    const canUseTool = h.getCanUseTool()
    const controller = new AbortController()
    const result = await canUseTool(
      'Write',
      { file_path: '/Users/x/Desktop/foo.py' },
      { signal: controller.signal, toolUseID: 'tu-5', requestId: 'sdk-req-5' }
    )

    expectDenied(result)
  })

  it('denies when the SDK aborts the request mid-ask', async () => {
    const h = makeHarness({
      requestUserApproval: () => new Promise(() => {}) // never resolves - abort must win
    })
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    const canUseTool = h.getCanUseTool()
    const controller = new AbortController()
    const pending = canUseTool(
      'Write',
      { file_path: '/Users/x/Desktop/foo.py' },
      { signal: controller.signal, toolUseID: 'tu-6', requestId: 'sdk-req-6' }
    )
    controller.abort()

    const result = await pending
    expectDenied(result)
  })
})
