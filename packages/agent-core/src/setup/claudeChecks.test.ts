import { describe, expect, it } from 'vitest'
import { ClaudeChecker } from './claudeChecks'
import type { ClaudeCheckerOptions, ExecResult } from './claudeChecks'

interface ExecCall {
  file: string
  args: string[]
}

function makeChecker(options: {
  executables?: string[]
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  execResults?: (file: string, args: string[]) => ExecResult
  calls?: ExecCall[]
}): ClaudeChecker {
  const executables = new Set(options.executables ?? [])
  const checkerOptions: ClaudeCheckerOptions = {
    env: options.env ?? { PATH: '' },
    platform: options.platform ?? 'darwin',
    home: '/Users/tester',
    isExecutable: async (path) => executables.has(path),
    exec: async (file, args) => {
      options.calls?.push({ file, args })
      return (
        options.execResults?.(file, args) ?? { code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' }
      )
    }
  }
  return new ClaudeChecker(checkerOptions)
}

describe('ClaudeChecker.checkCli resolution order', () => {
  it('prefers the VOYAGER_CLAUDE_PATH override over everything else', async () => {
    const checker = makeChecker({
      executables: ['/custom/claude', '/usr/local/bin/claude'],
      env: { VOYAGER_CLAUDE_PATH: '/custom/claude', PATH: '/usr/local/bin' }
    })
    const result = await checker.checkCli()
    expect(result.state).toBe('ready')
    expect(checker.cliPath()).toBe('/custom/claude')
  })

  it('walks PATH before probing common install locations', async () => {
    const checker = makeChecker({
      executables: ['/on/path/claude', '/opt/homebrew/bin/claude'],
      env: { PATH: '/nowhere:/on/path' }
    })
    await checker.checkCli()
    expect(checker.cliPath()).toBe('/on/path/claude')
  })

  it('falls back to common locations when PATH has nothing (packaged .app scenario)', async () => {
    const checker = makeChecker({
      executables: ['/opt/homebrew/bin/claude'],
      env: { PATH: '/usr/bin:/bin' }
    })
    await checker.checkCli()
    expect(checker.cliPath()).toBe('/opt/homebrew/bin/claude')
  })

  it('asks a login shell as the last resort on darwin', async () => {
    const calls: ExecCall[] = []
    const executables = new Set<string>(['/from/shell/claude'])
    const checker = new ClaudeChecker({
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      platform: 'darwin',
      home: '/Users/tester',
      isExecutable: async (path) => executables.has(path),
      exec: async (file, args) => {
        calls.push({ file, args })
        if (file === '/bin/zsh') return { code: 0, stdout: '/from/shell/claude\n', stderr: '' }
        return { code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' }
      }
    })
    const result = await checker.checkCli()
    expect(result.state).toBe('ready')
    expect(checker.cliPath()).toBe('/from/shell/claude')
    expect(calls[0]).toEqual({ file: '/bin/zsh', args: ['-ilc', 'command -v claude'] })
  })

  it('reports an actionable error when nothing is found', async () => {
    const checker = makeChecker({
      executables: [],
      platform: 'linux',
      env: { PATH: '/usr/bin' }
    })
    const result = await checker.checkCli()
    expect(result.state).toBe('error')
    expect(result.detail).toMatch(/install/i)
    expect(checker.cliPath()).toBeNull()
  })

  it('reports an error (and clears cliPath) when --version fails', async () => {
    const checker = makeChecker({
      executables: ['/usr/local/bin/claude'],
      env: { PATH: '/usr/local/bin' },
      execResults: () => ({ code: 1, stdout: '', stderr: 'segfault' })
    })
    const result = await checker.checkCli()
    expect(result.state).toBe('error')
    expect(result.detail).toContain('segfault')
    expect(checker.cliPath()).toBeNull()
  })
})

describe('ClaudeChecker.checkAuth', () => {
  async function readyChecker(authResult: ExecResult): Promise<ClaudeChecker> {
    const checker = makeChecker({
      executables: ['/usr/local/bin/claude'],
      env: { PATH: '/usr/local/bin' },
      execResults: (_file, args) =>
        args[0] === 'auth' ? authResult : { code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' }
    })
    await checker.checkCli()
    return checker
  }

  it('reports ready when `auth status` says loggedIn: true', async () => {
    const checker = await readyChecker({
      code: 0,
      stdout: '{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}',
      stderr: ''
    })
    const result = await checker.checkAuth()
    expect(result.state).toBe('ready')
    expect(result.detail).toMatch(/subscription/i)
  })

  it('reports an error with login guidance when loggedIn: false', async () => {
    const checker = await readyChecker({ code: 0, stdout: '{"loggedIn": false}', stderr: '' })
    const result = await checker.checkAuth()
    expect(result.state).toBe('error')
    expect(result.detail).toMatch(/login/i)
  })

  it('tolerates update-check noise before the JSON', async () => {
    const checker = await readyChecker({
      code: 0,
      stdout: 'Checking for updates...\n{"loggedIn": true, "authMethod": "oauth_token"}',
      stderr: ''
    })
    const result = await checker.checkAuth()
    expect(result.state).toBe('ready')
  })

  it('requires checkCli to have succeeded first', async () => {
    const checker = makeChecker({ executables: [], platform: 'linux', env: { PATH: '' } })
    await checker.checkCli()
    const result = await checker.checkAuth()
    expect(result.state).toBe('error')
  })
})
