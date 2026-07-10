import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSavePrinterProfileTool } from './savePrinterProfile'
import { PrinterProfileStore } from '../src/projects/printerProfiles'
import type { VoyagerMcpDeps, VoyagerMcpEmission } from './types'

let baseDir: string
let emissions: VoyagerMcpEmission[]
let printerProfiles: PrinterProfileStore

function deps(): VoyagerMcpDeps {
  return {
    projectStore: {
      getProjectDir: () => baseDir,
      recordIteration: async () => {
        throw new Error('not used')
      },
      activeIterationRecord: async () => null
    },
    printerProfiles,
    emit: (e) => emissions.push(e)
  }
}

/** Same explicit-undefined convention as `updateBrief.test.ts` - the SDK's `tool()` types every
 *  optional field as a required key of `X | undefined`. */
type SaveArgs = Parameters<ReturnType<typeof createSavePrinterProfileTool>['handler']>[0]

function args(overrides: Partial<SaveArgs> = {}): SaveArgs {
  return {
    name: 'Prusa MK4',
    bed_x_mm: 250,
    bed_y_mm: 210,
    bed_z_mm: 220,
    nozzle_diameter_mm: 0.4,
    materials: undefined,
    ...overrides
  }
}

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'voyager-mcp-printer-'))
  emissions = []
  printerProfiles = new PrinterProfileStore({ baseDir })
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('save_printer_profile tool', () => {
  it('persists the profile, makes it active, and emits printer-profiles-updated', async () => {
    const handler = createSavePrinterProfileTool(deps()).handler
    const result = await handler(args({ materials: ['PLA', 'PETG'] }), {})

    expect(result.isError).toBeFalsy()
    expect((result.content[0] as { text: string }).text).toContain('Prusa MK4')
    expect((result.content[0] as { text: string }).text).toMatch(/active/i)

    expect(emissions).toHaveLength(1)
    const emission = emissions[0]
    if (emission.kind !== 'printer-profiles-updated') throw new Error('expected printer-profiles-updated')
    expect(emission.payload.activeId).toBe('prusa-mk4')
    expect(emission.payload.profiles[0]).toMatchObject({
      name: 'Prusa MK4',
      bedXMm: 250,
      bedYMm: 210,
      bedZMm: 220,
      nozzleDiameterMm: 0.4,
      materials: ['PLA', 'PETG']
    })

    expect(await printerProfiles.getActive()).toMatchObject({ id: 'prusa-mk4' })
  })

  it('defaults materials to an empty list when omitted', async () => {
    const handler = createSavePrinterProfileTool(deps()).handler
    await handler(args(), {})
    expect((await printerProfiles.getActive())?.materials).toEqual([])
  })

  it('returns store validation failures as a clean error result, not a crash', async () => {
    const handler = createSavePrinterProfileTool(deps()).handler
    const result = await handler(args({ bed_x_mm: 0 }), {})

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/positive number of millimeters/)
    expect(emissions).toHaveLength(0)
    expect(await printerProfiles.list()).toEqual({ profiles: [], activeId: null })
  })

  it('errors cleanly when no printer profile store is configured', async () => {
    const handler = createSavePrinterProfileTool({ ...deps(), printerProfiles: undefined }).handler
    const result = await handler(args(), {})
    expect(result.isError).toBe(true)
    expect(emissions).toHaveLength(0)
  })
})
