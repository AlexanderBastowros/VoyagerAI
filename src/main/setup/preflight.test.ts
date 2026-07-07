import { describe, expect, it } from 'vitest'
import { createPreflightChecks, runPreflight } from './preflight'
import type { PreflightDeps } from './preflight'
import type { SetupCheck, SetupStatus } from '../../shared/ipc'

function fakeEnvManager(result: SetupCheck, progressEvents: SetupCheck[] = []): PreflightDeps['envManager'] {
  return {
    ensureReady: async (onProgress) => {
      for (const event of progressEvents) onProgress?.(event)
      return result
    }
  }
}

function fakeClaude(
  cli: SetupCheck = { state: 'ready', detail: 'Claude Code 2.1.0' },
  auth: SetupCheck = { state: 'ready', detail: 'Signed in' },
  callOrder: string[] = []
): PreflightDeps['claude'] {
  return {
    checkCli: async () => {
      callOrder.push('claudeCli')
      return cli
    },
    checkAuth: async () => {
      callOrder.push('claudeAuth')
      return auth
    }
  }
}

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    envManager: fakeEnvManager({ state: 'ready', detail: 'ok' }),
    claude: fakeClaude(),
    ...overrides
  }
}

describe('createPreflightChecks ordering', () => {
  it('declares checks in a fixed order: claudeCli, claudeAuth, then pythonEnv', () => {
    const checks = createPreflightChecks(deps())
    expect(checks.map((c) => c.id)).toEqual(['claudeCli', 'claudeAuth', 'pythonEnv'])
  })

  it('runs checkCli before checkAuth (auth uses the CLI path resolved by the first check)', async () => {
    const callOrder: string[] = []
    await runPreflight(deps({ claude: fakeClaude(undefined, undefined, callOrder) }), () => {})
    expect(callOrder).toEqual(['claudeCli', 'claudeAuth'])
  })
})

describe('runPreflight', () => {
  it('resolves with every check settled when all pass', async () => {
    const finalStatus = await runPreflight(deps(), () => {})
    expect(finalStatus.claudeCli).toEqual({ state: 'ready', detail: 'Claude Code 2.1.0' })
    expect(finalStatus.claudeAuth).toEqual({ state: 'ready', detail: 'Signed in' })
    expect(finalStatus.pythonEnv).toEqual({ state: 'ready', detail: 'ok' })
  })

  it('streams in_progress snapshots for the claude checks before they settle', async () => {
    const snapshots: SetupStatus[] = []
    await runPreflight(deps(), (status) => snapshots.push(status))
    expect(snapshots.some((s) => s.claudeCli.state === 'in_progress')).toBe(true)
    expect(snapshots.some((s) => s.claudeAuth.state === 'in_progress')).toBe(true)
  })

  it('streams intermediate pythonEnv progress through onProgress before the final status', async () => {
    const progressSnapshots: SetupStatus[] = []
    const envManager = fakeEnvManager({ state: 'ready', detail: 'Ready' }, [
      { state: 'in_progress', detail: 'Creating virtual environment…' },
      { state: 'in_progress', detail: 'Installing packages…' }
    ])

    const finalStatus = await runPreflight(deps({ envManager }), (status) =>
      progressSnapshots.push(status)
    )

    const pythonEnvDetails = progressSnapshots.map((s) => s.pythonEnv.detail)
    expect(pythonEnvDetails).toContain('Creating virtual environment…')
    expect(pythonEnvDetails).toContain('Installing packages…')
    expect(finalStatus.pythonEnv.state).toBe('ready')
  })

  it('surfaces a claudeCli error without throwing and still runs the remaining checks', async () => {
    const finalStatus = await runPreflight(
      deps({ claude: fakeClaude({ state: 'error', detail: 'CLI not found' }) }),
      () => {}
    )
    expect(finalStatus.claudeCli.state).toBe('error')
    // Later checks still ran/settled - preflight reports everything it can.
    expect(finalStatus.pythonEnv.state).toBe('ready')
  })

  it('surfaces a pythonEnv error without throwing, leaving the other checks untouched', async () => {
    const envManager = fakeEnvManager({ state: 'error', detail: 'Install Python 3.10+ or uv, then retry.' })
    const finalStatus = await runPreflight(deps({ envManager }), () => {})

    expect(finalStatus.pythonEnv.state).toBe('error')
    expect(finalStatus.pythonEnv.detail).toBe('Install Python 3.10+ or uv, then retry.')
    expect(finalStatus.claudeCli.state).toBe('ready')
  })
})
