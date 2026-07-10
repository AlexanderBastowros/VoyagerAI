import type { DesignBrief, ModelDisplayedPayload, PrinterProfileRef, PrintSettings, VerificationReport } from '@shared/ipc'
import type { ProjectIteration } from '../src/projects/store'
import type { PrinterProfileList } from '../src/projects/printerProfiles'
import type { BriefAgentPatch } from '../brief/agentPatch'

/** The subset of ProjectStore each MCP tool needs - kept narrow for testability. */
export interface VoyagerMcpProjectStore {
  getProjectDir(): string
  recordIteration(entry: {
    stlPath: string
    stepPath?: string
    scriptPath: string
    summary: string
    briefVersion?: number
    /** Which part to record into (WS-I); defaults to the active part, created on first use. */
    partId?: string
    partName?: string
  }): Promise<ProjectIteration>
  /** The iteration currently shown/exported, or null if the project has none yet - used by
   *  `recommend_print_settings` to tag its output with the model version it applies to. */
  activeIterationRecord(): Promise<ProjectIteration | null>
  /** The active part's id (WS-I) - `display_model` resolves it to tag its emission with the part
   *  it recorded into when the agent didn't name one explicitly. */
  getActivePartId(): Promise<string>
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

/** The subset of `PrinterProfileStore` (`packages/agent-core/src/projects/printerProfiles.ts`)
 *  the `save_printer_profile` tool and `AgentSession` (which reads the active profile into the
 *  system prompt) need - kept narrow for testability, mirroring `VoyagerBriefStore`. Optional on
 *  `VoyagerMcpDeps` so tool tests that don't touch profiles don't need to wire one up;
 *  `src/main/ipc.ts` always supplies the real app-data-backed store in production. */
export interface VoyagerPrinterProfileStore {
  getActive(): Promise<PrinterProfileRef | null>
  save(profile: PrinterProfileRef): Promise<PrinterProfileList>
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
  | { kind: 'printer-profiles-updated'; payload: PrinterProfileList }

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
  /** Backs the `save_printer_profile` tool (WS-E) - optional, mirrors `briefStore`. */
  printerProfiles?: VoyagerPrinterProfileStore
  emit: (emission: VoyagerMcpEmission) => void
}
