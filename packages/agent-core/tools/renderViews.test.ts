import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRenderViewsTool } from './renderViews'
import { makeDeps } from './testSupport'
import type { RenderIterationOutcome, VoyagerMcpEmission } from './types'
import type { ProjectIteration } from '../src/projects/store'

const activeIteration: ProjectIteration = {
  n: 3,
  stlPath: 'outputs/part_v3.stl',
  scriptPath: 'outputs/part_v3.py',
  summary: 'A bracket',
  at: '2026-07-11T00:00:00.000Z'
}

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'voyager-render-views-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** Writes a fake render set to `scratch` and returns the ok:true outcome the injected
 *  `deps.renderViews` would produce - lets tests exercise the tool's own file-reading logic
 *  against real bytes on disk instead of mocking `readFile`. */
async function writeFakeRenders(views: string[]): Promise<RenderIterationOutcome> {
  const dir = join(scratch, 'part_v3.renders')
  await mkdir(dir, { recursive: true })
  const map: Partial<Record<string, string>> = {}
  for (const name of views) {
    const filename = `${name}.png`
    await writeFile(join(dir, filename), Buffer.from(`fake-png-${name}`))
    map[name] = filename
  }
  return { ok: true, dir, views: map, widthMm: 40, heightMm: 20, depthMm: 10 }
}

describe('render_views tool', () => {
  it('renders the active iteration and returns each view as an image content block plus a text summary', async () => {
    const emissions: VoyagerMcpEmission[] = []
    const outcome = await writeFakeRenders(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso1', 'iso2'])
    let calledWith: ProjectIteration | null = null

    const deps = {
      ...makeDeps('/proj', emissions, [], () => activeIteration),
      renderViews: async (iteration: ProjectIteration) => {
        calledWith = iteration
        return outcome
      }
    }

    const handler = createRenderViewsTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBeFalsy()
    expect(calledWith).toEqual(activeIteration)

    const images = result.content.filter((entry) => entry.type === 'image')
    expect(images).toHaveLength(8)
    expect(images.every((entry) => entry.type === 'image' && entry.mimeType === 'image/png')).toBe(true)
    // Bytes round-trip correctly through base64.
    const front = images[0] as { type: 'image'; data: string; mimeType: string }
    expect(Buffer.from(front.data, 'base64').toString()).toBe('fake-png-front')

    const text = result.content.find((entry) => entry.type === 'text') as { text: string }
    expect(text.text).toContain('v3')
    expect(text.text).toContain('8 canonical view')
    expect(text.text).toContain('40.0 × 10.0 × 20.0 mm')
  })

  it('degrades gracefully when some view files are missing, using only the readable ones', async () => {
    const emissions: VoyagerMcpEmission[] = []
    const dir = join(scratch, 'part_v3.renders')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'front.png'), Buffer.from('fake-png-front'))
    // "back.png" is listed but never actually written - simulates one view failing to render.
    const outcome: RenderIterationOutcome = {
      ok: true,
      dir,
      views: { front: 'front.png', back: 'back.png' },
      widthMm: 40,
      heightMm: 20,
      depthMm: 10
    }

    const deps = {
      ...makeDeps('/proj', emissions, [], () => activeIteration),
      renderViews: async () => outcome
    }

    const handler = createRenderViewsTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBeFalsy()
    const images = result.content.filter((entry) => entry.type === 'image')
    expect(images).toHaveLength(1)
  })

  it('errors cleanly when the render outcome itself reports failure', async () => {
    const emissions: VoyagerMcpEmission[] = []
    const deps = {
      ...makeDeps('/proj', emissions, [], () => activeIteration),
      renderViews: async (): Promise<RenderIterationOutcome> => ({ ok: false, error: 'matplotlib is not installed' })
    }

    const handler = createRenderViewsTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('matplotlib is not installed')
  })

  it('errors cleanly when no model is displayed yet', async () => {
    const emissions: VoyagerMcpEmission[] = []
    const deps = {
      ...makeDeps('/proj', emissions, [], () => null),
      renderViews: async (): Promise<RenderIterationOutcome> => ({ ok: false, error: 'should not be called' })
    }

    const handler = createRenderViewsTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBe(true)
  })

  it('errors cleanly when rendering is not available in this session', async () => {
    const emissions: VoyagerMcpEmission[] = []
    const deps = makeDeps('/proj', emissions, [], () => activeIteration)

    const handler = createRenderViewsTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBe(true)
  })

  it('errors cleanly when every listed view file is unreadable', async () => {
    const emissions: VoyagerMcpEmission[] = []
    const outcome: RenderIterationOutcome = {
      ok: true,
      dir: join(scratch, 'does-not-exist'),
      views: { front: 'front.png' },
      widthMm: 40,
      heightMm: 20,
      depthMm: 10
    }
    const deps = {
      ...makeDeps('/proj', emissions, [], () => activeIteration),
      renderViews: async () => outcome
    }

    const handler = createRenderViewsTool(deps).handler
    const result = await handler({}, {})

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('no image files could be read')
  })
})
