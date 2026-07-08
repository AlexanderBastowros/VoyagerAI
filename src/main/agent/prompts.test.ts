import { describe, expect, it } from 'vitest'
import { buildUserMessage, formatSelectionContext, systemPromptAppend } from './prompts'
import type { ChatAttachment, SelectionSummary } from '../../shared/ipc'

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
    const message = buildUserMessage('make this hole 5mm', selection) as string
    expect(message.startsWith('make this hole 5mm\n\n')).toBe(true)
    expect(message).toContain('Selected region')
  })

  it('returns the text unchanged when attachments is an empty array', () => {
    expect(buildUserMessage('make it taller', null, [])).toBe('make it taller')
  })

  it('turns into an image-blocks-then-text content array when images are attached', () => {
    const attachments: ChatAttachment[] = [
      { data: 'aGVsbG8=', mediaType: 'image/png', name: 'reference.png' },
      { data: 'd29ybGQ=', mediaType: 'image/jpeg', name: 'photo.jpg' }
    ]
    const message = buildUserMessage('match this reference', null, attachments)

    expect(Array.isArray(message)).toBe(true)
    const blocks = message as Array<{ type: string }>
    expect(blocks.map((b) => b.type)).toEqual(['image', 'image', 'text'])
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
    })
    expect(blocks[2]).toEqual({ type: 'text', text: 'match this reference' })
  })

  it('still includes the selection block in the trailing text block when both are present', () => {
    const message = buildUserMessage('make this hole 5mm', selection, [
      { data: 'x', mediaType: 'image/png', name: 'ref.png' }
    ])
    const blocks = message as Array<{ type: string; text?: string }>
    expect(blocks.at(-1)?.type).toBe('text')
    expect(blocks.at(-1)?.text).toContain('Selected region')
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
