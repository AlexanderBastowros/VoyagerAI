import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { SetupCheck } from '@shared/ipc'

/**
 * Locates and probes the Claude Code CLI for the claudeCli / claudeAuth
 * preflight checks, and hands the resolved binary path to the agent session
 * (`pathToClaudeCodeExecutable`).
 *
 * All environment access is injectable so the resolution order is fully
 * unit-testable; `src/main/ipc.ts` constructs this with real defaults.
 */

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ClaudeCheckerOptions {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  home?: string
  /** Returns true if `path` exists and is executable. */
  isExecutable?: (path: string) => Promise<boolean>
  /** Runs a binary with args; resolves (never rejects) with exit code + output. */
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>
}

const VERSION_TIMEOUT_MS = 10_000
const AUTH_TIMEOUT_MS = 10_000
const SHELL_LOOKUP_TIMEOUT_MS = 8_000

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function defaultExec(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf-8' }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? 1) : 0
      resolvePromise({
        code: typeof code === 'number' ? code : 1,
        stdout: stdout ?? '',
        stderr: stderr ?? ''
      })
    })
  })
}

const INSTALL_HINT =
  'Claude Code CLI not found. Install it (e.g. `npm install -g @anthropic-ai/claude-code` ' +
  'or see https://claude.com/claude-code), then restart Voyager AI or press Retry.'

const LOGIN_HINT =
  'Not signed in. Run `claude` in a terminal and complete `/login` with your Claude ' +
  'subscription account (no API key needed), then press Retry.'

export class ClaudeChecker {
  private readonly env: Record<string, string | undefined>
  private readonly platform: NodeJS.Platform
  private readonly home: string
  private readonly isExecutable: (path: string) => Promise<boolean>
  private readonly exec: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>

  private resolvedCliPath: string | null = null

  constructor(options: ClaudeCheckerOptions = {}) {
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.home = options.home ?? homedir()
    this.isExecutable = options.isExecutable ?? defaultIsExecutable
    this.exec = options.exec ?? defaultExec
  }

  /** Resolved CLI path once `checkCli()` has succeeded; null before/on failure. */
  cliPath(): string | null {
    return this.resolvedCliPath
  }

  /**
   * Locates the `claude` binary and confirms it runs. Resolution order
   * matters: packaged macOS apps do not inherit the user's shell PATH, so
   * after an explicit override and a PATH walk we probe the common install
   * locations directly, and only then fall back to asking a login shell.
   */
  async checkCli(): Promise<SetupCheck> {
    const candidate = await this.locateCli()
    if (!candidate) {
      this.resolvedCliPath = null
      return { state: 'error', detail: INSTALL_HINT }
    }

    const version = await this.exec(candidate, ['--version'], VERSION_TIMEOUT_MS)
    if (version.code !== 0) {
      this.resolvedCliPath = null
      return {
        state: 'error',
        detail: `Found ${candidate} but \`--version\` failed: ${(version.stderr || version.stdout).trim().slice(0, 200) || `exit code ${version.code}`}`
      }
    }

    this.resolvedCliPath = candidate
    return { state: 'ready', detail: `Claude Code ${version.stdout.trim()}` }
  }

  /**
   * Probes sign-in state via `claude auth status`, which prints JSON like
   * `{"loggedIn": true, "authMethod": "oauth_token", ...}`. Requires
   * `checkCli()` to have succeeded first.
   */
  async checkAuth(): Promise<SetupCheck> {
    if (!this.resolvedCliPath) {
      return { state: 'error', detail: 'Claude Code CLI must be found before checking sign-in.' }
    }

    const result = await this.exec(this.resolvedCliPath, ['auth', 'status'], AUTH_TIMEOUT_MS)
    const parsed = this.parseAuthJson(result.stdout)
    if (parsed) {
      if (parsed.loggedIn) {
        const method = parsed.authMethod === 'oauth_token' ? 'Claude account (subscription)' : parsed.authMethod
        return { state: 'ready', detail: `Signed in via ${method}` }
      }
      return { state: 'error', detail: LOGIN_HINT }
    }

    // Older CLIs without `auth status` (or unexpected output): fall back to
    // "credentials material exists" as a best-effort signal.
    if (await this.isExecutable(join(this.home, '.claude', '.credentials.json'))) {
      return { state: 'ready', detail: 'Signed in (credentials found)' }
    }
    return {
      state: 'error',
      detail: `Could not determine sign-in state (${(result.stderr || result.stdout).trim().slice(0, 120) || 'no output'}). ${LOGIN_HINT}`
    }
  }

  // -- internal -------------------------------------------------------------

  private async locateCli(): Promise<string | null> {
    const override = this.env.VOYAGER_CLAUDE_PATH
    if (override && (await this.isExecutable(override))) return override

    for (const dir of (this.env.PATH ?? '').split(delimiter)) {
      if (!dir) continue
      const candidate = join(dir, 'claude')
      if (await this.isExecutable(candidate)) return candidate
    }

    const commonLocations = [
      join(this.home, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      join(this.home, '.claude', 'local', 'claude'),
      join(this.home, '.npm-global', 'bin', 'claude')
    ]
    for (const candidate of commonLocations) {
      if (await this.isExecutable(candidate)) return candidate
    }

    if (this.platform === 'darwin') {
      const shell = this.env.SHELL ?? '/bin/zsh'
      const result = await this.exec(shell, ['-ilc', 'command -v claude'], SHELL_LOOKUP_TIMEOUT_MS)
      const path = result.stdout.trim().split('\n').pop() ?? ''
      if (result.code === 0 && path && (await this.isExecutable(path))) return path
    }

    return null
  }

  private parseAuthJson(stdout: string): { loggedIn: boolean; authMethod?: string } | null {
    // `auth status` output may be preceded by update-check noise; find the
    // first JSON object in the output.
    const start = stdout.indexOf('{')
    if (start === -1) return null
    try {
      const parsed = JSON.parse(stdout.slice(start)) as Record<string, unknown>
      if (typeof parsed.loggedIn !== 'boolean') return null
      return {
        loggedIn: parsed.loggedIn,
        authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined
      }
    } catch {
      return null
    }
  }
}
