import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSetStatusTool } from './setStatus'
import type { VoyagerMcpEmission } from './types'
import { makeDeps } from './testSupport'

let projectDir: string
let emissions: VoyagerMcpEmission[]

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'voyager-mcp-'))
  emissions = []
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('set_status tool', () => {
  it('emits the status detail', async () => {
    const deps = makeDeps(projectDir, emissions, [], () => null)
    const handler = createSetStatusTool(deps).handler
    const result = await handler({ message: 'Running the parametric script…' }, {})
    expect(result.isError).toBeFalsy()
    expect(emissions).toEqual([{ kind: 'status', detail: 'Running the parametric script…' }])
  })
})
