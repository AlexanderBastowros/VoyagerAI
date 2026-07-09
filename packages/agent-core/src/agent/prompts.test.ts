import { describe, expect, it } from 'vitest'
import { buildUserMessage, formatRevertContext, formatSelectionContext, systemPromptAppend } from './prompts'
import type { ChatAttachment, SelectionSummary } from '@shared/ipc'
import type { ProjectIteration } from '../projects/store'

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

function iteration(overrides: Partial<ProjectIteration> = {}): ProjectIteration {
  return {
    n: 2,
    stlPath: 'outputs/part_v2.stl',
    scriptPath: 'outputs/part_v2.py',
    scriptSnapshotPath: 'outputs/versions/v2.py',
    summary: 'v2',
    at: '2024-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('formatRevertContext', () => {
  it('names the reverted version and its snapshot script, and marks the block machine-generated', () => {
    const block = formatRevertContext(iteration(), 5)
    expect(block).toContain('reverted to model v2')
    expect(block).toContain('`outputs/versions/v2.py`')
    expect(block).toMatch(/not typed by the user/i)
  })

  it('lists the superseded range of later versions', () => {
    expect(formatRevertContext(iteration({ n: 2 }), 5)).toContain('v3-v5')
    // A single superseding version reads as just that version, not a range.
    expect(formatRevertContext(iteration({ n: 2 }), 3)).toContain('v3')
    expect(formatRevertContext(iteration({ n: 2 }), 3)).not.toContain('v3-')
  })

  it('falls back to scriptPath when a pre-snapshot record has no scriptSnapshotPath', () => {
    const block = formatRevertContext(iteration({ scriptSnapshotPath: undefined }), 3)
    expect(block).toContain('`outputs/part_v2.py`')
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

  it('appends the revert context after the text', () => {
    const revert = formatRevertContext(iteration(), 5)
    const message = buildUserMessage('make the base thicker', null, undefined, revert) as string
    expect(message.startsWith('make the base thicker\n\n')).toBe(true)
    expect(message).toContain('Reverted model')
  })

  it('includes both selection and revert blocks when both are present', () => {
    const revert = formatRevertContext(iteration(), 5)
    const message = buildUserMessage('tweak this', selection, undefined, revert) as string
    expect(message).toContain('Selected region')
    expect(message).toContain('Reverted model')
    // Selection block comes before revert block.
    expect(message.indexOf('Selected region')).toBeLessThan(message.indexOf('Reverted model'))
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

  it('instructs the agent to call recommend_print_settings when the user asks for print settings', () => {
    const prompt = systemPromptAppend('/tmp/project')
    expect(prompt).toContain('recommend_print_settings')
  })

  it('documents the per-version script snapshots and the reverted-model rebase behavior', () => {
    const prompt = systemPromptAppend('/tmp/project')
    expect(prompt).toContain('outputs/versions/vN.py')
    expect(prompt).toContain('Reverted model')
  })
})
