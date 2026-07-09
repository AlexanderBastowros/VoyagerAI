import { describe, expect, it } from 'vitest'
import { emptyScriptManifest, isScriptManifest, ScriptManifestSchema } from './manifest'

describe('emptyScriptManifest', () => {
  it('produces a schema-valid manifest', () => {
    expect(ScriptManifestSchema.safeParse(emptyScriptManifest()).success).toBe(true)
  })
})

describe('isScriptManifest', () => {
  it('accepts params and feature bindings', () => {
    const manifest = {
      params: [{ name: 'WIDTH', value: 40, unit: 'mm', min: 10, max: 100, label: 'Width', brief: 'envelope.x' }],
      featureBindings: [{ featureId: 'f1', paramName: 'WIDTH', dragAxis: 'x' }]
    }
    expect(isScriptManifest(manifest)).toBe(true)
  })

  it('rejects malformed shapes', () => {
    expect(isScriptManifest(null)).toBe(false)
    expect(isScriptManifest({ params: [{ name: 'WIDTH' }], featureBindings: [] })).toBe(false)
  })

  it('accepts an importedBase marker (WS-G remix, §12.5)', () => {
    const manifest = {
      params: [],
      featureBindings: [],
      importedBase: { path: 'imports/thingiverse-bracket.step', lineage: 'step' }
    }
    expect(isScriptManifest(manifest)).toBe(true)
  })

  it('rejects an importedBase with an unknown lineage', () => {
    const manifest = {
      params: [],
      featureBindings: [],
      importedBase: { path: 'imports/scan.obj', lineage: 'brep' }
    }
    expect(isScriptManifest(manifest)).toBe(false)
  })
})
