import { describe, expect, it } from 'vitest'
import {
  minTeethToAvoidUndercut,
  runGearSpecCheck,
  theoreticalCenterDistanceMm,
  virtualToothCount
} from './gearsSpecCheck'
import type { GearFeatureSpec } from './gearsSpecCheck'

function pinion(overrides: Partial<GearFeatureSpec> = {}): GearFeatureSpec {
  return {
    id: 'pinion',
    label: 'Pinion',
    moduleMm: 1.5,
    teeth: 20,
    pressureAngleDeg: 20,
    meshesWith: 'wheel',
    ...overrides
  }
}

function wheel(overrides: Partial<GearFeatureSpec> = {}): GearFeatureSpec {
  return {
    id: 'wheel',
    label: 'Wheel',
    moduleMm: 1.5,
    teeth: 40,
    pressureAngleDeg: 20,
    meshesWith: 'pinion',
    ...overrides
  }
}

describe('pure gear math helpers (hand-computed fixture numbers)', () => {
  it('minTeethToAvoidUndercut matches the widely-cited 20deg/14.5deg textbook figures', () => {
    // 2 / sin(20deg)^2 = 2 / 0.116978... = 17.09726... (commonly cited as ~17)
    expect(minTeethToAvoidUndercut(20)).toBeCloseTo(17.09726, 3)
    // 2 / sin(14.5deg)^2 = 2 / 0.062690... = 31.90294... (commonly cited as ~32)
    expect(minTeethToAvoidUndercut(14.5)).toBeCloseTo(31.90294, 3)
  })

  it('virtualToothCount is a no-op for a spur gear and grows for a helical gear', () => {
    expect(virtualToothCount(20)).toBe(20)
    expect(virtualToothCount(20, 0)).toBe(20)
    // 12 / cos(30deg)^3 = 12 / 0.649519... = 18.47521...
    expect(virtualToothCount(12, 30)).toBeCloseTo(18.47521, 3)
  })

  it('theoreticalCenterDistanceMm is m*(z1+z2)/2 for a spur pair', () => {
    // module 1.5 * (20 + 40) / 2 = 45 - the roadmap's "done when" pair.
    expect(theoreticalCenterDistanceMm(pinion(), wheel())).toBeCloseTo(45, 6)
  })

  it('theoreticalCenterDistanceMm applies the transverse-module correction for a helical pair', () => {
    // module 1.5, helix 30deg -> transverse module = 1.5 / cos(30deg) = 1.5 / 0.866025 = 1.73205
    // center distance = 1.73205 * (20 + 40) / 2 = 51.9615
    const a = pinion({ helixDeg: 30 })
    const b = wheel({ helixDeg: -30 })
    expect(theoreticalCenterDistanceMm(a, b)).toBeCloseTo(51.9615, 3)
  })
})

describe('runGearSpecCheck - the roadmap "done when" spur pair', () => {
  it('20/40 teeth, module 1.5, 20deg PA, placed at the exact 45mm center distance: all pass, no blocking findings', () => {
    const a = pinion({ axisPositionMm: [0, 0, 0] })
    const b = wheel({ axisPositionMm: [45, 0, 0] })

    const result = runGearSpecCheck({ gears: [a, b] })

    expect(result.findings.some((f) => f.severity === 'blocking')).toBe(false)
    expect(result.conformance.every((row) => row.pass)).toBe(true)
    expect(result.conformance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ briefField: 'features.pinion+wheel.module', pass: true }),
        expect.objectContaining({ briefField: 'features.pinion+wheel.pressureAngle', pass: true }),
        expect.objectContaining({ briefField: 'features.pinion+wheel.centerDistance', pass: true })
      ])
    )
    // No BACKLASH allowance configured yet - informational only, not a hard failure.
    expect(
      result.findings.some((f) => f.severity === 'info' && f.message.includes('Backlash') && f.message.includes('not checked'))
    ).toBe(true)
  })

  it('processes a reciprocally-declared pair exactly once (no duplicate conformance rows)', () => {
    const a = pinion({ axisPositionMm: [0, 0, 0] })
    const b = wheel({ axisPositionMm: [45, 0, 0] })

    const result = runGearSpecCheck({ gears: [a, b] })

    expect(result.conformance.filter((row) => row.briefField === 'features.pinion+wheel.module')).toHaveLength(1)
  })
})

describe('runGearSpecCheck - herringbone pair (matched, opposite-hand helix)', () => {
  it('passes module/PA/helix checks and computes the transverse-module center distance', () => {
    const a = pinion({ helixDeg: 30, axisPositionMm: [0, 0, 0] })
    const b = wheel({ helixDeg: -30, axisPositionMm: [51.9615, 0, 0] })

    const result = runGearSpecCheck({ gears: [a, b] })

    expect(result.findings.some((f) => f.severity === 'blocking')).toBe(false)
    const centerRow = result.conformance.find((row) => row.briefField === 'features.pinion+wheel.centerDistance')
    expect(centerRow?.pass).toBe(true)
  })

  it('flags a same-hand helix pair as a suggestion (not blocking) - likely a crossed-axis pair or a sign mistake', () => {
    const a = pinion({ helixDeg: 30 })
    const b = wheel({ helixDeg: 30 })

    const result = runGearSpecCheck({ gears: [a, b] })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'suggestion', briefField: 'features.pinion+wheel.helix' })
    )
    expect(result.findings.some((f) => f.severity === 'blocking')).toBe(false)
  })
})

describe('runGearSpecCheck - spec mismatches', () => {
  it('flags a module mismatch as blocking with a failing conformance row', () => {
    const a = pinion()
    const b = wheel({ moduleMm: 2.0 })

    const result = runGearSpecCheck({ gears: [a, b] })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'blocking', briefField: 'features.pinion+wheel.module' })
    )
    expect(result.conformance.find((r) => r.briefField === 'features.pinion+wheel.module')?.pass).toBe(false)
  })

  it('flags a pressure-angle mismatch as blocking with a failing conformance row', () => {
    const a = pinion()
    const b = wheel({ pressureAngleDeg: 14.5 })

    const result = runGearSpecCheck({ gears: [a, b] })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'blocking', briefField: 'features.pinion+wheel.pressureAngle' })
    )
    expect(result.conformance.find((r) => r.briefField === 'features.pinion+wheel.pressureAngle')?.pass).toBe(false)
  })

  it('flags a spur-vs-helical mismatch as blocking', () => {
    const a = pinion()
    const b = wheel({ helixDeg: 20 })

    const result = runGearSpecCheck({ gears: [a, b] })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'blocking', briefField: 'features.pinion+wheel.helix' })
    )
  })

  it('flags a center distance that does not match the formula as blocking', () => {
    // Theoretical is 45mm; place them 50mm apart instead.
    const a = pinion({ axisPositionMm: [0, 0, 0] })
    const b = wheel({ axisPositionMm: [50, 0, 0] })

    const result = runGearSpecCheck({ gears: [a, b] })

    const finding = result.findings.find((f) => f.briefField === 'features.pinion+wheel.centerDistance')
    expect(finding?.severity).toBe('blocking')
    expect(finding?.message).toContain('45.00 mm')
    expect(finding?.message).toContain('50.00 mm')
    expect(result.conformance.find((r) => r.briefField === 'features.pinion+wheel.centerDistance')?.pass).toBe(false)
  })

  it('reports center distance as informational (not blocking) when axis positions are unknown', () => {
    const result = runGearSpecCheck({ gears: [pinion(), wheel()] })

    const finding = result.findings.find((f) => f.briefField === 'features.pinion+wheel.centerDistance')
    expect(finding?.severity).toBe('info')
    expect(result.conformance.some((r) => r.briefField === 'features.pinion+wheel.centerDistance')).toBe(false)
  })
})

describe('runGearSpecCheck - meshesWith bookkeeping', () => {
  it('flags a gear with no declared mesh partner as a suggestion and skips its pair checks', () => {
    const lone = pinion({ meshesWith: undefined })

    const result = runGearSpecCheck({ gears: [lone] })

    expect(result.findings).toEqual([
      expect.objectContaining({ severity: 'suggestion', briefField: 'features.pinion.meshesWith' })
    ])
    expect(result.conformance).toEqual([])
  })

  it('flags a dangling meshesWith reference as blocking', () => {
    const a = pinion({ meshesWith: 'ghost' })

    const result = runGearSpecCheck({ gears: [a] })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'blocking', briefField: 'features.pinion.meshesWith' })
    )
  })

  it('flags an asymmetric meshesWith declaration as a suggestion', () => {
    const a = pinion({ meshesWith: 'wheel' })
    const b = wheel({ meshesWith: 'idler' }) // points somewhere else entirely
    const idler = pinion({ id: 'idler', label: 'Idler', meshesWith: undefined })

    const result = runGearSpecCheck({ gears: [a, b, idler] })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'suggestion', briefField: 'features.pinion.meshesWith' })
    )
  })
})

describe('runGearSpecCheck - undercut', () => {
  it('flags a low tooth count spur gear below the undercut threshold', () => {
    const thin = pinion({ id: 'thin', teeth: 10, moduleMm: 1.5, meshesWith: undefined })

    const result = runGearSpecCheck({ gears: [thin] })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'suggestion', briefField: 'features.thin.teeth' })
    )
  })

  it('does not flag undercut for a helical gear whose virtual tooth count clears the threshold', () => {
    // 12 real teeth would undercut as a spur (12 < 17.09) but virtualToothCount(12, 30) ~= 18.47.
    const helicalPinion = pinion({ id: 'helical', teeth: 12, helixDeg: 30, meshesWith: undefined })

    const result = runGearSpecCheck({ gears: [helicalPinion] })

    expect(result.findings.some((f) => f.briefField === 'features.helical.teeth')).toBe(false)
  })

  it('does not flag a healthy tooth count', () => {
    const result = runGearSpecCheck({ gears: [pinion({ meshesWith: undefined }), wheel({ meshesWith: undefined })] })

    expect(result.findings.some((f) => f.message.includes('undercut'))).toBe(false)
  })
})

describe('runGearSpecCheck - backlash', () => {
  it('is silent when both backlash values match and fall inside the configured allowance', () => {
    const a = pinion({ backlashMm: 0.1 })
    const b = wheel({ backlashMm: 0.1 })

    const result = runGearSpecCheck({ gears: [a, b], backlashAllowanceMm: { minMm: 0.05, maxMm: 0.2 } })

    expect(result.findings.some((f) => f.briefField === 'features.pinion+wheel.backlash')).toBe(false)
  })

  it('flags mismatched backlash values between the two gears', () => {
    const a = pinion({ backlashMm: 0.1 })
    const b = wheel({ backlashMm: 0.25 })

    const result = runGearSpecCheck({ gears: [a, b], backlashAllowanceMm: { minMm: 0.05, maxMm: 0.3 } })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'suggestion', briefField: 'features.pinion+wheel.backlash' })
    )
  })

  it('flags backlash below the configured minimum', () => {
    const a = pinion({ backlashMm: 0.01 })
    const b = wheel({ backlashMm: 0.01 })

    const result = runGearSpecCheck({ gears: [a, b], backlashAllowanceMm: { minMm: 0.05, maxMm: 0.3 } })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'suggestion', briefField: 'features.pinion+wheel.backlash' })
    )
  })

  it('flags backlash above the configured maximum', () => {
    const a = pinion({ backlashMm: 0.5 })
    const b = wheel({ backlashMm: 0.5 })

    const result = runGearSpecCheck({ gears: [a, b], backlashAllowanceMm: { minMm: 0.05, maxMm: 0.3 } })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'suggestion', briefField: 'features.pinion+wheel.backlash' })
    )
  })

  it('reports backlash as informational when the allowance is configured but a value is missing', () => {
    const a = pinion({ backlashMm: 0.1 })
    const b = wheel() // no backlashMm

    const result = runGearSpecCheck({ gears: [a, b], backlashAllowanceMm: { minMm: 0.05, maxMm: 0.3 } })

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'info', briefField: 'features.pinion+wheel.backlash' })
    )
  })
})

describe('runGearSpecCheck - layer tagging', () => {
  it('defaults every finding to the brief-conformance layer', () => {
    const result = runGearSpecCheck({ gears: [pinion({ meshesWith: undefined })] })
    expect(result.findings.every((f) => f.layer === 'brief-conformance')).toBe(true)
  })

  it('accepts a layer override', () => {
    const result = runGearSpecCheck({ gears: [pinion({ meshesWith: undefined })], layer: 'geometry' })
    expect(result.findings.every((f) => f.layer === 'geometry')).toBe(true)
  })
})
