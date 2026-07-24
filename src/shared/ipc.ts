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
 *   - WS-0c (contract addendum) adds the `model:import`, `part:*`, and `brief:listVersions`
 *     channels, `createdBy` iteration provenance, part identity on `ModelDisplayedPayload`, and the
 *     `'plate'` export format - the surface WS-G (import/remix), WS-H (gears), and WS-I (multi-part)
 *     consume without editing this file.
 */

import type { DesignBrief, PrinterProfileRef } from './brief'
import type { ScriptManifest } from './manifest'
import type { PartRecord, Placement } from './parts'
import type { VerificationReport } from './verification'

export * from './brief'
export * from './manifest'
export * from './parts'
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
  /** Which part the selected region belongs to (WS-I multi-part, §14) - lets the agent know which
   *  part a "make this hole bigger" refers to. Absent for a single-part project / the `main` part. */
  partId?: string
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
  /** The part the user has focused in the parts panel/viewport when sending (WS-I multi-part, §14),
   *  so the agent knows which part an otherwise-ambiguous change targets. Absent = no explicit
   *  focus (the agent asks, or assumes the sole/`main` part). */
  focusedPartId?: string
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
  /** Whether the designer renders + inspects the 8 canonical views (WS-D): backs the
   *  `render_views` tool and the automatic per-iteration render set. Omitted = enabled;
   *  toggleable per project from the chat toolbar (rendering costs a few seconds of
   *  matplotlib work per iteration, so slow machines can turn it off). */
  renderViews?: boolean
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
  /** Emitted after a turn completes with the session's current context-window usage
   *  (`Query.getContextUsage()`), so the chat UI can show e.g. "104k tokens". */
  | { type: 'context-usage'; totalTokens: number; maxTokens: number }

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
 * How an iteration came to exist (architecture doc §8's `created_by` column). `agent` = a
 * `display_model` turn; `param` = a no-LLM parameter-panel re-run (WS-B); `revert` = a reverted
 * generation re-recorded as current; `import` = an externally-sourced base model (WS-G, §12.5).
 * Optional wherever it appears, so records/payloads written before this field existed still parse.
 */
export type IterationCreatedBy = 'agent' | 'param' | 'revert' | 'import'

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
  /** Provenance of this iteration (WS-0c), if recorded - lets the version history label param
   *  edits / imports distinctly from agent turns. */
  createdBy?: IterationCreatedBy
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
  /** Which part this display belongs to (WS-0c/WS-I multi-part, §14). Absent = the default `main`
   *  part - so single-part callers (and payloads written before multi-part) need no change; the
   *  viewer keys its per-part mesh map on `partId ?? MAIN_PART_ID`. */
  partId?: string
  /** Provenance of the iteration being displayed (WS-0c) - see `IterationCreatedBy`. */
  createdBy?: IterationCreatedBy
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

/** `'3mf'`, `'plate'`, and `'package'` are stubbed here for WS-F (architecture doc §12.1's
 *  graduation bundle + §14's per-part/plate export); `resolveExportSource`/`model:export` do not
 *  yet implement them. `'plate'` bakes the current part placements into one merged STL (WS-I/WS-F);
 *  the others resolve per part. */
export type ExportFormat = 'stl' | 'step' | '3mf' | 'plate' | 'package'

export interface ExportModelRequest {
  format: ExportFormat
  /** Which part to export (WS-0c/WS-I multi-part, §14). Omitted: a single-part project exports
   *  its one part; a multi-part project exports **every part as separate files in one zip** -
   *  parts are never silently merged (§14/WS-F). Ignored by `'plate'` (which spans all parts)
   *  and `'package'` (which bundles every part). */
  partId?: string
}

export interface ExportModelResponse {
  saved: boolean
  /** Destination path the file was written to. Only set when `saved` is true. */
  path?: string
  /** Human-readable reason the export could not be saved. Omitted on user-cancel. */
  reason?: string
  /** Display names of parts left out of an all-parts zip export (no iterations yet, or no
   *  recorded STEP on a STEP export). Only ever set when `saved` is true and the export was
   *  the multi-part zip; the renderer surfaces these next to the success message. */
  skippedParts?: string[]
}

/** WS-F's graduation package export (architecture doc §12.1) - zip of STEP + 3MF + STL + script
 *  + locked brief JSON + manifest + generated README for the active (or a named) iteration. A
 *  distinct request/response from `ExportModelRequest`/`Response` (per-part STL/STEP export - one
 *  file, or one zip of separate per-part files on a multi-part project) since the package always
 *  bundles every artifact rather than picking one format. */
export interface ExportPackageRequest {
  /** Iteration to package; omit for the active iteration. */
  iteration?: number
  /** Restrict the package to one part (WS-0c/WS-I multi-part, §14); omit to bundle every part. */
  partId?: string
}

export interface ExportPackageResponse {
  saved: boolean
  path?: string
  reason?: string
}

// ---------------------------------------------------------------------------
// External model import & remix (WS-G - architecture doc §12.5)
// ---------------------------------------------------------------------------

/**
 * Renderer -> main: import an external model (Thingiverse STL, a colleague's STEP, a scan) as a
 * project's base, recorded as an iteration with `createdBy: 'import'`. Two-phase for unitless
 * formats (STL/OBJ carry no units): the first call measures and, if a scale hasn't been confirmed,
 * returns `needsUnitConfirmation`; the renderer shows the `ImportDialog` with that measured
 * dimension and re-calls with `unitScaleMm`. Stub handler in WS-0c; WS-G wires the real
 * copy/measure/repair/display path.
 */
export interface ImportModelRequest {
  /** Absolute path to the source file (from a native picker or a drag-drop). Omit to have the main
   *  process open a picker. */
  filePath?: string
  /** User-confirmed real length (mm) of the dimension `needsUnitConfirmation` reported, supplied on
   *  the second call to resolve a unitless mesh's scale. */
  unitScaleMm?: number
  /** Target part slug (WS-I multi-part); omit for a new/`main` part. */
  partId?: string
}

export interface ImportModelResponse {
  /** False on cancel, unsupported format, or when `needsUnitConfirmation` is set. */
  imported: boolean
  reason?: string
  /** Set when `imported` - the recorded iteration's payload, also pushed via `model:displayed`. */
  model?: ModelDisplayedPayload
  /** Set for a unitless format with no `unitScaleMm` yet: the renderer confirms/corrects this one
   *  measured dimension, then re-calls `import` with `unitScaleMm`. */
  needsUnitConfirmation?: { measuredMm: number; axis: 'x' | 'y' | 'z' }
}

// ---------------------------------------------------------------------------
// Multi-part projects & placement (WS-I - architecture doc §14)
// ---------------------------------------------------------------------------

/** Every part in the active project (WS-I), plus which one is *active*: the part unscoped
 *  operations target (the model shown as "current", the part `param:*`/`verification:get`/export/
 *  revert resolve against, and the default for a new `display_model`). It's a project-level pointer
 *  (like `activeIteration`), set by the last `display_model` and by `part:setActive` when the user
 *  focuses a part in the panel; null before any part exists. */
export interface PartListResponse {
  parts: PartRecord[]
  activePartId: string | null
}

/** Renderer -> main: persist a part's placement (layout only - never touches its script/mesh, §14).
 *  Resolves with the refreshed list (mirrors the printer-profile ops). */
export interface PartSetPlacementRequest {
  partId: string
  placement: Placement
}

/** Renderer -> main: show/hide a part in the viewport. */
export interface PartSetVisibilityRequest {
  partId: string
  visible: boolean
}

/** Renderer -> main: make `partId` the active part (the user focused it in the panel), so the
 *  param/verification/history panels, export, and the next unscoped change all follow it. Resolves
 *  with the refreshed list. */
export interface PartSetActiveRequest {
  partId: string
}

/** Renderer -> main: fetch one part's active-iteration model (with STL bytes) so the viewer can
 *  render every visible part, each at its placement. On-demand rather than bundled into
 *  `PartListResponse` so a light metadata list (and the `part:updated` push) never re-ships
 *  megabytes of geometry; mirrors `model:loadSample`/`param:getManifest`'s fetch-when-needed shape.
 *  Resolves null if the part has no iterations yet. */
export interface PartGetModelRequest {
  partId: string
}

/** Renderer -> main: duplicate `partId` as a new part (print several of the same piece, or fork a
 *  variant). The copy shares the source's immutable artifacts on disk, gets a `-copy` id/name
 *  suffix and an offset placement, and becomes the active part. Resolves with the refreshed list
 *  (mirrors the other part ops); the copy's geometry is fetched via `part:getModel` like any other
 *  part the renderer hasn't loaded yet. */
export interface PartDuplicateRequest {
  partId: string
}

/** Renderer -> main: permanently remove a part from the project (its name, placement,
 *  visibility, and iteration history stop being tracked; the on-disk artifacts its iterations
 *  point to are left alone, mirroring the immutable-iterations rule). Rejects if `partId` is the
 *  project's only remaining part. Resolves with the refreshed list; if the removed part was
 *  active, `activePartId` now names the first remaining part. */
export interface PartDeleteRequest {
  partId: string
}

/** Renderer -> main: fetch one canonical-view PNG of an iteration's render set (WS-D) as a data
 *  URL, for version-history thumbnails. On-demand per visible row (mirrors `part:getModel`'s
 *  fetch-when-needed shape) rather than pushing every iteration's images up front. `view` is one
 *  of the 8 canonical view names (`front`/`back`/`left`/`right`/`top`/`bottom`/`iso1`/`iso2` -
 *  kept a plain string here so this renderer-safe module doesn't import `@voyager/render-rig`,
 *  which would drag node builtins into the renderer bundle; the main handler validates it). */
export interface RenderGetRequest {
  /** Which part's history `n` indexes; omit for the active part. */
  partId?: string
  n: number
  view: string
}

export interface RenderGetResponse {
  /** `data:image/png;base64,...`, or null when that iteration has no render set (yet) - e.g.
   *  recorded while render previews were toggled off, or before matplotlib was installed. */
  dataUrl: string | null
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

/** Renderer -> main: read back every locked brief version (WS-A's `BriefStore.listVersions`), so
 *  `BriefPanel` can browse history. Newest last, matching the on-disk `versions/v{n}.json` order. */
export interface BriefListVersionsResponse {
  versions: Array<{ version: number; lockedAt: string; brief: DesignBrief }>
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
  /** Which part to re-run (WS-I multi-part). Omitted = whatever part the main process currently
   *  considers active - kept optional so single-part callers need no change, but the renderer
   *  should always send the focused part's id once one exists, so a slider edit can't land on
   *  the wrong part if the active-part pointer and the panel's focus have drifted apart. */
  partId?: string
}

export interface ParamUpdateResponse {
  accepted: boolean
  reason?: string
  /** Set when `accepted` - the freshly re-run, re-recorded iteration's model payload, pushed the
   *  same way `model:displayed` already is so the viewport updates identically either path. */
  model?: ModelDisplayedPayload
}

/** Renderer -> main: fetch a part's manifest (PARAMS entries), if any exists yet. `partId`
 *  omitted = whatever part the main process currently considers active (single-part behavior,
 *  unchanged); the renderer should pass the focused part's id once one exists - see
 *  `ParamUpdateRequest.partId`'s doc comment for why this shouldn't rely on the active-part
 *  pointer alone. */
export interface ParamGetManifestRequest {
  partId?: string
}

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

/** Renderer -> main: permanently remove a saved profile (WS-E follow-up - previously the panel
 *  could list/save/set-active but never remove one, so a mis-added printer lived forever short of
 *  hand-editing `<userData>/printer-profiles.json`). */
export interface PrinterProfileDeleteRequest {
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
  modelImport: 'model:import',
  partList: 'part:list',
  partGetModel: 'part:getModel',
  partSetPlacement: 'part:setPlacement',
  partSetVisibility: 'part:setVisibility',
  partSetActive: 'part:setActive',
  partDuplicate: 'part:duplicate',
  partDelete: 'part:delete',
  partUpdated: 'part:updated',
  renderGet: 'render:get',
  briefGet: 'brief:get',
  briefUpdate: 'brief:update',
  briefLock: 'brief:lock',
  briefUpdated: 'brief:updated',
  briefListVersions: 'brief:listVersions',
  paramUpdate: 'param:update',
  paramGetManifest: 'param:getManifest',
  verificationGet: 'verification:get',
  verificationUpdated: 'verification:updated',
  printerProfileList: 'printerProfile:list',
  printerProfileSave: 'printerProfile:save',
  printerProfileSetActive: 'printerProfile:setActive',
  printerProfileDelete: 'printerProfile:delete',
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
  'error',
  'context-usage'
] as const

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.type !== 'string') return false
  return (AGENT_EVENT_TYPES as readonly string[]).includes(candidate.type)
}
