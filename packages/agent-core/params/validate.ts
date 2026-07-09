import type { ScriptManifest } from '@shared/ipc'

export type ParamUpdateValidation = { ok: true } | { ok: false; reason: string }

/** Checks a `param:update` request against the manifest before any script re-run happens - an
 *  unknown name or an out-of-range value is rejected here, for free, instead of burning a
 *  python invocation on it. */
export function validateParamUpdate(
  manifest: ScriptManifest | null,
  name: string,
  value: number
): ParamUpdateValidation {
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'Parameter value must be a finite number.' }
  }
  if (!manifest || manifest.params.length === 0) {
    return { ok: false, reason: 'No parameters are available for this iteration.' }
  }
  const entry = manifest.params.find((p) => p.name === name)
  if (!entry) {
    return { ok: false, reason: `Unknown parameter "${name}".` }
  }
  if (entry.min !== undefined && value < entry.min) {
    return { ok: false, reason: `${entry.label} must be at least ${entry.min} ${entry.unit}.` }
  }
  if (entry.max !== undefined && value > entry.max) {
    return { ok: false, reason: `${entry.label} must be at most ${entry.max} ${entry.unit}.` }
  }
  return { ok: true }
}
