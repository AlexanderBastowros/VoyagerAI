import { describe, expect, it } from 'vitest'
import { runVerification } from './runVerification'
import type { ExecFileFn } from './execJson'
import { emptyDesignBrief } from '@shared/ipc'
import type { DesignBrief } from '@shared/ipc'

function fakeExecFor(outputs: {
  static?: object
  extractParams?: { code: number }
  geometry?: object
  conformance?: object
  partInterference?: object
}): ExecFileFn {
  return async (_cmd, args) => {
    const script = args[0]
    if (script.includes('static_check')) {
      return { code: 0, stdout: JSON.stringify(outputs.static ?? { findings: [] }), stderr: '' }
    }
    if (script.includes('extract_params')) {
      const code = outputs.extractParams?.code ?? 0
      return { code, stdout: '', stderr: code === 0 ? '' : 'PARAMS error' }
    }
    if (script.includes('geometry_report')) {
      return { code: 0, stdout: JSON.stringify(outputs.geometry ?? { findings: [] }), stderr: '' }
    }
    if (script.includes('conformance_check')) {
      return { code: 0, stdout: JSON.stringify(outputs.conformance ?? { findings: [], conformance: [] }), stderr: '' }
    }
    if (script.includes('part_interference')) {
      return { code: 0, stdout: JSON.stringify(outputs.partInterference ?? { findings: [] }), stderr: '' }
    }
    throw new Error(`unexpected script: ${script}`)
  }
}

const baseOptions = {
  iteration: 3,
  pythonPath: 'python3',
  staticCheckScriptPath: 'static_check.py',
  geometryReportScriptPath: 'geometry_report.py',
  conformanceCheckScriptPath: 'conformance_check.py',
  scriptPath: 'part_v3.py'
}

describe('runVerification', () => {
  it('runs only layer 1 when there is no STL/STEP yet, and passes on no findings', async () => {
    const report = await runVerification(baseOptions, fakeExecFor({}))

    expect(report.iteration).toBe(3)
    expect(report.badge).toBe('pass')
    expect(report.findings).toEqual([])
    expect(report.conformance).toEqual([])
    expect(typeof report.generatedAt).toBe('string')
  })

  it('runs layers 1-2 once an STL exists, and layer 2 findings flip the badge', async () => {
    const report = await runVerification(
      { ...baseOptions, stlPath: 'part_v3.stl' },
      fakeExecFor({ geometry: { findings: [{ severity: 'blocking', message: 'Mesh is not watertight.' }] } })
    )

    expect(report.badge).toBe('fail')
    expect(report.findings).toEqual([{ layer: 'geometry', severity: 'blocking', message: 'Mesh is not watertight.' }])
  })

  it('skips layer 3 when the brief is not locked, even with a STEP export', async () => {
    const brief: DesignBrief = { ...emptyDesignBrief(), version: 1 } // lockedAt left unset

    let conformanceCalled = false
    const execFn: ExecFileFn = async (cmd, args) => {
      if (args[0].includes('conformance_check')) conformanceCalled = true
      return fakeExecFor({})(cmd, args)
    }

    await runVerification({ ...baseOptions, stepPath: 'part_v3.step', brief }, execFn)

    expect(conformanceCalled).toBe(false)
  })

  it('a deliberately-wrong hole diameter surfaces as a failed conformance row and flips the badge to fail', async () => {
    const brief: DesignBrief = {
      ...emptyDesignBrief(),
      lockedAt: '2026-07-09T00:00:00.000Z',
      envelope: {
        x: { value: 40, unit: 'mm', provenance: 'user' },
        y: { value: 20, unit: 'mm', provenance: 'user' },
        z: { value: 10, unit: 'mm', provenance: 'user' }
      },
      features: [
        {
          id: 'mount-hole',
          kind: 'hole',
          diameter: { value: 3.4, unit: 'mm', provenance: 'user' },
          purpose: 'clearance',
          position: 'center of top face'
        }
      ]
    }

    const report = await runVerification(
      { ...baseOptions, stepPath: 'part_v3.step', brief },
      fakeExecFor({
        conformance: {
          findings: [
            {
              severity: 'blocking',
              message: "Hole 'mount-hole' measures 5.10 mm, brief specifies 3.40 mm (tolerance 0.30 mm).",
              briefField: 'features.mount-hole.diameter'
            }
          ],
          conformance: [
            { briefField: 'features.mount-hole.diameter', spec: '3.40 mm', measured: '5.10 mm', pass: false }
          ]
        }
      })
    )

    expect(report.conformance).toEqual([
      { briefField: 'features.mount-hole.diameter', spec: '3.40 mm', measured: '5.10 mm', pass: false }
    ])
    expect(report.badge).toBe('fail')
  })

  it('warns (does not fail) on suggestion-only findings', async () => {
    const report = await runVerification(
      { ...baseOptions, stlPath: 'part_v3.stl' },
      fakeExecFor({ geometry: { findings: [{ severity: 'suggestion', message: 'Fits only if reoriented.' }] } })
    )

    expect(report.badge).toBe('warning')
  })

  it('skips the cross-part interference check with no partInterferenceScriptPath, even with 2+ parts', async () => {
    let interferenceCalled = false
    const execFn: ExecFileFn = async (cmd, args) => {
      if (args[0].includes('part_interference')) interferenceCalled = true
      return fakeExecFor({})(cmd, args)
    }

    await runVerification(
      {
        ...baseOptions,
        parts: [
          { partId: 'box', stlPath: 'box.stl', placement: { position: [0, 0, 0], rotation: [0, 0, 0] } },
          { partId: 'lid', stlPath: 'lid.stl', placement: { position: [0, 0, 10], rotation: [0, 0, 0] } }
        ]
      },
      execFn
    )

    expect(interferenceCalled).toBe(false)
  })

  it('skips the cross-part interference check for a single part, even with a script path set', async () => {
    let interferenceCalled = false
    const execFn: ExecFileFn = async (cmd, args) => {
      if (args[0].includes('part_interference')) interferenceCalled = true
      return fakeExecFor({})(cmd, args)
    }

    await runVerification(
      {
        ...baseOptions,
        partInterferenceScriptPath: 'part_interference.py',
        parts: [{ partId: 'main', stlPath: 'main.stl', placement: { position: [0, 0, 0], rotation: [0, 0, 0] } }]
      },
      execFn
    )

    expect(interferenceCalled).toBe(false)
  })

  it('runs the cross-part interference check for 2+ parts and folds a blocking finding into the geometry layer + badge', async () => {
    const report = await runVerification(
      {
        ...baseOptions,
        partInterferenceScriptPath: 'part_interference.py',
        parts: [
          { partId: 'box', stlPath: 'box.stl', placement: { position: [0, 0, 0], rotation: [0, 0, 0] } },
          { partId: 'lid', stlPath: 'lid.stl', placement: { position: [2, 0, 0], rotation: [0, 0, 0] } }
        ]
      },
      fakeExecFor({
        partInterference: {
          findings: [{ severity: 'blocking', message: 'Parts "box" and "lid" interpenetrate at their current placement.' }]
        }
      })
    )

    expect(report.badge).toBe('fail')
    expect(report.findings).toEqual([
      { layer: 'geometry', severity: 'blocking', message: 'Parts "box" and "lid" interpenetrate at their current placement.' }
    ])
  })
})
