import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readVerificationForIteration, verificationPathForStl, writeVerificationForIteration } from './reportConvention'
import type { VerificationReport } from '@shared/ipc'

describe('verificationPathForStl', () => {
  it('swaps the .stl extension for .verification.json, same basename', () => {
    expect(verificationPathForStl('outputs/bracket_v2.stl')).toBe('outputs/bracket_v2.verification.json')
  })

  it('handles a bare filename with no directory', () => {
    expect(verificationPathForStl('bracket_v2.stl')).toBe('bracket_v2.verification.json')
  })
})

describe('readVerificationForIteration / writeVerificationForIteration', () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'voyager-verify-report-'))
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('returns null when nothing has been recorded yet', async () => {
    const result = await readVerificationForIteration(projectDir, { stlPath: 'outputs/bracket_v1.stl' })
    expect(result).toBeNull()
  })

  it('round-trips a written report', async () => {
    const report: VerificationReport = {
      iteration: 1,
      badge: 'pass',
      findings: [],
      conformance: [],
      generatedAt: '2026-07-09T00:00:00.000Z'
    }
    await writeVerificationForIteration(projectDir, { stlPath: 'outputs/bracket_v1.stl' }, report)
    const result = await readVerificationForIteration(projectDir, { stlPath: 'outputs/bracket_v1.stl' })
    expect(result).toEqual(report)
  })

  it('returns null for malformed JSON on disk rather than throwing', async () => {
    const result = await readVerificationForIteration(projectDir, { stlPath: 'missing/nope.stl' })
    expect(result).toBeNull()
  })
})
