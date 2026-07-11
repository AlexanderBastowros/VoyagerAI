import { describe, expect, it } from 'vitest'
import { renderViews } from './renderViews'
import type { ExecFileFn } from './execFile'

const SUCCESS_JSON = JSON.stringify({
  ok: true,
  views: {
    front: 'front.png',
    back: 'back.png',
    left: 'left.png',
    right: 'right.png',
    top: 'top.png',
    bottom: 'bottom.png',
    iso1: 'iso1.png',
    iso2: 'iso2.png'
  },
  widthMm: 40,
  heightMm: 20,
  depthMm: 10,
  sizePx: 512
})

describe('renderViews', () => {
  it('invokes the script with stl path and out dir, and passes through a successful result', async () => {
    let capturedCommand = ''
    let capturedArgs: readonly string[] = []
    const fakeExec: ExecFileFn = async (command, args) => {
      capturedCommand = command
      capturedArgs = args
      return { code: 0, stdout: SUCCESS_JSON, stderr: '' }
    }

    const result = await renderViews(
      {
        pythonPath: '/venv/bin/python3',
        scriptPath: '/render-rig/render_views.py',
        stlPath: '/proj/outputs/part.stl',
        outDir: '/proj/outputs/part.renders'
      },
      fakeExec
    )

    expect(capturedCommand).toBe('/venv/bin/python3')
    expect(capturedArgs).toEqual(['/render-rig/render_views.py', '/proj/outputs/part.stl', '/proj/outputs/part.renders'])
    expect(result).toEqual({
      ok: true,
      views: {
        front: 'front.png',
        back: 'back.png',
        left: 'left.png',
        right: 'right.png',
        top: 'top.png',
        bottom: 'bottom.png',
        iso1: 'iso1.png',
        iso2: 'iso2.png'
      },
      widthMm: 40,
      heightMm: 20,
      depthMm: 10,
      sizePx: 512
    })
  })

  it('appends --size only when provided', async () => {
    let capturedArgs: readonly string[] = []
    const fakeExec: ExecFileFn = async (_command, args) => {
      capturedArgs = args
      return { code: 0, stdout: SUCCESS_JSON, stderr: '' }
    }

    await renderViews(
      { pythonPath: 'python3', scriptPath: 'render_views.py', stlPath: 'part.stl', outDir: 'out', sizePx: 256 },
      fakeExec
    )

    expect(capturedArgs).toEqual(['render_views.py', 'part.stl', 'out', '--size', '256'])
  })

  it('passes through a clean {ok: false} result from the script without treating it as a parse failure', async () => {
    const fakeExec: ExecFileFn = async () => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, error: 'No mesh data in part.stl.' }),
      stderr: ''
    })

    const result = await renderViews(
      { pythonPath: 'python3', scriptPath: 'render_views.py', stlPath: 'part.stl', outDir: 'out' },
      fakeExec
    )

    expect(result).toEqual({ ok: false, error: 'No mesh data in part.stl.' })
  })

  it('reports a clean failure when stdout is not JSON (e.g. a crash), without throwing', async () => {
    const fakeExec: ExecFileFn = async () => ({ code: 1, stdout: '', stderr: 'Traceback: boom' })

    const result = await renderViews(
      { pythonPath: 'python3', scriptPath: 'render_views.py', stlPath: 'part.stl', outDir: 'out' },
      fakeExec
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Traceback: boom')
  })

  it('reports a clean failure when stdout parses but is not the expected shape', async () => {
    const fakeExec: ExecFileFn = async () => ({ code: 0, stdout: JSON.stringify({ unexpected: true }), stderr: '' })

    const result = await renderViews(
      { pythonPath: 'python3', scriptPath: 'render_views.py', stlPath: 'part.stl', outDir: 'out' },
      fakeExec
    )

    expect(result).toEqual({ ok: false, error: 'render_views.py returned an unexpected result shape.' })
  })
})
