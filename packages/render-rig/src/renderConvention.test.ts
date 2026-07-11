import { describe, expect, it } from 'vitest'
import { renderDirForStl } from './renderConvention'

describe('renderDirForStl', () => {
  it('replaces the .stl extension with .renders, same basename', () => {
    expect(renderDirForStl('outputs/bracket_v3.stl')).toBe('outputs/bracket_v3.renders')
  })

  it('handles a bare filename with no directory component', () => {
    expect(renderDirForStl('bracket_v3.stl')).toBe('bracket_v3.renders')
  })

  it('is case-insensitive on the .stl extension', () => {
    expect(renderDirForStl('outputs/bracket_v3.STL')).toBe('outputs/bracket_v3.renders')
  })

  it('preserves a nested directory path', () => {
    expect(renderDirForStl('outputs/param-edits/abc/outputs/part.stl')).toBe(
      'outputs/param-edits/abc/outputs/part.renders'
    )
  })
})
