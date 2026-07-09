import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { textResult } from './helpers'
import type { VoyagerMcpDeps } from './types'

/**
 * Builds the `run_verification` MCP tool (WS-C, architecture doc §5): recomputes the active
 * iteration's verification report on demand, without recording a new iteration. Every
 * `recordIteration()` already triggers this automatically (see `ProjectStore.onIterationRecorded`),
 * so this tool exists for the case where something that affects conformance changed *without* a
 * new iteration - most commonly the brief being edited or locked after the model was generated.
 */
export function createRunVerificationTool(deps: VoyagerMcpDeps): SdkMcpToolDefinition<Record<string, never>> {
  return tool(
    'run_verification',
    'Recompute the verification report (static script checks, geometry, brief conformance) for ' +
      "the currently displayed model, without generating a new iteration. Call this if you've " +
      "just locked or edited the brief after the model was already displayed, or if the user " +
      "asks to re-check conformance. Most of the time you don't need this - every display_model " +
      'call already triggers a fresh check automatically.',
    {},
    async () => {
      if (!deps.runVerification) return textResult('Verification is not available in this session.', true)

      const active = await deps.projectStore.activeIterationRecord()
      if (!active) return textResult('No model is displayed yet — generate a model before verifying it.', true)

      const report = await deps.runVerification(active)
      deps.emit({ kind: 'verification-computed', payload: report })

      const blocking = report.findings.filter((f) => f.severity === 'blocking').length
      const failedRows = report.conformance.filter((row) => !row.pass).length
      return textResult(
        `Verification updated for v${active.n}: badge "${report.badge}", ${blocking} blocking ` +
          `finding(s), ${failedRows} failed conformance row(s). Shown in the verification panel.`
      )
    }
  )
}
