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

describe('ProjectStore.getProjectDir', () => {
  it('throws before ensureProject has resolved', () => {
    expect(() => makeStore().getProjectDir()).toThrow(/ensureProject/)
  })
})
