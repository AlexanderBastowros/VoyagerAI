import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUpdateBriefTool } from './updateBrief'
import { BriefStore } from '../brief/store'
import type { BriefAgentPatch } from '../brief/agentPatch'
import type { VoyagerMcpDeps, VoyagerMcpEmission } from './types'

let projectDir: string
let emissions: VoyagerMcpEmission[]
let briefStore: BriefStore

function deps(): VoyagerMcpDeps {
  return {
    projectStore: {
      getProjectDir: () => projectDir,
      recordIteration: async () => {
        throw new Error('not used')
      },
      activeIterationRecord: async () => null,
      getActivePartId: async () => 'main'
    },
    briefStore,
    emit: (e) => emissions.push(e)
  }
}

/** The handler's actual args type, per the SDK's `tool()` - every optional field is a required
 *  key typed `X | undefined` (see `InferShape` in the SDK's `.d.ts`), not an optional key like a
 *  plain `z.infer<>` would give. Real tool calls only ever populate the fields they care about, so
 *  `patch()` fills in the rest as explicit `undefined` to satisfy that stricter shape in tests. */
type UpdateBriefArgs = Parameters<ReturnType<typeof createUpdateBriefTool>['handler']>[0]

function patch(overrides: Partial<BriefAgentPatch>): UpdateBriefArgs {
  return {
    part_name: undefined,
    part_purpose: undefined,
    envelope_x_mm: undefined,
    envelope_y_mm: undefined,
    envelope_z_mm: undefined,
    materials_requested: undefined,
    materials_on_hand: undefined,
    must_fit_bed: undefined,
    allow_split: undefined,
    max_pieces: undefined,
    print_orientation: undefined,
    load_bearing: undefined,
    exclusions: undefined,
    acceptance: undefined,
    features: undefined,
    printer_name: undefined,
    printer_bed_x_mm: undefined,
    printer_bed_y_mm: undefined,
    printer_bed_z_mm: undefined,
    printer_nozzle_mm: undefined,
    printer_materials: undefined,
    ...overrides
  }
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'voyager-mcp-brief-'))
  emissions = []
  briefStore = new BriefStore()
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('update_brief tool', () => {
  it('merges the patch, persists it, and emits brief-updated', async () => {
    const handler = createUpdateBriefTool(deps()).handler
    const result = await handler(patch({ part_name: 'Bracket', envelope_x_mm: 40 }), {})

    expect(result.isError).toBeFalsy()
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { text: string }).text).toContain('draft version 1')

    expect(emissions).toHaveLength(1)
    const emission = emissions[0]
    if (emission.kind !== 'brief-updated') throw new Error('expected brief-updated')
    expect(emission.payload.part.name).toBe('Bracket')

    const persisted = await briefStore.get(projectDir)
    expect(persisted.part.name).toBe('Bracket')
  })

  it('reports the lock status once the brief has been locked', async () => {
    await briefStore.replace(projectDir, {
      ...(await briefStore.get(projectDir)),
      part: { name: 'Bracket', purpose: 'Mounts a sensor', referenceImages: [] },
      envelope: {
        x: { value: 40, unit: 'mm', provenance: 'user' },
        y: { value: 30, unit: 'mm', provenance: 'user' },
        z: { value: 10, unit: 'mm', provenance: 'user' }
      },
      materials: { requested: 'PLA', onHand: [] },
      acceptance: ['Fits the sensor without wobble']
    })
    await briefStore.lock(projectDir)

    const handler = createUpdateBriefTool(deps()).handler
    const result = await handler(patch({ part_purpose: 'Revised purpose' }), {})

    // Editing a locked brief bumps the version and clears the lock (BriefStore semantics).
    expect((result.content[0] as { text: string }).text).toContain('draft version 2')
  })

  it('errors cleanly when no brief store is configured', async () => {
    const handler = createUpdateBriefTool({ ...deps(), briefStore: undefined }).handler
    const result = await handler(patch({ part_name: 'Bracket' }), {})
    expect(result.isError).toBe(true)
    expect(emissions).toHaveLength(0)
  })

  it('upserts a feature by id across two calls', async () => {
    const handler = createUpdateBriefTool(deps()).handler
    await handler(
      patch({ features: [{ kind: 'hole', id: 'f1', diameter_mm: 3.4, purpose: 'clearance', position: 'top-left' }] }),
      {}
    )
    await handler(
      patch({
        features: [{ kind: 'hole', id: 'f1', diameter_mm: 3.6, purpose: 'tapped', position: 'top-left, 5mm in' }]
      }),
      {}
    )

    const brief = await briefStore.get(projectDir)
    expect(brief.features).toHaveLength(1)
    expect(brief.features[0]).toMatchObject({ purpose: 'tapped', position: 'top-left, 5mm in' })
  })
})
