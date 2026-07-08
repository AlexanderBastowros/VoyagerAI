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

/** An image attached to a chat message, read client-side as base64 (no `data:` URL prefix).
 *  `name` is display-only (the chat UI's paperclip chip) - it is not sent to the model. */
export interface ChatAttachment {
  data: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  name: string
}

export interface SendMessageRequest {
  text: string
  selectionContext?: SelectionSummary | null
  attachments?: ChatAttachment[]
}

export interface SendMessageResponse {
  accepted: boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// Agent settings (R8 model + effort selector)
// ---------------------------------------------------------------------------

/** Mirrors the Claude Agent SDK's `Options['effort']`. Some models reject this option outright
 *  (see `EFFORT_UNSUPPORTED_MODELS` in `src/main/agent/session.ts`), in which case it's omitted
 *  from the request regardless of the user's choice here. */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The models surfaced in the UI's model picker - a curated subset of what the SDK accepts,
 *  spanning the speed/depth tradeoff from deepest to fastest. */
export type AgentModel = 'claude-opus-4-8' | 'claude-sonnet-5' | 'claude-haiku-4-5'

export interface AgentSettings {
  model: AgentModel
  effort: AgentEffort
}

export type AgentEvent =
  | { type: 'text-delta'; messageId: string; delta: string }
  | { type: 'thinking-delta'; messageId: string; delta: string }
  | { type: 'tool-activity'; messageId: string; toolName: string; detail: string }
  | { type: 'message-complete'; messageId: string }
  /** Emitted when the user interrupts an in-flight turn. Exactly one terminal
   *  event fires per turn: `message-complete` | `error` | `stopped`. */
  | { type: 'stopped'; messageId: string }
  | { type: 'error'; messageId?: string; message: string }

// ---------------------------------------------------------------------------
// Projects (R3 multi-project switcher)
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string
  name: string
  createdAt: string
}

/** Metadata only, never the base64 `data` - restored history only ever renders the
 *  "📎 filename" chip (`ChatMessageRow` never reads `.data`), so persisting image bytes into
 *  project.json would bloat it for zero visible benefit. */
export interface PersistedAttachment {
  name: string
  mediaType: ChatAttachment['mediaType']
}

/** A durable, restorable chat entry - the subset of `ChatMessage` (renderer-only state) worth
 *  writing to `project.json`. Routine tool-activity narration is intentionally not persisted
 *  (see `AgentSession`'s `flushAssistantBuffer`) - only user/assistant conversation content is. */
export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant' | 'system-status'
  text: string
  createdAt: string
  attachments?: PersistedAttachment[]
}

/** Hydrates the renderer on mount and on every project switch/create. */
export interface ProjectStateSnapshot {
  activeProjectId: string
  projects: ProjectSummary[]
  messages: PersistedMessage[]
  agentSettings: AgentSettings
  model: ModelDisplayedPayload | null
}

export interface CreateProjectRequest {
  name?: string
}

export interface SwitchProjectRequest {
  id: string
}

export interface RenameProjectRequest {
  id: string
  name: string
}

// ---------------------------------------------------------------------------
// Permission gate (canUseTool approval card)
// ---------------------------------------------------------------------------

/** Pushed main -> renderer when a tool call falls outside the auto-allow policy. */
export interface PermissionRequestPayload {
  requestId: string
  toolName: string
  summary: string
}

/** Sent renderer -> main with the user's Allow/Deny decision for a pending request. */
export interface PermissionRespondRequest {
  requestId: string
  allow: boolean
}

export interface PermissionRespondResponse {
  /** False if `requestId` was unknown or already resolved (e.g. it timed out first). */
  acknowledged: boolean
}

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
  agentGetSettings: 'agent:getSettings',
  agentSetSettings: 'agent:setSettings',
  agentEvent: 'agent:event',
  agentInterrupt: 'agent:interrupt',
  agentPermissionRequest: 'agent:permissionRequest',
  agentPermissionRespond: 'agent:permissionRespond',
  modelDisplayed: 'model:displayed',
  modelLoadSample: 'model:loadSample',
  modelExport: 'model:export',
  projectList: 'project:list',
  projectCreate: 'project:create',
  projectSwitch: 'project:switch',
  projectRename: 'project:rename',
  projectGetState: 'project:getState'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// ---------------------------------------------------------------------------
// Type guards - useful for validating payloads that cross the IPC boundary
// ---------------------------------------------------------------------------

const SETUP_CHECK_STATES: readonly SetupCheckState[] = ['unchecked', 'in_progress', 'ready', 'error']

export function isSetupCheckState(value: unknown): value is SetupCheckState {
  return typeof value === 'string' && (SETUP_CHECK_STATES as readonly string[]).includes(value)
}

const AGENT_EVENT_TYPES = [
  'text-delta',
  'thinking-delta',
  'tool-activity',
  'message-complete',
  'stopped',
  'error'
] as const

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.type !== 'string') return false
  return (AGENT_EVENT_TYPES as readonly string[]).includes(candidate.type)
}
