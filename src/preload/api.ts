import type {
  AgentEvent,
  AgentSettings,
  BriefListVersionsResponse,
  BriefLockResponse,
  BriefUpdateRequest,
  BriefUpdateResponse,
  CreateProjectRequest,
  DesignBrief,
  ExportModelRequest,
  ExportModelResponse,
  ExportPackageRequest,
  ExportPackageResponse,
  ImportModelRequest,
  ImportModelResponse,
  IterationInfo,
  ModelDisplayedPayload,
  ParamGetManifestResponse,
  ParamUpdateRequest,
  ParamUpdateResponse,
  PartDuplicateRequest,
  PartGetModelRequest,
  PartListResponse,
  PartSetActiveRequest,
  PartSetPlacementRequest,
  PartSetVisibilityRequest,
  PermissionRequestPayload,
  PermissionRespondRequest,
  PermissionRespondResponse,
  PrinterProfileDeleteRequest,
  PrinterProfileListResponse,
  PrinterProfileSaveRequest,
  PrinterProfileSetActiveRequest,
  PrintSettings,
  ProjectStateSnapshot,
  ProjectSummary,
  RenameProjectRequest,
  RevertToRequest,
  SendMessageRequest,
  SendMessageResponse,
  SetupStatus,
  SwitchProjectRequest,
  VerificationGetResponse,
  VerificationReport
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
    /** Prompts a native save dialog and saves the active iteration's STL/STEP: one file for a
     *  single-part project (or an explicit `partId`), a zip of separate per-part files for a
     *  multi-part project - parts are never silently merged (§14). */
    export: (request: ExportModelRequest) => Promise<ExportModelResponse>
    /** WS-G External model import/remix - stub behavior until WS-G lands (see `src/main/ipc.ts`). */
    import: (request: ImportModelRequest) => Promise<ImportModelResponse>
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
  /** WS-A Design Brief - stub behavior until WS-A lands (see `src/main/ipc.ts`). */
  brief: {
    get: () => Promise<DesignBrief>
    update: (request: BriefUpdateRequest) => Promise<BriefUpdateResponse>
    lock: () => Promise<BriefLockResponse>
    /** Every locked brief version, oldest first (WS-0c) - for the panel's history browser. */
    listVersions: () => Promise<BriefListVersionsResponse>
    /** Subscribe to brief changes (own edits and, later, agent-authored ones); returns an
     *  unsubscribe function. */
    onUpdated: (callback: (brief: DesignBrief) => void) => () => void
  }
  /** WS-I Multi-part projects - stub behavior until WS-I lands (see `src/main/ipc.ts`). */
  part: {
    /** Every part in the active project. */
    list: () => Promise<PartListResponse>
    /** One part's active-iteration model (with STL bytes) for the viewer, or null if it has none. */
    getModel: (request: PartGetModelRequest) => Promise<ModelDisplayedPayload | null>
    /** Persists a part's placement (layout only); resolves with the refreshed list. */
    setPlacement: (request: PartSetPlacementRequest) => Promise<PartListResponse>
    /** Shows/hides a part in the viewport; resolves with the refreshed list. */
    setVisibility: (request: PartSetVisibilityRequest) => Promise<PartListResponse>
    /** Makes a part the active one (the user focused it); resolves with the refreshed list. */
    setActive: (request: PartSetActiveRequest) => Promise<PartListResponse>
    /** Duplicates a part (shared immutable artifacts, offset placement, becomes active);
     *  resolves with the refreshed list. */
    duplicate: (request: PartDuplicateRequest) => Promise<PartListResponse>
    /** Subscribe to parts-list changes (e.g. the agent creating a new part); returns an
     *  unsubscribe function. */
    onUpdated: (callback: (response: PartListResponse) => void) => () => void
  }
  /** WS-B Parameter panel - stub behavior until WS-B lands (see `src/main/ipc.ts`). */
  param: {
    update: (request: ParamUpdateRequest) => Promise<ParamUpdateResponse>
    getManifest: () => Promise<ParamGetManifestResponse>
  }
  /** WS-C Verification - stub behavior until WS-C lands (see `src/main/ipc.ts`). */
  verification: {
    get: () => Promise<VerificationGetResponse>
    /** Subscribe to freshly-computed reports; returns an unsubscribe function. */
    onUpdated: (callback: (report: VerificationReport) => void) => () => void
  }
  /** WS-E Printer profiles - stub behavior until WS-E lands (see `src/main/ipc.ts`). */
  printerProfile: {
    list: () => Promise<PrinterProfileListResponse>
    save: (request: PrinterProfileSaveRequest) => Promise<PrinterProfileListResponse>
    setActive: (request: PrinterProfileSetActiveRequest) => Promise<PrinterProfileListResponse>
    /** Permanently removes a saved profile; the active pointer moves to null if it was active.
     *  Rejects if Voyager is mid-turn - stop or wait first. */
    delete: (request: PrinterProfileDeleteRequest) => Promise<PrinterProfileListResponse>
    /** Subscribe to profile-list changes; returns an unsubscribe function. */
    onUpdated: (callback: (response: PrinterProfileListResponse) => void) => () => void
  }
  /** WS-F Graduation package export - stub behavior until WS-F lands (see `src/main/ipc.ts`). */
  exportPackage: {
    export: (request: ExportPackageRequest) => Promise<ExportPackageResponse>
  }
}
