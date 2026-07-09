import { describe, expect, it } from 'vitest'
import { createRunVerificationTool } from './runVerification'
import { makeDeps } from './testSupport'
import type { ProjectIteration } from '../src/projects/store'
import type { VerificationReport } from '@shared/ipc'
import type { VoyagerMcpEmission } from './types'

const activeIteration: ProjectIteration = {
  n: 2,
  stlPath: 'outputs/part_v2.stl',
  scriptPath: 'outputs/part_v2.py',
  summary: 'A bracket',
  at: '2026-07-09T00:00:00.000Z'
}

function fakeReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return { iteration: 2, badge: 'pass', findings: [], conformance: [], generatedAt: '2026-07-09T00:00:00.000Z', ...overrides }
}

describe('run_verification tool', () => {
  it('recomputes the active iteration, emits verification-computed, and summarizes the result', async () => {
    const emissions: VoyagerMcpEmission[] = []
    let calledWith: ProjectIteration | null = null
    const report = fakeReport({
      badge: 'fail',
      findings: [{ layer: 'brief-conformance', severity: 'blocking', message: 'boom' }],
      conformance: [{ briefField: 'envelope.x', spec: '40 mm', measured: '45 mm', pass: false }]
    })

    const deps = {
      ...makeDeps('/proj', emissions, [], () => activeIteration),
      runVerification: async (iteration: ProjectIteration) => {
        calledWith = iteration
        return report
      }
    }

    const handler = createRunVerificationTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBeFalsy()
    expect(calledWith).toEqual(activeIteration)
    expect(emissions).toEqual([{ kind: 'verification-computed', payload: report }])
    expect((result.content[0] as { text: string }).text).toContain('badge "fail"')
    expect((result.content[0] as { text: string }).text).toContain('1 blocking finding(s)')
    expect((result.content[0] as { text: string }).text).toContain('1 failed conformance row(s)')
  })

  it('errors cleanly when no model is displayed yet', async () => {
    const emissions: VoyagerMcpEmission[] = []
    const deps = {
      ...makeDeps('/proj', emissions, [], () => null),
      runVerification: async () => fakeReport()
    }

    const handler = createRunVerificationTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBe(true)
    expect(emissions).toHaveLength(0)
  })

  it('errors cleanly when verification is not available in this session', async () => {
    const emissions: VoyagerMcpEmission[] = []
    const deps = makeDeps('/proj', emissions, [], () => activeIteration)

    const handler = createRunVerificationTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBe(true)
  })
})
