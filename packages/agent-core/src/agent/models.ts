import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { matchModelRow, supportsEffort } from '@shared/ipc'
import type { AgentEffort, AgentModel, AgentModelInfo } from '@shared/ipc'
import type { QueryFn } from './session'

/**
 * Models known to be servable but **missing from the CLI's own `supportedModels()` list**.
 *
 * `Query.supportedModels()` returns a catalog compiled into the CLI binary, so it lags the
 * serving fleet: CLI 2.1.220 lists Opus 4.8 as the newest Opus and offers no Opus 5 row, yet
 * `--model claude-opus-5` runs and the usage ledger reports `claude-opus-5` back. A picker
 * wired only to `supportedModels()` would therefore still hide the newest model - the exact
 * staleness this catalog exists to fix.
 *
 * Every entry here is verified with a probe before it reaches the picker (see `verify`), so a
 * candidate the account cannot serve is dropped rather than offered and failed at first turn.
 * Adding a future model is a one-line change here; it does NOT require a CLI update.
 */
export const CANDIDATE_MODELS: ReadonlyArray<Omit<AgentModelInfo, 'source' | 'supportsEffort'>> = [
  {
    value: 'claude-opus-5',
    resolvedModel: 'claude-opus-5',
    displayName: 'Opus 5',
    description: 'Newest Opus · Not yet listed by the CLI, verified servable',
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  }
]

/**
 * Older pinned ids, offered so a project can stay on the model that produced its recorded
 * iterations. Unlike candidates these are not probed - they are an explicit advanced choice,
 * and probing each would cost a turn per launch for rows almost nobody selects. A retired id
 * surfaces as a turn error rather than a silent fallback.
 */
export const LEGACY_MODELS: ReadonlyArray<Omit<AgentModelInfo, 'source' | 'supportsEffort'>> = [
  { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Previous Opus' },
  { value: 'claude-opus-4-7', resolvedModel: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Legacy Opus' },
  { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Legacy Sonnet' }
]

/** Models whose API rejects `effort` outright. Only consulted for rows the SDK didn't describe
 *  (candidates and legacy); catalog rows carry their own `supportsEffort`. */
const EFFORT_UNSUPPORTED = /^claude-haiku-/

/** Persisted so the probe cost is paid once per CLI build rather than once per launch. */
export interface CatalogCache {
  read: () => Promise<{ cliVersion: string; models: AgentModelInfo[] } | null>
  write: (entry: { cliVersion: string; models: AgentModelInfo[] }) => Promise<void>
}

export interface ModelCatalogDeps {
  queryFn: QueryFn
  /** Base `Options` (cwd, env, `pathToClaudeCodeExecutable`) shared with `AgentSession`, so the
   *  probe resolves the same CLI binary the real turns will use. */
  baseOptions: () => Options
  /** Invalidates the cache when the user updates the CLI, which is when its catalog changes. */
  cliVersion: () => Promise<string>
  cache?: CatalogCache
}

/** An iterable that yields nothing until closed - lets a control-plane query (`supportedModels`)
 *  stay open long enough to answer, then exit cleanly instead of being killed. */
function idlePrompt(): AsyncIterable<SDKUserMessage> & { close: () => void } {
  let release: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    close: release,
    async *[Symbol.asyncIterator]() {
      await closed
    }
  }
}

/**
 * Yields exactly one minimal user turn, then ends the stream.
 *
 * A probe MUST send a real message: with an idle prompt the CLI sits waiting for input and no
 * `result` message is ever emitted, so `verify` blocks forever rather than returning false.
 * Ending the iterable after one message is what lets the subprocess exit on its own.
 */
function oneShotPrompt(): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'user',
        message: { role: 'user', content: 'hi' },
        parent_tool_use_id: null,
        session_id: ''
      } as unknown as SDKUserMessage
    }
  }
}

function normalizeEffort(levels: unknown): AgentEffort[] | undefined {
  return Array.isArray(levels) ? (levels as AgentEffort[]) : undefined
}

/**
 * Builds the model picker's contents by merging three sources, newest-capability first:
 * verified candidates the CLI doesn't list yet, the CLI's own catalog, then legacy pins.
 *
 * De-duplication is by `value` AND `resolvedModel`, so a pinned candidate is dropped once the
 * CLI catches up and starts covering it behind an alias - `claude-opus-5` disappears from the
 * "verified" group and the `opus` alias row takes over, with no code change.
 */
export class ModelCatalog {
  private inflight: Promise<AgentModelInfo[]> | null = null

  constructor(private readonly deps: ModelCatalogDeps) {}

  /** Cached per CLI version; concurrent callers share one in-flight computation. */
  async list(): Promise<AgentModelInfo[]> {
    this.inflight ??= this.compute().catch((error) => {
      // A failed probe must not leave the picker empty - fall back to the static rows so the
      // user can still pick a model, and let the next call retry.
      this.inflight = null
      throw error
    })
    return this.inflight
  }

  private async compute(): Promise<AgentModelInfo[]> {
    const cliVersion = await this.deps.cliVersion()
    const cached = await this.deps.cache?.read()
    if (cached?.cliVersion === cliVersion && cached.models.length > 0) return cached.models

    const catalog = await this.fetchCatalog()
    const covered = new Set<string>()
    for (const row of catalog) {
      covered.add(row.value)
      if (row.resolvedModel) covered.add(row.resolvedModel)
    }

    const verified: AgentModelInfo[] = []
    for (const candidate of CANDIDATE_MODELS) {
      if (covered.has(candidate.value) || (candidate.resolvedModel && covered.has(candidate.resolvedModel))) continue
      if (!(await this.verify(candidate.value))) continue
      verified.push({ ...candidate, supportsEffort: !EFFORT_UNSUPPORTED.test(candidate.value), source: 'verified' })
      covered.add(candidate.value)
      if (candidate.resolvedModel) covered.add(candidate.resolvedModel)
    }

    // Matched on the exact `value`, deliberately NOT on the resolved wire id: the `opus` alias
    // resolves to Opus 4.8 today but will move to Opus 5 when the CLI updates, whereas the
    // `claude-opus-4-8` legacy pin never moves. Both rows are therefore meaningful at once, and
    // collapsing them by resolved id would delete the pin - the reproducibility escape hatch.
    const legacy = LEGACY_MODELS.filter((row) => !covered.has(row.value)).map(
      (row): AgentModelInfo => ({ ...row, supportsEffort: !EFFORT_UNSUPPORTED.test(row.value), source: 'legacy' })
    )

    const models = [...verified, ...catalog, ...legacy]
    await this.deps.cache?.write({ cliVersion, models })
    return models
  }

  /** The CLI's own list. Aliases here auto-track new releases, which is why they stay first-class
   *  even though they lag: `opus` will start resolving to Opus 5 on its own once the CLI updates. */
  private async fetchCatalog(): Promise<AgentModelInfo[]> {
    const prompt = idlePrompt()
    const query = this.deps.queryFn({ prompt, options: this.deps.baseOptions() })
    try {
      const rows = await query.supportedModels()
      return rows.map(
        (row): AgentModelInfo => ({
          value: row.value,
          resolvedModel: row.resolvedModel,
          displayName: row.displayName,
          description: row.description,
          supportsEffort: row.supportsEffort ?? false,
          supportedEffortLevels: normalizeEffort(row.supportedEffortLevels),
          source: 'catalog'
        })
      )
    } finally {
      prompt.close()
    }
  }

  /**
   * Confirms the account can actually run `model`, using the cheapest turn we can ask for.
   *
   * Checks two things, because they fail differently: an unknown id comes back `is_error` with
   * `duration_api_ms: 0` (rejected before any API call), while a *silent downgrade* would come
   * back successful but with a different key in `modelUsage`. Requiring the requested id to
   * appear in the usage ledger is what distinguishes "served" from "substituted".
   */
  private async verify(model: string): Promise<boolean> {
    const query = this.deps.queryFn({
      prompt: oneShotPrompt(),
      options: { ...this.deps.baseOptions(), model, maxTurns: 1 }
    })
    try {
      for await (const message of query) {
        if (message.type !== 'result') continue
        if (message.is_error) return false
        const usage = 'modelUsage' in message ? message.modelUsage : undefined
        return Boolean(usage && Object.keys(usage).some((id) => id === model || id.startsWith(`${model}[`)))
      }
      return false
    } catch {
      return false
    }
  }
}

/**
 * The row a brand-new project should start on: the first verified row if the catalog turned one
 * up (today, Opus 5 - which is how "Opus 5 takes over Opus 4.8" happens without editing a
 * default), otherwise the CLI's own recommended alias, otherwise whatever is first.
 */
export function preferredModel(rows: readonly AgentModelInfo[]): AgentModel | undefined {
  return (
    rows.find((row) => row.source === 'verified')?.value ??
    rows.find((row) => row.value === 'default')?.value ??
    rows[0]?.value
  )
}

// Re-exported so agent-core consumers get the whole model vocabulary from one place; the
// implementations live in @shared/ipc because the renderer needs them too.
export { matchModelRow, supportsEffort }
