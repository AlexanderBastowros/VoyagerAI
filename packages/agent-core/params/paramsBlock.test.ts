import { describe, expect, it } from 'vitest'
import { formatParamValue, substituteParamValue } from './paramsBlock'

const SCRIPT = `from build123d import *

NOZZLE = 0.4  # unit=mm label="Nozzle diameter"

# --- PARAMS ---
WIDTH = 40.0     # unit=mm min=10 max=200 label="Width" brief=envelope.x
HEIGHT = 20.0    # unit=mm min=5 max=100 label="Height"
# --- END PARAMS ---

with BuildPart() as part:
    Box(WIDTH, HEIGHT, 10)
`

describe('substituteParamValue', () => {
  it('replaces only the target line, preserving indentation and the annotation comment', () => {
    const result = substituteParamValue(SCRIPT, 'WIDTH', 55)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('WIDTH = 55     # unit=mm min=10 max=200 label="Width" brief=envelope.x')
    expect(result.text).toContain('HEIGHT = 20.0    # unit=mm min=5 max=100 label="Height"')
    expect(result.text).toContain('NOZZLE = 0.4  # unit=mm label="Nozzle diameter"')
  })

  it('formats a float value with rounding, not as an integer', () => {
    const result = substituteParamValue(SCRIPT, 'HEIGHT', 22.5)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('HEIGHT = 22.5    # unit=mm min=5 max=100 label="Height"')
  })

  it('does not match a similarly-prefixed name (WIDTH vs WIDTH_2)', () => {
    const script = SCRIPT.replace('WIDTH = 40.0', 'WIDTH_2 = 40.0')
    const result = substituteParamValue(script, 'WIDTH', 55)
    expect(result).toEqual({ ok: false, reason: 'Parameter "WIDTH" was not found in the PARAMS block.' })
  })

  it('fails when the script has no PARAMS block', () => {
    const result = substituteParamValue('x = 1\n', 'WIDTH', 55)
    expect(result).toEqual({ ok: false, reason: 'Script has no PARAMS block.' })
  })

  it('fails when the name does not appear inside the block', () => {
    const result = substituteParamValue(SCRIPT, 'DEPTH', 5)
    expect(result).toEqual({ ok: false, reason: 'Parameter "DEPTH" was not found in the PARAMS block.' })
  })

  it('fails when the script has more than one PARAMS block', () => {
    const script = `${SCRIPT}\n# --- PARAMS ---\nDEPTH = 5  # unit=mm label="Depth"\n# --- END PARAMS ---\n`
    const result = substituteParamValue(script, 'WIDTH', 55)
    expect(result).toEqual({ ok: false, reason: 'Script has more than one PARAMS block.' })
  })
})

describe('formatParamValue', () => {
  it('renders whole numbers without a decimal point', () => {
    expect(formatParamValue(40)).toBe('40')
  })

  it('rounds floats to 6 decimal places and drops trailing zeros', () => {
    expect(formatParamValue(22.5)).toBe('22.5')
    expect(formatParamValue(1 / 3)).toBe('0.333333')
  })
})
