import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDisplayModelTool } from './displayModel'
import { BriefStore } from '../brief/store'
import type { VoyagerMcpEmission, VoyagerMcpProjectStore } from './types'
import { fakeStlBytes, makeDeps } from './testSupport'

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

function deps() {
  return makeDeps(projectDir, emissions, recorded, () => null)
}

describe('display_model tool', () => {
  it('rejects paths that escape the project directory without emitting', async () => {
    const handler = createDisplayModelTool(deps()).handler
    const result = await handler(
      {
        stl_path: '../../etc/passwd',
        step_path: undefined,
        script_path: 'outputs/part_v1.py',
        summary: 'nope',
        part: undefined,
        part_name: undefined
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
      { stl_path: '/etc/hosts', step_path: undefined, script_path: 'outputs/p.py', summary: 'nope', part: undefined, part_name: undefined },
      {}
    )
    expect(result.isError).toBe(true)
  })

  it('errors cleanly when the STL is missing or too small', async () => {
    const handler = createDisplayModelTool(deps()).handler

    const missing = await handler(
      { stl_path: 'outputs/nope.stl', step_path: undefined, script_path: 'outputs/p.py', summary: 's', part: undefined, part_name: undefined },
      {}
    )
    expect(missing.isError).toBe(true)

    await writeFile(join(projectDir, 'outputs', 'tiny.stl'), Buffer.alloc(10))
    const tiny = await handler(
      { stl_path: 'outputs/tiny.stl', step_path: undefined, script_path: 'outputs/p.py', summary: 's', part: undefined, part_name: undefined },
      {}
    )
    expect(tiny.isError).toBe(true)
    expect(emissions).toHaveLength(0)
  })

  it('errors when the STL is valid but the script is missing, without recording', async () => {
    await writeFile(join(projectDir, 'outputs', 'part_v1.stl'), fakeStlBytes())
    // No part_v1.py written.

    const handler = createDisplayModelTool(deps()).handler
    const result = await handler(
      { stl_path: 'outputs/part_v1.stl', step_path: undefined, script_path: 'outputs/part_v1.py', summary: 's', part: undefined, part_name: undefined },
      {}
    )

    expect(result.isError).toBe(true)
    expect(recorded).toHaveLength(0)
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
        summary: 'A 20mm test cube',
        part: undefined,
        part_name: undefined
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
        summary: 'A 20mm test cube',
        partId: 'main'
      }
    ])

    expect(emissions).toHaveLength(1)
    const emission = emissions[0]
    if (emission.kind !== 'model-displayed') throw new Error('expected model-displayed')
    expect(emission.payload.iteration).toBe(1)
    expect(emission.payload.stlBuffer.byteLength).toBe(fakeStlBytes().byteLength)
    // No explicit part -> the active (`main`) part; the emission carries it so the viewer keys its
    // per-part mesh map correctly (WS-I).
    expect(emission.payload.partId).toBe('main')
  })

  it('records into (and emits) an explicit part slug, slugified (WS-I)', async () => {
    await writeFile(join(projectDir, 'outputs', 'lid_v1.stl'), fakeStlBytes())
    await writeFile(join(projectDir, 'outputs', 'lid_v1.py'), '# script')

    const handler = createDisplayModelTool(deps()).handler
    await handler(
      {
        stl_path: 'outputs/lid_v1.stl',
        step_path: undefined,
        script_path: 'outputs/lid_v1.py',
        summary: 'the lid',
        part: 'Lid Top',
        part_name: 'Lid'
      },
      {}
    )

    expect(recorded[0]).toMatchObject({ partId: 'lid-top', partName: 'Lid' })
    const emission = emissions[0]
    if (emission.kind !== 'model-displayed') throw new Error('expected model-displayed')
    expect(emission.payload.partId).toBe('lid-top')
  })

  it('stamps the locked brief version onto the iteration when a brief store is configured', async () => {
    await writeFile(join(projectDir, 'outputs', 'part_v1.stl'), fakeStlBytes())
    await writeFile(join(projectDir, 'outputs', 'part_v1.py'), '# script')

    const briefStore = new BriefStore()
    await briefStore.replace(projectDir, {
      ...(await briefStore.get(projectDir)),
      part: { name: 'Bracket', purpose: 'Mounts a sensor', referenceImages: [] },
      envelope: {
        x: { value: 40, unit: 'mm', provenance: 'user' },
        y: { value: 30, unit: 'mm', provenance: 'user' },
        z: { value: 10, unit: 'mm', provenance: 'user' }
      },
      materials: { requested: 'PLA', onHand: [] },
      acceptance: ['Fits without wobble']
    })
    await briefStore.lock(projectDir)

    const handler = createDisplayModelTool({ ...deps(), briefStore }).handler
    await handler(
      { stl_path: 'outputs/part_v1.stl', step_path: undefined, script_path: 'outputs/part_v1.py', summary: 's', part: undefined, part_name: undefined },
      {}
    )

    expect(recorded).toEqual([
      {
        stlPath: 'outputs/part_v1.stl',
        stepPath: undefined,
        scriptPath: 'outputs/part_v1.py',
        summary: 's',
        partId: 'main',
        briefVersion: 1
      }
    ])
  })

  it('does not stamp a briefVersion when the brief has never been locked', async () => {
    await writeFile(join(projectDir, 'outputs', 'part_v1.stl'), fakeStlBytes())
    await writeFile(join(projectDir, 'outputs', 'part_v1.py'), '# script')

    const briefStore = new BriefStore()
    const handler = createDisplayModelTool({ ...deps(), briefStore }).handler
    await handler(
      { stl_path: 'outputs/part_v1.stl', step_path: undefined, script_path: 'outputs/part_v1.py', summary: 's', part: undefined, part_name: undefined },
      {}
    )

    expect(recorded[0]).not.toHaveProperty('briefVersion')
  })
})
