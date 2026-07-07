import type { SetupCheck, SetupStatus } from '../../shared/ipc'
import type { EnvManager } from '../python/envManager'

/**
 * One entry per first-run check. `id` picks which field of `SetupStatus`
 * the check's result is written into; `run` performs the check, optionally
 * reporting intermediate progress before settling.
 *
 * M2 implements `pythonEnv` for real (delegated to EnvManager). `claudeCli`
 * and `claudeAuth` are clearly-marked M3 stubs. M3 drops in real
 * implementations by replacing those two `run` functions in
 * `createPreflightChecks` below - `runPreflight` and every caller (IPC
 * wiring, tests) stay untouched.
 */
export interface PreflightCheck {
  id: keyof SetupStatus
  run: (onProgress: (check: SetupCheck) => void) => Promise<SetupCheck>
}

export interface PreflightDeps {
  envManager: Pick<EnvManager, 'ensureReady'>
}

const UNCHECKED: SetupCheck = { state: 'unchecked', detail: 'Not checked yet' }

/**
 * Builds the ordered list of first-run checks. This order is also the order
 * `runPreflight` executes them in and the order SetupScreen renders its
 * checklist rows in.
 */
export function createPreflightChecks(deps: PreflightDeps): PreflightCheck[] {
  return [
    {
      // M3 TODO: replace with a real check for the Claude CLI binary
      // (existence + version). Non-blocking stub until then, see
      // src/renderer/src/state/setupSelectors.ts.
      id: 'claudeCli',
      run: async () => ({ ...UNCHECKED, detail: 'Claude CLI check arrives in Milestone 3' })
    },
    {
      // M3 TODO: replace with a real Claude sign-in/auth check.
      id: 'claudeAuth',
      run: async () => ({ ...UNCHECKED, detail: 'Claude auth check arrives in Milestone 3' })
    },
    {
      id: 'pythonEnv',
      run: (onProgress) => deps.envManager.ensureReady(onProgress)
    }
  ]
}

/**
 * Runs every first-run check in order, streaming an incremental
 * `SetupStatus` snapshot to `onProgress` on each check's own progress
 * updates as well as when a check settles. Resolves with the final status
 * once every check has settled.
 */
export async function runPreflight(
  deps: PreflightDeps,
  onProgress: (status: SetupStatus) => void
): Promise<SetupStatus> {
  const checks = createPreflightChecks(deps)
  const status: SetupStatus = {
    claudeCli: { ...UNCHECKED },
    claudeAuth: { ...UNCHECKED },
    pythonEnv: { ...UNCHECKED }
  }

  for (const check of checks) {
    const result = await check.run((partial) => {
      status[check.id] = partial
      onProgress({ ...status })
    })
    status[check.id] = result
    onProgress({ ...status })
  }

  return status
}
