import { describe, expect, it } from 'vitest'
import { runLayer1StaticScript } from './layer1StaticScript'
import type { ExecFileFn } from './execJson'

describe('runLayer1StaticScript', () => {
  it('maps static_check.py findings onto the static-script layer', async () => {
    const fakeExec: ExecFileFn = async () => ({
      code: 0,
      stdout: JSON.stringify({ findings: [{ severity: 'info', message: 'Script parses; imports are within the allowlist.' }] }),
      stderr: ''
    })

    const findings = await runLayer1StaticScript(
      { pythonPath: 'python3', staticCheckScriptPath: 'static_check.py', scriptPath: 'part.py' },
      fakeExec
    )

    expect(findings).toEqual([
      { layer: 'static-script', severity: 'info', message: 'Script parses; imports are within the allowlist.' }
    ])
  })

  it('degrades to an info finding when the script output cannot be parsed', async () => {
    const fakeExec: ExecFileFn = async () => ({ code: 1, stdout: '', stderr: 'Traceback (most recent call last)' })

    const findings = await runLayer1StaticScript(
      { pythonPath: 'python3', staticCheckScriptPath: 'static_check.py', scriptPath: 'part.py' },
      fakeExec
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ layer: 'static-script', severity: 'info' })
    expect(findings[0].message).toContain('Traceback')
  })

  it('adds a blocking finding when extract_params.py exits non-zero', async () => {
    let call = 0
    const fakeExec: ExecFileFn = async (_cmd, args) => {
      call += 1
      if (args[0] === 'static_check.py') {
        return { code: 0, stdout: JSON.stringify({ findings: [] }), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: "part.py: line 3: does not match 'NAME = VALUE...'" }
    }

    const findings = await runLayer1StaticScript(
      {
        pythonPath: 'python3',
        staticCheckScriptPath: 'static_check.py',
        scriptPath: 'part.py',
        extractParamsScriptPath: 'extract_params.py'
      },
      fakeExec
    )

    expect(call).toBe(2)
    expect(findings).toEqual([
      {
        layer: 'static-script',
        severity: 'blocking',
        message: "PARAMS block is missing or invalid: part.py: line 3: does not match 'NAME = VALUE...'"
      }
    ])
  })

  it('skips the PARAMS check when no extractParamsScriptPath is given', async () => {
    const fakeExec: ExecFileFn = async () => ({ code: 0, stdout: JSON.stringify({ findings: [] }), stderr: '' })

    const findings = await runLayer1StaticScript(
      { pythonPath: 'python3', staticCheckScriptPath: 'static_check.py', scriptPath: 'part.py' },
      fakeExec
    )

    expect(findings).toEqual([])
  })
})
