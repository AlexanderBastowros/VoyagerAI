import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { textResult } from './helpers'
import type { VoyagerMcpDeps } from './types'

/**
 * Builds the `set_status` MCP tool: a lightweight way for Claude to narrate
 * a long-running step (running the script, validating the mesh) without
 * that text becoming part of its chat reply. Reported as a `tool-activity`
 * agent event rather than extending the shared IPC contract with a new
 * event type - see `VoyagerMcpEmission`'s doc comment.
 */
export function createSetStatusTool(deps: VoyagerMcpDeps): SdkMcpToolDefinition<{ message: z.ZodString }> {
  return tool(
    'set_status',
    'Report a short status update (e.g. "Running the parametric script...") to show in the chat ' +
      'while you work. Does not count as your reply to the user.',
    { message: z.string() },
    async (args) => {
      deps.emit({ kind: 'status', detail: args.message })
      return textResult('ok')
    }
  )
}
