import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveExportSource } from './exportResolver'

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
})
