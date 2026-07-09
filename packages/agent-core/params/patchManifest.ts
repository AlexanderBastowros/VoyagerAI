import type { ScriptManifest } from '@shared/ipc'

/**
 * Returns a copy of `manifest` with `name`'s current value replaced - the fast path for a
 * param edit, which knows the new value exactly and has no reason to re-derive the rest of the
 * manifest's structure (unit/min/max/label/brief) via a fresh extraction. Callers are expected
 * to have already run `validateParamUpdate` (name existence is not re-checked here); a `name`
 * that isn't present leaves the manifest unchanged rather than throwing.
 */
export function patchManifestValue(manifest: ScriptManifest, name: string, value: number): ScriptManifest {
  return {
    ...manifest,
    params: manifest.params.map((p) => (p.name === name ? { ...p, value } : p))
  }
}
