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
 *   - WS-0b (this pass) lands the `brief:*`, `param:*`, `verification:*`, `printerProfile:*`,
 *     and `model:exportPackage` channels below with stub main-process handlers - WS-A/B/C/E/F
 *     replace the stub behavior without touching this file (shared contracts are frozen once
 *     WS-0b lands - see `agents/production-roadmap.md`'s Ground rules).
 */

import type { DesignBrief, PrinterProfileRef } from './brief'
import type { ScriptManifest } from './manifest'
import type { VerificationReport } from './verification'

export * from './brief'
export * from './manifest'
export * from './verification'

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
 *  (see `EFFORT_UNSUPPORTED_MODELS` in `packages/agent-core/src/agent/session.ts`), in which case
 *  it's omitted from the request regardless of the user's choice here. */
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
  | {
      type: 'tool-activity'
      messageId: string
      toolName: string
      /** Concise one-liner (e.g. "Editing bracket.py") — the only thing shown in normal mode. */
      detail: string
      /** Truncated, stringified tool input. Shown only when the "full stream" toggle is on. */
      args?: string
      /** Bookkeeping tools (e.g. TodoWrite) — emitted but hidden unless "full stream" is on. */
      routine?: boolean
    }
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

/**
 * One row of the version-history list (R4). A trimmed, renderer-safe view of `ProjectIteration`
 * (which lives in `packages/agent-core/src/projects/store.ts` and isn't imported here to keep
 * this module free of main-only types) - `hasStep` replaces the raw `stepPath` since the
 * renderer only ever needs to know whether a STEP export exists, not its on-disk path.
 */
export interface IterationInfo {
  n: number
  summary: string
  at: string
  hasStep: boolean
}

/** Hydrates the renderer on mount and on every project switch/create/revert. */
export interface ProjectStateSnapshot {
  activeProjectId: string
  projects: ProjectSummary[]
  messages: PersistedMessage[]
  agentSettings: AgentSettings
  model: ModelDisplayedPayload | null
  /** Every iteration ever recorded for the active project, oldest first (R4 version history). */
  iterations: IterationInfo[]
  /** The `n` of the iteration currently shown/exported, or null if the project has none yet. */
  activeIteration: number | null
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

export interface RevertToRequest {
  n: number
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
// Print settings (on-demand recommend_print_settings MCP tool)
// ---------------------------------------------------------------------------

/**
 * Recommended FDM slicer settings for the currently displayed model, produced on demand by the
 * `recommend_print_settings` MCP tool (mirrors `ModelDisplayedPayload`'s `display_model` pattern).
 * `iteration` is set server-side (from `ProjectStore.activeIterationRecord()`), never by the
 * agent, so a stale recommendation can be detected against the live `ModelInfo.iteration`.
 */
export interface PrintSettings {
  iteration: number
  material: string
  layerHeightMm: number
  wallCount: number
  topBottomLayers: number
  infillPercent: number
  infillPattern?: string
  supports: string
  adhesion: string
  nozzleTempC: number
  bedTempC: number
  printSpeedMmS: number
  orientation: string
  notes?: string
}

// ---------------------------------------------------------------------------
// Model export (M5 Export STL/STEP; M1 graduation package export - WS-F)
// ---------------------------------------------------------------------------

/** `'3mf'` and `'package'` are stubbed here for WS-F (architecture doc §12.1's graduation
 *  bundle); `resolveExportSource`/`model:export` do not yet implement them. */
export type ExportFormat = 'stl' | 'step' | '3mf' | 'package'

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

/** WS-F's graduation package export (architecture doc §12.1) - zip of STEP + 3MF + STL + script
 *  + locked brief JSON + manifest + generated README for the active (or a named) iteration. A
 *  distinct request/response from `ExportModelRequest`/`Response` (single-file export) since the
 *  package always bundles every artifact rather than picking one format. */
export interface ExportPackageRequest {
  /** Iteration to package; omit for the active iteration. */
  iteration?: number
}

export interface ExportPackageResponse {
  saved: boolean
  path?: string
  reason?: string
}

// ---------------------------------------------------------------------------
// Design Brief (WS-A - architecture doc §6)
// ---------------------------------------------------------------------------

/** Renderer -> main: propose a full replacement brief (from panel edits). Stub handler in
 *  WS-0b just persists-and-echoes; WS-A adds real merge/provenance semantics and the
 *  `update_brief` MCP tool's agent-authored path. */
export interface BriefUpdateRequest {
  brief: DesignBrief
}

export interface BriefUpdateResponse {
  brief: DesignBrief
}

/** Renderer -> main: lock the current brief version, stamping `lockedAt`. Locked briefs are
 *  immutable - further edits create a new version (see `DesignBrief.version`). */
export interface BriefLockResponse {
  brief: DesignBrief
}

// ---------------------------------------------------------------------------
// Parameter panel (WS-B - architecture doc §7, no-LLM re-run)
// ---------------------------------------------------------------------------

/** Renderer -> main: override one PARAMS constant and re-run the script (no agent turn). Stub
 *  handler in WS-0b rejects with `accepted: false`; WS-B wires the real venv re-execution +
 *  layers 1-3 verification + `recordIteration` path. */
export interface ParamUpdateRequest {
  name: string
  value: number
}

export interface ParamUpdateResponse {
  accepted: boolean
  reason?: string
  /** Set when `accepted` - the freshly re-run, re-recorded iteration's model payload, pushed the
   *  same way `model:displayed` already is so the viewport updates identically either path. */
  model?: ModelDisplayedPayload
}

/** Renderer -> main: fetch the active iteration's manifest (PARAMS entries), if any exists yet. */
export interface ParamGetManifestResponse {
  manifest: ScriptManifest | null
}

// ---------------------------------------------------------------------------
// Verification (WS-C - architecture doc §5)
// ---------------------------------------------------------------------------

/** Renderer -> main: fetch the current iteration's report, if any has been computed yet. */
export interface VerificationGetResponse {
  report: VerificationReport | null
}

// ---------------------------------------------------------------------------
// Printer profiles (WS-E - product doc §4.4)
// ---------------------------------------------------------------------------

export interface PrinterProfileSaveRequest {
  profile: PrinterProfileRef
}

export interface PrinterProfileSetActiveRequest {
  id: string
}

export interface PrinterProfileListResponse {
  profiles: PrinterProfileRef[]
  activeId: string | null
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
  printSettingsUpdated: 'printSettings:updated',
  modelLoadSample: 'model:loadSample',
  modelExport: 'model:export',
  projectList: 'project:list',
  projectCreate: 'project:create',
  projectSwitch: 'project:switch',
  projectRename: 'project:rename',
  projectGetState: 'project:getState',
  projectListIterations: 'project:listIterations',
  projectRevertTo: 'project:revertTo',
  modelExportPackage: 'model:exportPackage',
  briefGet: 'brief:get',
  briefUpdate: 'brief:update',
  briefLock: 'brief:lock',
  briefUpdated: 'brief:updated',
  paramUpdate: 'param:update',
  paramGetManifest: 'param:getManifest',
  verificationGet: 'verification:get',
  verificationUpdated: 'verification:updated',
  printerProfileList: 'printerProfile:list',
  printerProfileSave: 'printerProfile:save',
  printerProfileSetActive: 'printerProfile:setActive',
  printerProfileUpdated: 'printerProfile:updated'
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
