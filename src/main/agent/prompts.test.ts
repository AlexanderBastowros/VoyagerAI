import { describe, expect, it } from 'vitest'
import { buildUserMessage, formatSelectionContext, systemPromptAppend } from './prompts'
import type { SelectionSummary } from '../../shared/ipc'

const selection: SelectionSummary = {
  bboxMin: [1.234567, -2, 0],
  bboxMax: [11.234567, 8, 5.5],
  centroid: [6.234567, 3, 2.75],
  dims: [10, 10, 5.5],
  triCount: 42
}

describe('formatSelectionContext', () => {
  it('formats every coordinate to two decimals in mm', () => {
    const block = formatSelectionContext(selection)
    expect(block).toContain('(1.23, -2.00, 0.00) mm')
    expect(block).toContain('(11.23, 8.00, 5.50) mm')
    expect(block).toContain('Centroid: (6.23, 3.00, 2.75) mm')
    expect(block).toContain('10.00 x 10.00 x 5.50 mm')
    expect(block).toContain('Triangle count: 42')
  })

  it('marks the block as machine-generated, not user-typed', () => {
    expect(formatSelectionContext(selection)).toMatch(/not typed by the user/i)
  })
})

describe('buildUserMessage', () => {
  it('returns the text unchanged when there is no selection', () => {
    expect(buildUserMessage('make it taller')).toBe('make it taller')
    expect(buildUserMessage('make it taller', null)).toBe('make it taller')
  })

  it('appends the selection block after the text when a region is highlighted', () => {
    const message = buildUserMessage('make this hole 5mm', selection)
    expect(message.startsWith('make this hole 5mm\n\n')).toBe(true)
    expect(message).toContain('Selected region')
  })
})

describe('systemPromptAppend', () => {
  it('mentions the project dir, outputs versioning, display_model, and the managed python', () => {
    const prompt = systemPromptAppend('/tmp/project')
    expect(prompt).toContain('/tmp/project')
    expect(prompt).toContain('./outputs/')
    expect(prompt).toContain('display_model')
    expect(prompt).toMatch(/build123d/)
    expect(prompt).toMatch(/never generate `?viewer\.html`?/i)
  })
})
