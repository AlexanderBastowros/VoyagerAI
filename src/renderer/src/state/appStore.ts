import { create } from 'zustand'
import type { SelectionSummary, SetupCheck, SetupStatus } from '../../../shared/ipc'

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

  /** Appends a new message and returns its generated id (for later streaming updates). */
  addMessage: (message: Omit<ChatMessage, 'id' | 'createdAt'>) => string
  /** Appends `delta` to an existing message's text - used for streamed assistant replies. */
  appendToMessage: (id: string, delta: string) => void
  /** Marks a streaming message as finished. */
  completeMessage: (id: string) => void
  setModel: (model: ModelInfo | null) => void
  setSetupStatus: (status: SetupStatus) => void
  setSelection: (selection: SelectionSummary | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  messages: [],
  model: null,
  setupStatus: initialSetupStatus(),
  selection: null,

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

  setModel: (model) => set({ model }),
  setSetupStatus: (setupStatus) => set({ setupStatus }),
  setSelection: (selection) => set({ selection })
}))
