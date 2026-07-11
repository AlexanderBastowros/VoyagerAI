import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deriveThreeMfPath,
  resolveAllPartsExportSources,
  resolveExportSource,
  type PartExportSource
} from './exportResolver'

const projectDir = '/home/user/.config/voyager/projects/default'

describe('resolveExportSource', () => {
  it('rejects when there is no iteration yet', () => {
    const result = resolveExportSource(null, projectDir, 'stl')
    expect(result).toEqual({ ok: false, reason: 'No model has been generated yet.' })
  })

  it('rejects a step export when the iteration has no stepPath', () => {
    const result = resolveExportSource(
      { stlPath: 'outputs/part_v1.stl', stepPath: undefined },
      projectDir,
      'step'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no STEP export/)
  })

  it('resolves an stl export to an absolute path inside the project dir', () => {
    const result = resolveExportSource(
      { stlPath: 'outputs/part_v2.stl', stepPath: 'outputs/part_v2.step' },
      projectDir,
      'stl'
    )
    expect(result).toEqual({
      ok: true,
      absPath: join(projectDir, 'outputs/part_v2.stl'),
      fileName: 'part_v2.stl'
    })
  })

  it('resolves a step export to an absolute path inside the project dir', () => {
    const result = resolveExportSource(
      { stlPath: 'outputs/part_v2.stl', stepPath: 'outputs/part_v2.step' },
      projectDir,
      'step'
    )
    expect(result).toEqual({
      ok: true,
      absPath: join(projectDir, 'outputs/part_v2.step'),
      fileName: 'part_v2.step'
    })
  })

  it('rejects a hostile relative path that escapes the project dir', () => {
    const result = resolveExportSource(
      { stlPath: '../../etc/passwd', stepPath: undefined },
      projectDir,
      'stl'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/outside the project directory/)
  })

  it('rejects an absolute path outside the project dir', () => {
    const result = resolveExportSource(
      { stlPath: '/etc/passwd', stepPath: undefined },
      projectDir,
      'stl'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/outside the project directory/)
  })

  it('rejects a path that resolves to the project dir itself', () => {
    const result = resolveExportSource({ stlPath: '.', stepPath: undefined }, projectDir, 'stl')
    expect(result.ok).toBe(false)
  })

  it('rejects a 3mf export when no threeMfPath was resolved (no 3MF was ever produced)', () => {
    const result = resolveExportSource({ stlPath: 'outputs/part_v1.stl', stepPath: undefined }, projectDir, '3mf')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no 3MF export/)
  })

  it('resolves a 3mf export once the caller has confirmed the sibling file exists', () => {
    const result = resolveExportSource(
      { stlPath: 'outputs/part_v2.stl', stepPath: undefined, threeMfPath: 'outputs/part_v2.3mf' },
      projectDir,
      '3mf'
    )
    expect(result).toEqual({
      ok: true,
      absPath: join(projectDir, 'outputs/part_v2.3mf'),
      fileName: 'part_v2.3mf'
    })
  })
})

describe('deriveThreeMfPath', () => {
  it('swaps the .stl extension for .3mf, same directory/basename', () => {
    expect(deriveThreeMfPath('outputs/bracket_v2.stl')).toBe('outputs/bracket_v2.3mf')
  })

  it('handles a bare filename with no directory', () => {
    expect(deriveThreeMfPath('bracket_v2.stl')).toBe('bracket_v2.3mf')
  })

  it('matches the extension case-insensitively', () => {
    expect(deriveThreeMfPath('outputs/bracket_v2.STL')).toBe('outputs/bracket_v2.3mf')
  })
})

function part(id: string, name: string, iteration: PartExportSource['iteration']): PartExportSource {
  return { id, name, iteration }
}

describe('resolveAllPartsExportSources', () => {
  const bracket = part('bracket', 'Bracket', {
    n: 2,
    stlPath: 'outputs/bracket_v2.stl',
    stepPath: 'outputs/bracket_v2.step'
  })
  const lid = part('lid', 'Lid', { n: 1, stlPath: 'outputs/lid_v1.stl', stepPath: undefined })

  it('resolves every part to its own zip entry named <partId>_v<N>.<format>', () => {
    const result = resolveAllPartsExportSources([bracket, lid], projectDir, 'stl')
    expect(result).toEqual({
      ok: true,
      entries: [
        { absPath: join(projectDir, 'outputs/bracket_v2.stl'), entryName: 'bracket_v2.stl' },
        { absPath: join(projectDir, 'outputs/lid_v1.stl'), entryName: 'lid_v1.stl' }
      ],
      skippedParts: [],
      zipFileName: 'parts-stl.zip'
    })
  })

  it('names the zip after the project when a base name is given', () => {
    const result = resolveAllPartsExportSources([bracket, lid], projectDir, 'stl', 'Hinge Box!')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.zipFileName).toBe('hinge-box-stl.zip')
  })

  it('skips parts without a STEP on a step export and reports them by display name', () => {
    const result = resolveAllPartsExportSources([bracket, lid], projectDir, 'step')
    expect(result).toEqual({
      ok: true,
      entries: [{ absPath: join(projectDir, 'outputs/bracket_v2.step'), entryName: 'bracket_v2.step' }],
      skippedParts: ['Lid'],
      zipFileName: 'parts-step.zip'
    })
  })

  it('resolves 3mf entries only for parts whose threeMfPath was confirmed to exist', () => {
    const withThreeMf = part('bracket', 'Bracket', {
      n: 2,
      stlPath: 'outputs/bracket_v2.stl',
      stepPath: 'outputs/bracket_v2.step',
      threeMfPath: 'outputs/bracket_v2.3mf'
    })
    const result = resolveAllPartsExportSources([withThreeMf, lid], projectDir, '3mf')
    expect(result).toEqual({
      ok: true,
      entries: [{ absPath: join(projectDir, 'outputs/bracket_v2.3mf'), entryName: 'bracket_v2.3mf' }],
      skippedParts: ['Lid'],
      zipFileName: 'parts-3mf.zip'
    })
  })

  it('skips parts that have no iterations yet', () => {
    const empty = part('spacer', 'Spacer', null)
    const result = resolveAllPartsExportSources([bracket, empty], projectDir, 'stl')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.entries.map((e) => e.entryName)).toEqual(['bracket_v2.stl'])
      expect(result.skippedParts).toEqual(['Spacer'])
    }
  })

  it('rejects when no part has any iteration', () => {
    const result = resolveAllPartsExportSources(
      [part('a', 'A', null), part('b', 'B', null)],
      projectDir,
      'stl'
    )
    expect(result).toEqual({ ok: false, reason: 'No model has been generated yet.' })
  })

  it('rejects a step export when no part has a STEP, pointing at Export STL', () => {
    const stlOnly = part('base', 'Base', { n: 3, stlPath: 'outputs/base_v3.stl', stepPath: undefined })
    const result = resolveAllPartsExportSources([stlOnly, lid], projectDir, 'step')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/None of the parts has a STEP export/)
  })

  it('fails the whole export when any part path escapes the project dir', () => {
    const hostile = part('evil', 'Evil', { n: 1, stlPath: '../../etc/passwd', stepPath: undefined })
    const result = resolveAllPartsExportSources([bracket, hostile], projectDir, 'stl')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/part "Evil".*outside the project directory/)
  })
})
