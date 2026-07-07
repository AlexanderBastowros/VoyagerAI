import type { SetupCheck, SetupStatus } from '../../shared/ipc'
import type { EnvManager } from '../python/envManager'
import type { ClaudeChecker } from './claudeChecks'

/**
 * One entry per first-run check. `id` picks which field of `SetupStatus`
 * the check's result is written into; `run` performs the check, optionally
 * reporting intermediate progress before settling.
 *
 * All three checks are real: claudeCli / claudeAuth delegate to
 * `ClaudeChecker` (CLI discovery + `claude auth status`), pythonEnv to
 * `EnvManager`.
 */
export interface PreflightCheck {
  id: keyof SetupStatus
  run: (onProgress: (check: SetupCheck) => void) => Promise<SetupCheck>
}

export interface PreflightDeps {
  envManager: Pick<EnvManager, 'ensureReady'>
  claude: Pick<ClaudeChecker, 'checkCli' | 'checkAuth'>
}

const UNCHECKED: SetupCheck = { state: 'unchecked', detail: 'Not checked yet' }

/**
 * Builds the ordered list of first-run checks. This order is also the order
 * `runPreflight` executes them in and the order SetupScreen renders its
 * checklist rows in. claudeCli must run before claudeAuth (the auth probe
 * uses the CLI path the first check resolved).
 */
export function createPreflightChecks(deps: PreflightDeps): PreflightCheck[] {
  return [
    {
      id: 'claudeCli',
      run: async (onProgress) => {
        onProgress({ state: 'in_progress', detail: 'Locating the Claude Code CLI…' })
        return deps.claude.checkCli()
      }
    },
    {
      id: 'claudeAuth',
      run: async (onProgress) => {
        onProgress({ state: 'in_progress', detail: 'Checking Claude sign-in…' })
        return deps.claude.checkAuth()
      }
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
