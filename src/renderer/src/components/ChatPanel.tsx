import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useAppStore } from '../state/appStore'
import type { ChatMessage } from '../state/appStore'

function messageClassName(role: ChatMessage['role']): string {
  switch (role) {
    case 'user':
      return 'chat-message chat-message-user'
    case 'assistant':
      return 'chat-message chat-message-assistant'
    case 'system-status':
      return 'chat-message chat-message-system'
  }
}

/**
 * M1 note: the input stays enabled so the send -> IPC -> stub -> echo round
 * trip can be exercised end to end. M2/M3 will set this from real setup /
 * session readiness (see appStore.setupStatus) instead of a hardcoded null,
 * disabling the input with an explanatory placeholder until the agent
 * session is actually available.
 */
const INPUT_DISABLED_REASON: string | null = null

export function ChatPanel(): React.JSX.Element {
  const messages = useAppStore((state) => state.messages)
  const addMessage = useAppStore((state) => state.addMessage)
  const selection = useAppStore((state) => state.selection)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const isDisabled = INPUT_DISABLED_REASON !== null || sending

  async function sendDraft(): Promise<void> {
    const text = draft.trim()
    if (!text || isDisabled) return

    setDraft('')
    addMessage({ role: 'user', text })

    setSending(true)
    try {
      const response = await window.voyager.agent.sendMessage({
        text,
        selectionContext: selection
      })
      addMessage({
        role: 'system-status',
        text: response.reason ?? 'Agent not connected yet (Milestone 3)'
      })
    } catch (err) {
      addMessage({
        role: 'system-status',
        text: err instanceof Error ? `Failed to reach agent: ${err.message}` : 'Failed to reach agent'
      })
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendDraft()
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">Chat</div>
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty-state">
            Describe the part you want to model. Chat is not yet wired to the Claude Agent SDK
            (Milestone 3).
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={messageClassName(message.role)}>
            <div className="chat-message-role">{message.role}</div>
            <div className="chat-message-text">
              {message.text}
              {message.streaming && <span className="chat-message-cursor">|</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={INPUT_DISABLED_REASON ?? 'Message Voyager AI... (Enter to send)'}
          rows={3}
        />
        <button
          type="button"
          className="chat-send-button"
          onClick={() => void sendDraft()}
          disabled={isDisabled || draft.trim().length === 0}
        >
          Send
        </button>
      </div>
    </div>
  )
}
