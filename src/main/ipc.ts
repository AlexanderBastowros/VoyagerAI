import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  AgentEvent,
  AgentSettings,
  BriefLockResponse,
  BriefUpdateRequest,
  BriefUpdateResponse,
  CreateProjectRequest,
  DesignBrief,
  ExportModelRequest,
  ExportModelResponse,
  ExportPackageRequest,
  ExportPackageResponse,
  IterationInfo,
  ModelDisplayedPayload,
  ParamGetManifestResponse,
  ParamUpdateRequest,
  ParamUpdateResponse,
  PermissionRespondRequest,
  PermissionRespondResponse,
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
  VerificationGetResponse
} from '../shared/ipc'
import {
  AgentSession,
  BriefStore,
  ClaudeChecker,
  EnvManager,
  ProjectStore,
  readManifestForIteration,
  rerunWithParam,
  resolveExportSource,
  runPreflight,
  validateParamUpdate
} from '@voyager/agent-core'

/**
 * Resolves a path under the app's `resources/` directory, in both dev (where
 * it lives at the project root) and packaged builds (where electron-builder's
 * `extraResources` config copies it under `process.resourcesPath`).
 */
function resourcePath(...segments: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  return join(base, ...segments)
}

/**
 * Absolute path to `packages/verify`'s bundled `validate_stl.py`. Not under `resources/` (it's
 * package source, not an app resource), so it gets its own dev/packaged resolution mirroring
 * `resourcePath` - packaged builds copy it via electron-builder's `extraResources` `verify` entry.
 */
function verifyScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'verify', 'validate_stl.py')
    : join(__dirname, '../../packages/verify/python/validate_stl.py')
}

/**
 * Absolute path to `packages/agent-core/params`'s bundled `extract_params.py`. Same dev/packaged
 * resolution as `verifyScriptPath` - packaged builds copy it via electron-builder's
 * `extraResources` `params` entry.
 */
function extractParamsScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'params', 'extract_params.py')
    : join(__dirname, '../../packages/agent-core/params/python/extract_params.py')
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * Pending approval requests awaiting a renderer response, keyed by
 * `requestId`. AgentSession's own 120s timeout (see session.ts's
 * `raceApproval`) is what actually unblocks a stalled turn - this map isn't
 * separately time-boxed, so a request the user never answers just lingers
 * here (harmlessly; the session has already moved on) until it does get a
 * response or the app quits.
 */
const pendingApprovals = new Map<string, (allow: boolean) => void>()

/**
 * Broadcasts an out-of-policy tool call as an inline approval card to every
 * window and returns a promise that resolves with the user's decision. This
 * is `AgentSessionDeps.requestUserApproval` - the `agent:permissionRespond`
 * handler below is what resolves the promise this returns.
 */
function askUser(request: { requestId: string; toolName: string; summary: string }): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.set(request.requestId, resolve)
    broadcast(IPC.agentPermissionRequest, request)
  })
}

/** Maps a main-only `ProjectIteration` to the renderer-safe `IterationInfo` (R4). */
function toIterationInfo(iteration: { n: number; summary: string; at: string; stepPath?: string }): IterationInfo {
  return { n: iteration.n, summary: iteration.summary, at: iteration.at, hasStep: Boolean(iteration.stepPath) }
}

/**
 * Reads everything the renderer needs to hydrate a project on mount, create, switch, or revert:
 * its summary list, full chat history, model/effort settings, the version-history list (R4),
 * and (if any iteration exists) the *active* iteration's STL bytes ready for the same
 * `viewerRef.current?.loadSTL(...)` call the live `model:displayed` path already uses - the
 * ArrayBuffer-slice here mirrors `modelLoadSample` below and `mcpTools.ts`'s `toArrayBuffer`.
 * Uses `activeIterationRecord()` (not `latestIteration()`) so a prior `revertTo()` call is
 * honored - see `ProjectStore.activeIterationRecord`.
 */
async function buildProjectSnapshot(projectStore: ProjectStore): Promise<ProjectStateSnapshot> {
  const [projects, messages, agentSettings, active, iterations] = await Promise.all([
    projectStore.listProjects(),
    projectStore.getChatHistory(),
    projectStore.getAgentSettings(),
    projectStore.activeIterationRecord(),
    projectStore.listIterations()
  ])

  let model: ModelDisplayedPayload | null = null
  if (active) {
    const buffer = await readFile(join(projectStore.getProjectDir(), active.stlPath))
    model = {
      stlPath: active.stlPath,
      stepPath: active.stepPath,
      scriptPath: active.scriptPath,
      summary: active.summary,
      iteration: active.n,
      stlBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    }
  }

  return {
    activeProjectId: projectStore.getActiveProjectId(),
    projects,
    messages,
    agentSettings,
    model,
    iterations: iterations.map(toIterationInfo),
    activeIteration: active?.n ?? null
  }
}

/**
 * In-memory stubs for the WS-C/E/F contracts landed by WS-0b (WS-A's brief handlers and WS-B's
 * parameter handlers below are both real - see `briefStore` and the venv re-run path). None of
 * this is persisted or per-project - each real work order (see `agents/production-roadmap.md`)
 * replaces its stub with durable, project-scoped state without needing to touch this file again,
 * since the IPC shapes are already final.
 */

/** Registers all main-process IPC handlers. */
export function registerIpcHandlers(): void {
  const envManager = new EnvManager({
    baseDir: join(app.getPath('userData'), 'pyenv'),
    binDir: join(app.getPath('userData'), 'bin'),
    smokeTestScriptPath: resourcePath('python', 'smoke_test.py')
  })

  const claudeChecker = new ClaudeChecker()

  const projectStore = new ProjectStore({
    baseDir: join(app.getPath('userData'), 'projects'),
    skillSourceDir: resourcePath('skills', 'printable-cad'),
    verifyScriptPath: verifyScriptPath(),
    extractParamsScriptPath: extractParamsScriptPath()
  })

  const briefStore = new BriefStore()

  const agentSession = new AgentSession({
    projectStore,
    briefStore,
    pythonPath: () => envManager.pythonPath(),
    claudeCliPath: () => claudeChecker.cliPath(),
    emitAgentEvent: (event: AgentEvent) => broadcast(IPC.agentEvent, event),
    emitModelDisplayed: (payload: ModelDisplayedPayload) => broadcast(IPC.modelDisplayed, payload),
    emitPrintSettings: (payload: PrintSettings) => broadcast(IPC.printSettingsUpdated, payload),
    emitBriefUpdated: (payload: DesignBrief) => broadcast(IPC.briefUpdated, payload),
    requestUserApproval: askUser
  })
  app.on('will-quit', () => agentSession.dispose())

  let cachedStatus: SetupStatus = {
    claudeCli: { state: 'unchecked', detail: 'Not checked yet' },
    claudeAuth: { state: 'unchecked', detail: 'Not checked yet' },
    pythonEnv: { state: 'unchecked', detail: 'Not checked yet' }
  }
  let preflightPromise: Promise<SetupStatus> | null = null

  function broadcastProgress(status: SetupStatus): void {
    cachedStatus = status
    broadcast(IPC.setupProgress, status)
  }

  // Kicks off (or reuses) the single in-flight preflight run. Never runs two
  // preflight passes concurrently - repeated `setup:getStatus` invokes (e.g.
  // from multiple windows, or React effect re-runs) just await/observe the
  // same run.
  function startPreflight(): Promise<SetupStatus> {
    if (!preflightPromise) {
      preflightPromise = runPreflight({ envManager, claude: claudeChecker }, broadcastProgress).then(
        (status) => {
          cachedStatus = status
          return status
        }
      )
    }
    return preflightPromise
  }

  function setupIncompleteReason(): string | null {
    if (cachedStatus.claudeCli.state !== 'ready') return 'Claude Code CLI is not ready yet.'
    if (cachedStatus.claudeAuth.state !== 'ready') return 'Claude sign-in is not ready yet.'
    if (cachedStatus.pythonEnv.state !== 'ready') return 'The Python environment is not ready yet.'
    return null
  }

  ipcMain.handle(IPC.modelLoadSample, async (): Promise<ArrayBuffer> => {
    const filePath = resourcePath('sample', 'cube.stl')
    const buffer = await readFile(filePath)
    // Slice out a standalone ArrayBuffer so we don't hand back a view into
    // Node's shared buffer pool.
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

  ipcMain.handle(
    IPC.modelExport,
    async (event, request: ExportModelRequest): Promise<ExportModelResponse> => {
      // activeIterationRecord() awaits ensureProject() internally, so getProjectDir()
      // below is guaranteed to have a resolved project by the time we reach it. Exporting the
      // *active* (not necessarily latest) iteration means a reverted project exports what's
      // actually on screen.
      const active = await projectStore.activeIterationRecord()
      const resolved = resolveExportSource(active, projectStore.getProjectDir(), request.format)
      if (!resolved.ok) return { saved: false, reason: resolved.reason }

      const filters =
        request.format === 'step'
          ? [{ name: 'STEP', extensions: ['step', 'stp'] }]
          : [{ name: 'STL', extensions: ['stl'] }]

      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogOptions = { defaultPath: resolved.fileName, filters }
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      if (canceled || !filePath) return { saved: false }

      try {
        await copyFile(resolved.absPath, filePath)
      } catch (err) {
        return {
          saved: false,
          reason: err instanceof Error ? `Could not save the file: ${err.message}` : 'Could not save the file.'
        }
      }

      return { saved: true, path: filePath }
    }
  )

  ipcMain.handle(IPC.setupGetStatus, async (): Promise<SetupStatus> => {
    // Return the current status immediately; preflight (re)runs in the
    // background and streams updates via `setup:progress`.
    void startPreflight()
    return cachedStatus
  })

  ipcMain.handle(IPC.setupRetry, async (): Promise<SetupStatus> => {
    preflightPromise = null
    return startPreflight()
  })

  ipcMain.handle(
    IPC.agentSendMessage,
    async (_event, request: SendMessageRequest): Promise<SendMessageResponse> => {
      // The renderer gates the input on setup state too; this is the
      // authoritative backstop (e.g. a message raced against a failing retry).
      const notReady = setupIncompleteReason()
      if (notReady) return { accepted: false, reason: notReady }

      return agentSession.sendMessage(request.text, request.selectionContext ?? null, request.attachments)
    }
  )

  ipcMain.handle(IPC.agentGetSettings, async (): Promise<AgentSettings> => projectStore.getAgentSettings())

  ipcMain.handle(IPC.agentSetSettings, async (_event, request: AgentSettings): Promise<AgentSettings> => {
    await projectStore.setAgentSettings(request)
    return request
  })

  ipcMain.handle(IPC.agentInterrupt, async (): Promise<void> => agentSession.interrupt())

  ipcMain.handle(
    IPC.agentPermissionRespond,
    async (_event, request: PermissionRespondRequest): Promise<PermissionRespondResponse> => {
      const resolve = pendingApprovals.get(request.requestId)
      if (!resolve) return { acknowledged: false }
      pendingApprovals.delete(request.requestId)
      resolve(request.allow)
      return { acknowledged: true }
    }
  )

  ipcMain.handle(IPC.projectList, async (): Promise<ProjectSummary[]> => projectStore.listProjects())

  ipcMain.handle(IPC.projectGetState, async (): Promise<ProjectStateSnapshot> => buildProjectSnapshot(projectStore))

  ipcMain.handle(
    IPC.projectCreate,
    async (_event, request: CreateProjectRequest): Promise<ProjectStateSnapshot> => {
      if (agentSession.isBusy()) {
        throw new Error('Voyager is still working — wait for it to finish before creating a new project.')
      }
      await projectStore.createProject(request.name)
      return buildProjectSnapshot(projectStore)
    }
  )

  ipcMain.handle(
    IPC.projectSwitch,
    async (_event, request: SwitchProjectRequest): Promise<ProjectStateSnapshot> => {
      if (agentSession.isBusy()) {
        throw new Error('Voyager is still working — wait for it to finish before switching projects.')
      }
      await projectStore.switchProject(request.id)
      return buildProjectSnapshot(projectStore)
    }
  )

  ipcMain.handle(
    IPC.projectRename,
    async (_event, request: RenameProjectRequest): Promise<ProjectSummary> =>
      projectStore.renameProject(request.id, request.name)
  )

  ipcMain.handle(
    IPC.projectListIterations,
    async (): Promise<IterationInfo[]> => (await projectStore.listIterations()).map(toIterationInfo)
  )

  ipcMain.handle(
    IPC.projectRevertTo,
    async (_event, request: RevertToRequest): Promise<ProjectStateSnapshot> => {
      if (agentSession.isBusy()) {
        throw new Error('Voyager is still working — wait for it to finish before reverting.')
      }
      await projectStore.revertTo(request.n)
      // Returning the full snapshot (rather than broadcasting model:displayed) mirrors
      // project:switch: the renderer that initiated the revert calls hydrateProject() + syncModel()
      // with this response, and there's exactly one active window's viewport to update.
      return buildProjectSnapshot(projectStore)
    }
  )

  // -- WS-A Design Brief ---------------------------------------------------

  ipcMain.handle(IPC.briefGet, async (): Promise<DesignBrief> => {
    await projectStore.ensureProject()
    return briefStore.get(projectStore.getProjectDir())
  })

  ipcMain.handle(
    IPC.briefUpdate,
    async (_event, request: BriefUpdateRequest): Promise<BriefUpdateResponse> => {
      await projectStore.ensureProject()
      const brief = await briefStore.replace(projectStore.getProjectDir(), request.brief)
      broadcast(IPC.briefUpdated, brief)
      return { brief }
    }
  )

  ipcMain.handle(IPC.briefLock, async (): Promise<BriefLockResponse> => {
    await projectStore.ensureProject()
    // Throws (surfaced to the renderer as a rejected promise) when the brief is missing required
    // fields - "completeness gates generation, not form-filling" (product doc §4.4). The brief
    // panel disables its Lock button before this can happen in the normal flow; this is the
    // authoritative backstop.
    const brief = await briefStore.lock(projectStore.getProjectDir())
    broadcast(IPC.briefUpdated, brief)
    return { brief }
  })

  // -- WS-B Parameter panel (venv re-run, no agent turn) ------------------

  ipcMain.handle(
    IPC.paramUpdate,
    async (_event, request: ParamUpdateRequest): Promise<ParamUpdateResponse> => {
      // Both the agent and a param edit call `recordIteration` - serializing them avoids two
      // writers racing on project.json (and, worse, an agent turn overwriting the model the user
      // is mid-way through tweaking with a slider).
      if (agentSession.isBusy()) {
        return {
          accepted: false,
          reason: 'Voyager is still working — wait for it to finish before editing a parameter.'
        }
      }

      const active = await projectStore.activeIterationRecord()
      if (!active) return { accepted: false, reason: 'No model has been generated yet.' }

      const manifest = await readManifestForIteration(projectStore.getProjectDir(), active)
      const validation = validateParamUpdate(manifest, request.name, request.value)
      if (!validation.ok) return { accepted: false, reason: validation.reason }
      if (!manifest) return { accepted: false, reason: 'No parameters are available for this iteration.' }

      const result = await rerunWithParam(
        {
          projectDir: projectStore.getProjectDir(),
          scriptRelPath: active.scriptSnapshotPath ?? active.scriptPath,
          name: request.name,
          value: request.value,
          manifest
        },
        { pythonPath: envManager.pythonPath() }
      )
      if (!result.ok) return { accepted: false, reason: result.reason }

      const entry = manifest.params.find((p) => p.name === request.name)
      const summary = entry
        ? `${entry.label}: ${request.value} ${entry.unit}`
        : `${request.name}: ${request.value}`

      const iteration = await projectStore.recordIteration({
        stlPath: result.stlRelPath,
        stepPath: result.stepRelPath,
        scriptPath: result.scriptRelPath,
        summary
      })

      const buffer = await readFile(join(projectStore.getProjectDir(), iteration.stlPath))
      const payload: ModelDisplayedPayload = {
        stlPath: iteration.stlPath,
        stepPath: iteration.stepPath,
        scriptPath: iteration.scriptPath,
        summary: iteration.summary,
        iteration: iteration.n,
        stlBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      }
      // Pushed the same way an agent-authored `display_model` call is, so the viewport/version
      // history update identically either path - see `ParamUpdateResponse`'s doc comment.
      broadcast(IPC.modelDisplayed, payload)
      return { accepted: true, model: payload }
    }
  )

  ipcMain.handle(IPC.paramGetManifest, async (): Promise<ParamGetManifestResponse> => {
    const active = await projectStore.activeIterationRecord()
    if (!active) return { manifest: null }
    return { manifest: await readManifestForIteration(projectStore.getProjectDir(), active) }
  })

  // -- WS-C Verification (stub - no verify pipeline wired up yet) ---------

  ipcMain.handle(IPC.verificationGet, async (): Promise<VerificationGetResponse> => ({ report: null }))

  // -- WS-E Printer profiles (stub - no persisted store yet) --------------

  ipcMain.handle(
    IPC.printerProfileList,
    async (): Promise<PrinterProfileListResponse> => ({ profiles: [], activeId: null })
  )

  ipcMain.handle(
    IPC.printerProfileSave,
    async (_event, _request: PrinterProfileSaveRequest): Promise<PrinterProfileListResponse> => ({
      profiles: [],
      activeId: null
    })
  )

  ipcMain.handle(
    IPC.printerProfileSetActive,
    async (_event, _request: PrinterProfileSetActiveRequest): Promise<PrinterProfileListResponse> => ({
      profiles: [],
      activeId: null
    })
  )

  // -- WS-F Graduation package export (stub - no package builder yet) ----

  ipcMain.handle(
    IPC.modelExportPackage,
    async (_event, _request: ExportPackageRequest): Promise<ExportPackageResponse> => ({
      saved: false,
      reason: 'Package export is not implemented yet.'
    })
  )
}
