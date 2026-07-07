import { create } from 'zustand'
import type {
  AgentEvent,
  PermissionRequestPayload,
  SelectionSummary,
  SetupCheck,
  SetupStatus
} from '../../../shared/ipc'

export type ChatRole = 'user' | 'assistant' | 'system-status'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  createdAt: number
  /** True while an assistant message is still being streamed via agent:event. */
  streaming?: boolean
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

function initialSetupStatus(): SetupStatus {
  return {
    claudeCli: unchecked('Not checked yet'),
    claudeAuth: unchecked('Not checked yet'),
    pythonEnv: unchecked('Not checked yet')
  }
}

let messageSequence = 0
function createMessageId(): string {
  messageSequence += 1
  return `msg-${Date.now()}-${messageSequence}`
}

export interface AppState {
  messages: ChatMessage[]
  model: ModelInfo | null
  setupStatus: SetupStatus
  selection: SelectionSummary | null
  /** True while the "Select region" toolbar toggle is active. */
  selectMode: boolean
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

  /** Appends a new message and returns its generated id (for later streaming updates). */
  addMessage: (message: Omit<ChatMessage, 'id' | 'createdAt'>) => string
  /** Appends `delta` to an existing message's text - used for streamed assistant replies. */
  appendToMessage: (id: string, delta: string) => void
  /** Marks a streaming message as finished. */
  completeMessage: (id: string) => void
  /** Replaces the current model. Also clears any active selection - its triangle indices
   *  and coordinates refer to the previous iteration's geometry and must not leak forward. */
  setModel: (model: ModelInfo | null) => void
  setSetupStatus: (status: SetupStatus) => void
  setSelection: (selection: SelectionSummary | null) => void
  setSelectMode: (selectMode: boolean) => void
  setAgentBusy: (busy: boolean) => void
  /** Sets or clears (pass `null`) the pending approval card. */
  setPendingPermission: (request: PermissionRequestPayload | null) => void
  /** Folds one streamed `agent:event` into the chat state. */
  applyAgentEvent: (event: AgentEvent) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  messages: [],
  model: null,
  setupStatus: initialSetupStatus(),
  selection: null,
  selectMode: false,
  agentBusy: false,
  agentStreamIds: {},
  pendingPermission: null,
  thinkingText: '',

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

  setModel: (model) => set({ model, selection: null }),
  setSetupStatus: (setupStatus) => set({ setupStatus }),
  setSelection: (selection) => set({ selection }),
  setSelectMode: (selectMode) => set({ selectMode }),
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
        // parametric script" activity) into a single status line.
        const last = state.messages.at(-1)
        if (last?.role === 'system-status' && last.text === event.detail) return
        state.addMessage({ role: 'system-status', text: event.detail })
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
    }
  }
}))
