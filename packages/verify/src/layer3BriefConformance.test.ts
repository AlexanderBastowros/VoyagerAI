import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runLayer3BriefConformance } from './layer3BriefConformance'
import type { ExecFileFn } from './execJson'

describe('runLayer3BriefConformance', () => {
  it('writes the envelope/holes subset to a scratch JSON file, passes its path, and cleans up', async () => {
    let capturedArgs: readonly string[] = []
    let briefJsonAtCallTime = ''
    const fakeExec: ExecFileFn = async (_cmd, args) => {
      capturedArgs = args
      const briefJsonPath = args[args.indexOf('--brief-json') + 1]
      briefJsonAtCallTime = await readFile(briefJsonPath, 'utf-8')
      return { code: 0, stdout: JSON.stringify({ findings: [], conformance: [] }), stderr: '' }
    }

    const result = await runLayer3BriefConformance(
      {
        pythonPath: 'python3',
        conformanceCheckScriptPath: 'conformance_check.py',
        stepPath: 'part.step',
        envelope: { x: { value: 40 }, y: { value: 20, tolerance: 0.2 }, z: { value: 10 } },
        holes: [{ id: 'mount-hole', diameterMm: 3.4 }]
      },
      fakeExec
    )

    expect(capturedArgs[0]).toBe('conformance_check.py')
    expect(capturedArgs[1]).toBe('part.step')
    expect(capturedArgs[2]).toBe('--brief-json')
    expect(JSON.parse(briefJsonAtCallTime)).toEqual({
      envelope: { x: { value: 40 }, y: { value: 20, tolerance: 0.2 }, z: { value: 10 } },
      holes: [{ id: 'mount-hole', diameterMm: 3.4 }]
    })
    expect(result).toEqual({ findings: [], conformance: [] })

    // The scratch directory should be gone - re-reading the same path now throws.
    const briefJsonPath = capturedArgs[capturedArgs.indexOf('--brief-json') + 1]
    await expect(readFile(briefJsonPath, 'utf-8')).rejects.toThrow()
  })

  it('maps a failed conformance row into a blocking finding with a red row', async () => {
    const fakeExec: ExecFileFn = async () => ({
      code: 0,
      stdout: JSON.stringify({
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
      }),
      stderr: ''
    })

    const result = await runLayer3BriefConformance(
      {
        pythonPath: 'python3',
        conformanceCheckScriptPath: 'conformance_check.py',
        stepPath: 'part.step',
        envelope: { x: { value: 40 }, y: { value: 20 }, z: { value: 10 } },
        holes: [{ id: 'mount-hole', diameterMm: 3.4 }]
      },
      fakeExec
    )

    expect(result.conformance).toEqual([
      { briefField: 'features.mount-hole.diameter', spec: '3.40 mm', measured: '5.10 mm', pass: false }
    ])
    expect(result.findings).toEqual([
      {
        layer: 'brief-conformance',
        severity: 'blocking',
        message: "Hole 'mount-hole' measures 5.10 mm, brief specifies 3.40 mm (tolerance 0.30 mm).",
        briefField: 'features.mount-hole.diameter'
      }
    ])
  })

  it('degrades to an info finding when the script cannot run, and still cleans up', async () => {
    const fakeExec: ExecFileFn = async () => ({ code: 1, stdout: '', stderr: 'OCP is not available' })

    const result = await runLayer3BriefConformance(
      {
        pythonPath: 'python3',
        conformanceCheckScriptPath: 'conformance_check.py',
        stepPath: 'part.step',
        envelope: { x: { value: 40 }, y: { value: 20 }, z: { value: 10 } },
        holes: []
      },
      fakeExec
    )

    expect(result).toEqual({
      findings: [
        { layer: 'brief-conformance', severity: 'info', message: 'Brief conformance check could not run: OCP is not available' }
      ],
      conformance: []
    })
  })
})
