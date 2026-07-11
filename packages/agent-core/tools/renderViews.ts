import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { textResult } from './helpers'
import type { VoyagerMcpDeps } from './types'

/** Canonical view order (WS-D, architecture doc §4.3): 6 orthographic axis views + 2 isometric.
 *  Mirrors `packages/render-rig/src/renderViews.ts`'s `RENDER_VIEW_NAMES` - duplicated here
 *  (rather than importing across the package boundary) since it's just a fixed display order,
 *  not shared logic. */
const VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso1', 'iso2'] as const

/**
 * Builds the `render_views` MCP tool (WS-D, architecture doc §4.3/§5): renders the currently
 * displayed iteration from 6 orthographic + 2 isometric canonical views and hands the images
 * back as image content blocks, so the designer can actually *look at* what it built before
 * declaring success ("self-inspection catches most gross errors at zero extra-model cost").
 * Exported standalone (not just bundled into the server) so tests can call `.handler(...)`
 * directly without spinning up an MCP transport - same pattern as every other tool file here.
 */
export function createRenderViewsTool(deps: VoyagerMcpDeps): SdkMcpToolDefinition<Record<string, never>> {
  return tool(
    'render_views',
    'Render the currently displayed model from 6 orthographic views (front/back/left/right/top/' +
      'bottom) plus 2 isometric angles, with fixed lighting, a neutral material, and an mm grid ' +
      'in frame. Call this before declaring the model done (printable-cad skill Phase 5/6) to ' +
      "actually look at what you built - missing, misplaced, mirrored, or mis-oriented features " +
      'are usually obvious in these views. It cannot judge dimensions - that is what layers 1-3 ' +
      'and run_verification are for.',
    {},
    async (): Promise<CallToolResult> => {
      if (!deps.renderViews) return textResult('Rendering is not available in this session.', true)

      const active = await deps.projectStore.activeIterationRecord()
      if (!active) return textResult('No model is displayed yet — generate a model before rendering it.', true)

      const outcome = await deps.renderViews(active)
      if (!outcome.ok) return textResult(`Could not render views: ${outcome.error}`, true)

      const content: CallToolResult['content'] = []
      for (const name of VIEW_ORDER) {
        const filename = outcome.views[name]
        if (!filename) continue
        try {
          const bytes = await readFile(join(outcome.dir, filename))
          content.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
        } catch {
          // One missing/unreadable view degrades gracefully - the rest of the set still helps.
        }
      }

      if (content.length === 0) {
        return textResult(`Render set for v${active.n} was produced but no image files could be read.`, true)
      }

      const dims = `${outcome.widthMm.toFixed(1)} × ${outcome.depthMm.toFixed(1)} × ${outcome.heightMm.toFixed(1)} mm`
      content.push({
        type: 'text',
        text:
          `Rendered v${active.n} from ${content.length} canonical view(s) (${dims} bounding box). ` +
          'Look for missing, misplaced, mirrored, or mis-oriented features before declaring success.'
      })

      return { content }
    }
  )
}
