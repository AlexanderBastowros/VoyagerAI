import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useAppStore } from '../state/appStore'
import type { ChatMessage } from '../state/appStore'
import { deriveChatDisabledReason } from '../state/setupSelectors'

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

export function ChatPanel(): React.JSX.Element {
  const messages = useAppStore((state) => state.messages)
  const addMessage = useAppStore((state) => state.addMessage)
  const selection = useAppStore((state) => state.selection)
  const setupStatus = useAppStore((state) => state.setupStatus)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const setAgentBusy = useAppStore((state) => state.setAgentBusy)
  const [draft, setDraft] = useState('')

  // Input unlocks once all three setup checks (CLI, sign-in, Python env) are
  // ready, and re-locks while Claude is working on a turn.
  const disabledReason = deriveChatDisabledReason(setupStatus)
  const isDisabled = disabledReason !== null || agentBusy

  async function sendDraft(): Promise<void> {
    const text = draft.trim()
    if (!text || isDisabled) return

    setDraft('')
    addMessage({ role: 'user', text })
    setAgentBusy(true)

    try {
      const response = await window.voyager.agent.sendMessage({
        text,
        selectionContext: selection
      })
      if (!response.accepted) {
        setAgentBusy(false)
        addMessage({
          role: 'system-status',
          text: response.reason ?? 'The agent could not accept the message.'
        })
      }
      // On accept, streamed agent:event messages drive the UI from here;
      // agentBusy clears on message-complete / error.
    } catch (err) {
      setAgentBusy(false)
      addMessage({
        role: 'system-status',
        text: err instanceof Error ? `Failed to reach agent: ${err.message}` : 'Failed to reach agent'
      })
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
            Describe the part you want to 3D print — for example “a wall bracket for a 32mm
            curtain rod”. Claude will ask about your printer and dimensions, then model it.
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
        {agentBusy && <div className="chat-working-indicator">Claude is working…</div>}
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={disabledReason ?? 'Message Voyager AI... (Enter to send)'}
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
