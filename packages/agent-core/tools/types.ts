import type { ModelDisplayedPayload, PrintSettings } from '@shared/ipc'
import type { ProjectIteration } from '../src/projects/store'

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

export interface VoyagerMcpDeps {
  projectStore: VoyagerMcpProjectStore
  emit: (emission: VoyagerMcpEmission) => void
}
