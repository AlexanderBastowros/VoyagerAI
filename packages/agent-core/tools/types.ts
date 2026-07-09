import type { DesignBrief, ModelDisplayedPayload, PrintSettings, VerificationReport } from '@shared/ipc'
import type { ProjectIteration } from '../src/projects/store'
import type { BriefAgentPatch } from '../brief/agentPatch'

/** The subset of ProjectStore each MCP tool needs - kept narrow for testability. */
export interface VoyagerMcpProjectStore {
  getProjectDir(): string
  recordIteration(entry: {
    stlPath: string
    stepPath?: string
    scriptPath: string
    summary: string
  }): Promise<ProjectIteration>
  /** The iteration currently shown/exported, or null if the project has none yet - used by
   *  `recommend_print_settings` to tag its output with the model version it applies to. */
  activeIterationRecord(): Promise<ProjectIteration | null>
}

/** The subset of `BriefStore` (`packages/agent-core/brief/store.ts`) the `update_brief` tool and
 *  `display_model` (for `briefVersion` stamping) need - kept narrow for testability, mirroring
 *  `VoyagerMcpProjectStore`. Optional on `VoyagerMcpDeps` so tool tests that don't touch the brief
 *  (set_status, recommend_print_settings, and existing display_model fixtures) don't need to wire
 *  one up; `AgentSession` always supplies a real one in production. */
export interface VoyagerBriefStore {
  get(projectDir: string): Promise<DesignBrief>
  applyAgentPatch(projectDir: string, patch: BriefAgentPatch): Promise<DesignBrief>
}

/**
 * Domain-level events tool handlers report back to whoever owns the session (AgentSession).
 * Kept independent of the raw `agent:event` / `model:displayed` IPC channel shapes so no tool
 * file needs to know about the current turn's `messageId` - AgentSession attaches that when it
 * turns an emission into an actual IPC push.
 */
export type VoyagerMcpEmission =
  | { kind: 'status'; detail: string }
  | { kind: 'model-displayed'; payload: ModelDisplayedPayload }
  | { kind: 'print-settings'; payload: PrintSettings }
  | { kind: 'brief-updated'; payload: DesignBrief }
  | { kind: 'verification-computed'; payload: VerificationReport }

export interface VoyagerMcpDeps {
  projectStore: VoyagerMcpProjectStore
  briefStore?: VoyagerBriefStore
  /**
   * Recomputes and persists the verification report for one iteration (WS-C) - backs the
   * `run_verification` on-demand tool. Optional so tool tests that don't touch verification
   * (every fixture that predates WS-C) don't need to wire one up; `AgentSession` always supplies
   * the real `verifyIteration` function `src/main/ipc.ts` builds (the same one its automatic
   * `ProjectStore.onIterationRecorded` hook uses) in production.
   */
  runVerification?: (iteration: ProjectIteration) => Promise<VerificationReport>
  emit: (emission: VoyagerMcpEmission) => void
}
