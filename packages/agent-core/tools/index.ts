import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { createDisplayModelTool } from './displayModel'
import { createRecommendPrintSettingsTool } from './recommendPrintSettings'
import { createRunVerificationTool } from './runVerification'
import { createSetStatusTool } from './setStatus'
import { createUpdateBriefTool } from './updateBrief'
import type { VoyagerMcpDeps } from './types'

export { createDisplayModelTool } from './displayModel'
export { createRecommendPrintSettingsTool } from './recommendPrintSettings'
export { createRunVerificationTool } from './runVerification'
export { createSetStatusTool } from './setStatus'
export { createUpdateBriefTool } from './updateBrief'
export type { VoyagerBriefStore, VoyagerMcpDeps, VoyagerMcpEmission, VoyagerMcpProjectStore } from './types'

/**
 * Assembles the in-process `voyager` MCP server registered on the agent session's `mcpServers`
 * option. One file per tool under this directory (see `agents/production-roadmap.md`'s WS-0b) so
 * each parallel work order (WS-A's `updateBrief.ts`, WS-C's `runVerification.ts`, WS-D's
 * `renderViews.ts`, ...) adds its own tool file and a line here, never touching another
 * stream's file.
 */
export function createVoyagerMcpServer(deps: VoyagerMcpDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'voyager',
    version: '0.1.0',
    tools: [
      createDisplayModelTool(deps),
      createRecommendPrintSettingsTool(deps),
      createRunVerificationTool(deps),
      createSetStatusTool(deps),
      createUpdateBriefTool(deps)
    ]
  })
}
