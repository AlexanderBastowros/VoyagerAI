/**
 * Substitutes one named constant's numeric literal inside a script's `# --- PARAMS ---` /
 * `# --- END PARAMS ---` block (grammar documented in the printable-cad skill's SKILL.md
 * Phase 4, and mirrored by `python/extract_params.py`), leaving indentation, spacing, and the
 * trailing annotation comment untouched. This is the no-LLM edit path (architecture doc §7):
 * the value the user already picked is known exactly, so there's nothing to re-derive - only a
 * targeted text edit.
 */

const PARAMS_START = /^\s*#\s*---\s*PARAMS\s*---\s*$/
const PARAMS_END = /^\s*#\s*---\s*END PARAMS\s*---\s*$/

export type SubstituteParamResult = { ok: true; text: string } | { ok: false; reason: string }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches how `extract_params.py` prints its own extracted values - integers stay bare,
 *  floats round to 6 decimal places and drop trailing zeros. */
export function formatParamValue(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 1e6) / 1e6)
}

export function substituteParamValue(scriptText: string, name: string, value: number): SubstituteParamResult {
  const lines = scriptText.split('\n')

  let start = -1
  let end = -1
  let duplicate = false
  for (let i = 0; i < lines.length; i++) {
    if (PARAMS_START.test(lines[i])) {
      if (start === -1) start = i
      else duplicate = true
    } else if (PARAMS_END.test(lines[i])) {
      if (end === -1) end = i
      else duplicate = true
    }
  }
  if (duplicate) return { ok: false, reason: 'Script has more than one PARAMS block.' }
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, reason: 'Script has no PARAMS block.' }
  }

  const assignment = new RegExp(`^(\\s*)(${escapeRegExp(name)})(\\s*=\\s*)-?\\d+(?:\\.\\d+)?(\\s*(?:#.*)?)$`)
  for (let i = start + 1; i < end; i++) {
    const match = assignment.exec(lines[i])
    if (match) {
      const [, indent, paramName, eq, tail] = match
      lines[i] = `${indent}${paramName}${eq}${formatParamValue(value)}${tail}`
      return { ok: true, text: lines.join('\n') }
    }
  }
  return { ok: false, reason: `Parameter "${name}" was not found in the PARAMS block.` }
}
