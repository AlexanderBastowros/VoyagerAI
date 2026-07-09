import { describe, expect, it } from 'vitest'
import { runLayer2Geometry } from './layer2Geometry'
import type { ExecFileFn } from './execJson'

describe('runLayer2Geometry', () => {
  it('passes bed/nozzle flags through only when provided', async () => {
    let capturedArgs: readonly string[] = []
    const fakeExec: ExecFileFn = async (_cmd, args) => {
      capturedArgs = args
      return { code: 0, stdout: JSON.stringify({ findings: [] }), stderr: '' }
    }

    await runLayer2Geometry(
      {
        pythonPath: 'python3',
        geometryReportScriptPath: 'geometry_report.py',
        stlPath: 'part.stl',
        bedXMm: 256,
        bedYMm: 256,
        bedZMm: 256,
        nozzleMm: 0.4
      },
      fakeExec
    )

    expect(capturedArgs).toEqual([
      'geometry_report.py',
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

  it('maps geometry_report.py findings onto the geometry layer', async () => {
    const fakeExec: ExecFileFn = async () => ({
      code: 0,
      stdout: JSON.stringify({
        findings: [{ severity: 'blocking', message: 'Mesh is not watertight.' }]
      }),
      stderr: ''
    })

    const findings = await runLayer2Geometry(
      { pythonPath: 'python3', geometryReportScriptPath: 'geometry_report.py', stlPath: 'part.stl' },
      fakeExec
    )

    expect(findings).toEqual([{ layer: 'geometry', severity: 'blocking', message: 'Mesh is not watertight.' }])
  })

  it('degrades to an info finding when the script crashes', async () => {
    const fakeExec: ExecFileFn = async () => ({ code: 1, stdout: 'not json', stderr: '' })

    const findings = await runLayer2Geometry(
      { pythonPath: 'python3', geometryReportScriptPath: 'geometry_report.py', stlPath: 'part.stl' },
      fakeExec
    )

    expect(findings).toEqual([
      { layer: 'geometry', severity: 'info', message: 'Geometry check could not run: not json' }
    ])
  })
})
