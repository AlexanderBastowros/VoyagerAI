import { memo, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { useAppStore } from '../state/appStore'
import type { ChatMessage } from '../state/appStore'
import type { AgentEffort, AgentModel, AgentSettings, ChatAttachment } from '../../../shared/ipc'
import { deriveChatDisabledReason } from '../state/setupSelectors'
import { Markdown } from './Markdown'

const SUPPORTED_IMAGE_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const MODEL_OPTIONS: Array<{ value: AgentModel; label: string }> = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8 — deepest' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest' }
]

const EFFORT_OPTIONS: Array<{ value: AgentEffort; label: string }> = [
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
  { value: 'xhigh', label: 'X-high effort' },
  { value: 'max', label: 'Max effort' }
]

/** Haiku's API rejects the `effort` option outright - mirrors `EFFORT_UNSUPPORTED_MODELS` in
 *  `src/main/agent/session.ts`. The effort select is disabled for this model rather than sent
 *  a value the agent would have to silently drop. */
const EFFORT_UNSUPPORTED_MODELS = new Set<AgentModel>(['claude-haiku-4-5'])

/** Reads an image `File` into a `ChatAttachment` (base64, no `data:` prefix). Resolves `null`
 *  for a file type the Anthropic API doesn't accept as an image block, so callers can filter it out. */
function readImageFile(file: File): Promise<ChatAttachment | null> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve({
        data: result.slice(result.indexOf(',') + 1),
        mediaType: file.type as ChatAttachment['mediaType'],
        name: file.name || 'image'
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

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

/** Renders a single chat message. Memoized so that during streaming, only the
 *  actively-updated message re-renders - the store replaces just the streaming
 *  message object per delta, and historical messages keep reference equality. */
const ChatMessageRow = memo(function ChatMessageRow({
  message
}: {
  message: ChatMessage
}): React.JSX.Element {
  const textClassName = message.streaming ? 'chat-message-text streaming' : 'chat-message-text'
  return (
    <div className={messageClassName(message.role)}>
      <div className="chat-message-role">{message.role}</div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="chat-message-attachments">
          {message.attachments.map((attachment, index) => (
            <span className="chat-attachment-chip" key={index}>
              📎 {attachment.name}
            </span>
          ))}
        </div>
      )}
      {(message.text.length > 0 || message.streaming) && (
        <div className={textClassName}>
          {message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}
          {message.streaming && <span className="chat-message-cursor">|</span>}
        </div>
      )}
    </div>
  )
})

export function ChatPanel(): React.JSX.Element {
  const messages = useAppStore((state) => state.messages)
  const addMessage = useAppStore((state) => state.addMessage)
  const selection = useAppStore((state) => state.selection)
  const setSelection = useAppStore((state) => state.setSelection)
  const setupStatus = useAppStore((state) => state.setupStatus)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const setAgentBusy = useAppStore((state) => state.setAgentBusy)
  const pendingPermission = useAppStore((state) => state.pendingPermission)
  const setPendingPermission = useAppStore((state) => state.setPendingPermission)
  const thinkingText = useAppStore((state) => state.thinkingText)
  const agentSettings = useAppStore((state) => state.agentSettings)
  const setAgentSettings = useAppStore((state) => state.setAgentSettings)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const projects = useAppStore((state) => state.projects)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [stopping, setStopping] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Settings/messages/project name all hydrate together via `App.tsx`'s one-time
  // project:getState mount effect (and on every create/switch) - no separate fetch here.
  const activeProjectName = projects.find((p) => p.id === activeProjectId)?.name

  async function updateAgentSettings(partial: Partial<AgentSettings>): Promise<void> {
    const next = { ...agentSettings, ...partial }
    setAgentSettings(next)
    try {
      await window.voyager.agent.setSettings(next)
    } catch (err) {
      console.error('Failed to save agent settings', err)
    }
  }

  // Rolling last-5-lines window of the current turn's thinking text. Trim
  // trailing whitespace first so a trailing newline doesn't count as a blank
  // 6th line and push a real line off the top.
  const thinkingLines = thinkingText.trimEnd().split('\n').slice(-5).join('\n')

  // Input unlocks once all three setup checks (CLI, sign-in, Python env) are
  // ready, and re-locks while Claude is working on a turn.
  const disabledReason = deriveChatDisabledReason(setupStatus)
  const isDisabled = disabledReason !== null || agentBusy

  async function addFiles(files: Iterable<File>): Promise<void> {
    const read = await Promise.all(Array.from(files).map((file) => readImageFile(file)))
    const valid = read.filter((attachment): attachment is ChatAttachment => attachment !== null)
    if (valid.length > 0) setAttachments((prev) => [...prev, ...valid])
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>): void {
    if (event.target.files) void addFiles(event.target.files)
    event.target.value = ''
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (imageFiles.length > 0) void addFiles(imageFiles)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files)
  }

  function removeAttachment(index: number): void {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  async function sendDraft(): Promise<void> {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || isDisabled) return

    const selectionAtSend = selection
    const attachmentsAtSend = attachments.length > 0 ? attachments : undefined
    setDraft('')
    setAttachments([])
    addMessage({ role: 'user', text, attachments: attachmentsAtSend })
    setAgentBusy(true)

    try {
      const response = await window.voyager.agent.sendMessage({
        text,
        selectionContext: selectionAtSend,
        attachments: attachmentsAtSend
      })
      if (!response.accepted) {
        setAgentBusy(false)
        addMessage({
          role: 'system-status',
          text: response.reason ?? 'The agent could not accept the message.'
        })
        // Refused send: the selection context wasn't consumed, so keep it around.
      } else if (selectionAtSend) {
        // Accepted send that included a selection: it's a one-shot context for
        // this refinement, so clear it before the user's next message.
        setSelection(null)
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

  // The main process emits the terminal `stopped` event (which the store turns
  // into a "Stopped." status line and clears agentBusy) regardless of whether
  // the interrupt IPC call itself succeeds, so this effect - not the click
  // handler - is what un-disables the Stop button once the turn has actually
  // ended.
  useEffect(() => {
    if (!agentBusy) setStopping(false)
  }, [agentBusy])

  async function stopTurn(): Promise<void> {
    if (stopping) return
    setStopping(true)
    try {
      await window.voyager.agent.interrupt()
    } catch (err) {
      // The main process emits the terminal stopped/error event once the
      // interrupt is *delivered*. If the invoke itself fails, nothing will
      // ever arrive, so re-arm the Stop button instead of waiting forever.
      setStopping(false)
      console.error('agent.interrupt failed', err)
    }
  }

  async function respondToPermission(allow: boolean): Promise<void> {
    if (!pendingPermission) return
    const { requestId } = pendingPermission
    // Clear immediately so a slow IPC round-trip can't double-submit via a
    // second click; the request is already resolved from the user's view.
    setPendingPermission(null)
    try {
      await window.voyager.agent.respondPermission({ requestId, allow })
    } catch {
      // Best-effort: if the main process is gone the session has already
      // timed the request out on its own (see session.ts's approval race).
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-title-group">
          <span className="chat-header-title">Chat</span>
          {activeProjectName && <span className="chat-header-project">{activeProjectName}</span>}
        </div>
        <div className="chat-header-settings">
          <select
            className="chat-settings-select"
            aria-label="Model"
            value={agentSettings.model}
            onChange={(e) => void updateAgentSettings({ model: e.target.value as AgentModel })}
          >
            {MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="chat-settings-select"
            aria-label="Effort"
            value={agentSettings.effort}
            disabled={EFFORT_UNSUPPORTED_MODELS.has(agentSettings.model)}
            title={
              EFFORT_UNSUPPORTED_MODELS.has(agentSettings.model)
                ? 'Haiku does not support an effort setting'
                : undefined
            }
            onChange={(e) => void updateAgentSettings({ effort: e.target.value as AgentEffort })}
          >
            {EFFORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty-state">
            Describe the part you want to 3D print — for example “a wall bracket for a 32mm
            curtain rod”. Voyager will ask about your printer and dimensions, then model it.
          </div>
        )}
        {messages.map((message) => (
          <ChatMessageRow key={message.id} message={message} />
        ))}
        {thinkingLines.length > 0 && (
          <div className="chat-thinking">
            <div className="chat-thinking-text">{thinkingLines}</div>
          </div>
        )}
        {agentBusy && <div className="chat-working-indicator">Voyager is working…</div>}
      </div>
      {pendingPermission && (
        <div className="chat-permission-card">
          <div className="chat-permission-text">Voyager wants to: {pendingPermission.summary}</div>
          <div className="chat-permission-actions">
            <button
              type="button"
              className="chat-permission-allow"
              onClick={() => void respondToPermission(true)}
            >
              Allow once
            </button>
            <button type="button" className="chat-permission-deny" onClick={() => void respondToPermission(false)}>
              Deny
            </button>
          </div>
        </div>
      )}
      {selection && (
        <div className="chat-selection-banner">
          Refining selected region — {selection.dims[0].toFixed(1)}×{selection.dims[1].toFixed(1)}×
          {selection.dims[2].toFixed(1)} mm
        </div>
      )}
      {attachments.length > 0 && (
        <div className="chat-attachments-preview">
          {attachments.map((attachment, index) => (
            <span className="chat-attachment-chip chat-attachment-chip-pending" key={index}>
              📎 {attachment.name}
              <button
                type="button"
                className="chat-attachment-remove"
                onClick={() => removeAttachment(index)}
                aria-label="Remove attachment"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="chat-input-row" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="chat-file-input"
          onChange={handleFileInputChange}
        />
        <button
          type="button"
          className="chat-attach-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isDisabled}
          aria-label="Attach image"
          title="Attach image"
        >
          📎
        </button>
        <textarea
          className="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={isDisabled}
          placeholder={disabledReason ?? 'Message Voyager AI... (Enter to send)'}
          rows={3}
        />
        {agentBusy ? (
          <button
            type="button"
            className="chat-stop-button"
            onClick={() => void stopTurn()}
            disabled={stopping}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button
            type="button"
            className="chat-send-button"
            onClick={() => void sendDraft()}
            disabled={isDisabled || (draft.trim().length === 0 && attachments.length === 0)}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
