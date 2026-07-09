import { randomUUID } from 'node:crypto'
import { delimiter, dirname } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentEvent,
  AgentModel,
  AgentSettings,
  ChatAttachment,
  DesignBrief,
  ModelDisplayedPayload,
  PrintSettings,
  SelectionSummary,
  SendMessageResponse
} from '@shared/ipc'
import type { ProjectStore } from '../projects/store'
import { BriefStore } from '../../brief/store'
import { createVoyagerMcpServer } from '../../tools'
import type { VoyagerMcpEmission } from '../../tools'
import { decideToolPermission } from './permissions'
import { buildUserMessage, formatRevertContext, systemPromptAppend } from './prompts'

/** Denial message returned to Claude on a declined/timed-out/aborted approval request - steers it
 *  toward the always-allowed path (./outputs/ inside the project dir) instead of retrying blindly. */
const DECLINED_MESSAGE =
  'The user declined this action. Save files under ./outputs/ inside the project directory instead.'

/** How long an inline approval card waits for a user response before auto-denying. Overridable via
 *  `AgentSessionDeps.approvalTimeoutMs` so tests don't need to wait 2 minutes for the timeout path. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

/** Models whose API rejects the `effort` option outright (400) - omitted from `query()`'s
 *  options for these regardless of the user's effort choice. */
const EFFORT_UNSUPPORTED_MODELS = new Set<AgentModel>(['claude-haiku-4-5'])

/**
 * Races the injected approval promise against a timeout and the SDK's abort
 * signal. Resolves `false` (deny) on timeout or abort instead of rejecting,
 * so `canUseTool` never has to deal with (or propagate) a thrown error here.
 */
function raceApproval(approval: Promise<boolean>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolveRace) => {
    let settled = false
    const timer = setTimeout(() => settle(false), timeoutMs)

    function cleanup(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }

    function settle(value: boolean): void {
      if (settled) return
      settled = true
      cleanup()
      resolveRace(value)
    }

    function onAbort(): void {
      settle(false)
    }

    if (signal.aborted) {
      settle(false)
      return
    }
    signal.addEventListener('abort', onAbort)

    approval.then(
      (value) => settle(value === true),
      () => settle(false)
    )
  })
}

/**
 * Owns the single Claude Agent SDK session behind Voyager's chat.
 *
 * Design notes:
 * - The session runs in streaming-input mode (`prompt` is an AsyncIterable
 *   we push user turns into), so one long-lived Claude Code subprocess
 *   carries the whole multi-turn conversation - clarifying questions,
 *   design-contract confirmation, refinements - with full context.
 * - Exactly one turn is in flight at a time: `sendMessage` while Claude is
 *   working returns `accepted: false` and the renderer shows the reason.
 *   (Queueing instead would surprise users mid-clarification.)
 * - No `electron` imports; everything environment-shaped is injected so the
 *   class is unit-testable under plain vitest (see `queryFn`).
 */

/** Narrow view of the query() entrypoint, injectable for tests. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query

export interface AgentSessionDeps {
  projectStore: ProjectStore
  /** Design Brief store (WS-A) - defaults to a fresh `new BriefStore()` when omitted, which is
   *  perfectly usable (its methods take the project directory per call, so it carries no
   *  project-specific state to lose). Injectable mainly so a single instance can be shared with
   *  `src/main/ipc.ts`'s `brief:*` IPC handlers. */
  briefStore?: BriefStore
  /** Absolute path to the managed venv's python (EnvManager.pythonPath). */
  pythonPath: () => string
  /** Resolved Claude CLI path from preflight, if any (ClaudeChecker.cliPath). */
  claudeCliPath: () => string | null
  emitAgentEvent: (event: AgentEvent) => void
  emitModelDisplayed: (payload: ModelDisplayedPayload) => void
  emitPrintSettings: (payload: PrintSettings) => void
  /** Pushed whenever the `update_brief` MCP tool changes the brief - optional so existing test
   *  harnesses that never exercise that tool don't need to wire one up. */
  emitBriefUpdated?: (payload: DesignBrief) => void
  /**
   * Surfaces an out-of-policy tool call to the user (an inline Allow/Deny
   * card in the chat) and resolves with their decision. Backed by an IPC
   * round-trip in production (see ipc.ts's `askUser`); never expected to
   * throw - `canUseTool` treats a rejection the same as an explicit `false`.
   */
  requestUserApproval: (request: { requestId: string; toolName: string; summary: string }) => Promise<boolean>
  queryFn?: QueryFn
  env?: Record<string, string | undefined>
  /** Overrides the 120s default approval timeout - primarily for tests. */
  approvalTimeoutMs?: number
}

/** Unbounded push queue exposed as an AsyncIterable - the SDK session's stdin. */
class AsyncPushQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(item: T): void {
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ value: item, done: false })
    else this.buffer.push(item)
  }

  end(): void {
    this.ended = true
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      }
    }
  }
}

/** What `translateSdkMessage` reports back to the session's consume loop. */
export interface Translation {
  events: AgentEvent[]
  sessionId?: string
  turnComplete?: boolean
}

/** Structured description of a tool_use block for the chat activity stream. */
export interface ToolActivity {
  /** Concise one-liner shown in normal mode. */
  detail: string
  /** True for bookkeeping tools that are emitted but hidden unless "full stream" is on. */
  routine: boolean
  /** Truncated, stringified tool input — shown only in "full stream" mode. */
  args?: string
}

/** Stringified tool input, clamped so a single activity payload stays small. Returns `undefined`
 *  for empty input so callers can omit the field entirely. */
export function truncateArgs(input: Record<string, unknown>, max = 500): string | undefined {
  if (!input || Object.keys(input).length === 0) return undefined
  let json: string
  try {
    json = JSON.stringify(input)
  } catch {
    return undefined // circular / non-serializable input - nothing useful to show
  }
  return json.length > max ? `${json.slice(0, max)}…` : json
}

/**
 * Human-readable description of a tool_use block, shown as chat activity.
 * Returns `null` only for tools that should never produce a line (their own
 * handler emits better text); `routine: true` marks lines hidden unless the
 * user has turned on the "full stream" toggle.
 */
export function humanizeToolUse(name: string, input: Record<string, unknown>): ToolActivity | null {
  const str = (key: string): string | null => (typeof input[key] === 'string' ? (input[key] as string) : null)
  const base = (path: string): string => path.split('/').pop() ?? path
  const activity = (detail: string, routine = false): ToolActivity => ({
    detail,
    routine,
    args: truncateArgs(input)
  })

  switch (name) {
    case 'Bash': {
      const description = str('description')
      if (description) return activity(description)
      const command = str('command')
      return activity(
        command ? `Running: ${command.length > 60 ? `${command.slice(0, 60)}…` : command}` : 'Running a command'
      )
    }
    case 'Write': {
      const file = str('file_path')
      return activity(file ? `Writing ${base(file)}` : 'Writing a file')
    }
    case 'Edit': {
      const file = str('file_path')
      return activity(file ? `Editing ${base(file)}` : 'Editing a file')
    }
    case 'Read': {
      const file = str('file_path')
      return activity(file ? `Reading ${base(file)}` : 'Reading a file')
    }
    case 'Skill': {
      const skill = str('skill')
      return activity(skill ? `Using the ${skill} skill` : 'Loading a skill')
    }
    case 'Glob':
    case 'Grep':
      return activity('Searching project files')
    case 'TodoWrite':
      return activity('Updating its task list', true) // bookkeeping - hidden unless full stream
    case 'mcp__voyager__display_model':
      return activity('Displaying the model in the viewport')
    case 'mcp__voyager__recommend_print_settings':
      return activity('Recommending print settings')
    case 'mcp__voyager__set_status':
      return null // the tool handler itself emits the (better) status text
    case 'mcp__voyager__update_brief':
      return activity('Updating the design brief')
    case 'AskUserQuestion':
      // Denied by policy (see decideToolPermission); Claude re-asks in prose,
      // so a "Using AskUserQuestion" line would just be confusing noise.
      return null
    default:
      return activity(`Using ${name}`)
  }
}

/**
 * Pure translation from one SDK message to Voyager's `agent:event` stream.
 * Kept side-effect-free so tests can feed synthetic SDK messages through it
 * and assert on the emitted sequence.
 */
export function translateSdkMessage(
  message: SDKMessage,
  messageId: string,
  interruptRequested = false
): Translation {
  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init') {
        return { events: [], sessionId: message.session_id }
      }
      return { events: [] }
    }

    case 'stream_event': {
      const event = message.event
      if (event.type === 'content_block_delta') {
        // Deltas from subagent/tool-nested contexts would duplicate top-level
        // text; only surface top-level assistant prose (and thinking).
        if (message.parent_tool_use_id === null) {
          if (event.delta.type === 'text_delta') {
            return { events: [{ type: 'text-delta', messageId, delta: event.delta.text }] }
          }
          if (event.delta.type === 'thinking_delta') {
            return { events: [{ type: 'thinking-delta', messageId, delta: event.delta.thinking }] }
          }
        }
      }
      return { events: [] }
    }

    case 'assistant': {
      const events: AgentEvent[] = []
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          const activity = humanizeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>)
          if (activity) {
            events.push({
              type: 'tool-activity',
              messageId,
              toolName: block.name,
              detail: activity.detail,
              routine: activity.routine,
              args: activity.args
            })
          }
        }
      }
      return { events }
    }

    case 'result': {
      // The SDK's typed result-subtype union (SDKResultSuccess | SDKResultError)
      // doesn't include 'interrupt', but a real CLI reports it at runtime when
      // Query.interrupt() cuts a turn short - detect it defensively via a
      // string compare rather than trusting the type. `interruptRequested` is
      // the belt-and-suspenders fallback for CLI builds/versions that instead
      // report an ordinary error subtype after an interrupt.
      if ((message.subtype as string) === 'interrupt' || interruptRequested) {
        return { events: [{ type: 'stopped', messageId }], turnComplete: true }
      }
      const events: AgentEvent[] = []
      if (message.subtype !== 'success') {
        events.push({
          type: 'error',
          messageId,
          message: `Voyager stopped unexpectedly (${message.subtype.replaceAll('_', ' ')}). Send your message again to continue.`
        })
      }
      events.push({ type: 'message-complete', messageId })
      return { events, turnComplete: true }
    }

    default:
      return { events: [] }
  }
}

export class AgentSession {
  private readonly deps: AgentSessionDeps
  private readonly queryFn: QueryFn
  private readonly briefStore: BriefStore

  private queue: AsyncPushQueue<SDKUserMessage> | null = null
  private activeQuery: Query | null = null
  private busy = false
  /** Set by `interrupt()` for the duration of the turn it cut short; passed into
   *  `translateSdkMessage` so a result that arrives as an ordinary error subtype
   *  (rather than the SDK's runtime-only `'interrupt'` subtype) still resolves to
   *  a `stopped` event, not an `error`. Cleared wherever a turn ends. */
  private interruptRequested = false
  private turn = 0
  private currentMessageId = 'turn-0'
  private sessionId: string | null = null
  private receivedAnyMessage = false
  private skipResumeOnRestart = false
  private approvalSeq = 0
  /** Set once `ensureStarted` resolves the project dir; read by `canUseTool`, and compared
   *  against the project's live dir on each `ensureStarted` call to detect a project switch. */
  private projectDir = ''
  /** The model/effort combination baked into the currently-running query, if any - compared
   *  against the project's live settings on each `ensureStarted` call to detect a change. */
  private appliedSettings: AgentSettings | null = null
  /** Accumulates the current turn's assistant text so it can be persisted as one durable
   *  message on the turn's terminal event - see `flushAssistantBuffer`. */
  private assistantBuffer = ''

  constructor(deps: AgentSessionDeps) {
    this.deps = deps
    this.queryFn = deps.queryFn ?? (query as QueryFn)
    this.briefStore = deps.briefStore ?? new BriefStore()
  }

  /**
   * The SDK's single permission authority (wired into `query()`'s options in
   * `ensureStarted`). Declared as a bound arrow property (rather than a
   * prototype method) so it can be handed to the SDK as a plain value
   * (`options.canUseTool = this.canUseTool`) without losing its `this`.
   *
   * Policy allows resolve immediately with no user involvement; anything
   * `decideToolPermission` flags asks the user (via `deps.requestUserApproval`,
   * an IPC round-trip in production) and races that against a timeout and the
   * SDK's own abort signal. Never throws - any unexpected failure denies with
   * the same steer-toward-outputs message a normal decline gets, so a bug
   * here degrades to "Claude tries something else" rather than a stalled turn.
   */
  private canUseTool: CanUseTool = async (toolName, input, { signal }): Promise<PermissionResult> => {
    try {
      const decision = decideToolPermission(toolName, input, this.projectDir)
      // `updatedInput` is optional in the SDK's PermissionResult type but the
      // CLI's control-protocol schema REQUIRES it on the allow arm (verified
      // against a live session: omitting it fails Zod validation with
      // "expected record at updatedInput" and the tool call errors). Always
      // echo the input back.
      if (decision.kind === 'allow') return { behavior: 'allow', updatedInput: input }

      // Denied outright (e.g. AskUserQuestion) - block without an approval card;
      // the message steers Claude toward a supported path instead of stalling.
      if (decision.kind === 'deny') return { behavior: 'deny', message: decision.message }

      this.approvalSeq += 1
      const requestId = `perm-${this.turn}-${this.approvalSeq}`

      this.deps.emitAgentEvent({
        type: 'tool-activity',
        messageId: this.currentMessageId,
        toolName,
        detail: `Waiting for your approval: ${decision.summary}`
      })

      const timeoutMs = this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
      const approved = await raceApproval(
        this.deps.requestUserApproval({ requestId, toolName, summary: decision.summary }),
        timeoutMs,
        signal
      )

      if (approved) return { behavior: 'allow', updatedInput: input }
      return { behavior: 'deny', message: DECLINED_MESSAGE }
    } catch {
      return { behavior: 'deny', message: DECLINED_MESSAGE }
    }
  }

  isBusy(): boolean {
    return this.busy
  }

  /**
   * Accepts one user turn. Returns `accepted: false` (with a reason the
   * renderer displays) instead of throwing for all expected refusals.
   */
  async sendMessage(
    text: string,
    selectionContext?: SelectionSummary | null,
    attachments?: ChatAttachment[]
  ): Promise<SendMessageResponse> {
    if (this.busy) {
      return {
        accepted: false,
        reason: 'Voyager is still working on your previous request — wait for it to finish.'
      }
    }
    // Set eagerly, before the `await` below yields control - otherwise a concurrent call
    // (another sendMessage, or a project switch/create) landing while ensureStarted() is
    // in flight would see the stale pre-await `busy === false`. Reset in the catch arm below
    // if starting the session actually fails.
    this.busy = true

    try {
      await this.ensureStarted()
    } catch (err) {
      this.busy = false
      return {
        accepted: false,
        reason: `Could not start the Voyager session: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    this.turn += 1
    this.currentMessageId = `turn-${this.turn}`

    void this.deps.projectStore
      .appendMessage({
        id: randomUUID(),
        role: 'user',
        text,
        attachments: attachments?.map(({ name, mediaType }) => ({ name, mediaType })),
        createdAt: new Date().toISOString()
      })
      .catch(() => {})

    // If the user is sitting on a reverted (older) version - active pointer behind the latest
    // recorded iteration - inject a "Reverted model" block so the agent branches from that
    // version's snapshotted script rather than the later versions it produced. Stateless: once the
    // agent regenerates, `recordIteration` sets activeIteration == latest and this stops injecting.
    const [active, latest] = await Promise.all([
      this.deps.projectStore.activeIterationRecord(),
      this.deps.projectStore.latestIteration()
    ])
    const revertContext =
      active && latest && active.n < latest.n ? formatRevertContext(active, latest.n) : null

    this.queue?.push({
      type: 'user',
      message: {
        role: 'user',
        content: buildUserMessage(text, selectionContext, attachments, revertContext)
      },
      parent_tool_use_id: null
    })

    return { accepted: true }
  }

  /** Ends the session's input stream (app quit). */
  dispose(): void {
    this.queue?.end()
    this.queue = null
    this.activeQuery = null
  }

  /**
   * Cuts the in-flight turn short (the renderer's "stop" affordance). Exactly
   * one terminal event fires per turn - `message-complete` | `error` |
   * `stopped` - and interrupting must land on `stopped` without tearing the
   * session down: unlike `dispose()`, the queue and subprocess stay alive so
   * the next `sendMessage` continues the same conversation.
   *
   * A no-op when there's no turn to interrupt. Never throws: if the
   * subprocess has already died, `activeQuery.interrupt()` rejects and we
   * fall back to resetting the session ourselves and emitting `stopped`
   * directly, so the renderer can never be left stuck showing "busy" with no
   * way out.
   *
   * Does not clear `busy` on the success path - that happens exactly once,
   * in `consume()`'s normal turn-complete handling, when the interrupted
   * turn's result message comes through.
   */
  async interrupt(): Promise<void> {
    if (!this.busy || !this.activeQuery) return

    this.interruptRequested = true
    try {
      await this.activeQuery.interrupt()
    } catch {
      // The subprocess is already gone, so consume()'s loop (and its turnComplete flush)
      // will never run for this turn - flush here instead or any partial reply is lost.
      this.flushAssistantBuffer()
      this.resetAfterExit()
      this.deps.emitAgentEvent({ type: 'stopped', messageId: this.currentMessageId })
    }
  }

  // -- internal -------------------------------------------------------------

  private async ensureStarted(): Promise<void> {
    const { dir } = await this.deps.projectStore.ensureProject()
    const projectChanged = dir !== this.projectDir
    this.projectDir = dir
    const settings = await this.deps.projectStore.getAgentSettings()

    if (projectChanged) {
      // Both are scoped to whatever project was previously active - carrying either into a
      // different project would try to resume the wrong session, or (skipResumeOnRestart)
      // wrongly suppress a perfectly valid resume for the newly-active one. This must run
      // whenever the project changed, NOT only when there's a live `activeQuery` to tear down
      // below - a project switch immediately after the previous project's query already died
      // on its own (e.g. a failed resume) reaches here with `activeQuery` already null, and
      // `skipResumeOnRestart` would otherwise leak from that failure into the new project.
      this.sessionId = null
      this.skipResumeOnRestart = false
    }

    if (this.activeQuery) {
      const unchanged =
        !projectChanged &&
        this.appliedSettings?.model === settings.model &&
        this.appliedSettings?.effort === settings.effort
      if (unchanged) return
      // The active project switched, or the user picked a different model/effort, since this
      // query started - end the input stream so the subprocess exits cleanly, then fall
      // through to start a fresh one below. `sendMessage` only reaches `ensureStarted` while
      // idle, so this never cuts an in-flight turn short.
      this.queue?.end()
      this.queue = null
      this.activeQuery = null
    }

    let resume: string | undefined
    if (!this.skipResumeOnRestart) {
      resume = (await this.deps.projectStore.getSessionId()) ?? undefined
    }

    const venvBin = dirname(this.deps.pythonPath())
    const baseEnv = this.deps.env ?? process.env
    const cliPath = this.deps.claudeCliPath()

    const options: Options = {
      cwd: dir,
      settingSources: ['project'],
      strictMcpConfig: true,
      mcpServers: {
        voyager: createVoyagerMcpServer({
          projectStore: this.deps.projectStore,
          briefStore: this.briefStore,
          emit: (emission) => this.handleEmission(emission)
        })
      },
      // No `permissionMode` here: the default mode plus `canUseTool` below is
      // the single permission authority. `allowedTools` is intentionally
      // trimmed to the tools that are *always* safe to auto-run - bare
      // Write/Edit/Bash entries here would short-circuit before
      // `canUseTool` ever runs and defeat the scoped write policy.
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'Skill',
        'TodoWrite',
        'mcp__voyager__display_model',
        'mcp__voyager__recommend_print_settings',
        'mcp__voyager__set_status',
        'mcp__voyager__update_brief'
      ],
      canUseTool: this.canUseTool,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend(dir) },
      includePartialMessages: true,
      // Enable adaptive thinking with visible summaries so the renderer receives thinking_delta
      // stream events (off by default on Opus 4.7/4.8; display defaults to "omitted" = empty text).
      thinking: { type: 'adaptive', display: 'summarized' },
      model: settings.model,
      // Effort defaults to xhigh (adaptive thinking otherwise defaults to "high") so thinking
      // runs deeper on essentially every substantive turn - the user can trade that away for
      // speed via the model/effort selectors. Haiku's API 400s on `effort` entirely, so it's
      // omitted rather than sent for a model that rejects it.
      ...(EFFORT_UNSUPPORTED_MODELS.has(settings.model) ? {} : { effort: settings.effort }),
      env: { ...baseEnv, PATH: `${venvBin}${delimiter}${baseEnv.PATH ?? ''}` },
      ...(resume ? { resume } : {}),
      ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {})
    }

    this.queue = new AsyncPushQueue<SDKUserMessage>()
    this.receivedAnyMessage = false
    this.appliedSettings = settings
    this.activeQuery = this.queryFn({ prompt: this.queue, options })
    void this.consume(this.activeQuery, resume !== undefined)
  }

  private async consume(activeQuery: Query, resumed: boolean): Promise<void> {
    try {
      for await (const message of activeQuery) {
        this.receivedAnyMessage = true
        const translation = translateSdkMessage(message, this.currentMessageId, this.interruptRequested)

        if (translation.sessionId && translation.sessionId !== this.sessionId) {
          this.sessionId = translation.sessionId
          void this.deps.projectStore.setSessionId(translation.sessionId).catch(() => {})
        }

        for (const event of translation.events) {
          if (event.type === 'text-delta') this.assistantBuffer += event.delta
          this.deps.emitAgentEvent(event)
        }

        if (translation.turnComplete) {
          this.flushAssistantBuffer()
          this.busy = false
          this.interruptRequested = false
        }
      }
      // Input stream ended (dispose) or the subprocess exited cleanly.
      this.resetAfterExit()
    } catch (err) {
      const failedBeforeAnyMessage = !this.receivedAnyMessage
      this.resetAfterExit()

      if (resumed && failedBeforeAnyMessage) {
        // A stale/foreign session id is the usual cause of an immediate
        // failure on resume - drop it so the next message starts fresh.
        this.skipResumeOnRestart = true
        this.deps.emitAgentEvent({
          type: 'error',
          message: 'Could not resume the previous session — a fresh one will start with your next message.'
        })
        return
      }

      this.deps.emitAgentEvent({
        type: 'error',
        messageId: this.currentMessageId,
        message: `Voyager session error: ${err instanceof Error ? err.message : String(err)}. Send your message again to restart.`
      })
    }
  }

  private resetAfterExit(): void {
    this.queue?.end()
    this.queue = null
    this.activeQuery = null
    this.busy = false
    this.interruptRequested = false
  }

  /** Persists the turn's accumulated assistant text as one durable message, if any was
   *  produced. Self-clearing, so it's safe to call from both the normal turn-complete path
   *  (inside `consume()`'s loop) and `interrupt()`'s dead-subprocess fallback - whichever
   *  happens first wins and the other becomes a no-op. */
  private flushAssistantBuffer(): void {
    if (!this.assistantBuffer) return
    const text = this.assistantBuffer
    this.assistantBuffer = ''
    void this.deps.projectStore
      .appendMessage({ id: randomUUID(), role: 'assistant', text, createdAt: new Date().toISOString() })
      .catch(() => {})
  }

  private handleEmission(emission: VoyagerMcpEmission): void {
    switch (emission.kind) {
      case 'status':
        this.deps.emitAgentEvent({
          type: 'tool-activity',
          messageId: this.currentMessageId,
          toolName: 'set_status',
          detail: emission.detail
        })
        return
      case 'model-displayed':
        this.deps.emitModelDisplayed(emission.payload)
        return
      case 'print-settings':
        this.deps.emitPrintSettings(emission.payload)
        return
      case 'brief-updated':
        this.deps.emitBriefUpdated?.(emission.payload)
        return
    }
  }
}
