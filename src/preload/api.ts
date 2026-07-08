import type {
  AgentEvent,
  AgentSettings,
  CreateProjectRequest,
  ExportModelRequest,
  ExportModelResponse,
  IterationInfo,
  ModelDisplayedPayload,
  PermissionRequestPayload,
  PermissionRespondRequest,
  PermissionRespondResponse,
  PrintSettings,
  ProjectStateSnapshot,
  ProjectSummary,
  RenameProjectRequest,
  RevertToRequest,
  SendMessageRequest,
  SendMessageResponse,
  SetupStatus,
  SwitchProjectRequest
} from '../shared/ipc'

/**
 * Typed shape of `window.voyager`, exposed by the preload script via
 * contextBridge. Renderer code must only ever talk to main through this
 * surface - never through raw ipcRenderer.
 */
export interface VoyagerApi {
  setup: {
    getStatus: () => Promise<SetupStatus>
    /** Forces a fresh setup attempt (e.g. after an error); resolves with the new status. */
    retry: () => Promise<SetupStatus>
    /** Subscribe to setup progress events; returns an unsubscribe function. */
    onProgress: (callback: (status: SetupStatus) => void) => () => void
  }
  agent: {
    sendMessage: (request: SendMessageRequest) => Promise<SendMessageResponse>
    /** Current model/effort choice for the active project. */
    getSettings: () => Promise<AgentSettings>
    /** Persists a new model/effort choice; applied by the session starting from the next turn. */
    setSettings: (settings: AgentSettings) => Promise<AgentSettings>
    /** Stops the in-flight turn; resolves once the interrupt is delivered. No-op when idle. */
    interrupt: () => Promise<void>
    /** Subscribe to streaming agent events; returns an unsubscribe function. */
    onEvent: (callback: (event: AgentEvent) => void) => () => void
    /** Subscribe to out-of-policy tool approval requests; returns an unsubscribe function. */
    onPermissionRequest: (callback: (payload: PermissionRequestPayload) => void) => () => void
    /** Sends the user's Allow/Deny decision for a pending permission request. */
    respondPermission: (request: PermissionRespondRequest) => Promise<PermissionRespondResponse>
  }
  model: {
    loadSample: () => Promise<ArrayBuffer>
    /** Subscribe to model-displayed events; returns an unsubscribe function. */
    onDisplayed: (callback: (payload: ModelDisplayedPayload) => void) => () => void
    /** Subscribe to on-demand print-settings recommendations; returns an unsubscribe function. */
    onPrintSettings: (callback: (payload: PrintSettings) => void) => () => void
    /** Prompts a native save dialog and copies the latest iteration's STL/STEP there. */
    export: (request: ExportModelRequest) => Promise<ExportModelResponse>
  }
  project: {
    /** Every known project, in stable creation/discovery order. */
    list: () => Promise<ProjectSummary[]>
    /** Creates a new project and switches to it; resolves with its full hydrated state. */
    create: (request: CreateProjectRequest) => Promise<ProjectStateSnapshot>
    /** Switches the active project; resolves with its full hydrated state. Rejects if Voyager
     *  is mid-turn - stop or wait first. */
    switch: (request: SwitchProjectRequest) => Promise<ProjectStateSnapshot>
    /** Renames any project by id, active or not. */
    rename: (request: RenameProjectRequest) => Promise<ProjectSummary>
    /** The active project's full hydrated state - called once on app mount. */
    getState: () => Promise<ProjectStateSnapshot>
    /** Every iteration ever recorded for the active project, oldest first (R4 version history). */
    listIterations: () => Promise<IterationInfo[]>
    /** Reverts the active project's "current" iteration to an earlier (or later) generation;
     *  resolves with its full hydrated state (same shape as switch/create) so the caller can
     *  `hydrateProject()` + re-sync the viewport. Rejects if Voyager is mid-turn. */
    revertTo: (request: RevertToRequest) => Promise<ProjectStateSnapshot>
  }
}
