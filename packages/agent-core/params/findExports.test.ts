import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findFileByExt } from './findExports'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'voyager-findexports-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('findFileByExt', () => {
  it('finds a matching file directly under the root', async () => {
    await writeFile(join(scratch, 'part.stl'), 'x')
    expect(await findFileByExt(scratch, 'stl')).toBe(join(scratch, 'part.stl'))
  })

  it('finds a matching file nested in a subdirectory', async () => {
    await mkdir(join(scratch, 'outputs'), { recursive: true })
    await writeFile(join(scratch, 'outputs', 'part.stl'), 'x')
    expect(await findFileByExt(scratch, 'stl')).toBe(join(scratch, 'outputs', 'part.stl'))
  })

  it('matches the extension case-insensitively and accepts a leading dot', async () => {
    await writeFile(join(scratch, 'part.STL'), 'x')
    expect(await findFileByExt(scratch, '.stl')).toBe(join(scratch, 'part.STL'))
  })

  it('ignores files with a different extension', async () => {
    await writeFile(join(scratch, 'notes.txt'), 'x')
    expect(await findFileByExt(scratch, 'stl')).toBeNull()
  })

  it('returns null when the root directory does not exist', async () => {
    expect(await findFileByExt(join(scratch, 'missing'), 'stl')).toBeNull()
  })

  it('returns the alphabetically-first match when several exist', async () => {
    await writeFile(join(scratch, 'b.stl'), 'x')
    await writeFile(join(scratch, 'a.stl'), 'x')
    expect(await findFileByExt(scratch, 'stl')).toBe(join(scratch, 'a.stl'))
  })
})
