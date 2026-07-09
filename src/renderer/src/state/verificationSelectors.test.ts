import { describe, expect, it } from 'vitest'
import {
  badgeLabel,
  badgeTone,
  groupFindingsByLayer,
  hasAnyContent,
  isUpdateForCurrentIteration,
  layerLabel
} from './verificationSelectors'
import type { VerificationFinding, VerificationReport } from '../../../shared/ipc'

describe('badgeLabel / badgeTone', () => {
  it('maps every badge to a label and tone', () => {
    expect(badgeLabel('pass')).toBe('Pass')
    expect(badgeTone('pass')).toBe('success')
    expect(badgeLabel('warning')).toBe('Warnings')
    expect(badgeTone('warning')).toBe('warning')
    expect(badgeLabel('fail')).toBe('Fail')
    expect(badgeTone('fail')).toBe('error')
    expect(badgeLabel('pending')).toBe('Pending')
    expect(badgeTone('pending')).toBe('default')
  })
})

describe('layerLabel', () => {
  it('gives a human label for every layer', () => {
    expect(layerLabel('static-script')).toBe('Static script')
    expect(layerLabel('brief-conformance')).toBe('Brief conformance')
  })
})

describe('groupFindingsByLayer', () => {
  const findings: VerificationFinding[] = [
    { layer: 'geometry', severity: 'info', message: 'info geo' },
    { layer: 'static-script', severity: 'blocking', message: 'blocking static' },
    { layer: 'geometry', severity: 'blocking', message: 'blocking geo' },
    { layer: 'brief-conformance', severity: 'suggestion', message: 'suggestion conformance' }
  ]

  it('buckets findings by layer', () => {
    const groups = groupFindingsByLayer(findings)
    const geometryGroup = groups.find((g) => g.layer === 'geometry')
    expect(geometryGroup?.findings).toHaveLength(2)
  })

  it('sorts each group most-severe first', () => {
    const groups = groupFindingsByLayer(findings)
    const geometryGroup = groups.find((g) => g.layer === 'geometry')
    expect(geometryGroup?.findings.map((f) => f.severity)).toEqual(['blocking', 'info'])
  })

  it('orders groups by their most severe finding', () => {
    const groups = groupFindingsByLayer(findings)
    expect(groups[0].findings[0].severity).toBe('blocking')
    expect(groups.at(-1)?.findings[0].severity).not.toBe('blocking')
  })

  it('returns no groups for an empty list', () => {
    expect(groupFindingsByLayer([])).toEqual([])
  })
})

describe('hasAnyContent', () => {
  it('is false for null or an empty report', () => {
    expect(hasAnyContent(null)).toBe(false)
    const empty: VerificationReport = { iteration: 1, badge: 'pass', findings: [], conformance: [], generatedAt: 'x' }
    expect(hasAnyContent(empty)).toBe(false)
  })

  it('is true once there is at least one finding or conformance row', () => {
    const withFinding: VerificationReport = {
      iteration: 1,
      badge: 'pass',
      findings: [{ layer: 'geometry', severity: 'info', message: 'x' }],
      conformance: [],
      generatedAt: 'x'
    }
    expect(hasAnyContent(withFinding)).toBe(true)
  })
})

describe('isUpdateForCurrentIteration', () => {
  const report = (iteration: number): VerificationReport => ({
    iteration,
    badge: 'pass',
    findings: [],
    conformance: [],
    generatedAt: 'x'
  })

  it('accepts a push matching the currently displayed iteration', () => {
    expect(isUpdateForCurrentIteration(report(3), 3)).toBe(true)
  })

  it('rejects a stale push for an older iteration that resolved late', () => {
    // e.g. iteration 2's slow layer-3 ray-cast resolves after iteration 3 already displayed.
    expect(isUpdateForCurrentIteration(report(2), 3)).toBe(false)
  })

  it('rejects any push while no model is displayed yet', () => {
    expect(isUpdateForCurrentIteration(report(1), null)).toBe(false)
  })
})
