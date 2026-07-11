import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runPartInterferenceCheck } from './layerPartInterference'
import type { ExecFileFn } from './execJson'

const placement = (position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) => ({
  position,
  rotation
})

describe('runPartInterferenceCheck', () => {
  it('is a no-op for zero or one part - never spawns a process', async () => {
    let called = false
    const fakeExec: ExecFileFn = async () => {
      called = true
      return { code: 0, stdout: JSON.stringify({ findings: [] }), stderr: '' }
    }

    expect(await runPartInterferenceCheck({ pythonPath: 'python3', partInterferenceScriptPath: 'p.py', parts: [] }, fakeExec)).toEqual([])
    expect(
      await runPartInterferenceCheck(
        {
          pythonPath: 'python3',
          partInterferenceScriptPath: 'p.py',
          parts: [{ partId: 'main', stlPath: 'main.stl', placement: placement([0, 0, 0]) }]
        },
        fakeExec
      )
    ).toEqual([])
    expect(called).toBe(false)
  })

  it('writes every part\'s stl path + placement to a scratch JSON file, passes its path, and cleans up', async () => {
    let capturedArgs: readonly string[] = []
    let manifestAtCallTime = ''
    const fakeExec: ExecFileFn = async (_cmd, args) => {
      capturedArgs = args
      const partsJsonPath = args[args.indexOf('--parts-json') + 1]
      manifestAtCallTime = await readFile(partsJsonPath, 'utf-8')
      return { code: 0, stdout: JSON.stringify({ findings: [] }), stderr: '' }
    }

    const result = await runPartInterferenceCheck(
      {
        pythonPath: 'python3',
        partInterferenceScriptPath: 'part_interference.py',
        parts: [
          { partId: 'box', stlPath: '/abs/box.stl', placement: placement([0, 0, 0]) },
          { partId: 'lid', stlPath: '/abs/lid.stl', placement: placement([0, 0, 10], [0, 0, 45]) }
        ]
      },
      fakeExec
    )

    expect(capturedArgs[0]).toBe('part_interference.py')
    expect(capturedArgs[1]).toBe('--parts-json')
    expect(JSON.parse(manifestAtCallTime)).toEqual([
      { partId: 'box', stlPath: '/abs/box.stl', position: [0, 0, 0], rotation: [0, 0, 0] },
      { partId: 'lid', stlPath: '/abs/lid.stl', position: [0, 0, 10], rotation: [0, 0, 45] }
    ])
    expect(result).toEqual([])

    // The scratch directory should be gone - re-reading the same path now throws.
    const partsJsonPath = capturedArgs[capturedArgs.indexOf('--parts-json') + 1]
    await expect(readFile(partsJsonPath, 'utf-8')).rejects.toThrow()
  })

  it('maps interpenetration findings onto the geometry layer', async () => {
    const fakeExec: ExecFileFn = async () => ({
      code: 0,
      stdout: JSON.stringify({
        findings: [
          { severity: 'blocking', message: 'Parts "box" and "lid" interpenetrate at their current placement.' }
        ]
      }),
      stderr: ''
    })

    const findings = await runPartInterferenceCheck(
      {
        pythonPath: 'python3',
        partInterferenceScriptPath: 'part_interference.py',
        parts: [
          { partId: 'box', stlPath: '/abs/box.stl', placement: placement([0, 0, 0]) },
          { partId: 'lid', stlPath: '/abs/lid.stl', placement: placement([2, 0, 0]) }
        ]
      },
      fakeExec
    )

    expect(findings).toEqual([
      { layer: 'geometry', severity: 'blocking', message: 'Parts "box" and "lid" interpenetrate at their current placement.' }
    ])
  })

  it('degrades to an info finding when the script crashes', async () => {
    const fakeExec: ExecFileFn = async () => ({ code: 1, stdout: 'not json', stderr: '' })

    const findings = await runPartInterferenceCheck(
      {
        pythonPath: 'python3',
        partInterferenceScriptPath: 'part_interference.py',
        parts: [
          { partId: 'box', stlPath: '/abs/box.stl', placement: placement([0, 0, 0]) },
          { partId: 'lid', stlPath: '/abs/lid.stl', placement: placement([2, 0, 0]) }
        ]
      },
      fakeExec
    )

    expect(findings).toEqual([
      { layer: 'geometry', severity: 'info', message: 'Cross-part interference check could not run: not json' }
    ])
  })
})
