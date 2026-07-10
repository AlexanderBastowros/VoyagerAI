import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentSession, humanizeToolUse, translateSdkMessage, truncateArgs } from './session'
import type { QueryFn } from './session'
import { ProjectStore } from '../projects/store'
import type { VoyagerPrinterProfileStore } from '../../tools'
import type { AgentEvent, ModelDisplayedPayload, PrinterProfileRef, PrintSettings } from '@shared/ipc'

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

  it('turns top-level thinking deltas into thinking-delta events', () => {
    const t = translateSdkMessage(
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think' } }
      }),
      'turn-1'
    )
    expect(t.events).toEqual([{ type: 'thinking-delta', messageId: 'turn-1', delta: 'Let me think' }])
  })

  it('suppresses thinking deltas from nested tool contexts', () => {
    const t = translateSdkMessage(
      msg({
        type: 'stream_event',
        parent_tool_use_id: 'tool-1',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'nested' } }
      }),
      'turn-1'
    )
    expect(t.events).toEqual([])
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
      {
        type: 'tool-activity',
        messageId: 'turn-2',
        toolName: 'Write',
        detail: 'Writing bracket_v1.py',
        routine: false,
        args: '{"file_path":"/proj/outputs/bracket_v1.py"}'
      }
    ])
  })

  it('emits a routine tool-activity event for bookkeeping tools like TodoWrite', () => {
    const t = translateSdkMessage(
      msg({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }] }
      }),
      'turn-2'
    )
    expect(t.events).toEqual([
      {
        type: 'tool-activity',
        messageId: 'turn-2',
        toolName: 'TodoWrite',
        detail: 'Updating its task list',
        routine: true,
        args: '{"todos":[]}'
      }
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

  it('emits stopped (not error) on a result whose subtype is the runtime-only "interrupt"', () => {
    const t = translateSdkMessage(msg({ type: 'result', subtype: 'interrupt', is_error: false }), 'turn-3')
    expect(t.turnComplete).toBe(true)
    expect(t.events).toEqual([{ type: 'stopped', messageId: 'turn-3' }])
  })

  it('emits stopped (not error) for an ordinary error subtype when interruptRequested is true', () => {
    const t = translateSdkMessage(
      msg({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      'turn-3',
      true
    )
    expect(t.turnComplete).toBe(true)
    expect(t.events).toEqual([{ type: 'stopped', messageId: 'turn-3' }])
  })
})

describe('humanizeToolUse', () => {
  it('prefers the Bash description over the raw command', () => {
    expect(humanizeToolUse('Bash', { description: 'Run the validator', command: 'python x.py' })).toMatchObject({
      detail: 'Run the validator',
      routine: false
    })
    expect(humanizeToolUse('Bash', { command: 'python part.py' })).toMatchObject({
      detail: 'Running: python part.py',
      routine: false
    })
  })

  it('names files for Write/Edit/Read, carrying truncated args', () => {
    expect(humanizeToolUse('Edit', { file_path: '/a/b/part_v2.py' })).toEqual({
      detail: 'Editing part_v2.py',
      routine: false,
      args: '{"file_path":"/a/b/part_v2.py"}'
    })
  })

  it('marks bookkeeping tools routine (emitted) and keeps set_status suppressed (null)', () => {
    expect(humanizeToolUse('TodoWrite', {})).toEqual({ detail: 'Updating its task list', routine: true })
    expect(humanizeToolUse('mcp__voyager__set_status', {})).toBeNull()
    expect(humanizeToolUse('mcp__voyager__display_model', {})).toMatchObject({
      detail: 'Displaying the model in the viewport',
      routine: false
    })
  })

  it('surfaces update_brief calls (WS-A)', () => {
    expect(humanizeToolUse('mcp__voyager__update_brief', { part_name: 'Bracket' })).toMatchObject({
      detail: 'Updating the design brief',
      routine: false
    })
  })

  it('suppresses AskUserQuestion (denied by policy; Claude re-asks in prose)', () => {
    expect(humanizeToolUse('AskUserQuestion', { questions: [] })).toBeNull()
  })
})

describe('truncateArgs', () => {
  it('returns undefined for empty input', () => {
    expect(truncateArgs({})).toBeUndefined()
  })

  it('stringifies small input verbatim', () => {
    expect(truncateArgs({ file_path: '/a/b.py' })).toBe('{"file_path":"/a/b.py"}')
  })

  it('clamps long input to the max length with an ellipsis', () => {
    const result = truncateArgs({ command: 'x'.repeat(1000) }, 100)
    expect(result).toHaveLength(101) // 100 chars + the … suffix
    expect(result?.endsWith('…')).toBe(true)
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
  await writeFile(join(scratch, 'validate_stl.py'), '# fake validator')
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

interface Harness {
  session: AgentSession
  store: ProjectStore
  /** The most recent `queryFn` call's fake output stream - see `outputsHistory` for tests
   *  spanning more than one call (e.g. a settings-change restart). */
  outputs: PushStream<SDKMessage>
  /** One entry per `queryFn` call, in call order - grows when `ensureStarted` restarts the
   *  query (e.g. after a model/effort change). */
  outputsHistory: PushStream<SDKMessage>[]
  inputs: SDKUserMessage[]
  events: AgentEvent[]
  models: ModelDisplayedPayload[]
  printSettings: PrintSettings[]
  /** Returns the `canUseTool` handler from the most recent `queryFn` call's options. */
  getCanUseTool: () => CanUseTool
  /** Returns the options object from the most recent `queryFn` call, if any. */
  getCapturedOptions: () => Options | undefined
  /** One entry per `queryFn` call, in call order - see `outputsHistory`. */
  optionsHistory: Options[]
  /** Spy standing in for the fake Query's `interrupt()` method. */
  interruptSpy: ReturnType<typeof vi.fn>
}

interface HarnessOptions {
  approvalTimeoutMs?: number
  requestUserApproval?: (request: { requestId: string; toolName: string; summary: string }) => Promise<boolean>
  /** Lets a test script what happens when `activeQuery.interrupt()` is called - e.g. push a
   *  result message onto `outputs`, or throw/reject to simulate a dead subprocess. */
  onInterrupt?: (outputs: PushStream<SDKMessage>) => void | Promise<void>
  /** Overrides the default real, scratch-backed ProjectStore - e.g. to point at a broken
   *  skillSourceDir and force ensureProject()/ensureStarted() to reject. */
  store?: ProjectStore
  /** Wires a printer-profile store (WS-E) so tests can assert the active profile reaches the
   *  system prompt and that a profile change restarts the query. */
  printerProfiles?: VoyagerPrinterProfileStore
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const store =
    opts.store ??
    new ProjectStore({
      baseDir: join(scratch, 'projects'),
      skillSourceDir: join(scratch, 'skill-src'),
      verifyScriptPath: join(scratch, 'validate_stl.py')
    })
  const outputsHistory: PushStream<SDKMessage>[] = []
  const optionsHistory: Options[] = []
  const inputs: SDKUserMessage[] = []
  const events: AgentEvent[] = []
  const models: ModelDisplayedPayload[] = []
  const printSettings: PrintSettings[] = []

  const interruptSpy = vi.fn(async () => {
    const current = outputsHistory.at(-1)
    if (opts.onInterrupt && current) await opts.onInterrupt(current)
  })

  const queryFn: QueryFn = ({ prompt, options }) => {
    if (!options) throw new Error('queryFn was called without options')
    optionsHistory.push(options)
    // A real query() call gets its own dedicated output stream (a fresh subprocess) - mirror
    // that here so a settings-change restart doesn't have two queries racing over one stream.
    const outputs = new PushStream<SDKMessage>()
    outputsHistory.push(outputs)
    void (async () => {
      for await (const m of prompt) inputs.push(m)
    })()
    // for-await in the session needs an async *iterable*, not a bare iterator.
    const iterable: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]: () => outputs[Symbol.asyncIterator]()
    }
    // Real Query objects have control-request methods (interrupt, etc.) beyond
    // the async-iterable surface; only `interrupt` is exercised here.
    return { ...iterable, interrupt: interruptSpy } as unknown as Query
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
    emitPrintSettings: (p) => printSettings.push(p),
    queryFn,
    env: { PATH: '/usr/bin' },
    requestUserApproval,
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
    ...(opts.printerProfiles ? { printerProfiles: opts.printerProfiles } : {})
  })

  return {
    session,
    store,
    get outputs(): PushStream<SDKMessage> {
      const current = outputsHistory.at(-1)
      if (!current) throw new Error('queryFn has not been called yet - no active output stream')
      return current
    },
    outputsHistory,
    inputs,
    events,
    models,
    printSettings,
    getCanUseTool: () => {
      const options = optionsHistory.at(-1)
      if (!options?.canUseTool) throw new Error('canUseTool was not set on the query() options')
      return options.canUseTool
    },
    getCapturedOptions: () => optionsHistory.at(-1),
    optionsHistory,
    interruptSpy
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

  it('forwards attached images as image content blocks ahead of the text block', async () => {
    const h = makeHarness()

    const response = await h.session.sendMessage('match this reference', null, [
      { data: 'aGVsbG8=', mediaType: 'image/png', name: 'reference.png' }
    ])
    expect(response.accepted).toBe(true)

    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    const content = h.inputs[0].message.content as Array<{ type: string; text?: string }>
    expect(Array.isArray(content)).toBe(true)
    expect(content.map((b) => b.type)).toEqual(['image', 'text'])
    expect(content.at(-1)?.text).toBe('match this reference')
  })

  it('injects a "Reverted model" block when the active version is behind the latest', async () => {
    const h = makeHarness()
    const { dir } = await h.store.ensureProject()
    // Two iterations (each needs its source script on disk for the snapshot copy).
    await writeFile(join(dir, 'outputs', 'part_v1.py'), '# v1')
    const first = await h.store.recordIteration({
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'v1'
    })
    await writeFile(join(dir, 'outputs', 'part_v2.py'), '# v2')
    await h.store.recordIteration({ stlPath: 'outputs/part_v2.stl', scriptPath: 'outputs/part_v2.py', summary: 'v2' })
    await h.store.revertTo(first.n)

    await h.session.sendMessage('make the base thicker')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    const content = h.inputs[0].message.content as string
    expect(content.startsWith('make the base thicker')).toBe(true)
    expect(content).toContain('Reverted model')
    expect(content).toContain('outputs/versions/main/v1.py')
  })

  it('does not inject a revert block when the active version is already the latest', async () => {
    const h = makeHarness()
    const { dir } = await h.store.ensureProject()
    await writeFile(join(dir, 'outputs', 'part_v1.py'), '# v1')
    await h.store.recordIteration({ stlPath: 'outputs/part_v1.stl', scriptPath: 'outputs/part_v1.py', summary: 'v1' })

    await h.session.sendMessage('keep going')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    const content = h.inputs[0].message.content as string
    expect(content).toBe('keep going')
  })

  it('enables adaptive thinking with visible summaries on the query() options', async () => {
    const h = makeHarness()
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    expect(h.getCapturedOptions()?.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(h.getCapturedOptions()?.model).toBe('claude-opus-4-8')
    expect(h.getCapturedOptions()?.effort).toBe('xhigh')
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
// AgentSession model/effort settings (R8)
// ---------------------------------------------------------------------------

describe('AgentSession model/effort settings', () => {
  it('applies a saved model/effort choice from the first turn', async () => {
    const h = makeHarness()
    await h.store.setAgentSettings({ model: 'claude-sonnet-5', effort: 'low' })

    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    expect(h.getCapturedOptions()?.model).toBe('claude-sonnet-5')
    expect(h.getCapturedOptions()?.effort).toBe('low')
  })

  it('omits effort for a model whose API rejects it (Haiku)', async () => {
    const h = makeHarness()
    await h.store.setAgentSettings({ model: 'claude-haiku-4-5', effort: 'max' })

    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    expect(h.getCapturedOptions()?.model).toBe('claude-haiku-4-5')
    expect(h.getCapturedOptions()?.effort).toBeUndefined()
  })

  it('does not restart the query between turns when settings are unchanged', async () => {
    const h = makeHarness()

    await h.session.sendMessage('first')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))
    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))

    await h.session.sendMessage('second')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(2))

    expect(h.optionsHistory).toHaveLength(1)
  })

  it('restarts the query on the next turn after a mid-session settings change, resuming the conversation', async () => {
    const h = makeHarness()

    await h.session.sendMessage('first')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    h.outputs.push(msg({ type: 'system', subtype: 'init', session_id: 'sess-1' }))
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))
    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))
    await vi.waitFor(async () => expect(await h.store.getSessionId()).toBe('sess-1'))

    await h.store.setAgentSettings({ model: 'claude-sonnet-5', effort: 'medium' })
    await h.session.sendMessage('second')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(2))

    // A fresh query started (not the first one reused) with the new settings, resuming the
    // prior conversation via `resume` rather than losing it.
    expect(h.optionsHistory).toHaveLength(2)
    expect(h.optionsHistory[0]?.model).toBe('claude-opus-4-8')
    expect(h.optionsHistory[1]?.model).toBe('claude-sonnet-5')
    expect(h.optionsHistory[1]?.effort).toBe('medium')
    expect(h.optionsHistory[1]?.resume).toBe('sess-1')
  })

  it('bakes the active printer profile into the system prompt append (WS-E)', async () => {
    const h = makeHarness({ printerProfiles: fakePrinterProfiles(printerProfile()).store })

    await h.session.sendMessage('design a 20mm cube')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    const append = promptAppendOf(h.getCapturedOptions())
    expect(append).toContain('"Prusa MK4"')
    expect(append).toContain('nozzle diameter')
  })

  it('says nothing about printer profiles when no profile store is wired', async () => {
    const h = makeHarness()

    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    expect(promptAppendOf(h.getCapturedOptions())).not.toContain('printer profile')
  })

  it('restarts the query (resuming) when the active printer profile changes between turns', async () => {
    const fake = fakePrinterProfiles(null)
    const h = makeHarness({ printerProfiles: fake.store })

    await h.session.sendMessage('first')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    h.outputs.push(msg({ type: 'system', subtype: 'init', session_id: 'sess-1' }))
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))
    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))
    await vi.waitFor(async () => expect(await h.store.getSessionId()).toBe('sess-1'))

    // With no profile saved, the prompt teaches ask-then-offer-to-save.
    expect(promptAppendOf(h.optionsHistory[0])).toContain('has not saved a printer profile yet')

    fake.setActiveProfile(printerProfile())
    await h.session.sendMessage('second')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(2))

    expect(h.optionsHistory).toHaveLength(2)
    expect(promptAppendOf(h.optionsHistory[1])).toContain('"Prusa MK4"')
    expect(h.optionsHistory[1]?.resume).toBe('sess-1')
  })

  it('does not restart the query between turns when the active profile is unchanged', async () => {
    const h = makeHarness({ printerProfiles: fakePrinterProfiles(printerProfile()).store })

    await h.session.sendMessage('first')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))
    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))

    await h.session.sendMessage('second')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(2))

    expect(h.optionsHistory).toHaveLength(1)
  })
})

function printerProfile(): PrinterProfileRef {
  return {
    id: 'prusa-mk4',
    name: 'Prusa MK4',
    bedXMm: 250,
    bedYMm: 210,
    bedZMm: 220,
    nozzleDiameterMm: 0.4,
    materials: ['PLA']
  }
}

/** A `VoyagerPrinterProfileStore` whose active profile tests can swap between turns. */
function fakePrinterProfiles(initial: PrinterProfileRef | null): {
  store: VoyagerPrinterProfileStore
  setActiveProfile: (profile: PrinterProfileRef | null) => void
} {
  let active = initial
  return {
    store: {
      getActive: async () => active,
      save: async (profile) => ({ profiles: [profile], activeId: profile.id })
    },
    setActiveProfile: (profile) => {
      active = profile
    }
  }
}

function promptAppendOf(options: Options | undefined): string {
  const systemPrompt = options?.systemPrompt
  if (!systemPrompt || typeof systemPrompt === 'string' || !('append' in systemPrompt)) {
    throw new Error('expected a preset system prompt with an append')
  }
  return systemPrompt.append ?? ''
}

// ---------------------------------------------------------------------------
// AgentSession.interrupt
// ---------------------------------------------------------------------------

describe('AgentSession.interrupt', () => {
  it('is a no-op when there is no turn in flight', async () => {
    const h = makeHarness()
    await h.session.interrupt()
    expect(h.interruptSpy).not.toHaveBeenCalled()
  })

  it('stops an in-flight turn without tearing the session down, and the conversation continues', async () => {
    const h = makeHarness({
      onInterrupt: (outputs) => {
        outputs.push(msg({ type: 'result', subtype: 'interrupt', is_error: false }))
      }
    })

    const response = await h.session.sendMessage('design a bracket')
    expect(response.accepted).toBe(true)
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    await h.session.interrupt()
    expect(h.interruptSpy).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))
    expect(h.events.at(-1)).toEqual({ type: 'stopped', messageId: 'turn-1' })
    expect(h.events.some((e) => e.type === 'error')).toBe(false)

    // The session survives: a follow-up message is accepted and continues
    // the same underlying query/queue rather than starting a new one.
    const followUp = await h.session.sendMessage('now make it thicker')
    expect(followUp.accepted).toBe(true)
    await vi.waitFor(() => expect(h.inputs).toHaveLength(2))
  })

  it('falls back to resetting the session when interrupt() rejects (dead subprocess)', async () => {
    const h = makeHarness({
      onInterrupt: () => {
        throw new Error('subprocess already exited')
      }
    })

    await h.session.sendMessage('design a bracket')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    await h.session.interrupt()

    expect(h.session.isBusy()).toBe(false)
    expect(h.events.some((e) => e.type === 'stopped')).toBe(true)
  })

  it('clears the interrupt flag once the turn ends, so the next normal turn completes normally', async () => {
    const h = makeHarness({
      onInterrupt: (outputs) => {
        outputs.push(msg({ type: 'result', subtype: 'interrupt', is_error: false }))
      }
    })

    await h.session.sendMessage('design a bracket')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    await h.session.interrupt()
    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))

    await h.session.sendMessage('now finish it')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(2))
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))

    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))
    expect(h.events.at(-1)).toEqual({ type: 'message-complete', messageId: 'turn-2' })
    expect(h.events.some((e) => e.type === 'stopped' && e.messageId === 'turn-2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AgentSession message persistence (R3.1)
// ---------------------------------------------------------------------------

describe('AgentSession message persistence', () => {
  it('persists the user message immediately on send', async () => {
    const h = makeHarness()
    await h.session.sendMessage('design a bracket')

    await vi.waitFor(async () => expect(await h.store.getChatHistory()).toHaveLength(1))
    const [message] = await h.store.getChatHistory()
    expect(message).toMatchObject({ role: 'user', text: 'design a bracket' })
  })

  it('strips attachment data down to name/mediaType before persisting', async () => {
    const h = makeHarness()
    await h.session.sendMessage('match this reference', null, [
      { data: 'aGVsbG8=', mediaType: 'image/png', name: 'reference.png' }
    ])

    await vi.waitFor(async () => expect(await h.store.getChatHistory()).toHaveLength(1))
    const [message] = await h.store.getChatHistory()
    expect(message.attachments).toEqual([{ name: 'reference.png', mediaType: 'image/png' }])
  })

  it('persists the accumulated assistant text as one message once the turn completes', async () => {
    const h = makeHarness()
    await h.session.sendMessage('design a bracket')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    h.outputs.push(
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Sure — ' } }
      })
    )
    h.outputs.push(
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'one bracket coming up.' } }
      })
    )
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))

    await vi.waitFor(async () => expect(await h.store.getChatHistory()).toHaveLength(2))
    const history = await h.store.getChatHistory()
    expect(history[1]).toMatchObject({ role: 'assistant', text: 'Sure — one bracket coming up.' })
  })

  it('does not persist an empty assistant message when a turn produces no text', async () => {
    const h = makeHarness()
    await h.session.sendMessage('hello')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))

    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))
    expect(await h.store.getChatHistory()).toHaveLength(1) // just the user message
  })

  it('persists partial assistant text via the interrupt() dead-subprocess fallback path', async () => {
    const h = makeHarness({
      onInterrupt: () => {
        throw new Error('subprocess already exited')
      }
    })
    await h.session.sendMessage('design a bracket')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))

    h.outputs.push(
      msg({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial reply' } }
      })
    )
    // Wait for the delta to actually reach the consume() loop (and thus assistantBuffer)
    // before interrupting, not just for the user message that was persisted synchronously.
    await vi.waitFor(() => expect(h.events.some((e) => e.type === 'text-delta')).toBe(true))

    await h.session.interrupt() // rejects (onInterrupt throws), taking the dead-subprocess fallback

    await vi.waitFor(async () => expect(await h.store.getChatHistory()).toHaveLength(2))
    const history = await h.store.getChatHistory()
    expect(history[1]).toMatchObject({ role: 'assistant', text: 'Partial reply' })
  })
})

// ---------------------------------------------------------------------------
// AgentSession project switching (R3)
// ---------------------------------------------------------------------------

describe('AgentSession project switching', () => {
  it('restarts the query with the new project cwd/resume id, and switching back resumes correctly', async () => {
    const h = makeHarness()

    await h.session.sendMessage('first')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    h.outputs.push(msg({ type: 'system', subtype: 'init', session_id: 'sess-a' }))
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))
    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))
    await vi.waitFor(async () => expect(await h.store.getSessionId()).toBe('sess-a'))

    const firstProjectId = h.store.getActiveProjectId()
    const firstProjectDir = h.store.getProjectDir()
    await h.store.createProject('Second')
    const secondProjectDir = h.store.getProjectDir()
    expect(secondProjectDir).not.toBe(firstProjectDir)

    await h.session.sendMessage('second project, first message')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(2))
    expect(h.optionsHistory).toHaveLength(2)
    expect(h.optionsHistory[1]?.cwd).toBe(secondProjectDir)
    expect(h.optionsHistory[1]?.resume).toBeUndefined() // the new project has no session of its own yet
    h.outputs.push(msg({ type: 'result', subtype: 'success', is_error: false }))
    await vi.waitFor(() => expect(h.session.isBusy()).toBe(false))

    await h.store.switchProject(firstProjectId)
    await h.session.sendMessage('back to the first project')
    await vi.waitFor(() => expect(h.inputs).toHaveLength(3))
    expect(h.optionsHistory).toHaveLength(3)
    expect(h.optionsHistory[2]?.cwd).toBe(firstProjectDir)
    expect(h.optionsHistory[2]?.resume).toBe('sess-a')
  })

  it('does not let a failed resume on one project suppress a valid resume on another after switching back', async () => {
    const store = new ProjectStore({
      baseDir: join(scratch, 'projects'),
      skillSourceDir: join(scratch, 'skill-src'),
      verifyScriptPath: join(scratch, 'validate_stl.py')
    })
    const events: AgentEvent[] = []
    const optionsHistory: Options[] = []
    const succeedingOutputs: PushStream<SDKMessage>[] = []
    let calls = 0

    const queryFn: QueryFn = ({ prompt, options }) => {
      if (!options) throw new Error('queryFn was called without options')
      calls += 1
      optionsHistory.push(options)
      void (async () => {
        for await (const _m of prompt) {
          /* drain - not asserted in this test */
        }
      })()
      if (calls === 2) {
        // The second project's resume attempt: reject before any message arrives - exactly
        // the stale/foreign-resume-id failure `skipResumeOnRestart` exists to recover from.
        const iterable: AsyncIterable<SDKMessage> = {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('resume failed')) })
        }
        return { ...iterable, interrupt: vi.fn() } as unknown as Query
      }
      const outputs = new PushStream<SDKMessage>()
      succeedingOutputs.push(outputs)
      const iterable: AsyncIterable<SDKMessage> = { [Symbol.asyncIterator]: () => outputs[Symbol.asyncIterator]() }
      return { ...iterable, interrupt: vi.fn() } as unknown as Query
    }

    const session = new AgentSession({
      projectStore: store,
      pythonPath: () => join(scratch, 'venv', 'bin', 'python'),
      claudeCliPath: () => null,
      emitAgentEvent: (e) => events.push(e),
      emitModelDisplayed: () => {},
      emitPrintSettings: () => {},
      queryFn,
      env: { PATH: '/usr/bin' },
      requestUserApproval: async () => {
        throw new Error('requestUserApproval was called unexpectedly')
      }
    })

    // Project A: complete one turn normally so it has its own valid, persisted session id.
    await session.sendMessage('hello from A')
    await vi.waitFor(() => expect(succeedingOutputs).toHaveLength(1))
    succeedingOutputs[0].push(msg({ type: 'system', subtype: 'init', session_id: 'sess-a' }))
    succeedingOutputs[0].push(msg({ type: 'result', subtype: 'success', is_error: false }))
    await vi.waitFor(() => expect(session.isBusy()).toBe(false))
    await vi.waitFor(async () => expect(await store.getSessionId()).toBe('sess-a'))
    const projectAId = store.getActiveProjectId()

    // Switch to a new project B carrying a (stale/foreign) session id, so B's first message
    // attempts - and fails - a resume.
    await store.createProject('B')
    await store.setSessionId('sess-b-stale')
    await session.sendMessage('hello from B')
    await vi.waitFor(() => expect(session.isBusy()).toBe(false))
    expect(events.some((e) => e.type === 'error' && e.message.toLowerCase().includes('resume'))).toBe(true)

    // Switch back to A - its own resume must still be attempted, not suppressed by B's
    // unrelated, just-failed resume (this is the bug the projectChanged reset guards against).
    await store.switchProject(projectAId)
    await session.sendMessage('back to A')
    await vi.waitFor(() => expect(optionsHistory).toHaveLength(3))
    expect(optionsHistory[2]?.resume).toBe('sess-a')
  })
})

// ---------------------------------------------------------------------------
// AgentSession busy-flag race (sendMessage vs. a concurrent isBusy() check)
// ---------------------------------------------------------------------------

describe('AgentSession busy-flag race', () => {
  it('marks the session busy synchronously, before ensureStarted() resolves', async () => {
    const h = makeHarness()
    const pending = h.session.sendMessage('hello')
    // Deliberately not awaited yet: sendMessage has only run synchronously up to its first
    // `await` (real filesystem I/O inside ensureStarted), so this checks the fix directly -
    // busy must already be true here, not just after the whole call settles.
    expect(h.session.isBusy()).toBe(true)
    await pending
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
  })

  it('resets busy if ensureStarted() fails, so the session is not permanently stuck', async () => {
    const brokenStore = new ProjectStore({
      baseDir: join(scratch, 'projects'),
      skillSourceDir: join(scratch, 'does-not-exist'),
      verifyScriptPath: join(scratch, 'validate_stl.py')
    })
    const h = makeHarness({ store: brokenStore })

    const response = await h.session.sendMessage('hello')
    expect(response.accepted).toBe(false)
    expect(h.session.isBusy()).toBe(false)

    // Fixing the underlying problem lets a later attempt succeed - proof busy didn't latch.
    await mkdir(join(scratch, 'does-not-exist'), { recursive: true })
    await writeFile(join(scratch, 'does-not-exist', 'SKILL.md'), '# fake skill')
    const retry = await h.session.sendMessage('hello again')
    expect(retry.accepted).toBe(true)
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

  it('denies AskUserQuestion without prompting the user (would otherwise hang the turn)', async () => {
    const approvalCalls: unknown[] = []
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
      'AskUserQuestion',
      { questions: [{ question: 'Which?', header: 'X', options: [] }] },
      { signal: controller.signal, toolUseID: 'tu-q', requestId: 'sdk-req-q' }
    )

    // Denied outright, no approval card, and the message steers Claude to prose.
    expect(expectDenied(result).message).toContain('plain text')
    expect(approvalCalls).toHaveLength(0)
    expect(h.events.some((e) => e.type === 'tool-activity' && e.detail.includes('Waiting for your approval'))).toBe(
      false
    )
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
