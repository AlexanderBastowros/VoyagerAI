import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDisplayModelTool, createSetStatusTool } from './mcpTools'
import type { VoyagerMcpDeps, VoyagerMcpEmission, VoyagerMcpProjectStore } from './mcpTools'
import type { ProjectIteration } from '../projects/store'

let projectDir: string
let emissions: VoyagerMcpEmission[]
let recorded: Array<Parameters<VoyagerMcpProjectStore['recordIteration']>[0]>

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'voyager-mcp-'))
  await mkdir(join(projectDir, 'outputs'), { recursive: true })
  emissions = []
  recorded = []
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

function deps(): VoyagerMcpDeps {
  let n = 0
  return {
    projectStore: {
      getProjectDir: () => projectDir,
      recordIteration: async (entry): Promise<ProjectIteration> => {
        recorded.push(entry)
        n += 1
        return { ...entry, n, at: new Date().toISOString() }
      }
    },
    emit: (emission) => emissions.push(emission)
  }
}

/** A structurally-plausible binary STL: 80-byte header + count + one triangle. */
function fakeStlBytes(): Buffer {
  return Buffer.alloc(84 + 50, 7)
}

describe('display_model tool', () => {
  it('rejects paths that escape the project directory without emitting', async () => {
    const handler = createDisplayModelTool(deps()).handler
    const result = await handler(
      {
        stl_path: '../../etc/passwd',
        step_path: undefined,
        script_path: 'outputs/part_v1.py',
        summary: 'nope'
      },
      {}
    )
    expect(result.isError).toBe(true)
    expect(emissions).toHaveLength(0)
    expect(recorded).toHaveLength(0)
  })

  it('rejects absolute paths outside the project directory', async () => {
    const handler = createDisplayModelTool(deps()).handler
    const result = await handler(
      { stl_path: '/etc/hosts', step_path: undefined, script_path: 'outputs/p.py', summary: 'nope' },
      {}
    )
    expect(result.isError).toBe(true)
  })

  it('errors cleanly when the STL is missing or too small', async () => {
    const handler = createDisplayModelTool(deps()).handler

    const missing = await handler(
      { stl_path: 'outputs/nope.stl', step_path: undefined, script_path: 'outputs/p.py', summary: 's' },
      {}
    )
    expect(missing.isError).toBe(true)

    await writeFile(join(projectDir, 'outputs', 'tiny.stl'), Buffer.alloc(10))
    const tiny = await handler(
      { stl_path: 'outputs/tiny.stl', step_path: undefined, script_path: 'outputs/p.py', summary: 's' },
      {}
    )
    expect(tiny.isError).toBe(true)
    expect(emissions).toHaveLength(0)
  })

  it('records the iteration and emits the STL bytes for a valid export', async () => {
    await writeFile(join(projectDir, 'outputs', 'part_v1.stl'), fakeStlBytes())
    await writeFile(join(projectDir, 'outputs', 'part_v1.py'), '# script')

    const handler = createDisplayModelTool(deps()).handler
    const result = await handler(
      {
        stl_path: 'outputs/part_v1.stl',
        step_path: 'outputs/part_v1.step',
        script_path: 'outputs/part_v1.py',
        summary: 'A 20mm test cube'
      },
      {}
    )

    // step_path may not exist on disk; only the STL is content-checked.
    expect(result.isError).toBeFalsy()
    expect(result.content[0]).toEqual({ type: 'text', text: 'Model v1 is now displayed in the viewport.' })

    expect(recorded).toEqual([
      {
        stlPath: 'outputs/part_v1.stl',
        stepPath: 'outputs/part_v1.step',
        scriptPath: 'outputs/part_v1.py',
        summary: 'A 20mm test cube'
      }
    ])

    expect(emissions).toHaveLength(1)
    const emission = emissions[0]
    if (emission.kind !== 'model-displayed') throw new Error('expected model-displayed')
    expect(emission.payload.iteration).toBe(1)
    expect(emission.payload.stlBuffer.byteLength).toBe(fakeStlBytes().byteLength)
  })
})

describe('set_status tool', () => {
  it('emits the status detail', async () => {
    const handler = createSetStatusTool(deps()).handler
    const result = await handler({ message: 'Running the parametric script…' }, {})
    expect(result.isError).toBeFalsy()
    expect(emissions).toEqual([{ kind: 'status', detail: 'Running the parametric script…' }])
  })
})
