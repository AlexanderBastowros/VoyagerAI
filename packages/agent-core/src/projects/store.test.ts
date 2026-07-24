import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from './store'

let scratch: string
let skillSource: string
let verifyScript: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'voyager-store-'))
  skillSource = join(scratch, 'skill-src')
  await mkdir(join(skillSource, 'scripts'), { recursive: true })
  await writeFile(join(skillSource, 'SKILL.md'), '# fake skill')
  verifyScript = join(scratch, 'verify-src', 'validate_stl.py')
  await mkdir(join(scratch, 'verify-src'), { recursive: true })
  await writeFile(verifyScript, '# fake validator')
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

function makeStore(): ProjectStore {
  return new ProjectStore({
    baseDir: join(scratch, 'projects'),
    skillSourceDir: skillSource,
    verifyScriptPath: verifyScript
  })
}

/**
 * `recordIteration` now snapshots the generating script, so the source `.py` must exist on disk.
 * This writes it (with distinctive contents, so snapshot fidelity can be asserted) into the active
 * project's outputs dir before recording. Mirrors what the agent + `display_model` guarantee in
 * production.
 */
async function recordScript(
  store: ProjectStore,
  entry: {
    stlPath: string
    stepPath?: string
    scriptPath: string
    summary: string
    briefVersion?: number
    partId?: string
    partName?: string
  }
): Promise<ReturnType<ProjectStore['recordIteration']>> {
  await writeFile(join(store.getProjectDir(), entry.scriptPath), `# source of ${entry.scriptPath}`)
  return store.recordIteration(entry)
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
    // WS-I: a fresh project has a single `main` part (no top-level iterations).
    expect(record.parts).toHaveLength(1)
    expect(record.parts[0]).toMatchObject({ id: 'main', name: 'Main', iterations: [], visible: true })
    expect(record.activePartId).toBe('main')
  })

  it('copies extract_params.py into the skill scripts/ dir when extractParamsScriptPath is given', async () => {
    const extractParamsScript = join(scratch, 'params-src', 'extract_params.py')
    await mkdir(join(scratch, 'params-src'), { recursive: true })
    await writeFile(extractParamsScript, '# fake extractor')

    const store = new ProjectStore({
      baseDir: join(scratch, 'projects'),
      skillSourceDir: skillSource,
      verifyScriptPath: verifyScript,
      extractParamsScriptPath: extractParamsScript
    })
    const { dir } = await store.ensureProject()

    expect(
      await readFile(join(dir, '.claude', 'skills', 'printable-cad', 'scripts', 'extract_params.py'), 'utf-8')
    ).toBe('# fake extractor')
  })

  it('skips the extract_params.py copy when extractParamsScriptPath is omitted', async () => {
    const store = makeStore()
    const { dir } = await store.ensureProject()

    await expect(
      stat(join(dir, '.claude', 'skills', 'printable-cad', 'scripts', 'extract_params.py'))
    ).rejects.toThrow()
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

    const first = await recordScript(store, {
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'first'
    })
    const second = await recordScript(store, {
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

  it('persists an optional briefVersion and leaves it unset when omitted (WS-A)', async () => {
    const store = makeStore()
    await store.ensureProject()

    const stamped = await recordScript(store, {
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'first',
      briefVersion: 2
    })
    expect(stamped.briefVersion).toBe(2)

    const unstamped = await recordScript(store, {
      stlPath: 'outputs/part_v2.stl',
      scriptPath: 'outputs/part_v2.py',
      summary: 'second'
    })
    expect(unstamped.briefVersion).toBeUndefined()

    const reloaded = makeStore()
    const iterations = await reloaded.listIterations()
    expect(iterations[0].briefVersion).toBe(2)
    expect(iterations[1].briefVersion).toBeUndefined()
  })

  it('fires onIterationRecorded with the new iteration and project dir, without awaiting it (WS-C)', async () => {
    const calls: Array<{ n: number; dir: string }> = []
    const store = new ProjectStore({
      baseDir: join(scratch, 'projects'),
      skillSourceDir: skillSource,
      verifyScriptPath: verifyScript,
      onIterationRecorded: (iteration, dir) => {
        calls.push({ n: iteration.n, dir })
      }
    })
    const { dir } = await store.ensureProject()

    const recorded = await recordScript(store, {
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'first'
    })

    expect(calls).toEqual([{ n: recorded.n, dir }])
  })

  it('does not fail recordIteration when onIterationRecorded throws synchronously (WS-C)', async () => {
    const store = new ProjectStore({
      baseDir: join(scratch, 'projects'),
      skillSourceDir: skillSource,
      verifyScriptPath: verifyScript,
      onIterationRecorded: () => {
        throw new Error('boom')
      }
    })
    await store.ensureProject()

    const recorded = await recordScript(store, {
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'first'
    })

    expect(recorded.n).toBe(1)
    // The iteration is still persisted and active despite the hook throwing.
    const reloaded = makeStore()
    expect((await reloaded.activeIterationRecord())?.n).toBe(1)
  })
})

describe('ProjectStore R4 version history', () => {
  it('recordIteration marks each freshly-recorded iteration as active', async () => {
    const store = makeStore()
    await store.ensureProject()

    const first = await recordScript(store, {
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'first'
    })
    expect((await store.activeIterationRecord())?.n).toBe(first.n)

    const second = await recordScript(store, {
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

    await recordScript(store, { stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })
    const second = await recordScript(store, { stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2' })

    expect((await store.activeIterationRecord())?.n).toBe(second.n)
  })

  it('listIterations returns every recorded iteration, oldest first, as a copy', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })
    await recordScript(store, { stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2' })

    const listed = await store.listIterations()
    expect(listed.map((it) => it.n)).toEqual([1, 2])

    listed.push({ n: 99, stlPath: 'x', scriptPath: 'y', summary: 'z', at: 'now' })
    expect((await store.listIterations()).map((it) => it.n)).toEqual([1, 2])
  })

  it('revertTo points activeIteration at an earlier version without touching the iterations array', async () => {
    const store = makeStore()
    await store.ensureProject()
    const first = await recordScript(store, { stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })
    await recordScript(store, { stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2' })

    const reverted = await store.revertTo(first.n)
    expect(reverted.n).toBe(first.n)
    expect((await store.activeIterationRecord())?.n).toBe(first.n)
    expect((await store.listIterations()).map((it) => it.n)).toEqual([1, 2])

    // Persists across reloads.
    const reloaded = makeStore()
    await reloaded.ensureProject()
    expect((await reloaded.activeIterationRecord())?.n).toBe(first.n)

    // A further generation supersedes the reverted-to version and becomes active again.
    const third = await recordScript(store, { stlPath: 'outputs/a_v3.stl', scriptPath: 'outputs/a_v3.py', summary: 'v3' })
    expect((await store.activeIterationRecord())?.n).toBe(third.n)
  })

  it('revertTo throws for an unknown iteration number', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })

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

describe('ProjectStore per-version script snapshots', () => {
  it('snapshots the generating script to outputs/versions/<part>/vN.py and records its path', async () => {
    const store = makeStore()
    const { dir } = await store.ensureProject()

    const first = await recordScript(store, {
      stlPath: 'outputs/part_v1.stl',
      scriptPath: 'outputs/part_v1.py',
      summary: 'v1'
    })

    expect(first.scriptSnapshotPath).toBe('outputs/versions/main/v1.py')
    // The snapshot is a faithful copy of the source script the agent wrote.
    expect(await readFile(join(dir, 'outputs', 'versions', 'main', 'v1.py'), 'utf-8')).toBe(
      '# source of outputs/part_v1.py'
    )
    // Persisted on the iteration record across reloads.
    const reloaded = makeStore()
    expect((await reloaded.latestIteration())?.scriptSnapshotPath).toBe('outputs/versions/main/v1.py')
  })

  it('gives each iteration its own snapshot without overwriting earlier ones', async () => {
    const store = makeStore()
    const { dir } = await store.ensureProject()

    await recordScript(store, { stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })
    await recordScript(store, { stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2' })

    expect(await readFile(join(dir, 'outputs', 'versions', 'main', 'v1.py'), 'utf-8')).toBe('# source of outputs/a_v1.py')
    expect(await readFile(join(dir, 'outputs', 'versions', 'main', 'v2.py'), 'utf-8')).toBe('# source of outputs/a_v2.py')
  })

  it('leaves earlier snapshots intact after a revert', async () => {
    const store = makeStore()
    const { dir } = await store.ensureProject()

    const first = await recordScript(store, { stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1' })
    await recordScript(store, { stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2' })
    await store.revertTo(first.n)

    expect(await readFile(join(dir, 'outputs', 'versions', 'main', 'v1.py'), 'utf-8')).toBe('# source of outputs/a_v1.py')
    expect(await readFile(join(dir, 'outputs', 'versions', 'main', 'v2.py'), 'utf-8')).toBe('# source of outputs/a_v2.py')
  })

  it('throws if the source script is missing, so display_model surfaces the error', async () => {
    const store = makeStore()
    await store.ensureProject()
    // Call recordIteration directly (bypassing the recordScript helper) with no source file on disk.
    await expect(
      store.recordIteration({ stlPath: 'outputs/x_v1.stl', scriptPath: 'outputs/missing.py', summary: 'x' })
    ).rejects.toThrow()
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

    expect(await store.getAgentSettings()).toEqual({ model: 'claude-opus-4-8', effort: 'xhigh', renderViews: true })
  })

  it('persists a choice across reloads', async () => {
    const store = makeStore()
    await store.ensureProject()
    await store.setAgentSettings({ model: 'claude-sonnet-5', effort: 'low' })

    const reloaded = makeStore()
    await reloaded.ensureProject()
    // renderViews omitted on write normalizes to enabled (the pre-WS-D default).
    expect(await reloaded.getAgentSettings()).toEqual({ model: 'claude-sonnet-5', effort: 'low', renderViews: true })
  })

  it('persists the render-previews toggle off and back on (WS-D)', async () => {
    const store = makeStore()
    await store.ensureProject()
    await store.setAgentSettings({ model: 'claude-sonnet-5', effort: 'low', renderViews: false })

    const reloaded = makeStore()
    await reloaded.ensureProject()
    expect((await reloaded.getAgentSettings()).renderViews).toBe(false)

    await reloaded.setAgentSettings({ model: 'claude-sonnet-5', effort: 'low', renderViews: true })
    expect((await reloaded.getAgentSettings()).renderViews).toBe(true)
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
    expect(await store.getAgentSettings()).toEqual({ model: 'claude-opus-4-8', effort: 'xhigh', renderViews: true })

    await store.switchProject(firstId)
    expect(await store.getSessionId()).toBe('session-a')
    expect(await store.getAgentSettings()).toEqual({ model: 'claude-sonnet-5', effort: 'low', renderViews: true })
  })
})

describe('ProjectStore.getChatHistory', () => {
  it('merges persisted messages with synthesized model-displayed lines, sorted chronologically', async () => {
    const store = makeStore()
    await store.ensureProject()

    await store.appendMessage({ id: 'm1', role: 'user', text: 'hello', createdAt: '2024-01-01T00:00:00.000Z' })
    await recordScript(store, { stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'first' })
    // recordIteration timestamps with the real current time internally - placing this second
    // message far in the future keeps the expected sort order deterministic either way.
    await store.appendMessage({ id: 'm2', role: 'assistant', text: 'done', createdAt: '2999-01-01T00:00:00.000Z' })

    const history = await store.getChatHistory()
    expect(history.map((m) => m.id)).toEqual(['m1', 'iteration-main-1', 'm2'])
    expect(history[1]).toMatchObject({ role: 'system-status', text: 'Model v1 displayed: first' })
  })

  it('is empty for a project with no messages or iterations', async () => {
    const store = makeStore()
    await store.ensureProject()
    expect(await store.getChatHistory()).toEqual([])
  })
})

describe('ProjectStore parts (WS-I)', () => {
  it('starts a fresh project with a single visible `main` part at the origin', async () => {
    const store = makeStore()
    await store.ensureProject()

    const parts = await store.listParts()
    expect(parts).toEqual([
      { id: 'main', name: 'Main', placement: { position: [0, 0, 0], rotation: [0, 0, 0] }, visible: true, activeIteration: null }
    ])
    expect(await store.getActivePartId()).toBe('main')
  })

  it('creates a part on first display_model and numbers iterations per part', async () => {
    const store = makeStore()
    await store.ensureProject()

    // The main part gets v1; a new `lid` part starts its own numbering at v1.
    const boxV1 = await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })
    const lidV1 = await recordScript(store, {
      stlPath: 'outputs/lid_v1.stl',
      scriptPath: 'outputs/lid_v1.py',
      summary: 'lid',
      partId: 'lid',
      partName: 'Lid'
    })
    const boxV2 = await recordScript(store, { stlPath: 'outputs/box_v2.stl', scriptPath: 'outputs/box_v2.py', summary: 'box2', partId: 'main' })

    expect(boxV1.n).toBe(1)
    expect(lidV1.n).toBe(1) // per-part numbering, not global
    expect(boxV2.n).toBe(2)

    const parts = await store.listParts()
    expect(parts.map((p) => p.id)).toEqual(['main', 'lid'])
    expect(parts.find((p) => p.id === 'lid')?.name).toBe('Lid')
  })

  it('scopes the script snapshot path per part so two parts\' v1 never collide', async () => {
    const store = makeStore()
    const { dir } = await store.ensureProject()

    const boxV1 = await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })
    const lidV1 = await recordScript(store, {
      stlPath: 'outputs/lid_v1.stl',
      scriptPath: 'outputs/lid_v1.py',
      summary: 'lid',
      partId: 'lid'
    })

    expect(boxV1.scriptSnapshotPath).toBe('outputs/versions/main/v1.py')
    expect(lidV1.scriptSnapshotPath).toBe('outputs/versions/lid/v1.py')
    expect(await readFile(join(dir, 'outputs', 'versions', 'lid', 'v1.py'), 'utf-8')).toBe('# source of outputs/lid_v1.py')
  })

  it('displaying a part makes it the active part', async () => {
    const store = makeStore()
    await store.ensureProject()

    await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })
    expect(await store.getActivePartId()).toBe('main')

    await recordScript(store, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'lid', partId: 'lid' })
    expect(await store.getActivePartId()).toBe('lid')
    // Unscoped activeIterationRecord now follows the active (lid) part.
    expect((await store.activeIterationRecord())?.summary).toBe('lid')
    // ...but an explicit partId still targets the box.
    expect((await store.activeIterationRecord('main'))?.summary).toBe('box')
  })

  it('reverts one part without touching another part\'s history or pointer', async () => {
    const store = makeStore()
    await store.ensureProject()

    const boxV1 = await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box1' })
    await recordScript(store, { stlPath: 'outputs/box_v2.stl', scriptPath: 'outputs/box_v2.py', summary: 'box2' })
    await recordScript(store, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'lid1', partId: 'lid' })

    // Revert the box to v1; the lid is untouched.
    await store.revertTo(boxV1.n, 'main')
    expect((await store.activeIterationRecord('main'))?.n).toBe(1)
    expect((await store.listIterations('main')).map((it) => it.n)).toEqual([1, 2])
    expect((await store.activeIterationRecord('lid'))?.n).toBe(1)
    expect((await store.listIterations('lid')).map((it) => it.n)).toEqual([1])

    // Reverting focuses that part.
    expect(await store.getActivePartId()).toBe('main')

    // Persists across reloads.
    const reloaded = makeStore()
    await reloaded.ensureProject()
    expect((await reloaded.activeIterationRecord('main'))?.n).toBe(1)
    expect((await reloaded.activeIterationRecord('lid'))?.n).toBe(1)
  })

  it('revertTo throws for an iteration number not in the target part', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })
    await recordScript(store, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'lid', partId: 'lid' })

    // The lid only has v1, so reverting the lid to v2 fails even though the box has a v2 next.
    await expect(store.revertTo(2, 'lid')).rejects.toThrow(/Unknown iteration/)
  })

  it('persists placement and visibility per part and returns the refreshed list', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'lid', partId: 'lid', partName: 'Lid' })

    const placed = await store.setPlacement('lid', { position: [10, 0, 5], rotation: [0, 90, 0] })
    expect(placed.find((p) => p.id === 'lid')?.placement).toEqual({ position: [10, 0, 5], rotation: [0, 90, 0] })

    await store.setVisibility('lid', false)

    const reloaded = makeStore()
    await reloaded.ensureProject()
    const lid = (await reloaded.listParts()).find((p) => p.id === 'lid')
    expect(lid?.placement).toEqual({ position: [10, 0, 5], rotation: [0, 90, 0] })
    expect(lid?.visible).toBe(false)
  })

  it('setActivePart redirects unscoped operations and persists', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })
    await recordScript(store, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'lid', partId: 'lid' })

    await store.setActivePart('main')
    expect(await store.getActivePartId()).toBe('main')
    expect((await store.activeIterationRecord())?.summary).toBe('box')

    const reloaded = makeStore()
    await reloaded.ensureProject()
    expect(await reloaded.getActivePartId()).toBe('main')
  })

  it('setPlacement / setVisibility / setActivePart throw for an unknown part', async () => {
    const store = makeStore()
    await store.ensureProject()
    await expect(store.setPlacement('nope', { position: [0, 0, 0], rotation: [0, 0, 0] })).rejects.toThrow(/Unknown part/)
    await expect(store.setVisibility('nope', false)).rejects.toThrow(/Unknown part/)
    await expect(store.setActivePart('nope')).rejects.toThrow(/Unknown part/)
  })

  it('migrates a pre-WS-I flat project.json into a single `main` part', async () => {
    const legacyDir = join(scratch, 'projects', 'default')
    await mkdir(join(legacyDir, 'outputs'), { recursive: true })
    await writeFile(
      join(legacyDir, 'project.json'),
      JSON.stringify({
        id: 'default',
        name: 'Pre-WS-I project',
        createdAt: '2023-01-01T00:00:00.000Z',
        activeIteration: 1,
        iterations: [
          { n: 1, stlPath: 'outputs/a_v1.stl', scriptPath: 'outputs/a_v1.py', summary: 'v1', at: '2023-01-01T00:00:00.000Z' },
          { n: 2, stlPath: 'outputs/a_v2.stl', scriptPath: 'outputs/a_v2.py', summary: 'v2', at: '2023-01-02T00:00:00.000Z' }
        ]
        // no `parts` field - this is the pre-WS-I schema.
      }),
      'utf-8'
    )

    const store = makeStore()
    await store.ensureProject()

    const parts = await store.listParts()
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ id: 'main', name: 'Main', visible: true })
    expect(await store.getActivePartId()).toBe('main')
    // The old flat iterations became the main part's history, active pointer preserved.
    expect((await store.listIterations()).map((it) => it.n)).toEqual([1, 2])
    expect((await store.activeIterationRecord())?.n).toBe(1)
  })

  it('tags synthesized chat lines with the part name once a project has more than one part', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'the box' })
    await recordScript(store, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'the lid', partId: 'lid', partName: 'Lid' })

    const history = await store.getChatHistory()
    const ids = history.map((m) => m.id)
    // Part-scoped, unique ids (box v1 and lid v1 would collide under a global `iteration-1`).
    expect(ids).toContain('iteration-main-1')
    expect(ids).toContain('iteration-lid-1')
    expect(new Set(ids).size).toBe(ids.length)
    expect(history.find((m) => m.id === 'iteration-lid-1')?.text).toBe('Model v1 displayed (Lid): the lid')
  })

  it('does not leave a phantom part when the snapshot copy fails for a new part', async () => {
    const store = makeStore()
    await store.ensureProject()
    // No source script on disk -> the copyFile in recordIteration throws before any record mutation.
    await expect(
      store.recordIteration({
        stlPath: 'outputs/lid_v1.stl',
        scriptPath: 'outputs/missing.py',
        summary: 'lid',
        partId: 'lid'
      })
    ).rejects.toThrow()
    // The 'lid' part must NOT have been added to the in-memory record (no ghost part).
    expect((await store.listParts()).map((p) => p.id)).toEqual(['main'])
  })

  it('migrates a parts[] record whose part lacks an iterations array without throwing or data loss', async () => {
    const legacyDir = join(scratch, 'projects', 'default')
    await mkdir(join(legacyDir, 'outputs'), { recursive: true })
    await writeFile(
      join(legacyDir, 'project.json'),
      JSON.stringify({
        id: 'default',
        name: 'Malformed',
        createdAt: '2023-01-01T00:00:00.000Z',
        activePartId: 'main',
        // A part object with no `iterations` field - a bare deref would throw, which readRecord's
        // catch would turn into a destructive fresh-record overwrite. Migration must coerce instead.
        parts: [
          {
            id: 'main',
            name: 'Main',
            createdAt: '2023-01-01T00:00:00.000Z',
            placement: { position: [0, 0, 0], rotation: [0, 0, 0] },
            visible: true
          }
        ],
        messages: []
      }),
      'utf-8'
    )

    const store = makeStore()
    await store.ensureProject()
    expect((await store.listParts()).map((p) => p.id)).toEqual(['main'])
    expect(await store.listIterations('main')).toEqual([])
    // The original name survived (no fresh-record overwrite).
    expect((await store.listProjects())[0].name).toBe('Malformed')
  })
})

describe('ProjectStore.duplicatePart', () => {
  it('copies the part with a -copy suffix, offset placement, and the same iteration history', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })
    await recordScript(store, { stlPath: 'outputs/box_v2.stl', scriptPath: 'outputs/box_v2.py', summary: 'box2' })
    await store.setPlacement('main', { position: [10, 0, -5], rotation: [0, 90, 0] })

    const parts = await store.duplicatePart('main')
    expect(parts.map((p) => p.id)).toEqual(['main', 'main-copy'])

    const copy = parts.find((p) => p.id === 'main-copy')
    expect(copy?.name).toBe('Main copy')
    expect(copy?.placement).toEqual({ position: [35, 0, 20], rotation: [0, 90, 0] })
    expect(copy?.activeIteration).toBe(2)
    // The full history came along, pointing at the same immutable artifacts.
    const iterations = await store.listIterations('main-copy')
    expect(iterations.map((it) => it.n)).toEqual([1, 2])
    expect(iterations[1].stlPath).toBe('outputs/box_v2.stl')
    // The duplicate becomes the active part (the user duplicates in order to work with it).
    expect(await store.getActivePartId()).toBe('main-copy')
  })

  it('uniquifies the id and name when the part was already duplicated', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })

    await store.duplicatePart('main')
    const parts = await store.duplicatePart('main')
    expect(parts.map((p) => p.id)).toEqual(['main', 'main-copy', 'main-copy-2'])
    expect(parts.map((p) => p.name)).toEqual(['Main', 'Main copy', 'Main copy 2'])
  })

  it('diverges independently: recording into the copy leaves the source untouched', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })
    await store.duplicatePart('main')

    // The duplicate is active, so an unscoped record lands in it.
    await recordScript(store, { stlPath: 'outputs/copy_v2.stl', scriptPath: 'outputs/copy_v2.py', summary: 'tweak' })
    expect((await store.listIterations('main-copy')).map((it) => it.n)).toEqual([1, 2])
    expect((await store.listIterations('main')).map((it) => it.n)).toEqual([1])
  })

  it('makes a hidden source\'s duplicate visible and preserves an empty history', async () => {
    const store = makeStore()
    await store.ensureProject()
    await store.setVisibility('main', false)

    const parts = await store.duplicatePart('main')
    const copy = parts.find((p) => p.id === 'main-copy')
    expect(copy?.visible).toBe(true)
    expect(copy?.activeIteration).toBeNull()
    expect(await store.listIterations('main-copy')).toEqual([])
  })

  it('throws for an unknown part id', async () => {
    const store = makeStore()
    await store.ensureProject()
    await expect(store.duplicatePart('bogus')).rejects.toThrow('Unknown part: bogus')
  })

  it('survives a reload: the duplicate persists in project.json', async () => {
    const first = makeStore()
    await first.ensureProject()
    await recordScript(first, { stlPath: 'outputs/box_v1.stl', scriptPath: 'outputs/box_v1.py', summary: 'box' })
    await first.duplicatePart('main')

    const reloaded = makeStore()
    await reloaded.ensureProject()
    expect((await reloaded.listParts()).map((p) => p.id)).toEqual(['main', 'main-copy'])
    expect(await reloaded.getActivePartId()).toBe('main-copy')
  })
})

describe('ProjectStore.deletePart', () => {
  it('removes a non-active part, leaving the active pointer untouched', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'lid', partId: 'lid' })
    await store.setActivePart('main')

    const parts = await store.deletePart('lid')
    expect(parts.map((p) => p.id)).toEqual(['main'])
    expect(await store.getActivePartId()).toBe('main')
  })

  it('reassigns the active pointer to the first remaining part when the active part is deleted', async () => {
    const store = makeStore()
    await store.ensureProject()
    await recordScript(store, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'lid', partId: 'lid' })
    expect(await store.getActivePartId()).toBe('lid')

    const parts = await store.deletePart('lid')
    expect(parts.map((p) => p.id)).toEqual(['main'])
    expect(await store.getActivePartId()).toBe('main')
  })

  it('throws for an unknown part id', async () => {
    const store = makeStore()
    await store.ensureProject()
    await expect(store.deletePart('bogus')).rejects.toThrow('Unknown part: bogus')
  })

  it('throws when deleting the only remaining part', async () => {
    const store = makeStore()
    await store.ensureProject()
    await expect(store.deletePart('main')).rejects.toThrow('Cannot delete the only part in a project')
  })

  it('leaves the removed part\'s on-disk artifacts untouched and persists across a reload', async () => {
    const first = makeStore()
    const { dir } = await first.ensureProject()
    await recordScript(first, { stlPath: 'outputs/lid_v1.stl', scriptPath: 'outputs/lid_v1.py', summary: 'lid', partId: 'lid' })
    await first.deletePart('lid')

    // The version snapshot the deleted part's iteration pointed to is still on disk.
    expect(await readFile(join(dir, 'outputs', 'versions', 'lid', 'v1.py'), 'utf-8')).toBe('# source of outputs/lid_v1.py')

    const reloaded = makeStore()
    await reloaded.ensureProject()
    expect((await reloaded.listParts()).map((p) => p.id)).toEqual(['main'])
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
