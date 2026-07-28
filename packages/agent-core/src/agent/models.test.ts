import { describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentModelInfo } from '@shared/ipc'
import { CANDIDATE_MODELS, ModelCatalog, matchModelRow, supportsEffort } from './models'
import type { CatalogCache } from './models'

/** The five rows CLI 2.1.220 actually returns - note it has no Opus 5 row, which is the whole
 *  reason `CANDIDATE_MODELS` exists. */
const CLI_ROWS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-4-8[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 4.8 with 1M context',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    description: 'Sonnet 5',
    supportsEffort: true
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5' }
]

interface StubOptions {
  /** Models the fake CLI will serve. Anything else comes back `is_error`. */
  servable?: string[]
  /** Model id reported in `modelUsage`, to simulate a silent downgrade. */
  reportAs?: (requested: string) => string
}

function stubQueryFn(stub: StubOptions = {}) {
  const servable = new Set(stub.servable ?? ['claude-opus-5'])
  const seen: string[] = []
  const queryFn = vi.fn((params: { prompt: AsyncIterable<unknown>; options?: Options }): Query => {
    const model = params.options?.model
    if (model) seen.push(model)
    const ok = model !== undefined && servable.has(model)
    const reported = stub.reportAs?.(model ?? '') ?? model
    const messages: SDKMessage[] = [
      {
        type: 'result',
        subtype: 'success',
        is_error: !ok,
        modelUsage: ok ? { [reported as string]: {} } : {}
      } as unknown as SDKMessage
    ]
    return {
      supportedModels: async () => CLI_ROWS,
      async *[Symbol.asyncIterator]() {
        yield* messages
      }
    } as unknown as Query
  })
  return { queryFn, seen }
}

function makeCatalog(stub: StubOptions = {}, cache?: CatalogCache) {
  const { queryFn, seen } = stubQueryFn(stub)
  const catalog = new ModelCatalog({
    queryFn,
    baseOptions: () => ({}) as Options,
    cliVersion: async () => '2.1.220',
    cache
  })
  return { catalog, queryFn, seen }
}

describe('ModelCatalog', () => {
  it('surfaces a servable model the CLI does not list', async () => {
    const { catalog } = makeCatalog()
    const models = await catalog.list()

    const opus5 = models.find((m) => m.value === 'claude-opus-5')
    expect(opus5).toBeDefined()
    expect(opus5?.source).toBe('verified')
    // Ahead of the CLI's own rows, so the newest model is the first thing the user sees.
    expect(models[0]?.value).toBe('claude-opus-5')
  })

  it('drops a candidate the account cannot serve rather than offering a broken row', async () => {
    const { catalog } = makeCatalog({ servable: [] })
    const models = await catalog.list()

    expect(models.some((m) => m.value === 'claude-opus-5')).toBe(false)
    expect(models.some((m) => m.source === 'catalog')).toBe(true)
  })

  it('rejects a candidate that is silently downgraded to another model', async () => {
    // `is_error` is false but the usage ledger names a different model - the case a naive
    // "did the turn succeed?" check would wave through.
    const { catalog } = makeCatalog({ reportAs: () => 'claude-opus-4-8' })
    const models = await catalog.list()

    expect(models.some((m) => m.value === 'claude-opus-5')).toBe(false)
  })

  it('stops offering a pinned candidate once the CLI catalog covers it', async () => {
    const { queryFn } = stubQueryFn()
    const withOpus5 = [...CLI_ROWS, { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: '' }]
    const catalog = new ModelCatalog({
      queryFn: vi.fn(
        () =>
          ({
            supportedModels: async () => withOpus5,
            async *[Symbol.asyncIterator]() {}
          }) as unknown as Query
      ),
      baseOptions: () => ({}) as Options,
      cliVersion: async () => '9.9.9'
    })
    const models = await catalog.list()

    expect(models.filter((m) => m.resolvedModel === 'claude-opus-5')).toHaveLength(1)
    expect(models.find((m) => m.resolvedModel === 'claude-opus-5')?.source).toBe('catalog')
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('marks Haiku as effort-unsupported from the CLI row, not a hardcoded list', async () => {
    const { catalog } = makeCatalog()
    const models = await catalog.list()

    expect(models.find((m) => m.value === 'haiku')?.supportsEffort).toBe(false)
    expect(models.find((m) => m.value === 'sonnet')?.supportsEffort).toBe(true)
  })

  it('reuses a cache written for the same CLI version, skipping the probe', async () => {
    const stored = [{ value: 'cached', displayName: 'Cached', description: '', supportsEffort: true, source: 'catalog' as const }]
    const cache: CatalogCache = {
      read: async () => ({ cliVersion: '2.1.220', models: stored }),
      write: vi.fn(async () => {})
    }
    const { catalog, queryFn } = makeCatalog({}, cache)

    expect(await catalog.list()).toEqual(stored)
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('recomputes when the CLI version moved, because its catalog moves with it', async () => {
    const cache: CatalogCache = {
      read: async () => ({ cliVersion: '2.0.0', models: [] }),
      write: vi.fn(async () => {})
    }
    const { catalog } = makeCatalog({}, cache)
    const models = await catalog.list()

    expect(models.some((m) => m.value === 'claude-opus-5')).toBe(true)
    expect(cache.write).toHaveBeenCalledWith(expect.objectContaining({ cliVersion: '2.1.220' }))
  })

  it('keeps every candidate probed at most once across concurrent callers', async () => {
    const { catalog, seen } = makeCatalog()
    await Promise.all([catalog.list(), catalog.list(), catalog.list()])

    expect(seen.filter((m) => m === 'claude-opus-5')).toHaveLength(1)
  })
})

describe('matchModelRow', () => {
  const rows: AgentModelInfo[] = [
    {
      value: 'default',
      resolvedModel: 'claude-opus-4-8[1m]',
      displayName: 'Default',
      description: '',
      supportsEffort: true,
      source: 'catalog'
    },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '', supportsEffort: true, source: 'catalog' }
  ]

  it('matches a persisted pinned id onto the alias row that now covers it', () => {
    // The stored value predates the alias rows and carries no [1m] suffix.
    expect(matchModelRow('claude-opus-4-8', rows)?.value).toBe('default')
  })

  it('prefers an exact value match over a resolved match', () => {
    expect(matchModelRow('sonnet', rows)?.value).toBe('sonnet')
  })

  it('returns undefined for a model no longer offered, so callers can fall back', () => {
    expect(matchModelRow('claude-opus-3', rows)).toBeUndefined()
  })
})

describe('supportsEffort', () => {
  it('assumes support for an unknown model rather than silently dropping the option', () => {
    expect(supportsEffort('claude-opus-9', [])).toBe(true)
  })

  it('still recognises Haiku when the catalog is unavailable', () => {
    expect(supportsEffort('claude-haiku-4-5', [])).toBe(false)
  })
})

describe('CANDIDATE_MODELS', () => {
  it('carries no row the CLI already lists, which would double up the picker', () => {
    const cliValues = new Set(CLI_ROWS.flatMap((r) => [r.value, r.resolvedModel]))
    for (const candidate of CANDIDATE_MODELS) {
      expect(cliValues.has(candidate.value)).toBe(false)
    }
  })
})
