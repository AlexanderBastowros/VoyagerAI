import { describe, expect, it } from 'vitest'
import { isVerificationReport, VerificationReportSchema } from './verification'

describe('isVerificationReport', () => {
  it('accepts a report with findings and a conformance table', () => {
    const report = {
      iteration: 2,
      badge: 'warning',
      findings: [{ layer: 'geometry', severity: 'suggestion', message: 'Wall thickness is thin near the base.' }],
      conformance: [{ briefField: 'envelope.x', spec: '40mm', measured: '39.8mm', pass: true }],
      generatedAt: '2026-01-01T00:00:00.000Z'
    }
    expect(isVerificationReport(report)).toBe(true)
    expect(VerificationReportSchema.parse(report).badge).toBe('warning')
  })

  it('rejects malformed reports', () => {
    expect(isVerificationReport(null)).toBe(false)
    expect(isVerificationReport({ iteration: 1, badge: 'unknown', findings: [], conformance: [] })).toBe(false)
  })
})
