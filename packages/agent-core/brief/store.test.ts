import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BriefStore } from './store'
import { emptyDesignBrief } from '@shared/ipc'
import type { DesignBrief } from '@shared/ipc'

let projectDir: string
let store: BriefStore

function completeBrief(overrides: Partial<DesignBrief> = {}): DesignBrief {
  const brief = emptyDesignBrief()
  return {
    ...brief,
    part: { ...brief.part, name: 'Bracket', purpose: 'Mounts a sensor' },
    envelope: {
      x: { value: 40, unit: 'mm', provenance: 'user' },
      y: { value: 30, unit: 'mm', provenance: 'user' },
      z: { value: 10, unit: 'mm', provenance: 'user' }
    },
    materials: { requested: 'PLA', onHand: [] },
    acceptance: ['Fits the sensor without wobble'],
    ...overrides
  }
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'voyager-brief-'))
  store = new BriefStore()
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('BriefStore.get', () => {
  it('returns an empty brief for a project that has never been touched', async () => {
    const brief = await store.get(projectDir)
    expect(brief).toEqual(emptyDesignBrief())
  })
})

describe('BriefStore.replace', () => {
  it('persists the edited brief and round-trips it on the next get', async () => {
    const edited = completeBrief()
    const result = await store.replace(projectDir, edited)
    expect(result.part.name).toBe('Bracket')

    const reloaded = await store.get(projectDir)
    expect(reloaded).toEqual(result)
  })

  it('ignores a client-supplied version/lockedAt while unlocked', async () => {
    const tampered = { ...completeBrief(), version: 99, lockedAt: '2020-01-01T00:00:00.000Z' }
    const result = await store.replace(projectDir, tampered)
    expect(result.version).toBe(1)
    expect(result.lockedAt).toBeUndefined()
  })

  it('bumps the version and clears lockedAt when editing a locked brief', async () => {
    await store.replace(projectDir, completeBrief())
    const locked = await store.lock(projectDir)
    expect(locked.version).toBe(1)
    expect(locked.lockedAt).toBeDefined()

    const edited = await store.replace(projectDir, { ...locked, part: { ...locked.part, name: 'Bracket v2' } })
    expect(edited.version).toBe(2)
    expect(edited.lockedAt).toBeUndefined()
    expect(edited.part.name).toBe('Bracket v2')
  })
})

describe('BriefStore.lock', () => {
  it('throws naming the missing fields when the brief is incomplete', async () => {
    await expect(store.lock(projectDir)).rejects.toThrow(/Part name/)
  })

  it('locks a complete brief, stamping lockedAt', async () => {
    await store.replace(projectDir, completeBrief())
    const locked = await store.lock(projectDir)
    expect(locked.lockedAt).toBeDefined()
    expect(locked.version).toBe(1)
  })

  it('is a no-op returning the already-locked brief on a second call', async () => {
    await store.replace(projectDir, completeBrief())
    const first = await store.lock(projectDir)
    const second = await store.lock(projectDir)
    expect(second).toEqual(first)
  })

  it('snapshots the locked version into versions/ for listVersions', async () => {
    await store.replace(projectDir, completeBrief())
    await store.lock(projectDir)
    const versions = await store.listVersions(projectDir)
    expect(versions).toHaveLength(1)
    expect(versions[0].version).toBe(1)
    expect(versions[0].brief.part.name).toBe('Bracket')
  })
})

describe('BriefStore.listVersions', () => {
  it('returns an empty array when nothing has ever been locked', async () => {
    expect(await store.listVersions(projectDir)).toEqual([])
  })

  it('accumulates one snapshot per locked version, oldest first', async () => {
    await store.replace(projectDir, completeBrief())
    await store.lock(projectDir)
    const editedAfterLock = await store.replace(projectDir, {
      ...(await store.get(projectDir)),
      part: { name: 'Bracket v2', purpose: 'Mounts a sensor', referenceImages: [] }
    })
    expect(editedAfterLock.version).toBe(2)
    await store.lock(projectDir)

    const versions = await store.listVersions(projectDir)
    expect(versions.map((v) => v.version)).toEqual([1, 2])
    expect(versions[1].brief.part.name).toBe('Bracket v2')
  })
})

describe('BriefStore.applyAgentPatch', () => {
  it('merges the patch into an empty brief and persists it', async () => {
    const next = await store.applyAgentPatch(projectDir, { part_name: 'Bracket', envelope_x_mm: 40 })
    expect(next.part.name).toBe('Bracket')
    expect(next.envelope.x).toMatchObject({ value: 40, provenance: 'inferred' })
    expect(await store.get(projectDir)).toEqual(next)
  })

  it('bumps the version when patching a locked brief', async () => {
    await store.replace(projectDir, completeBrief())
    const locked = await store.lock(projectDir)
    expect(locked.version).toBe(1)

    const patched = await store.applyAgentPatch(projectDir, { part_name: 'Revised name' })
    expect(patched.version).toBe(2)
    expect(patched.lockedAt).toBeUndefined()
    expect(patched.part.name).toBe('Revised name')
    // Fields not touched by the patch carry forward from the locked version.
    expect(patched.envelope.x.value).toBe(40)
  })
})
