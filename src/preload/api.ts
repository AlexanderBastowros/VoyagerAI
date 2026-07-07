import type {
  AgentEvent,
  ModelDisplayedPayload,
  SendMessageRequest,
  SendMessageResponse,
  SetupStatus
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
    /** Subscribe to streaming agent events; returns an unsubscribe function. */
    onEvent: (callback: (event: AgentEvent) => void) => () => void
  }
  model: {
    loadSample: () => Promise<ArrayBuffer>
    /** Subscribe to model-displayed events; returns an unsubscribe function. */
    onDisplayed: (callback: (payload: ModelDisplayedPayload) => void) => () => void
  }
}
