import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { manifestPathForStl, readManifestForIteration } from './manifestConvention'

describe('manifestPathForStl', () => {
  it('replaces the .stl extension and keeps the directory', () => {
    expect(manifestPathForStl('outputs/bracket_v3.stl')).toBe('outputs/bracket_v3.manifest.json')
  })

  it('handles a bare filename with no directory', () => {
    expect(manifestPathForStl('bracket_v3.stl')).toBe('bracket_v3.manifest.json')
  })

  it('is case-insensitive on the .stl extension', () => {
    expect(manifestPathForStl('outputs/bracket_v3.STL')).toBe('outputs/bracket_v3.manifest.json')
  })
})

describe('readManifestForIteration', () => {
  let scratch: string

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'voyager-manifest-'))
    await mkdir(join(scratch, 'outputs'), { recursive: true })
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('reads a valid manifest from beside the STL', async () => {
    const manifest = { params: [{ name: 'WIDTH', value: 40, unit: 'mm', label: 'Width' }], featureBindings: [] }
    await writeFile(join(scratch, 'outputs', 'bracket_v3.manifest.json'), JSON.stringify(manifest))

    const result = await readManifestForIteration(scratch, { stlPath: 'outputs/bracket_v3.stl' })
    expect(result).toEqual(manifest)
  })

  it('returns null when no manifest file exists', async () => {
    const result = await readManifestForIteration(scratch, { stlPath: 'outputs/bracket_v3.stl' })
    expect(result).toBeNull()
  })

  it('returns null when the file is not valid JSON', async () => {
    await writeFile(join(scratch, 'outputs', 'bracket_v3.manifest.json'), 'not json')
    const result = await readManifestForIteration(scratch, { stlPath: 'outputs/bracket_v3.stl' })
    expect(result).toBeNull()
  })

  it('returns null when the JSON does not match the ScriptManifest shape', async () => {
    await writeFile(join(scratch, 'outputs', 'bracket_v3.manifest.json'), JSON.stringify({ foo: 'bar' }))
    const result = await readManifestForIteration(scratch, { stlPath: 'outputs/bracket_v3.stl' })
    expect(result).toBeNull()
  })
})
