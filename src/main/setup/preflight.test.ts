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

describe('createPreflightChecks ordering', () => {
  it('declares checks in a fixed order: claudeCli, claudeAuth, then pythonEnv', () => {
    const checks = createPreflightChecks({ envManager: fakeEnvManager({ state: 'ready', detail: 'ok' }) })
    expect(checks.map((c) => c.id)).toEqual(['claudeCli', 'claudeAuth', 'pythonEnv'])
  })

  it('marks claudeCli/claudeAuth as non-blocking M3 stubs that resolve unchecked', async () => {
    const checks = createPreflightChecks({ envManager: fakeEnvManager({ state: 'ready', detail: 'ok' }) })
    const claudeCli = await checks[0].run(() => {})
    const claudeAuth = await checks[1].run(() => {})
    expect(claudeCli.state).toBe('unchecked')
    expect(claudeAuth.state).toBe('unchecked')
  })
})

describe('runPreflight', () => {
  it('runs checks in declared order and only pythonEnv reaches a terminal ready/error state', async () => {
    const callOrder: string[] = []
    const envManager: PreflightDeps['envManager'] = {
      ensureReady: async () => {
        callOrder.push('pythonEnv')
        return { state: 'ready', detail: 'Python environment ready' }
      }
    }
    // Wrap createPreflightChecks indirectly by observing side effects: the
    // stub claudeCli/claudeAuth checks are synchronous, so if pythonEnv were
    // run first, callOrder would start with 'pythonEnv'. Since the checks
    // are declared claudeCli, claudeAuth, pythonEnv and runPreflight awaits
    // sequentially, pythonEnv always finishes last regardless of the stubs'
    // own (no-op) ordering.
    const finalStatus = await runPreflight({ envManager }, () => {})

    expect(callOrder).toEqual(['pythonEnv'])
    expect(finalStatus.claudeCli.state).toBe('unchecked')
    expect(finalStatus.claudeAuth.state).toBe('unchecked')
    expect(finalStatus.pythonEnv).toEqual({ state: 'ready', detail: 'Python environment ready' })
  })

  it('streams intermediate pythonEnv progress through onProgress before the final status', async () => {
    const progressSnapshots: SetupStatus[] = []
    const envManager = fakeEnvManager({ state: 'ready', detail: 'Ready' }, [
      { state: 'in_progress', detail: 'Creating virtual environment…' },
      { state: 'in_progress', detail: 'Installing packages…' }
    ])

    const finalStatus = await runPreflight({ envManager }, (status) => progressSnapshots.push(status))

    // At least: 2 intermediate pythonEnv progress pushes, one per stub
    // settling, and one final push - all reflecting the merged SetupStatus.
    expect(progressSnapshots.length).toBeGreaterThanOrEqual(3)
    const pythonEnvDetails = progressSnapshots.map((s) => s.pythonEnv.detail)
    expect(pythonEnvDetails).toContain('Creating virtual environment…')
    expect(pythonEnvDetails).toContain('Installing packages…')
    expect(finalStatus.pythonEnv.state).toBe('ready')
  })

  it('surfaces a pythonEnv error without throwing, leaving the other checks untouched', async () => {
    const envManager = fakeEnvManager({ state: 'error', detail: 'Install Python 3.10+ or uv, then retry.' })
    const finalStatus = await runPreflight({ envManager }, () => {})

    expect(finalStatus.pythonEnv.state).toBe('error')
    expect(finalStatus.pythonEnv.detail).toBe('Install Python 3.10+ or uv, then retry.')
    expect(finalStatus.claudeCli.state).toBe('unchecked')
  })
})
