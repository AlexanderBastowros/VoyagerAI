import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { looksLikeAsciiSTL, parseAsciiSTL } from './stlAscii'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sampleStlPath = join(__dirname, '..', '..', 'resources', 'sample', 'cube.stl')

describe('parseAsciiSTL', () => {
  it('rejects input that does not start with "solid"', () => {
    expect(() => parseAsciiSTL('not an stl')).toThrow(/Not an ASCII STL/)
  })

  it('rejects malformed vertex data', () => {
    expect(() => parseAsciiSTL('solid x\nfacet normal 0 0 1\n')).toThrow(/Malformed/)
  })

  it('parses the bundled sample cube into 12 triangles with a 20mm bounding box', () => {
    const text = readFileSync(sampleStlPath, 'utf8')
    expect(looksLikeAsciiSTL(text)).toBe(true)

    const parsed = parseAsciiSTL(text)
    expect(parsed.triangleCount).toBe(12)
    expect(parsed.vertexCount).toBe(36)
    expect(parsed.boundingBox.min).toEqual([-10, -10, 0])
    expect(parsed.boundingBox.max).toEqual([10, 10, 20])
  })
})
