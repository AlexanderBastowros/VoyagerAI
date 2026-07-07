/**
 * Shared IPC contract between the main, preload, and renderer processes.
 *
 * This module is intentionally plain TypeScript with no imports from
 * `electron`, `node:*`, or DOM-only lib types, so it can be imported
 * unmodified by all three processes as well as by unit tests.
 *
 * Later milestones plug in real implementations behind these same channel
 * names and payload shapes:
 *   - M2 implements the pythonEnv setup check and `setup:progress` events.
 *   - M3 implements claudeCli / claudeAuth setup checks, wires up
 *     `agent:sendMessage` / `agent:event` to the Claude Agent SDK, and emits
 *     `model:displayed` when the agent's `display_model` MCP tool runs.
 *   - M4 populates `SelectionSummary` from real viewport region selection.
 */

// ---------------------------------------------------------------------------
// Setup status (M2 python env, M3 claude cli / auth)
// ---------------------------------------------------------------------------

export type SetupCheckState = 'unchecked' | 'in_progress' | 'ready' | 'error'

export interface SetupCheck {
  state: SetupCheckState
  detail: string
}

export interface SetupStatus {
  claudeCli: SetupCheck
  claudeAuth: SetupCheck
  pythonEnv: SetupCheck
}

// ---------------------------------------------------------------------------
// Selection (M4 region selection + refinement)
// ---------------------------------------------------------------------------

export interface SelectionSummary {
  bboxMin: [number, number, number]
  bboxMax: [number, number, number]
  centroid: [number, number, number]
  dims: [number, number, number]
  triCount: number
}

// ---------------------------------------------------------------------------
// Agent chat (M3 Claude Agent SDK)
// ---------------------------------------------------------------------------

export interface SendMessageRequest {
  text: string
  selectionContext?: SelectionSummary | null
}

export interface SendMessageResponse {
  accepted: boolean
  reason?: string
}

export type AgentEvent =
  | { type: 'text-delta'; messageId: string; delta: string }
  | { type: 'tool-activity'; messageId: string; toolName: string; detail: string }
  | { type: 'message-complete'; messageId: string }
  | { type: 'error'; messageId?: string; message: string }

// ---------------------------------------------------------------------------
// Model display (M3 display_model MCP tool)
// ---------------------------------------------------------------------------

export interface ModelDisplayedPayload {
  stlPath: string
  stepPath?: string
  scriptPath: string
  summary: string
  iteration: number
  /** Raw STL bytes, transferred so the renderer can hand them straight to STLLoader. */
  stlBuffer: ArrayBuffer
}

// ---------------------------------------------------------------------------
// Model export (M5 Export STL/STEP)
// ---------------------------------------------------------------------------

export type ExportFormat = 'stl' | 'step'

export interface ExportModelRequest {
  format: ExportFormat
}

export interface ExportModelResponse {
  saved: boolean
  /** Destination path the file was written to. Only set when `saved` is true. */
  path?: string
  /** Human-readable reason the export could not be saved. Omitted on user-cancel. */
  reason?: string
}

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

/** Keep in sync with src/main/ipc.ts and src/preload/index.ts. */
export const IPC = {
  setupGetStatus: 'setup:getStatus',
  setupRetry: 'setup:retry',
  setupProgress: 'setup:progress',
  agentSendMessage: 'agent:sendMessage',
  agentEvent: 'agent:event',
  modelDisplayed: 'model:displayed',
  modelLoadSample: 'model:loadSample',
  modelExport: 'model:export'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// ---------------------------------------------------------------------------
// Type guards - useful for validating payloads that cross the IPC boundary
// ---------------------------------------------------------------------------

const SETUP_CHECK_STATES: readonly SetupCheckState[] = ['unchecked', 'in_progress', 'ready', 'error']

export function isSetupCheckState(value: unknown): value is SetupCheckState {
  return typeof value === 'string' && (SETUP_CHECK_STATES as readonly string[]).includes(value)
}

const AGENT_EVENT_TYPES = ['text-delta', 'tool-activity', 'message-complete', 'error'] as const

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.type !== 'string') return false
  return (AGENT_EVENT_TYPES as readonly string[]).includes(candidate.type)
}
