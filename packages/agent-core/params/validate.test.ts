import { describe, expect, it } from 'vitest'
import { validateParamUpdate } from './validate'
import type { ScriptManifest } from '@shared/ipc'

const MANIFEST: ScriptManifest = {
  params: [{ name: 'WIDTH', value: 40, unit: 'mm', label: 'Width', min: 10, max: 200 }],
  featureBindings: []
}

describe('validateParamUpdate', () => {
  it('accepts a value within range', () => {
    expect(validateParamUpdate(MANIFEST, 'WIDTH', 55)).toEqual({ ok: true })
  })

  it('accepts the boundary values themselves', () => {
    expect(validateParamUpdate(MANIFEST, 'WIDTH', 10)).toEqual({ ok: true })
    expect(validateParamUpdate(MANIFEST, 'WIDTH', 200)).toEqual({ ok: true })
  })

  it('rejects a non-finite value', () => {
    expect(validateParamUpdate(MANIFEST, 'WIDTH', Number.NaN)).toEqual({
      ok: false,
      reason: 'Parameter value must be a finite number.'
    })
    expect(validateParamUpdate(MANIFEST, 'WIDTH', Number.POSITIVE_INFINITY).ok).toBe(false)
  })

  it('rejects when there is no manifest', () => {
    expect(validateParamUpdate(null, 'WIDTH', 55)).toEqual({
      ok: false,
      reason: 'No parameters are available for this iteration.'
    })
  })

  it('rejects when the manifest has no params', () => {
    expect(validateParamUpdate({ params: [], featureBindings: [] }, 'WIDTH', 55)).toEqual({
      ok: false,
      reason: 'No parameters are available for this iteration.'
    })
  })

  it('rejects an unknown parameter name', () => {
    expect(validateParamUpdate(MANIFEST, 'DEPTH', 5)).toEqual({ ok: false, reason: 'Unknown parameter "DEPTH".' })
  })

  it('rejects a value below min', () => {
    expect(validateParamUpdate(MANIFEST, 'WIDTH', 5)).toEqual({
      ok: false,
      reason: 'Width must be at least 10 mm.'
    })
  })

  it('rejects a value above max', () => {
    expect(validateParamUpdate(MANIFEST, 'WIDTH', 250)).toEqual({
      ok: false,
      reason: 'Width must be at most 200 mm.'
    })
  })

  it('accepts any value when min/max are absent', () => {
    const manifest: ScriptManifest = { params: [{ name: 'ANGLE', value: 0, unit: 'deg', label: 'Angle' }], featureBindings: [] }
    expect(validateParamUpdate(manifest, 'ANGLE', 999)).toEqual({ ok: true })
  })
})
