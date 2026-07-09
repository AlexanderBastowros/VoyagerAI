import { describe, expect, it } from 'vitest'
import { validateStl } from './validateStl'
import type { ExecFileFn } from './validateStl'

describe('validateStl', () => {
  it('invokes the script with the STL path and passes through a successful result', async () => {
    let capturedCommand = ''
    let capturedArgs: readonly string[] = []
    const fakeExec: ExecFileFn = async (command, args) => {
      capturedCommand = command
      capturedArgs = args
      return { code: 0, stdout: 'watertight: PASS', stderr: '' }
    }

    const result = await validateStl(
      { pythonPath: '/venv/bin/python3', scriptPath: '/verify/validate_stl.py', stlPath: '/proj/part.stl' },
      fakeExec
    )

    expect(capturedCommand).toBe('/venv/bin/python3')
    expect(capturedArgs).toEqual(['/verify/validate_stl.py', '/proj/part.stl'])
    expect(result).toEqual({ ok: true, exitCode: 0, stdout: 'watertight: PASS', stderr: '' })
  })

  it('appends bed/nozzle flags only when provided', async () => {
    let capturedArgs: readonly string[] = []
    const fakeExec: ExecFileFn = async (_command, args) => {
      capturedArgs = args
      return { code: 0, stdout: '', stderr: '' }
    }

    await validateStl(
      {
        pythonPath: 'python3',
        scriptPath: 'validate_stl.py',
        stlPath: 'part.stl',
        bedXMm: 256,
        bedYMm: 256,
        bedZMm: 256,
        nozzleMm: 0.4
      },
      fakeExec
    )

    expect(capturedArgs).toEqual([
      'validate_stl.py',
      'part.stl',
      '--bed-x',
      '256',
      '--bed-y',
      '256',
      '--bed-z',
      '256',
      '--nozzle',
      '0.4'
    ])
  })

  it('reports a non-zero exit as not ok, without throwing', async () => {
    const fakeExec: ExecFileFn = async () => ({ code: 1, stdout: 'watertight: FAIL', stderr: 'boom' })

    const result = await validateStl(
      { pythonPath: 'python3', scriptPath: 'validate_stl.py', stlPath: 'part.stl' },
      fakeExec
    )

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('boom')
  })
})
