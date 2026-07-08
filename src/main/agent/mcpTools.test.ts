import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDisplayModelTool, createRecommendPrintSettingsTool, createSetStatusTool } from './mcpTools'
import type { VoyagerMcpDeps, VoyagerMcpEmission, VoyagerMcpProjectStore } from './mcpTools'
import type { ProjectIteration } from '../projects/store'

let projectDir: string
let emissions: VoyagerMcpEmission[]
let recorded: Array<Parameters<VoyagerMcpProjectStore['recordIteration']>[0]>
/** Settable by tests that need `activeIterationRecord()` to resolve to a specific iteration (or
 *  null, the "no model yet" case) independent of what `recordIteration` has produced so far. */
let activeIteration: ProjectIteration | null

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'voyager-mcp-'))
  await mkdir(join(projectDir, 'outputs'), { recursive: true })
  emissions = []
  recorded = []
  activeIteration = null
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
      },
      activeIterationRecord: async (): Promise<ProjectIteration | null> => activeIteration
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

describe('recommend_print_settings tool', () => {
  const args = {
    material: 'PLA',
    layer_height_mm: 0.2,
    wall_count: 3,
    top_bottom_layers: 4,
    infill_percent: 20,
    infill_pattern: 'gyroid',
    supports: 'None',
    adhesion: 'Brim',
    nozzle_temp_c: 210,
    bed_temp_c: 60,
    print_speed_mm_s: 50,
    orientation: 'Flat face down for maximum bed contact',
    notes: 'Brim helps the small footprint stay put.'
  }

  it('emits print-settings tagged with the active iteration when a model exists', async () => {
    activeIteration = {
      n: 3,
      stlPath: 'outputs/part_v3.stl',
      scriptPath: 'outputs/part_v3.py',
      summary: 'A bracket',
      at: new Date().toISOString()
    }

    const handler = createRecommendPrintSettingsTool(deps()).handler
    const result = await handler(args, {})

    expect(result.isError).toBeFalsy()
    expect(emissions).toHaveLength(1)
    const emission = emissions[0]
    if (emission.kind !== 'print-settings') throw new Error('expected print-settings')
    expect(emission.payload).toEqual({
      iteration: 3,
      material: 'PLA',
      layerHeightMm: 0.2,
      wallCount: 3,
      topBottomLayers: 4,
      infillPercent: 20,
      infillPattern: 'gyroid',
      supports: 'None',
      adhesion: 'Brim',
      nozzleTempC: 210,
      bedTempC: 60,
      printSpeedMmS: 50,
      orientation: 'Flat face down for maximum bed contact',
      notes: 'Brim helps the small footprint stay put.'
    })
  })

  it('errors and emits nothing when no model has been displayed yet', async () => {
    activeIteration = null

    const handler = createRecommendPrintSettingsTool(deps()).handler
    const result = await handler(args, {})

    expect(result.isError).toBe(true)
    expect(emissions).toHaveLength(0)
  })
})
