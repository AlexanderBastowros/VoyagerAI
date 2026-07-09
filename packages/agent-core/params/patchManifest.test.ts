import { describe, expect, it } from 'vitest'
import { patchManifestValue } from './patchManifest'
import type { ScriptManifest } from '@shared/ipc'

const MANIFEST: ScriptManifest = {
  params: [
    { name: 'WIDTH', value: 40, unit: 'mm', label: 'Width', min: 10, max: 200 },
    { name: 'HEIGHT', value: 20, unit: 'mm', label: 'Height' }
  ],
  featureBindings: [{ featureId: 'f1', paramName: 'WIDTH' }]
}

describe('patchManifestValue', () => {
  it('replaces only the matching entry value', () => {
    const patched = patchManifestValue(MANIFEST, 'WIDTH', 55)
    expect(patched.params).toEqual([
      { name: 'WIDTH', value: 55, unit: 'mm', label: 'Width', min: 10, max: 200 },
      { name: 'HEIGHT', value: 20, unit: 'mm', label: 'Height' }
    ])
  })

  it('leaves feature bindings and unrelated params untouched', () => {
    const patched = patchManifestValue(MANIFEST, 'WIDTH', 55)
    expect(patched.featureBindings).toEqual(MANIFEST.featureBindings)
    expect(patched.params[1]).toEqual(MANIFEST.params[1])
  })

  it('does not mutate the input manifest', () => {
    patchManifestValue(MANIFEST, 'WIDTH', 55)
    expect(MANIFEST.params[0].value).toBe(40)
  })

  it('returns an equivalent manifest when the name is not found', () => {
    const patched = patchManifestValue(MANIFEST, 'DEPTH', 5)
    expect(patched).toEqual(MANIFEST)
  })
})
