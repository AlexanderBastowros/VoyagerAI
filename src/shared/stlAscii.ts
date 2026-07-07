/**
 * Minimal ASCII STL parser.
 *
 * This exists so the app (and its tests) can sanity-check STL text without
 * pulling in three.js's STLLoader, which expects a DOM/Blob environment and
 * only reports triangle geometry, not a quick structural summary.
 */

export interface ParsedAsciiSTL {
  triangleCount: number
  vertexCount: number
  boundingBox: {
    min: [number, number, number]
    max: [number, number, number]
  }
}

const VERTEX_RE = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g

export function looksLikeAsciiSTL(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith('solid')
}

export function parseAsciiSTL(text: string): ParsedAsciiSTL {
  if (!looksLikeAsciiSTL(text)) {
    throw new Error('Not an ASCII STL: expected the file to start with "solid"')
  }

  const vertices: Array<[number, number, number]> = []
  VERTEX_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = VERTEX_RE.exec(text)) !== null) {
    vertices.push([Number(match[1]), Number(match[2]), Number(match[3])])
  }

  if (vertices.length === 0 || vertices.length % 3 !== 0) {
    throw new Error(`Malformed ASCII STL: found ${vertices.length} vertices (expected a multiple of 3)`)
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const [x, y, z] of vertices) {
    min[0] = Math.min(min[0], x)
    min[1] = Math.min(min[1], y)
    min[2] = Math.min(min[2], z)
    max[0] = Math.max(max[0], x)
    max[1] = Math.max(max[1], y)
    max[2] = Math.max(max[2], z)
  }

  return {
    triangleCount: vertices.length / 3,
    vertexCount: vertices.length,
    boundingBox: { min, max }
  }
}
