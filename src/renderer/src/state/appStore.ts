import { create } from 'zustand'
import type {
  AgentEvent,
  AgentSettings,
  ChatAttachment,
  DesignBrief,
  IterationInfo,
  ModelDisplayedPayload,
  PartRecord,
  PermissionRequestPayload,
  PrinterProfileRef,
  PrintSettings,
  ProjectStateSnapshot,
  ProjectSummary,
  ScriptManifest,
  SelectionSummary,
  SetupCheck,
  SetupStatus,
  VerificationReport
} from '../../../shared/ipc'
import { emptyDesignBrief, emptyScriptManifest } from '../../../shared/ipc'

export type ChatRole = 'user' | 'assistant' | 'system-status'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  createdAt: number
  /** True while an assistant message is still being streamed via agent:event. */
  streaming?: boolean
  /** Images the user attached when sending this message, if any. */
  attachments?: ChatAttachment[]
  /** For `system-status` tool-activity rows: the underlying tool name. */
  toolName?: string
  /** For `system-status` tool-activity rows: truncated tool input, shown only in full-stream mode. */
  args?: string
  /** For `system-status` tool-activity rows: bookkeeping activity, hidden unless full-stream is on. */
  routine?: boolean
}

export interface ModelInfo {
  name: string
  iteration: number
  stlPath: string | null
  stepPath: string | null
  scriptPath: string | null
}

function unchecked(detail: string): SetupCheck {
  return { state: 'unchecked', detail }
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/** Shared by the live `model:displayed` handler (`App.tsx`) and project hydration below, so
 *  the mapping only lives in one place. */
export function toModelInfo(payload: ModelDisplayedPayload): ModelInfo {
  return {
    name: fileName(payload.stlPath),
    iteration: payload.iteration,
    stlPath: payload.stlPath,
    stepPath: payload.stepPath ?? null,
    scriptPath: payload.scriptPath
  }
}

function initialSetupStatus(): SetupStatus {
  return {
    claudeCli: unchecked('Not checked yet'),
    claudeAuth: unchecked('Not checked yet'),
    pythonEnv: unchecked('Not checked yet')
  }
}

/** Placeholder shown before `window.voyager.agent.getSettings()` resolves on mount - matches
 *  the main process's own default (see `DEFAULT_AGENT_SETTINGS` in `projects/store.ts`). */
const DEFAULT_AGENT_SETTINGS: AgentSettings = { model: 'claude-opus-4-8', effort: 'xhigh' }

let messageSequence = 0
function createMessageId(): string {
  messageSequence += 1
  return `msg-${Date.now()}-${messageSequence}`
}

/** Key for the "full stream" display preference in the renderer's localStorage. This preference
 *  is global (not per-project) and purely a display concern, so it lives in localStorage rather
 *  than in `project.json`. */
const FULL_STREAM_KEY = 'voyager.fullStream'

/** Reads the persisted "full stream" preference. Guarded so the node/jsdom test env (where
 *  `localStorage` may be absent or throw) falls back to the default rather than crashing. */
function readFullStream(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FULL_STREAM_KEY) === 'true'
  } catch {
    return false
  }
}

function writeFullStream(value: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FULL_STREAM_KEY, String(value))
  } catch {
    // Best-effort persistence - a private-mode/quota failure just means the toggle is session-only.
  }
}

export interface AppState {
  messages: ChatMessage[]
  model: ModelInfo | null
  /** The active project's model/effort choice, hydrated from the main process on mount. */
  agentSettings: AgentSettings
  /** Every known project, in stable creation/discovery order - shown in the right-hand sidebar. */
  projects: ProjectSummary[]
  /** The currently-active project's id, or null before the initial `project:getState` hydration. */
  activeProjectId: string | null
  /** The active project's version history, oldest first (R4) - hydrated alongside `model`. */
  iterations: IterationInfo[]
  /** The `n` of the currently-shown/exported iteration, or null before hydration / with no
   *  iterations yet. Note the agent always branches from the live conversation + on-disk files,
   *  never from this pointer - it only governs what's displayed and what `model:export` saves
   *  for the displayed part (a multi-part all-parts zip exports each part's own main-process
   *  active pointer - see `ProjectStore.activeIterationRecord`). */
  activeIteration: number | null
  /** The most recent on-demand print-settings recommendation, or null if none has been requested
   *  yet for the current model. Session-only (not persisted in `project.json`) and tagged with
   *  the iteration it applies to - cleared whenever the displayed model changes (`setModel`) or
   *  the project is (re)hydrated, since a new/reverted model invalidates it. */
  printSettings: PrintSettings | null
  setupStatus: SetupStatus
  selection: SelectionSummary | null
  /** True while the "Select region" toolbar toggle is active. */
  selectMode: boolean
  /** True while the "Measure" toolbar toggle is active. */
  measureMode: boolean
  /** The straight-line distance (mm) between the two most recently picked measurement points,
   *  or null before a measurement is completed / after it's cleared. */
  measurement: number | null
  /** True while the XYZ orientation gizmo is shown in the viewport. Defaults on. */
  showAxes: boolean
  /** True while the displayed model is rendered in wireframe rather than shaded. */
  wireframe: boolean
  /** Which handles the multi-part placement gizmo shows: slide/lift a part or rotate it. Kept in
   *  the store (not local to the toolbar) so the controller's g/r keyboard shortcuts and the
   *  toolbar toggle stay in sync. */
  gizmoMode: 'translate' | 'rotate'
  /** When on, the chat streams a fuller view of the agent's background work: bookkeeping
   *  (`routine`) tool-activity rows, each tool's inputs, and the complete thinking stream.
   *  Global display preference persisted in localStorage (survives restarts, not per-project). */
  fullStream: boolean
  /** True from an accepted send until the agent's message-complete/error event. */
  agentBusy: boolean
  /**
   * Maps the agent's stream messageId (e.g. `turn-3`) to the chat message id
   * its streamed text is accumulating into.
   */
  agentStreamIds: Record<string, string>
  /** The out-of-policy tool call currently awaiting an Allow/Deny decision, if any. */
  pendingPermission: PermissionRequestPayload | null
  /**
   * The current turn's rolling extended-thinking text. Ephemeral UI-only
   * state (never added to `messages`) - the UI shows only the last few lines
   * and it clears back to `''` when the turn ends (message-complete/error).
   */
  thinkingText: string

  /** The active project's Design Brief (WS-A). Placeholder-panel-only until WS-A lands - starts
   *  as an empty brief rather than null so `BriefPanel` never has to special-case "not fetched
   *  yet" vs. "genuinely empty". */
  brief: DesignBrief
  /** The active iteration's PARAMS manifest (WS-B). Empty until WS-B lands. */
  manifest: ScriptManifest
  /** The active iteration's verification report (WS-C), or null before one has been computed. */
  verificationReport: VerificationReport | null
  /** Every saved printer profile (WS-E) and which one is active, or null if none is set yet. */
  printerProfiles: PrinterProfileRef[]
  activePrinterProfileId: string | null
  /** Every part in the active project (WS-I multi-part, §14). Empty until WS-I lands its store
   *  model; hydrated by `PartsPanel` via `part.list`/`part:updated`, not from the project snapshot. */
  parts: PartRecord[]
  /** The part the user has focused in the parts panel/viewport, or null. Renderer-local (not
   *  persisted server state, see `PartListResponse`) - travels to the agent as
   *  `SendMessageRequest.focusedPartId`. */
  selectedPartId: string | null
  /** True while the WS-G import dialog is open. Store-held (not local to `App.tsx`) so any trigger -
   *  a toolbar button, drag-drop, an empty-project prompt - can open it without threading props. */
  importDialogOpen: boolean
  /** True while a parameter-panel edit's venv re-run is in flight (WS-B) - the viewport reads
   *  this to show a loading spinner over the model and freeze orbit/selection interaction until
   *  the re-run's `model:displayed` broadcast arrives (or it fails). Distinct from `agentBusy`:
   *  a param edit never goes through `AgentSession`. */
  paramUpdatePending: boolean

  /** Appends a new message and returns its generated id (for later streaming updates). */
  addMessage: (message: Omit<ChatMessage, 'id' | 'createdAt'>) => string
  /** Appends `delta` to an existing message's text - used for streamed assistant replies. */
  appendToMessage: (id: string, delta: string) => void
  /** Marks a streaming message as finished. */
  completeMessage: (id: string) => void
  /** Replaces the current model. Also clears any active selection and measurement - their
   *  triangle indices/points refer to the previous iteration's geometry and must not leak
   *  forward. */
  setModel: (model: ModelInfo | null) => void
  /** Replaces the current model/effort choice - called on mount and after the user changes it. */
  setAgentSettings: (settings: AgentSettings) => void
  /** Replaces `messages`/`model`/`agentSettings`/`projects`/`activeProjectId` from a full
   *  project snapshot (mount, create, or switch) and resets ephemeral turn state - see
   *  `project:getState`/`project:create`/`project:switch`. */
  hydrateProject: (snapshot: ProjectStateSnapshot) => void
  /** Updates (or inserts) one project's sidebar entry - used after a rename, which returns
   *  just the renamed summary rather than a full snapshot. */
  updateProject: (summary: ProjectSummary) => void
  /** Replaces the active project's version-history list - used after `project:revertTo` (also
   *  set wholesale by `hydrateProject`). */
  setIterations: (iterations: IterationInfo[]) => void
  /** Replaces the active-iteration pointer - used after `project:revertTo` (also set wholesale
   *  by `hydrateProject`). */
  setActiveIteration: (activeIteration: number | null) => void
  /** Appends a freshly-generated iteration (from a live `model:displayed` push, not a hydration)
   *  to the version-history list and marks it active - keeps `ProjectsDrawer`'s history in sync
   *  without a round-trip to `project:listIterations` every time the agent displays a model. */
  addIteration: (payload: ModelDisplayedPayload) => void
  /** Sets or clears (pass `null`) the current print-settings recommendation - see `printSettings`. */
  setPrintSettings: (settings: PrintSettings | null) => void
  setSetupStatus: (status: SetupStatus) => void
  setSelection: (selection: SelectionSummary | null) => void
  setSelectMode: (selectMode: boolean) => void
  setMeasureMode: (measureMode: boolean) => void
  setMeasurement: (measurement: number | null) => void
  setShowAxes: (showAxes: boolean) => void
  setWireframe: (wireframe: boolean) => void
  setGizmoMode: (gizmoMode: 'translate' | 'rotate') => void
  /** Toggles the "full stream" display preference and persists it to localStorage. */
  setFullStream: (fullStream: boolean) => void
  setAgentBusy: (busy: boolean) => void
  /** Sets or clears (pass `null`) the pending approval card. */
  setPendingPermission: (request: PermissionRequestPayload | null) => void
  /** Folds one streamed `agent:event` into the chat state. */
  applyAgentEvent: (event: AgentEvent) => void

  /** Replaces the Design Brief - used after `brief.get`/`update`/`lock` and the `brief:updated` push. */
  setBrief: (brief: DesignBrief) => void
  /** Replaces the active iteration's PARAMS manifest - used after `param.getManifest`. */
  setManifest: (manifest: ScriptManifest) => void
  /** Sets or clears (pass `null`) the verification report - used after `verification.get` and the
   *  `verification:updated` push. */
  setVerificationReport: (report: VerificationReport | null) => void
  /** Replaces the printer-profile list and active id - used after `printerProfile.list`/`save`/
   *  `setActive` and the `printerProfile:updated` push. */
  setPrinterProfiles: (profiles: PrinterProfileRef[], activeId: string | null) => void
  /** Sets or clears the in-flight flag for a parameter-panel re-run - see `paramUpdatePending`. */
  setParamUpdatePending: (pending: boolean) => void
  /** Replaces the parts list - used after `part.list`/`setPlacement`/`setVisibility` and the
   *  `part:updated` push. */
  setParts: (parts: PartRecord[]) => void
  /** Sets or clears (pass `null`) the focused part - see `selectedPartId`. */
  setSelectedPartId: (id: string | null) => void
  /** Opens/closes the import dialog - see `importDialogOpen`. */
  setImportDialogOpen: (open: boolean) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  messages: [],
  model: null,
  agentSettings: DEFAULT_AGENT_SETTINGS,
  projects: [],
  activeProjectId: null,
  iterations: [],
  activeIteration: null,
  printSettings: null,
  setupStatus: initialSetupStatus(),
  selection: null,
  selectMode: false,
  measureMode: false,
  measurement: null,
  showAxes: true,
  wireframe: false,
  gizmoMode: 'translate',
  fullStream: readFullStream(),
  agentBusy: false,
  agentStreamIds: {},
  pendingPermission: null,
  thinkingText: '',
  brief: emptyDesignBrief(),
  manifest: emptyScriptManifest(),
  verificationReport: null,
  printerProfiles: [],
  activePrinterProfileId: null,
  parts: [],
  selectedPartId: null,
  importDialogOpen: false,
  paramUpdatePending: false,

  addMessage: (message) => {
    const id = createMessageId()
    set((state) => ({
      messages: [...state.messages, { ...message, id, createdAt: Date.now() }]
    }))
    return id
  },

  appendToMessage: (id, delta) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m))
    }))
  },

  completeMessage: (id) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, streaming: false } : m))
    }))
  },

  setModel: (model) => set({ model, selection: null, measurement: null, printSettings: null }),
  setAgentSettings: (agentSettings) => set({ agentSettings }),

  hydrateProject: (snapshot) => {
    set({
      projects: snapshot.projects,
      activeProjectId: snapshot.activeProjectId,
      agentSettings: snapshot.agentSettings,
      model: snapshot.model ? toModelInfo(snapshot.model) : null,
      iterations: snapshot.iterations,
      activeIteration: snapshot.activeIteration,
      messages: snapshot.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        createdAt: Date.parse(m.createdAt),
        attachments: m.attachments?.map((a) => ({ ...a, data: '' }))
      })),
      // Ephemeral turn state can't legitimately still apply to a different project's chat -
      // reset it defensively even though the main process blocks switching mid-turn.
      selection: null,
      measurement: null,
      // Session-only, not part of ProjectStateSnapshot - a hydrated project never carries a
      // stale recommendation forward.
      printSettings: null,
      agentBusy: false,
      agentStreamIds: {},
      pendingPermission: null,
      thinkingText: '',
      paramUpdatePending: false,
      // Parts belong to the project being left - clear them so a switch never shows stale parts;
      // `PartsPanel` refetches via `part.list` when `activeProjectId` changes. Not carried in the
      // snapshot (see `parts` doc comment).
      parts: [],
      selectedPartId: null,
      importDialogOpen: false
    })
  },

  updateProject: (summary) => {
    set((state) => ({
      projects: state.projects.some((p) => p.id === summary.id)
        ? state.projects.map((p) => (p.id === summary.id ? summary : p))
        : [...state.projects, summary]
    }))
  },

  setIterations: (iterations) => set({ iterations }),
  setActiveIteration: (activeIteration) => set({ activeIteration }),

  addIteration: (payload) => {
    set((state) => ({
      iterations: [
        ...state.iterations,
        {
          n: payload.iteration,
          summary: payload.summary,
          at: new Date().toISOString(),
          hasStep: Boolean(payload.stepPath),
          createdBy: payload.createdBy
        }
      ],
      activeIteration: payload.iteration
    }))
  },
  setPrintSettings: (printSettings) => set({ printSettings }),
  setSetupStatus: (setupStatus) => set({ setupStatus }),
  setSelection: (selection) => set({ selection }),
  setSelectMode: (selectMode) => set({ selectMode }),
  setMeasureMode: (measureMode) => set({ measureMode }),
  setMeasurement: (measurement) => set({ measurement }),
  setShowAxes: (showAxes) => set({ showAxes }),
  setWireframe: (wireframe) => set({ wireframe }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  setFullStream: (fullStream) => {
    writeFullStream(fullStream)
    set({ fullStream })
  },
  setAgentBusy: (agentBusy) => set({ agentBusy }),
  setPendingPermission: (pendingPermission) => set({ pendingPermission }),

  applyAgentEvent: (event) => {
    const state = get()
    switch (event.type) {
      case 'text-delta': {
        const existing = state.agentStreamIds[event.messageId]
        if (existing) {
          state.appendToMessage(existing, event.delta)
          return
        }
        const id = state.addMessage({ role: 'assistant', text: event.delta, streaming: true })
        set((s) => ({ agentStreamIds: { ...s.agentStreamIds, [event.messageId]: id } }))
        return
      }
      case 'thinking-delta': {
        set((s) => ({ thinkingText: s.thinkingText + event.delta }))
        return
      }
      case 'tool-activity': {
        // Collapse consecutive duplicates (e.g. repeated Bash "Running the
        // parametric script" activity) into a single status line. The row
        // always records the tool metadata; whether `routine` rows show and
        // `args` expand is decided at render time by the full-stream toggle,
        // so flipping it re-renders the whole existing transcript live.
        const last = state.messages.at(-1)
        if (last?.role === 'system-status' && last.text === event.detail) return
        state.addMessage({
          role: 'system-status',
          text: event.detail,
          toolName: event.toolName,
          args: event.args,
          routine: event.routine
        })
        return
      }
      case 'message-complete': {
        const streaming = state.agentStreamIds[event.messageId]
        if (streaming) state.completeMessage(streaming)
        set({ agentBusy: false, thinkingText: '' })
        return
      }
      case 'error': {
        const streaming = event.messageId ? state.agentStreamIds[event.messageId] : undefined
        if (streaming) state.completeMessage(streaming)
        state.addMessage({ role: 'system-status', text: `⚠ ${event.message}` })
        set({ agentBusy: false, thinkingText: '' })
        return
      }
      case 'stopped': {
        const streaming = state.agentStreamIds[event.messageId]
        if (streaming) state.completeMessage(streaming)
        state.addMessage({ role: 'system-status', text: 'Stopped.' })
        // The interrupt aborts the SDK's permission-approval wait, so any
        // lingering Allow/Deny card would be answering a question the agent
        // is no longer listening for - clear it along with the turn state.
        set({ agentBusy: false, thinkingText: '', pendingPermission: null })
        return
      }
    }
  },

  setBrief: (brief) => set({ brief }),
  setManifest: (manifest) => set({ manifest }),
  setVerificationReport: (verificationReport) => set({ verificationReport }),
  setPrinterProfiles: (printerProfiles, activePrinterProfileId) =>
    set({ printerProfiles, activePrinterProfileId }),
  setParamUpdatePending: (paramUpdatePending) => set({ paramUpdatePending }),
  setParts: (parts) => set({ parts }),
  setSelectedPartId: (selectedPartId) => set({ selectedPartId }),
  setImportDialogOpen: (importDialogOpen) => set({ importDialogOpen })
}))
