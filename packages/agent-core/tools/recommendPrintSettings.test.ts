import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRecommendPrintSettingsTool } from './recommendPrintSettings'
import type { ProjectIteration } from '../src/projects/store'
import type { VoyagerMcpEmission } from './types'
import { makeDeps } from './testSupport'

let projectDir: string
let emissions: VoyagerMcpEmission[]
let activeIteration: ProjectIteration | null

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'voyager-mcp-'))
  emissions = []
  activeIteration = null
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
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

    const deps = makeDeps(projectDir, emissions, [], () => activeIteration)
    const handler = createRecommendPrintSettingsTool(deps).handler
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

    const deps = makeDeps(projectDir, emissions, [], () => activeIteration)
    const handler = createRecommendPrintSettingsTool(deps).handler
    const result = await handler(args, {})

    expect(result.isError).toBe(true)
    expect(emissions).toHaveLength(0)
  })
})
