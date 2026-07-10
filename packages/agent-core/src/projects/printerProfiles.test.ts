import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PrinterProfileStore } from './printerProfiles'
import type { PrinterProfileRef } from '@shared/ipc'

let baseDir: string
let store: PrinterProfileStore

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'voyager-printers-'))
  store = new PrinterProfileStore({ baseDir })
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

function profile(overrides: Partial<PrinterProfileRef> = {}): PrinterProfileRef {
  return {
    id: '',
    name: 'Prusa MK4',
    bedXMm: 250,
    bedYMm: 210,
    bedZMm: 220,
    nozzleDiameterMm: 0.4,
    materials: ['PLA', 'PETG'],
    ...overrides
  }
}

describe('PrinterProfileStore.list', () => {
  it('returns an empty list before anything is saved', async () => {
    expect(await store.list()).toEqual({ profiles: [], activeId: null })
  })

  it('falls back to an empty list when the file is corrupt', async () => {
    await writeFile(join(baseDir, 'printer-profiles.json'), 'not json at all', 'utf-8')
    expect(await store.list()).toEqual({ profiles: [], activeId: null })
  })

  it('falls back to an empty list when the file fails schema validation', async () => {
    await writeFile(
      join(baseDir, 'printer-profiles.json'),
      JSON.stringify({ profiles: [{ id: 'x', name: 'missing dims' }], activeId: 'x' }),
      'utf-8'
    )
    expect(await store.list()).toEqual({ profiles: [], activeId: null })
  })

  it('reads a dangling activeId as null instead of erroring', async () => {
    const { profiles } = await store.save(profile())
    await writeFile(
      join(baseDir, 'printer-profiles.json'),
      JSON.stringify({ profiles, activeId: 'no-such-printer' }),
      'utf-8'
    )
    expect((await store.list()).activeId).toBeNull()
    expect(await store.getActive()).toBeNull()
  })
})

describe('PrinterProfileStore.save', () => {
  it('derives a slug id from the name when the id is empty', async () => {
    const result = await store.save(profile({ name: 'Prusa MK4!' }))
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0]?.id).toBe('prusa-mk4')
  })

  it('uniquifies colliding slug ids with a numeric suffix', async () => {
    await store.save(profile({ name: 'Prusa MK4' }))
    const result = await store.save(profile({ name: 'prusa mk4' }))
    expect(result.profiles.map((p) => p.id)).toEqual(['prusa-mk4', 'prusa-mk4-2'])
  })

  it('falls back to a generic id for a name with no slug-able characters', async () => {
    const result = await store.save(profile({ name: '***' }))
    expect(result.profiles[0]?.id).toBe('printer')
  })

  it('makes a newly added profile the active one', async () => {
    const first = await store.save(profile({ name: 'First' }))
    expect(first.activeId).toBe('first')
    const second = await store.save(profile({ name: 'Second' }))
    expect(second.activeId).toBe('second')
  })

  it('updates in place by id without stealing the active slot', async () => {
    await store.save(profile({ name: 'Active printer' }))
    await store.save(profile({ name: 'Other printer' }))
    await store.setActive('active-printer')

    const result = await store.save(profile({ id: 'other-printer', name: 'Other printer', bedXMm: 300 }))
    expect(result.profiles).toHaveLength(2)
    expect(result.profiles.find((p) => p.id === 'other-printer')?.bedXMm).toBe(300)
    expect(result.activeId).toBe('active-printer')
  })

  it('persists across store instances', async () => {
    await store.save(profile())
    const reopened = new PrinterProfileStore({ baseDir })
    const result = await reopened.list()
    expect(result.profiles).toHaveLength(1)
    expect(result.activeId).toBe('prusa-mk4')
    expect(await reopened.getActive()).toMatchObject({ name: 'Prusa MK4', nozzleDiameterMm: 0.4 })
  })

  it('writes pretty-printed JSON like the other stores', async () => {
    await store.save(profile())
    const raw = await readFile(join(baseDir, 'printer-profiles.json'), 'utf-8')
    expect(raw).toContain('\n  ')
  })

  it('trims the name and drops blank materials', async () => {
    const result = await store.save(profile({ name: '  Bambu A1  ', materials: [' PLA ', '', '  '] }))
    expect(result.profiles[0]?.name).toBe('Bambu A1')
    expect(result.profiles[0]?.materials).toEqual(['PLA'])
  })

  it('rejects a blank name', async () => {
    await expect(store.save(profile({ name: '   ' }))).rejects.toThrow(/needs a name/)
  })

  it.each([
    ['bedXMm', { bedXMm: 0 }],
    ['bedYMm', { bedYMm: -5 }],
    ['nozzleDiameterMm', { nozzleDiameterMm: 0 }]
  ] as const)('rejects a non-positive %s', async (_field, override) => {
    await expect(store.save(profile(override))).rejects.toThrow(/positive number of millimeters/)
  })

  it('rejects NaN dimensions (zod catches these before the positivity check)', async () => {
    await expect(store.save(profile({ bedZMm: Number.NaN }))).rejects.toThrow()
  })

  it('serializes concurrent saves so neither write is lost', async () => {
    const [a, b] = await Promise.all([
      store.save(profile({ name: 'Printer A' })),
      store.save(profile({ name: 'Printer B' }))
    ])
    expect(a.profiles.length + b.profiles.length).toBeGreaterThanOrEqual(3) // 1 + 2, either order
    const final = await store.list()
    expect(final.profiles.map((p) => p.name).sort()).toEqual(['Printer A', 'Printer B'])
  })
})

describe('PrinterProfileStore.setActive', () => {
  it('switches the active profile', async () => {
    await store.save(profile({ name: 'First' }))
    await store.save(profile({ name: 'Second' }))
    const result = await store.setActive('first')
    expect(result.activeId).toBe('first')
    expect(await store.getActive()).toMatchObject({ name: 'First' })
  })

  it('throws on an unknown id', async () => {
    await store.save(profile())
    await expect(store.setActive('nope')).rejects.toThrow('Unknown printer profile: nope')
  })

  it('recovers after a failed mutation (the queue keeps serving)', async () => {
    await store.save(profile({ name: 'First' }))
    await expect(store.setActive('nope')).rejects.toThrow()
    expect((await store.setActive('first')).activeId).toBe('first')
  })
})

describe('PrinterProfileStore.getActive', () => {
  it('returns null before anything is saved', async () => {
    expect(await store.getActive()).toBeNull()
  })
})
