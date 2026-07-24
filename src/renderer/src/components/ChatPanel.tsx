import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Popover from '@mui/material/Popover'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AttachFileIcon from '@mui/icons-material/AttachFile'
import CompressIcon from '@mui/icons-material/Compress'
import HighlightAltIcon from '@mui/icons-material/HighlightAlt'
import SendIcon from '@mui/icons-material/Send'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import StopIcon from '@mui/icons-material/Stop'
import { useAppStore } from '../state/appStore'
import type { ChatMessage } from '../state/appStore'
import type {
  AgentEffort,
  AgentModel,
  AgentSettings,
  ChatAttachment,
  SelectionSummary
} from '../../../shared/ipc'
import { deriveChatDisabledReason } from '../state/setupSelectors'
import { colors } from '../colors'
import { formatTokenCount } from '../format'
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
 *  `packages/agent-core/src/agent/session.ts`. The effort select is disabled for this model
 *  rather than sent a value the agent would have to silently drop. */
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

function messageRowSx(role: ChatMessage['role']): object {
  switch (role) {
    case 'user':
      return { bgcolor: colors.accentDim, borderColor: colors.accentDim, alignSelf: 'flex-end', color: '#f2f6fc' }
    case 'assistant':
      return { bgcolor: colors.bgPanelRaised }
    case 'system-status':
      return { bgcolor: 'transparent', borderStyle: 'dashed', color: 'text.secondary', fontStyle: 'italic' }
  }
}

/** Renders a single chat message. Memoized so that during streaming, only the
 *  actively-updated message re-renders - the store replaces just the streaming
 *  message object per delta, and historical messages keep reference equality. */
const ChatMessageRow = memo(function ChatMessageRow({
  message
}: {
  message: ChatMessage
}): React.JSX.Element | null {
  // Subscribed here (not passed as a prop) so flipping the toggle re-renders
  // existing rows past the `memo(message)` guard.
  const fullStream = useAppStore((state) => state.fullStream)
  // Bookkeeping activity (e.g. task-list updates) is only shown in full-stream mode.
  if (message.role === 'system-status' && message.routine && !fullStream) return null
  const textClassName = message.streaming ? 'chat-message-text streaming' : 'chat-message-text'
  const showArgs = fullStream && message.role === 'system-status' && Boolean(message.args)
  return (
    <Paper
      variant="outlined"
      sx={{ px: 1.25, py: 1, maxWidth: '90%', ...messageRowSx(message.role) }}
    >
      <Typography
        variant="caption"
        component="div"
        sx={{ textTransform: 'uppercase', color: 'text.disabled', mb: 0.25 }}
      >
        {message.role}
      </Typography>
      {message.attachments && message.attachments.length > 0 && (
        <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mb: 0.75 }}>
          {message.attachments.map((attachment, index) => (
            <Chip key={index} size="small" icon={<AttachFileIcon />} label={attachment.name} />
          ))}
        </Stack>
      )}
      {(message.text.length > 0 || message.streaming) && (
        <Box
          className={textClassName}
          sx={{
            lineHeight: 1.45,
            whiteSpace: message.role === 'assistant' ? undefined : 'pre-wrap'
          }}
        >
          {message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}
          {message.streaming && <span className="chat-message-cursor">|</span>}
        </Box>
      )}
      {showArgs && (
        <Box
          sx={{
            mt: 0.5,
            fontFamily: 'monospace',
            fontSize: 10.5,
            color: 'text.disabled',
            fontStyle: 'normal',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all'
          }}
        >
          {message.args}
        </Box>
      )}
    </Paper>
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
  const contextUsage = useAppStore((state) => state.contextUsage)
  const pendingPermission = useAppStore((state) => state.pendingPermission)
  const setPendingPermission = useAppStore((state) => state.setPendingPermission)
  const thinkingText = useAppStore((state) => state.thinkingText)
  const agentSettings = useAppStore((state) => state.agentSettings)
  const setAgentSettings = useAppStore((state) => state.setAgentSettings)
  const fullStream = useAppStore((state) => state.fullStream)
  const setFullStream = useAppStore((state) => state.setFullStream)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const projects = useAppStore((state) => state.projects)
  const selectedPartId = useAppStore((state) => state.selectedPartId)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [stopping, setStopping] = useState(false)
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

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

  // In full-stream mode show the complete thinking text (in a scrollable box);
  // otherwise a rolling last-5-lines window. Trim trailing whitespace first so
  // a trailing newline doesn't count as a blank 6th line and push a real line
  // off the top of the window.
  const trimmedThinking = thinkingText.trimEnd()
  const thinkingDisplay = fullStream ? trimmedThinking : trimmedThinking.split('\n').slice(-5).join('\n')

  // Input unlocks once all three setup checks (CLI, sign-in, Python env) are
  // ready, and re-locks while Claude is working on a turn.
  const disabledReason = deriveChatDisabledReason(setupStatus)
  const isDisabled = disabledReason !== null || agentBusy
  const effortDisabled = EFFORT_UNSUPPORTED_MODELS.has(agentSettings.model)

  async function addFiles(files: Iterable<File>): Promise<void> {
    const read = await Promise.all(Array.from(files).map((file) => readImageFile(file)))
    const valid = read.filter((attachment): attachment is ChatAttachment => attachment !== null)
    if (valid.length > 0) setAttachments((prev) => [...prev, ...valid])
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>): void {
    if (event.target.files) void addFiles(event.target.files)
    event.target.value = ''
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>): void {
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

  /** Sends one user turn to the agent and adds its chat bubble - shared by the composer's
   *  Send button and the "Compact" shortcut in the settings row. */
  async function dispatchTurn(
    text: string,
    options?: { attachments?: ChatAttachment[]; selectionContext?: SelectionSummary | null }
  ): Promise<void> {
    const attachmentsAtSend = options?.attachments
    const selectionAtSend = options?.selectionContext ?? null
    addMessage({ role: 'user', text, attachments: attachmentsAtSend })
    setAgentBusy(true)

    try {
      const response = await window.voyager.agent.sendMessage({
        text,
        selectionContext: selectionAtSend,
        attachments: attachmentsAtSend,
        focusedPartId: selectedPartId ?? undefined
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

  async function sendDraft(): Promise<void> {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || isDisabled) return

    const selectionAtSend = selection
    const attachmentsAtSend = attachments.length > 0 ? attachments : undefined
    setDraft('')
    setAttachments([])
    await dispatchTurn(text, { attachments: attachmentsAtSend, selectionContext: selectionAtSend })
  }

  /** Sends `/compact` - the SDK's built-in context-compaction command, triggered the same way
   *  as if the user had typed it - so a long conversation can be summarized down without the
   *  user needing to know the slash command exists. */
  async function compactConversation(): Promise<void> {
    if (isDisabled || messages.length === 0) return
    await dispatchTurn('/compact')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
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

  // Keep the transcript pinned to the latest message - both when new content
  // arrives (new messages, streaming deltas, thinking updates) and whenever
  // this panel (re)mounts, e.g. switching back to it from another project/tab,
  // where the scroll container otherwise starts at its default scrollTop of 0.
  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, thinkingDisplay, agentBusy])

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
    <Stack sx={{ flex: 1, minHeight: 0, bgcolor: 'background.paper' }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        gap={1.25}
        sx={{ px: 1.75, py: 1.25, borderBottom: 1, borderColor: 'divider' }}
      >
        <Stack direction="row" alignItems="baseline" gap={1} sx={{ minWidth: 0 }}>
          <Typography variant="overline" color="text.secondary">
            Chat
          </Typography>
          {activeProjectName && (
            <Typography variant="body2" fontWeight={600} noWrap>
              {activeProjectName}
            </Typography>
          )}
        </Stack>
        <Tooltip title="Chat settings">
          <IconButton
            size="small"
            aria-label="Chat settings"
            onClick={(e) => setSettingsAnchor(e.currentTarget)}
          >
            <SettingsOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Per-project chat settings: model, render previews, and full stream live here rather than
          crowding the header. Model + render-previews are per-project (AgentSettings); full stream
          is a global display preference. */}
      <Popover
        open={Boolean(settingsAnchor)}
        anchorEl={settingsAnchor}
        onClose={() => setSettingsAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 272 } } }}
      >
        <Stack sx={{ p: 1.5 }} gap={1.5}>
          <Typography variant="overline" color="text.secondary">
            Chat settings
          </Typography>
          <Stack gap={0.5}>
            <Typography variant="caption" color="text.secondary">
              Model
            </Typography>
            <Select
              size="small"
              fullWidth
              value={agentSettings.model}
              onChange={(e) => void updateAgentSettings({ model: e.target.value as AgentModel })}
              inputProps={{ 'aria-label': 'Model' }}
              sx={{ fontSize: 13 }}
            >
              {MODEL_OPTIONS.map((option) => (
                <MenuItem key={option.value} value={option.value} sx={{ fontSize: 13 }}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </Stack>
          <Stack gap={0.5}>
            <Typography variant="caption" color="text.secondary">
              Effort
            </Typography>
            <Select
              size="small"
              fullWidth
              value={agentSettings.effort}
              disabled={effortDisabled}
              onChange={(e) => void updateAgentSettings({ effort: e.target.value as AgentEffort })}
              inputProps={{ 'aria-label': 'Effort' }}
              sx={{ fontSize: 13 }}
            >
              {EFFORT_OPTIONS.map((option) => (
                <MenuItem key={option.value} value={option.value} sx={{ fontSize: 13 }}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
            {effortDisabled && (
              <Typography variant="caption" color="text.disabled">
                Haiku doesn’t support an effort setting.
              </Typography>
            )}
          </Stack>
          <Divider />
          <FormControlLabel
            sx={{ m: 0, alignItems: 'flex-start', gap: 1 }}
            control={
              <Switch
                size="small"
                checked={agentSettings.renderViews !== false}
                onChange={() =>
                  void updateAgentSettings({ renderViews: !(agentSettings.renderViews !== false) })
                }
              />
            }
            label={
              <Box>
                <Typography variant="body2">Render previews</Typography>
                <Typography variant="caption" color="text.secondary">
                  Render &amp; inspect 8 views per iteration before display. Needed for version-history
                  thumbnails; adds a few seconds per iteration.
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            sx={{ m: 0, alignItems: 'flex-start', gap: 1 }}
            control={<Switch size="small" checked={fullStream} onChange={() => setFullStream(!fullStream)} />}
            label={
              <Box>
                <Typography variant="body2">Full stream</Typography>
                <Typography variant="caption" color="text.secondary">
                  Show all of Voyager&apos;s background activity — tool calls, inputs, and full thinking.
                </Typography>
              </Box>
            }
          />
          <Divider />
          <Stack gap={0.5} alignItems="flex-start">
            {contextUsage && (
              <Typography variant="caption" color="text.secondary">
                Context: {formatTokenCount(contextUsage.totalTokens)} of{' '}
                {formatTokenCount(contextUsage.maxTokens)}
              </Typography>
            )}
            <Button
              size="small"
              startIcon={<CompressIcon fontSize="small" />}
              disabled={isDisabled || messages.length === 0}
              onClick={() => {
                setSettingsAnchor(null)
                void compactConversation()
              }}
            >
              Compact conversation
            </Button>
          </Stack>
        </Stack>
      </Popover>
      <Stack spacing={1.25} sx={{ flex: 1, overflowY: 'auto', p: 1.5 }}>
        {messages.length === 0 && (
          <Typography variant="body2" color="text.disabled">
            Describe the part you want to 3D print — for example “a wall bracket for a 32mm
            curtain rod”. Voyager will ask about your printer and dimensions, then model it.
          </Typography>
        )}
        {messages.map((message) => (
          <ChatMessageRow key={message.id} message={message} />
        ))}
        {thinkingDisplay.length > 0 && (
          <Box
            sx={{
              color: 'text.disabled',
              fontSize: 11.5,
              borderLeft: 2,
              borderColor: 'divider',
              px: 1,
              whiteSpace: 'pre-wrap',
              fontStyle: 'italic',
              // Full-stream: the whole thinking transcript in a scrollable box.
              // Otherwise: the last-5-lines window, faded in at the top.
              ...(fullStream
                ? { maxHeight: 240, overflowY: 'auto' }
                : {
                    maxHeight: 'calc(1.4em * 5)',
                    overflow: 'hidden',
                    maskImage: 'linear-gradient(to bottom, transparent, #000 1.4em)',
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 1.4em)'
                  })
            }}
          >
            {thinkingDisplay}
          </Box>
        )}
        {agentBusy && (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={12} />
            <Typography variant="body2" color="text.disabled">
              Voyager is working…
            </Typography>
          </Stack>
        )}
        <div ref={messagesEndRef} />
      </Stack>
      {pendingPermission && (
        <Alert severity="warning" variant="outlined" sx={{ mx: 1.25, bgcolor: colors.warningDim }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Voyager wants to: {pendingPermission.summary}
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button variant="contained" color="warning" onClick={() => void respondToPermission(true)}>
              Allow once
            </Button>
            <Button variant="outlined" color="inherit" onClick={() => void respondToPermission(false)}>
              Deny
            </Button>
          </Stack>
        </Alert>
      )}
      {selection && (
        <Alert
          severity="info"
          icon={<HighlightAltIcon fontSize="inherit" />}
          sx={{ borderRadius: 0, py: 0, fontSize: 11.5 }}
        >
          Refining selected region — {selection.dims[0].toFixed(1)}×{selection.dims[1].toFixed(1)}×
          {selection.dims[2].toFixed(1)} mm
        </Alert>
      )}
      {attachments.length > 0 && (
        <Stack direction="row" flexWrap="wrap" gap={1} sx={{ px: 1.25, pt: 1.25 }}>
          {attachments.map((attachment, index) => (
            <Chip
              key={index}
              size="small"
              icon={<AttachFileIcon />}
              label={attachment.name}
              onDelete={() => removeAttachment(index)}
            />
          ))}
        </Stack>
      )}
      <Stack
        direction="row"
        spacing={1}
        sx={{ p: 1.25, borderTop: 1, borderColor: 'divider' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileInputChange}
        />
        <Tooltip title="Attach image">
          <span>
            <IconButton
              disabled={isDisabled}
              aria-label="Attach image"
              sx={{ alignSelf: 'flex-end' }}
              onClick={() => fileInputRef.current?.click()}
            >
              <AttachFileIcon />
            </IconButton>
          </span>
        </Tooltip>
        <TextField
          multiline
          minRows={3}
          maxRows={8}
          fullWidth
          size="small"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={isDisabled}
          placeholder={disabledReason ?? 'Message Voyager AI... (Enter to send)'}
        />
        {agentBusy ? (
          <Button
            variant="outlined"
            startIcon={<StopIcon />}
            onClick={() => void stopTurn()}
            disabled={stopping}
            sx={{ alignSelf: 'flex-end' }}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        ) : (
          <Button
            variant="contained"
            endIcon={<SendIcon />}
            onClick={() => void sendDraft()}
            disabled={isDisabled || (draft.trim().length === 0 && attachments.length === 0)}
            sx={{ alignSelf: 'flex-end' }}
          >
            Send
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
