import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from './store'

let scratch: string
let skillSource: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'voyager-store-'))
  skillSource = join(scratch, 'skill-src')
  await mkdir(join(skillSource, 'scripts'), { recursive: true })
  await writeFile(join(skillSource, 'SKILL.md'), '# fake skill')
  await writeFile(join(skillSource, 'scripts', 'validate_stl.py'), '# fake validator')
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

function makeStore(): ProjectStore {
  return new ProjectStore({ baseDir: join(scratch, 'projects'), skillSourceDir: skillSource })
}

describe('ProjectStore.ensureProject', () => {
  it('creates the project dir, outputs/, a full skill copy, and project.json', async () => {
    const store = makeStore()
    const { dir } = await store.ensureProject()

    expect((await stat(join(dir, 'outputs'))).isDirectory()).toBe(true)
    expect(
      await readFile(join(dir, '.claude', 'skills', 'printable-cad', 'SKILL.md'), 'utf-8')
    ).toBe('# fake skill')
    expect(
      await readFile(join(dir, '.claude', 'skills', 'printable-cad', 'scripts', 'validate_stl.py'), 'utf-8')
    ).toBe('# fake validator')

    const record = JSON.parse(await readFile(join(dir, 'project.json'), 'utf-8'))
    expect(record.id).toBe('default')
    expect(record.iterations).toEqual([])
  })

  it('is idempotent and preserves existing project.json contents', async () => {
    const store = makeStore()
    await store.ensureProject()
    await store.setSessionId('session-abc')

    const again = makeStore()
    await again.ensureProject()
    expect(await again.getSessionId()).toBe('session-abc')
  })
})

describe('ProjectStore.recordIteration', () => {
  it('numbers iterations sequentially from 1 and persists them', async () => {
    const store = makeStore()
    await store.ensureProject()

    const first = await store.recordIteration({
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'first'
    })
    const second = await store.recordIteration({
      stlPath: 'outputs/part_v2.stl',
      stepPath: 'outputs/part_v2.step',
      scriptPath: 'outputs/part_v2.py',
      summary: 'second'
    })

    expect(first.n).toBe(1)
    expect(second.n).toBe(2)

    const reloaded = makeStore()
    const latest = await reloaded.latestIteration()
    expect(latest?.n).toBe(2)
    expect(latest?.stepPath).toBe('outputs/part_v2.step')
  })
})

describe('ProjectStore R4 version history', () => {
  it('recordIteration marks each freshly-recorded iteration as active', async () => {
    const store = makeStore()
    await store.ensureProject()

    const first = await store.recordIteration({
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'first'
    })
    expect((await store.activeIterationRecord())?.n).toBe(first.n)

    const second = await store.recordIteration({
      stlPath: 'outputs/part_v2.stl',
      scriptPath: 'outputs/part_v2.py',
      summary: 'second'
    })
    expect((await store.activeIterationRecord())?.n).toBe(second.n)
  })

  it('activeIterationRecord falls back to latestIteration when nothing has been reverted', async () => {
    const store = makeStore()
    await store.ensureProject()
    expect(await store.activeIterationRecord()).toBeNull()

    await store.recordIteration({ stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })
    const second = await store.recordIteration({ stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2' })

    expect((await store.activeIterationRecord())?.n).toBe(second.n)
  })

  it('listIterations returns every recorded iteration, oldest first, as a copy', async () => {
    const store = makeStore()
    await store.ensureProject()
    await store.recordIteration({ stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })
    await store.recordIteration({ stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2' })

    const listed = await store.listIterations()
    expect(listed.map((it) => it.n)).toEqual([1, 2])

    listed.push({ n: 99, stlPath: 'x', scriptPath: 'y', summary: 'z', at: 'now' })
    expect((await store.listIterations()).map((it) => it.n)).toEqual([1, 2])
  })

  it('revertTo points activeIteration at an earlier version without touching the iterations array', async () => {
    const store = makeStore()
    await store.ensureProject()
    const first = await store.recordIteration({ stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })
    await store.recordIteration({ stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2' })

    const reverted = await store.revertTo(first.n)
    expect(reverted.n).toBe(first.n)
    expect((await store.activeIterationRecord())?.n).toBe(first.n)
    expect((await store.listIterations()).map((it) => it.n)).toEqual([1, 2])

    // Persists across reloads.
    const reloaded = makeStore()
    await reloaded.ensureProject()
    expect((await reloaded.activeIterationRecord())?.n).toBe(first.n)

    // A further generation supersedes the reverted-to version and becomes active again.
    const third = await store.recordIteration({ stlPath: 'outputs/a_v3.stl', scriptPath: 'outputs/a_v3.py', summary: 'v3' })
    expect((await store.activeIterationRecord())?.n).toBe(third.n)
  })

  it('revertTo throws for an unknown iteration number', async () => {
    const store = makeStore()
    await store.ensureProject()
    await store.recordIteration({ stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })

    await expect(store.revertTo(99)).rejects.toThrow(/Unknown iteration/)
  })

  it('back-fills activeIteration to the latest iteration for a pre-R4 project.json', async () => {
    const legacyDir = join(scratch, 'projects', 'default')
    await mkdir(join(legacyDir, 'outputs'), { recursive: true })
    await writeFile(
      join(legacyDir, 'project.json'),
      JSON.stringify({
        id: 'default',
        name: 'Pre-R4 project',
        createdAt: '2023-01-01T00:00:00.000Z',
        iterations: [
          { n: 1, stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1', at: '2023-01-01T00:00:00.000Z' },
          { n: 2, stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2', at: '2023-01-02T00:00:00.000Z' }
        ]
        // no `activeIteration` field - this is the pre-R4 schema.
      }),
      'utf-8'
    )

    const store = makeStore()
    await store.ensureProject()
    expect((await store.activeIterationRecord())?.n).toBe(2)
  })
})

describe('ProjectStore.getProjectDir', () => {
  it('throws before ensureProject has resolved', () => {
    expect(() => makeStore().getProjectDir()).toThrow(/ensureProject/)
  })
})

describe('ProjectStore.getAgentSettings / setAgentSettings', () => {
  it('defaults to Opus 4.8 + xhigh when nothing has been saved', async () => {
    const store = makeStore()
    await store.ensureProject()

    expect(await store.getAgentSettings()).toEqual({ model: 'claude-opus-4-8', effort: 'xhigh' })
  })

  it('persists a choice across reloads', async () => {
    const store = makeStore()
    await store.ensureProject()
    await store.setAgentSettings({ model: 'claude-sonnet-5', effort: 'low' })

    const reloaded = makeStore()
    await reloaded.ensureProject()
    expect(await reloaded.getAgentSettings()).toEqual({ model: 'claude-sonnet-5', effort: 'low' })
  })
})

describe('ProjectStore multi-project support', () => {
  it('creates additional projects and switches the active one', async () => {
    const store = makeStore()
    await store.ensureProject()
    const initial = await store.listProjects()
    expect(initial).toHaveLength(1)

    const created = await store.createProject('Bracket')
    expect(created.name).toBe('Bracket')
    expect(store.getActiveProjectId()).toBe(created.id)

    const listed = await store.listProjects()
    expect(listed.map((p) => p.id).sort()).toEqual([initial[0].id, created.id].sort())

    await store.switchProject(initial[0].id)
    expect(store.getActiveProjectId()).toBe(initial[0].id)
  })

  it('throws when switching to an unknown project id', async () => {
    const store = makeStore()
    await store.ensureProject()
    await expect(store.switchProject('does-not-exist')).rejects.toThrow(/Unknown project/)
  })

  it('defaults a new project to "Untitled project" when no name is given', async () => {
    const store = makeStore()
    await store.ensureProject()
    const created = await store.createProject()
    expect(created.name).toBe('Untitled project')
  })

  it('renames a project by id, active or not', async () => {
    const store = makeStore()
    await store.ensureProject()
    const created = await store.createProject('Original')
    const other = (await store.listProjects()).find((p) => p.id !== created.id)

    const renamedActive = await store.renameProject(created.id, 'Renamed active')
    expect(renamedActive.name).toBe('Renamed active')

    const renamedOther = await store.renameProject(other!.id, 'Renamed other')
    expect(renamedOther.name).toBe('Renamed other')

    const listed = await store.listProjects()
    expect(listed.find((p) => p.id === created.id)?.name).toBe('Renamed active')
    expect(listed.find((p) => p.id === other!.id)?.name).toBe('Renamed other')
  })

  it('throws when renaming an unknown project id', async () => {
    const store = makeStore()
    await store.ensureProject()
    await expect(store.renameProject('does-not-exist', 'x')).rejects.toThrow(/Unknown project/)
  })

  it('isolates iterations, session id, and settings per project', async () => {
    const store = makeStore()
    await store.ensureProject()
    const firstId = store.getActiveProjectId()
    await store.setSessionId('session-a')
    await store.setAgentSettings({ model: 'claude-sonnet-5', effort: 'low' })

    await store.createProject('Second')
    expect(await store.getSessionId()).toBeUndefined()
    expect(await store.getAgentSettings()).toEqual({ model: 'claude-opus-4-8', effort: 'xhigh' })

    await store.switchProject(firstId)
    expect(await store.getSessionId()).toBe('session-a')
    expect(await store.getAgentSettings()).toEqual({ model: 'claude-sonnet-5', effort: 'low' })
  })
})

describe('ProjectStore.getChatHistory', () => {
  it('merges persisted messages with synthesized model-displayed lines, sorted chronologically', async () => {
    const store = makeStore()
    await store.ensureProject()

    await store.appendMessage({ id: 'm1', role: 'user', text: 'hello', createdAt: '2024-01-01T00:00:00.000Z' })
    await store.recordIteration({ stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'first' })
    // recordIteration timestamps with the real current time internally - placing this second
    // message far in the future keeps the expected sort order deterministic either way.
    await store.appendMessage({ id: 'm2', role: 'assistant', text: 'done', createdAt: '2999-01-01T00:00:00.000Z' })

    const history = await store.getChatHistory()
    expect(history.map((m) => m.id)).toEqual(['m1', 'iteration-1', 'm2'])
    expect(history[1]).toMatchObject({ role: 'system-status', text: 'Model v1 displayed: first' })
  })

  it('is empty for a project with no messages or iterations', async () => {
    const store = makeStore()
    await store.ensureProject()
    expect(await store.getChatHistory()).toEqual([])
  })
})

describe('ProjectStore migration', () => {
  it('discovers a pre-R3 default project with no manifest and makes it active', async () => {
    const legacyDir = join(scratch, 'projects', 'default')
    await mkdir(join(legacyDir, 'outputs'), { recursive: true })
    await writeFile(
      join(legacyDir, 'project.json'),
      JSON.stringify({
        id: 'default',
        name: 'My old project',
        createdAt: '2023-01-01T00:00:00.000Z',
        sessionId: 'legacy-session',
        iterations: []
        // no `messages` field - this is the pre-R3 schema.
      }),
      'utf-8'
    )

    const store = makeStore()
    const { id } = await store.ensureProject()
    expect(id).toBe('default')
    expect(store.getActiveProjectId()).toBe('default')

    expect(await store.listProjects()).toEqual([
      { id: 'default', name: 'My old project', createdAt: '2023-01-01T00:00:00.000Z' }
    ])
    expect(await store.getSessionId()).toBe('legacy-session')
    expect(await store.getChatHistory()).toEqual([])
  })
})
