import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
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
import type { VoyagerApi } from './api'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: VoyagerApi = {
  setup: {
    getStatus: (): Promise<SetupStatus> => ipcRenderer.invoke(IPC.setupGetStatus),
    retry: (): Promise<SetupStatus> => ipcRenderer.invoke(IPC.setupRetry),
    onProgress: (callback) => subscribe<SetupStatus>(IPC.setupProgress, callback)
  },
  agent: {
    sendMessage: (request: SendMessageRequest): Promise<SendMessageResponse> =>
      ipcRenderer.invoke(IPC.agentSendMessage, request),
    getSettings: (): Promise<AgentSettings> => ipcRenderer.invoke(IPC.agentGetSettings),
    setSettings: (settings: AgentSettings): Promise<AgentSettings> =>
      ipcRenderer.invoke(IPC.agentSetSettings, settings),
    interrupt: (): Promise<void> => ipcRenderer.invoke(IPC.agentInterrupt),
    onEvent: (callback) => subscribe<AgentEvent>(IPC.agentEvent, callback),
    onPermissionRequest: (callback) => subscribe<PermissionRequestPayload>(IPC.agentPermissionRequest, callback),
    respondPermission: (request: PermissionRespondRequest): Promise<PermissionRespondResponse> =>
      ipcRenderer.invoke(IPC.agentPermissionRespond, request)
  },
  model: {
    loadSample: (): Promise<ArrayBuffer> => ipcRenderer.invoke(IPC.modelLoadSample),
    onDisplayed: (callback) => subscribe<ModelDisplayedPayload>(IPC.modelDisplayed, callback),
    onPrintSettings: (callback) => subscribe<PrintSettings>(IPC.printSettingsUpdated, callback),
    export: (request: ExportModelRequest): Promise<ExportModelResponse> =>
      ipcRenderer.invoke(IPC.modelExport, request)
  },
  project: {
    list: (): Promise<ProjectSummary[]> => ipcRenderer.invoke(IPC.projectList),
    create: (request: CreateProjectRequest): Promise<ProjectStateSnapshot> =>
      ipcRenderer.invoke(IPC.projectCreate, request),
    switch: (request: SwitchProjectRequest): Promise<ProjectStateSnapshot> =>
      ipcRenderer.invoke(IPC.projectSwitch, request),
    rename: (request: RenameProjectRequest): Promise<ProjectSummary> =>
      ipcRenderer.invoke(IPC.projectRename, request),
    getState: (): Promise<ProjectStateSnapshot> => ipcRenderer.invoke(IPC.projectGetState),
    listIterations: (): Promise<IterationInfo[]> => ipcRenderer.invoke(IPC.projectListIterations),
    revertTo: (request: RevertToRequest): Promise<ProjectStateSnapshot> =>
      ipcRenderer.invoke(IPC.projectRevertTo, request)
  }
}

// contextIsolation is enabled, so the renderer can only reach this API through
// contextBridge - it has no direct access to ipcRenderer or node primitives.
contextBridge.exposeInMainWorld('voyager', api)
