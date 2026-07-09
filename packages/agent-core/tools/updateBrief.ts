import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { briefAgentPatchShape } from '../brief/agentPatch'
import { computeBriefCompleteness } from '../brief/completeness'
import { textResult } from './helpers'
import type { VoyagerMcpDeps } from './types'

/**
 * Builds the `update_brief` MCP tool (WS-A, architecture doc §6): lets the designer persist the
 * Design Brief fields it confirms with the user as it confirms them, rather than holding
 * everything in its own context until the end. Every value it sets is recorded with `inferred`
 * provenance - only the user (via the brief panel) can mark a field as confirmed - so the tool
 * accepts bare numbers/strings, not the domain `Dim` shape; `BriefStore.applyAgentPatch` (via
 * `mergeAgentPatch`) does the wrapping. The returned text reports the resulting version/lock/
 * completeness state so the agent has a way to check whether it's clear to move on to generation
 * without a separate read tool.
 */
export function createUpdateBriefTool(deps: VoyagerMcpDeps): SdkMcpToolDefinition<typeof briefAgentPatchShape> {
  return tool(
    'update_brief',
    'Propose values for the project\'s Design Brief - the structured spec (part identity, ' +
      'envelope, features, materials, constraints, exclusions, acceptance criteria) that gates ' +
      'generation and later verification. Call this as soon as you confirm a field with the user ' +
      'during Phase 2 - do not wait until the end to record everything at once; the brief panel ' +
      'updates live as you call this. Every value you set is recorded with "inferred" provenance ' +
      'and rendered distinctly until the user confirms or edits it directly in the panel - you ' +
      'never get to mark something user-confirmed yourself. Only set the fields you have new or ' +
      'changed information for; omitted fields are left as they are. Features are matched by ' +
      '`id` - reuse the same id to revise a feature you already proposed; a new id adds one. Do ' +
      'not proceed to Phase 4 (code generation) until the returned status says the brief is locked.',
    briefAgentPatchShape,
    async (args) => {
      if (!deps.briefStore) return textResult('The brief store is not available in this session.', true)

      const projectDir = deps.projectStore.getProjectDir()
      const brief = await deps.briefStore.applyAgentPatch(projectDir, args)
      deps.emit({ kind: 'brief-updated', payload: brief })

      const completeness = computeBriefCompleteness(brief)
      const status = brief.lockedAt
        ? `locked (version ${brief.version})`
        : `draft version ${brief.version}, not locked, ${completeness.percent}% of required fields filled`
      return textResult(`Design brief updated - ${status}.`)
    }
  )
}
