import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildGraduationPackage, type BuildGraduationPackageInput, type PackageFsDeps } from './exportPackage'

const projectDir = '/home/user/.config/voyager/projects/default'
const STAMP = new Date(2026, 6, 10, 12, 30, 0)

/** In-memory fake `PackageFsDeps`, keyed by absolute path - lets tests assert exactly which
 *  artifacts get bundled without touching a real filesystem. */
function fakeFs(files: Record<string, string>): PackageFsDeps {
  return {
    async fileExists(absPath) {
      return absPath in files
    },
    async readFile(absPath) {
      const content = files[absPath]
      if (content === undefined) throw new Error(`ENOENT: ${absPath}`)
      return Buffer.from(content, 'utf-8')
    }
  }
}

/** Reads back a zip built by `writeZip` (agent-core's dependency-free reader used by
 *  `zipWriter.test.ts`, trimmed to just what these tests need: names + decompressed contents). */
function readZipEntries(archive: Buffer): Map<string, string> {
  const eocdOffset = archive.length - 22
  const entryCount = archive.readUInt16LE(eocdOffset + 8)
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)
  const contents = new Map<string, string>()
  let cursor = centralOffset
  for (let i = 0; i < entryCount; i++) {
    const method = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const payload = archive.subarray(dataStart, dataStart + compressedSize)
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload)
    contents.set(name, data.toString('utf-8'))
    cursor += 46 + nameLength
  }
  return contents
}

function baseInput(overrides: Partial<BuildGraduationPackageInput> = {}): BuildGraduationPackageInput {
  return {
    projectDir,
    projectName: 'Hinge Box',
    parts: [
      {
        id: 'bracket',
        name: 'Bracket',
        iteration: {
          n: 2,
          stlPath: 'outputs/bracket_v2.stl',
          stepPath: 'outputs/bracket_v2.step',
          scriptPath: 'outputs/bracket_v2.py',
          scriptSnapshotPath: 'outputs/versions/bracket/v2.py'
        }
      }
    ],
    manifests: { bracket: null },
    now: STAMP,
    ...overrides
  }
}

describe('buildGraduationPackage', () => {
  it('bundles STL + STEP + 3MF + script + manifest + README for a single part', async () => {
    const deps = fakeFs({
      [join(projectDir, 'outputs/bracket_v2.stl')]: 'solid bracket',
      [join(projectDir, 'outputs/bracket_v2.step')]: 'ISO-10303-21;',
      [join(projectDir, 'outputs/bracket_v2.3mf')]: '3mf-bytes',
      [join(projectDir, 'outputs/versions/bracket/v2.py')]: 'print("bracket")'
    })
    const result = await buildGraduationPackage(baseInput(), deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.zipFileName).toBe('bracket_v2-package.zip')

    const contents = readZipEntries(result.zipBuffer)
    expect([...contents.keys()].sort()).toEqual(
      ['README.md', 'bracket_v2.3mf', 'bracket_v2.py', 'bracket_v2.step', 'bracket_v2.stl', 'manifest.json'].sort()
    )
    expect(contents.get('bracket_v2.py')).toBe('print("bracket")')
    expect(contents.get('README.md')).toMatch(/bracket_v2\.step/)
    expect(contents.get('README.md')).toMatch(/pip install build123d/)
  })

  it("notes which locked brief version a part's iteration was generated against", async () => {
    const deps = fakeFs({ [join(projectDir, 'outputs/bracket_v2.stl')]: 'solid bracket' })
    const input = baseInput({
      parts: [
        {
          id: 'bracket',
          name: 'Bracket',
          iteration: { n: 2, stlPath: 'outputs/bracket_v2.stl', scriptPath: 'x.py', briefVersion: 4 }
        }
      ]
    })
    const result = await buildGraduationPackage(input, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readZipEntries(result.zipBuffer).get('README.md')).toMatch(/Generated against locked Design Brief v4/)
  })

  it('prefers scriptSnapshotPath over scriptPath for the .py entry', async () => {
    const deps = fakeFs({
      [join(projectDir, 'outputs/bracket_v2.stl')]: 'solid bracket',
      [join(projectDir, 'outputs/versions/bracket/v2.py')]: 'SNAPSHOT SOURCE',
      [join(projectDir, 'outputs/bracket_v2.py')]: 'LIVE SOURCE (should not be used)'
    })
    const result = await buildGraduationPackage(baseInput(), deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readZipEntries(result.zipBuffer).get('bracket_v2.py')).toBe('SNAPSHOT SOURCE')
  })

  it('degrades gracefully when STEP/3MF/script are absent (mesh-lineage), noting it in the README', async () => {
    const deps = fakeFs({ [join(projectDir, 'outputs/bracket_v2.stl')]: 'solid bracket' })
    const input = baseInput({
      parts: [
        {
          id: 'bracket',
          name: 'Bracket',
          iteration: { n: 2, stlPath: 'outputs/bracket_v2.stl', scriptPath: 'outputs/bracket_v2.py' }
        }
      ]
    })
    const result = await buildGraduationPackage(input, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const contents = readZipEntries(result.zipBuffer)
    expect([...contents.keys()].sort()).toEqual(['README.md', 'bracket_v2.stl', 'manifest.json'].sort())
    expect(contents.get('README.md')).toMatch(/No STEP was recorded/)
    expect(contents.get('README.md')).toMatch(/No 3MF was recorded/)
  })

  it('bundles every part with its own prefix and a combined manifest.json', async () => {
    const deps = fakeFs({
      [join(projectDir, 'outputs/bracket_v2.stl')]: 'solid bracket',
      [join(projectDir, 'outputs/lid_v1.stl')]: 'solid lid'
    })
    const input = baseInput({
      projectName: 'Hinge Box',
      parts: [
        { id: 'bracket', name: 'Bracket', iteration: { n: 2, stlPath: 'outputs/bracket_v2.stl', scriptPath: 'x.py' } },
        { id: 'lid', name: 'Lid', iteration: { n: 1, stlPath: 'outputs/lid_v1.stl', scriptPath: 'y.py' } }
      ],
      manifests: {
        bracket: { params: [{ name: 'width', value: 10, unit: 'mm', label: 'Width' }], featureBindings: [] },
        lid: null
      }
    })
    const result = await buildGraduationPackage(input, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.zipFileName).toBe('hinge-box-package.zip')
    const contents = readZipEntries(result.zipBuffer)
    expect([...contents.keys()].sort()).toEqual(
      ['README.md', 'bracket_v2.stl', 'lid_v1.stl', 'manifest.json'].sort()
    )
    const manifestDoc = JSON.parse(contents.get('manifest.json')!)
    expect(manifestDoc.parts.bracket.manifest.params[0].name).toBe('width')
    expect(manifestDoc.parts.lid.manifest).toBeNull()
  })

  it('bundles the locked brief as brief.v{K}.json when given', async () => {
    const deps = fakeFs({ [join(projectDir, 'outputs/bracket_v2.stl')]: 'solid bracket' })
    const input = baseInput({
      parts: [{ id: 'bracket', name: 'Bracket', iteration: { n: 2, stlPath: 'outputs/bracket_v2.stl', scriptPath: 'x.py' } }],
      lockedBrief: { version: 3, json: '{"version":3}' }
    })
    const result = await buildGraduationPackage(input, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const contents = readZipEntries(result.zipBuffer)
    expect(contents.get('brief.v3.json')).toBe('{"version":3}')
    expect(contents.get('README.md')).toMatch(/brief\.v3\.json/)
  })

  it('omits brief.*.json entirely when the project has never locked a brief', async () => {
    const deps = fakeFs({ [join(projectDir, 'outputs/bracket_v2.stl')]: 'solid bracket' })
    const input = baseInput({
      parts: [{ id: 'bracket', name: 'Bracket', iteration: { n: 2, stlPath: 'outputs/bracket_v2.stl', scriptPath: 'x.py' } }]
    })
    const result = await buildGraduationPackage(input, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const names = [...readZipEntries(result.zipBuffer).keys()]
    expect(names.some((n) => n.startsWith('brief.'))).toBe(false)
  })

  it('rejects when there are no parts to package', async () => {
    const result = await buildGraduationPackage(baseInput({ parts: [] }), fakeFs({}))
    expect(result).toEqual({ ok: false, reason: 'No model has been generated yet.' })
  })

  it('fails the whole package when a recorded path escapes the project directory', async () => {
    const deps = fakeFs({})
    const input = baseInput({
      parts: [
        {
          id: 'evil',
          name: 'Evil',
          iteration: { n: 1, stlPath: '../../etc/passwd', scriptPath: 'x.py' }
        }
      ]
    })
    const result = await buildGraduationPackage(input, deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/part "Evil".*outside the project directory/)
  })
})
