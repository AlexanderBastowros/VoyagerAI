#!/usr/bin/env node
/**
 * Generates resources/sample/cube.stl: a 20mm ASCII STL cube used as the
 * Milestone 1 "Load sample" dev fixture. Re-run with `npm run generate:sample-stl`
 * if the fixture ever needs to be regenerated.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 20 // mm, matches a typical 3D-printer calibration cube
const HALF = SIZE / 2

// Cube sits on the z=0 plane (like a model resting on the viewport grid),
// centered on x/y, spanning z in [0, SIZE].
const b0 = [-HALF, -HALF, 0]
const b1 = [HALF, -HALF, 0]
const b2 = [HALF, HALF, 0]
const b3 = [-HALF, HALF, 0]
const t0 = [-HALF, -HALF, SIZE]
const t1 = [HALF, -HALF, SIZE]
const t2 = [HALF, HALF, SIZE]
const t3 = [-HALF, HALF, SIZE]

// 12 triangles (2 per face x 6 faces), wound counter-clockwise when viewed
// from outside so computed normals point outward.
const faces = [
  [b0, b2, b1],
  [b0, b3, b2], // bottom, -Z
  [t0, t1, t2],
  [t0, t2, t3], // top, +Z
  [b0, b1, t1],
  [b0, t1, t0], // front, -Y
  [b3, t2, b2],
  [b3, t3, t2], // back, +Y
  [b0, t0, t3],
  [b0, t3, b3], // left, -X
  [b1, b2, t2],
  [b1, t2, t1] // right, +X
]

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

function fmt(n) {
  return n.toFixed(6)
}

const lines = ['solid cube']
for (const [a, b, c] of faces) {
  const normal = normalize(cross(sub(b, a), sub(c, a)))
  lines.push(`facet normal ${fmt(normal[0])} ${fmt(normal[1])} ${fmt(normal[2])}`)
  lines.push('  outer loop')
  for (const v of [a, b, c]) {
    lines.push(`    vertex ${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`)
  }
  lines.push('  endloop')
  lines.push('endfacet')
}
lines.push('endsolid cube')

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = join(__dirname, '..', 'resources', 'sample', 'cube.stl')
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
console.log(`Wrote ${outPath}`)
