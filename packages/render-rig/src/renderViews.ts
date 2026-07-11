import { defaultExecFile } from './execFile'
import type { ExecFileFn } from './execFile'

/**
 * The fixed camera protocol's view names, in the canonical order `render_views.py` documents and
 * always returns them in (architecture doc §4.3: "6 orthographic axis views + 2 isometric").
 * Shared by the MCP tool (`packages/agent-core/tools/renderViews.ts`) and the skill paragraph so
 * there is exactly one list to keep in sync with the python side.
 */
export const RENDER_VIEW_NAMES = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso1', 'iso2'] as const
export type RenderViewName = (typeof RENDER_VIEW_NAMES)[number]

export interface RenderViewsOptions {
  /** Absolute path to the managed venv's python (EnvManager.pythonPath()). */
  pythonPath: string
  /** Absolute path to the bundled render_views.py. */
  scriptPath: string
  /** Absolute path to the STL to render. */
  stlPath: string
  /** Absolute path to the directory the view PNGs are written into (created if missing). */
  outDir: string
  /** Square output size in pixels. Omit to use the script's own default (512). */
  sizePx?: number
}

export type RenderViewsResult =
  | {
      ok: true
      /** View name -> filename inside `outDir` (e.g. `"front.png"`), one entry per
       *  `RENDER_VIEW_NAMES` - a `Partial` record since a corrupted/truncated stdout parse could
       *  in principle be missing an entry; callers should not assume every key is present. */
      views: Partial<Record<RenderViewName, string>>
      widthMm: number
      heightMm: number
      depthMm: number
      sizePx: number
    }
  | { ok: false; error: string }

function isRenderViewsResult(value: unknown): value is RenderViewsResult {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  const record = value as Record<string, unknown>
  if (record.ok === false) return typeof record.error === 'string'
  if (record.ok === true) {
    return (
      typeof record.views === 'object' &&
      record.views !== null &&
      typeof record.widthMm === 'number' &&
      typeof record.heightMm === 'number' &&
      typeof record.depthMm === 'number' &&
      typeof record.sizePx === 'number'
    )
  }
  return false
}

/**
 * Thin TS wrapper around the bundled `render_views.py` (WS-D, architecture doc §4.3/§5): runs it
 * with the managed Python environment's own interpreter and parses its one-line JSON result.
 * Mirrors `packages/verify/src/validateStl.ts`'s injectable-exec shape exactly, so the same
 * fake-exec test pattern applies without needing a real python/matplotlib/trimesh install.
 */
export async function renderViews(
  options: RenderViewsOptions,
  execFileFn: ExecFileFn = defaultExecFile
): Promise<RenderViewsResult> {
  const args = [options.scriptPath, options.stlPath, options.outDir]
  if (options.sizePx !== undefined) args.push('--size', String(options.sizePx))

  const result = await execFileFn(options.pythonPath, args)

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exited with code ${result.code}`).slice(-400)
    return { ok: false, error: `render_views.py produced no usable output: ${detail}` }
  }

  if (!isRenderViewsResult(parsed)) {
    return { ok: false, error: 'render_views.py returned an unexpected result shape.' }
  }
  return parsed
}
