import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AgentEvent,
  ExportModelRequest,
  ExportModelResponse,
  ModelDisplayedPayload,
  PermissionRequestPayload,
  PermissionRespondRequest,
  PermissionRespondResponse,
  SendMessageRequest,
  SendMessageResponse,
  SetupStatus
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
    onEvent: (callback) => subscribe<AgentEvent>(IPC.agentEvent, callback),
    onPermissionRequest: (callback) => subscribe<PermissionRequestPayload>(IPC.agentPermissionRequest, callback),
    respondPermission: (request: PermissionRespondRequest): Promise<PermissionRespondResponse> =>
      ipcRenderer.invoke(IPC.agentPermissionRespond, request)
  },
  model: {
    loadSample: (): Promise<ArrayBuffer> => ipcRenderer.invoke(IPC.modelLoadSample),
    onDisplayed: (callback) => subscribe<ModelDisplayedPayload>(IPC.modelDisplayed, callback),
    export: (request: ExportModelRequest): Promise<ExportModelResponse> =>
      ipcRenderer.invoke(IPC.modelExport, request)
  }
}

// contextIsolation is enabled, so the renderer can only reach this API through
// contextBridge - it has no direct access to ipcRenderer or node primitives.
contextBridge.exposeInMainWorld('voyager', api)
