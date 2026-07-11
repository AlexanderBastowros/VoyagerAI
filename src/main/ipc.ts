import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  AgentEvent,
  AgentSettings,
  BriefListVersionsResponse,
  BriefLockResponse,
  BriefUpdateRequest,
  BriefUpdateResponse,
  CreateProjectRequest,
  DesignBrief,
  ExportModelRequest,
  ExportModelResponse,
  ExportPackageRequest,
  ExportPackageResponse,
  ImportModelRequest,
  ImportModelResponse,
  IterationInfo,
  ModelDisplayedPayload,
  ParamGetManifestResponse,
  ParamUpdateRequest,
  ParamUpdateResponse,
  PartDuplicateRequest,
  PartGetModelRequest,
  PartListResponse,
  PartSetActiveRequest,
  PartSetPlacementRequest,
  PartSetVisibilityRequest,
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
  ScriptManifest,
  SendMessageRequest,
  SendMessageResponse,
  SetupStatus,
  SwitchProjectRequest,
  VerificationGetResponse,
  VerificationReport
} from '../shared/ipc'
import {
  AgentSession,
  BriefStore,
  ClaudeChecker,
  copyImportSource,
  detectImportFormat,
  EnvManager,
  finalizeMeshImport,
  finalizeStepImport,
  isUnitlessFormat,
  measureMeshImport,
  pickUnitConfirmationAxis,
  PrinterProfileStore,
  ProjectStore,
  buildGraduationPackage,
  buildPlateStl,
  containedAbsPath,
  deriveThreeMfPath,
  readManifestForIteration,
  rerunWithParam,
  resolveAllPartsExportSources,
  resolveExportSource,
  runPreflight,
  slugifyForFilename,
  slugifyZipBase,
  validateParamUpdate,
  writeZip
} from '@voyager/agent-core'
import type {
  PackageFsDeps,
  PackagePartInput,
  PartExportSource,
  PlatePart,
  ProjectIteration,
  ZipEntry
} from '@voyager/agent-core'
import { readVerificationForIteration, runVerification, writeVerificationForIteration } from '@voyager/verify'

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

/** Absolute paths to `packages/verify`'s WS-C layer scripts - same dev/packaged resolution as
 *  `verifyScriptPath()`, since electron-builder's existing `verify` extraResources entry already
 *  copies the whole `packages/verify/python` directory. */
function staticCheckScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'verify', 'static_check.py')
    : join(__dirname, '../../packages/verify/python/static_check.py')
}

function geometryReportScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'verify', 'geometry_report.py')
    : join(__dirname, '../../packages/verify/python/geometry_report.py')
}

function conformanceCheckScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'verify', 'conformance_check.py')
    : join(__dirname, '../../packages/verify/python/conformance_check.py')
}

/** Absolute path to `packages/agent-core/remix`'s bundled `measure_mesh.py` (WS-G) - same
 *  dev/packaged resolution as `verifyScriptPath()`, mirroring the `remix` `extraResources` entry
 *  in `electron-builder.yml`. The only remix script `importModel.ts` invokes directly - mesh
 *  finalize/repair and the STEP import path run a self-contained generated script instead (see
 *  `importModel.ts`'s module doc comment for why). */
function measureMeshScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'remix', 'measure_mesh.py')
    : join(__dirname, '../../packages/agent-core/remix/measure_mesh.py')
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
 * A mesh import (STL/OBJ) awaiting the user's unit confirmation - the second `model:import` call
 * (with `unitScaleMm` set) resumes from here rather than re-deriving anything from the request,
 * since `ImportModelResponse.needsUnitConfirmation` carries only the measured dimension, not the
 * import's identity (see `ImportModelRequest`'s doc comment in `src/shared/ipc.ts`). Keyed by
 * project id so a project switch mid-confirmation can't resume into the wrong project; at most one
 * import is ever pending per project (a second `filePath` call before confirming just overwrites
 * it, leaving the earlier copy under `imports/` as harmless, unreferenced debris - the same
 * never-cleaned-up-scratch tolerance `params/rerun.ts`'s `outputs/param-edits/<uuid>/` dirs have).
 */
interface PendingMeshImport {
  partId: string
  importRelPath: string
  sourceBaseName: string
  measuredMm: number
}
const pendingMeshImports = new Map<string, PendingMeshImport>()

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
function toIterationInfo(iteration: ProjectIteration): IterationInfo {
  return {
    n: iteration.n,
    summary: iteration.summary,
    at: iteration.at,
    hasStep: Boolean(iteration.stepPath),
    createdBy: iteration.createdBy
  }
}

/**
 * Probes whether a 3MF was actually produced for the iteration that recorded `stlPath`, at the
 * conventional sibling path `deriveThreeMfPath` computes - SKILL.md's Phase 4 currently only
 * "offers" 3MF on request rather than always producing it (a contract-change request for that is
 * filed in the roadmap), so it's absent more often than not. `resolveExportSource`/
 * `resolveAllPartsExportSources` stay pure (no filesystem I/O), so this real `stat` call lives
 * here - applying the same containment guard those functions use before ever touching disk.
 */
async function resolveThreeMfPath(projectDir: string, stlPath: string): Promise<string | undefined> {
  const candidate = deriveThreeMfPath(stlPath)
  const abs = containedAbsPath(projectDir, candidate)
  if (!abs) return undefined
  try {
    await stat(abs)
    return candidate
  } catch {
    return undefined
  }
}

/**
 * Reads everything the renderer needs to hydrate a project on mount, create, switch, or revert:
 * its summary list, full chat history, model/effort settings, the version-history list (R4), and
 * (if any iteration exists) the *active* iteration's `model` metadata. The geometry itself is loaded
 * per-part by the renderer via `part.getModel` (WS-I `syncViewportParts`), so `model.stlBuffer` here
 * is intentionally empty - it's used only for presence + metadata. The version history reflects the
 * active part; `activeIterationRecord()` (not `latestIteration()`) honors a prior `revertTo()`.
 */
async function buildProjectSnapshot(projectStore: ProjectStore): Promise<ProjectStateSnapshot> {
  const [projects, messages, agentSettings, active, iterations] = await Promise.all([
    projectStore.listProjects(),
    projectStore.getChatHistory(),
    projectStore.getAgentSettings(),
    projectStore.activeIterationRecord(),
    projectStore.listIterations()
  ])

  // WS-I: the renderer loads each part's geometry on demand via `part.getModel` (see
  // `syncViewportParts`), and only uses this `model` for its metadata + presence (`toModelInfo`
  // never reads the bytes). So skip reading + structured-cloning the STL here - it was a redundant
  // multi-MB read on every getState/switch/create/revert. Hand back an empty buffer, tagged with the
  // active part.
  let model: ModelDisplayedPayload | null = null
  if (active) {
    model = {
      stlPath: active.stlPath,
      stepPath: active.stepPath,
      scriptPath: active.scriptPath,
      summary: active.summary,
      iteration: active.n,
      stlBuffer: new ArrayBuffer(0),
      partId: await projectStore.getActivePartId(),
      createdBy: active.createdBy
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
 * In-memory stub for the WS-F contract landed by WS-0b (WS-A's brief handlers, WS-B's
 * parameter handlers, WS-C's verification handlers, and WS-E's printer-profile handlers below
 * are all real). It isn't persisted or per-project - the real work order (see
 * `agents/production-roadmap.md`) replaces its stub with durable state without needing to touch
 * this file again, since the IPC shapes are already final.
 */

/** Registers all main-process IPC handlers. */
export function registerIpcHandlers(): void {
  const envManager = new EnvManager({
    baseDir: join(app.getPath('userData'), 'pyenv'),
    binDir: join(app.getPath('userData'), 'bin'),
    smokeTestScriptPath: resourcePath('python', 'smoke_test.py')
  })

  const claudeChecker = new ClaudeChecker()

  const briefStore = new BriefStore()

  // App-level (not per-project) user settings - product doc §4.4: bed/nozzle/materials are
  // settings, not per-project questions. Persisted at `<userData>/printer-profiles.json`.
  const printerProfileStore = new PrinterProfileStore({ baseDir: app.getPath('userData') })

  /**
   * Recomputes verification layers 1-3 (WS-C) for one iteration and persists the report beside
   * its STL (`writeVerificationForIteration`). Two call sites feed this: `ProjectStore`'s
   * `onIterationRecorded` hook below (every recorded iteration, agent- or param-panel-authored -
   * see `recordIteration()`'s doc comment) and `AgentSession`'s `runVerification` dep (the
   * on-demand `run_verification` MCP tool, which already knows the active iteration).
   */
  async function verifyIteration(iteration: ProjectIteration, projectDir: string): Promise<VerificationReport> {
    const brief = await briefStore.get(projectDir)
    // Layer 2's bed-fit and nozzle-scaled checks read `brief.printer`; a brief that never
    // recorded a printer falls back to the app-level active profile (WS-E - "verification layer 2
    // reads them"). Merged only into this run's input, never persisted onto the brief.
    const activeProfile = brief.printer ? null : await printerProfileStore.getActive()
    const report = await runVerification({
      iteration: iteration.n,
      pythonPath: envManager.pythonPath(),
      staticCheckScriptPath: staticCheckScriptPath(),
      geometryReportScriptPath: geometryReportScriptPath(),
      conformanceCheckScriptPath: conformanceCheckScriptPath(),
      extractParamsScriptPath: extractParamsScriptPath(),
      scriptPath: join(projectDir, iteration.scriptSnapshotPath ?? iteration.scriptPath),
      stlPath: join(projectDir, iteration.stlPath),
      stepPath: iteration.stepPath ? join(projectDir, iteration.stepPath) : undefined,
      brief: activeProfile ? { ...brief, printer: activeProfile } : brief
    })
    await writeVerificationForIteration(projectDir, iteration, report)
    return report
  }

  const projectStore = new ProjectStore({
    baseDir: join(app.getPath('userData'), 'projects'),
    skillSourceDir: resourcePath('skills', 'printable-cad'),
    verifyScriptPath: verifyScriptPath(),
    extractParamsScriptPath: extractParamsScriptPath(),
    // Fire-and-forget: a slow or failing verification run must never block or fail the display
    // path (see `ProjectStoreOptions.onIterationRecorded`'s doc comment).
    onIterationRecorded: (iteration, projectDir) => {
      void verifyIteration(iteration, projectDir)
        .then((report) => broadcast(IPC.verificationUpdated, report))
        .catch((err) => {
          console.error('Verification failed for iteration', iteration.n, err)
        })
    }
  })

  const agentSession = new AgentSession({
    projectStore,
    briefStore,
    runVerification: (iteration) => verifyIteration(iteration, projectStore.getProjectDir()),
    printerProfiles: printerProfileStore,
    pythonPath: () => envManager.pythonPath(),
    claudeCliPath: () => claudeChecker.cliPath(),
    emitAgentEvent: (event: AgentEvent) => broadcast(IPC.agentEvent, event),
    emitModelDisplayed: (payload: ModelDisplayedPayload) => broadcast(IPC.modelDisplayed, payload),
    emitPrintSettings: (payload: PrintSettings) => broadcast(IPC.printSettingsUpdated, payload),
    emitBriefUpdated: (payload: DesignBrief) => broadcast(IPC.briefUpdated, payload),
    emitVerificationUpdated: (payload: VerificationReport) => broadcast(IPC.verificationUpdated, payload),
    emitPrinterProfilesUpdated: (payload: PrinterProfileListResponse) => broadcast(IPC.printerProfileUpdated, payload),
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
      const { format, partId } = request
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      async function promptSavePath(defaultPath: string, filters: Electron.FileFilter[]): Promise<string | null> {
        const dialogOptions = { defaultPath, filters }
        const { canceled, filePath } = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)
        return canceled || !filePath ? null : filePath
      }

      // listParts() awaits ensureProject() internally, so getProjectDir()/getActiveProjectId()
      // below are guaranteed to have a resolved project. Exporting *active* (not necessarily
      // latest) iterations means a reverted project exports what's actually on screen.
      const parts = await projectStore.listParts()
      const projectDir = projectStore.getProjectDir()
      const activeProjectId = projectStore.getActiveProjectId()

      if (format === 'package') {
        return {
          saved: false,
          reason: 'Use "Export package" instead - graduation packages have their own export.'
        }
      }

      if (format === 'plate') {
        // Bakes every VISIBLE part's current placement into one merged STL, matching the
        // viewport arrangement (§14/WS-F) - spans every part, so `partId` is ignored.
        const plateParts: PlatePart[] = []
        const skippedParts: string[] = []
        for (const part of parts) {
          if (!part.visible) {
            skippedParts.push(part.name)
            continue
          }
          const iteration = await projectStore.activeIterationRecord(part.id)
          if (!iteration) {
            skippedParts.push(part.name)
            continue
          }
          const abs = containedAbsPath(projectDir, iteration.stlPath)
          if (!abs) {
            return {
              saved: false,
              reason: `The recorded STL path for part "${part.name}" resolves outside the project directory and was rejected.`
            }
          }
          plateParts.push({ name: part.name, stlBuffer: await readFile(abs), placement: part.placement })
        }
        // Every await above yields the event loop - mirrors the all-parts zip branch below's
        // concurrent-project-switch guard, since a plate mixing one project's STL bytes with
        // another's placements would be silently wrong rather than just stale.
        if (projectStore.getActiveProjectId() !== activeProjectId) {
          return { saved: false, reason: 'The active project changed while exporting - try again.' }
        }

        const built = buildPlateStl(plateParts)
        if (!built.ok) return { saved: false, reason: built.reason }

        const projectName = (await projectStore.listProjects()).find((p) => p.id === activeProjectId)?.name
        const defaultName = `${slugifyZipBase(projectName ?? '') || 'plate'}-plate.stl`
        const filePath = await promptSavePath(defaultName, [{ name: 'STL', extensions: ['stl'] }])
        if (!filePath) return { saved: false }

        try {
          await writeFile(filePath, built.stlBuffer)
        } catch (err) {
          return {
            saved: false,
            reason: err instanceof Error ? `Could not save the file: ${err.message}` : 'Could not save the file.'
          }
        }

        return {
          saved: true,
          path: filePath,
          ...(skippedParts.length > 0 ? { skippedParts } : {})
        }
      }

      // A stale/typo'd part id gets a precise error (matching setActivePart/setVisibility)
      // instead of resolving as "part with no iterations" -> "No model has been generated yet."
      if (partId && !parts.some((p) => p.id === partId)) {
        return { saved: false, reason: `Unknown part: ${partId}` }
      }

      // Multi-part project with no explicit part: every part's active iteration as separate
      // files in one zip - never a silent merge (§14/WS-F).
      if (!partId && parts.length > 1) {
        const sources: PartExportSource[] = []
        for (const part of parts) {
          const iteration = await projectStore.activeIterationRecord(part.id)
          const threeMfPath =
            format === '3mf' && iteration ? await resolveThreeMfPath(projectDir, iteration.stlPath) : undefined
          sources.push({ id: part.id, name: part.name, iteration: iteration ? { ...iteration, threeMfPath } : null })
        }
        const projectName = (await projectStore.listProjects()).find((p) => p.id === activeProjectId)?.name
        // Every await above yields the event loop, so a concurrent `project:switch` may have
        // repointed the store mid-assembly - the part list/iterations would then belong to the
        // old project while `projectDir` paths resolve into the new one. Bail rather than mix.
        if (projectStore.getActiveProjectId() !== activeProjectId) {
          return { saved: false, reason: 'The active project changed while exporting - try again.' }
        }
        const resolved = resolveAllPartsExportSources(sources, projectDir, format, projectName)
        if (!resolved.ok) return { saved: false, reason: resolved.reason }

        const filePath = await promptSavePath(resolved.zipFileName, [{ name: 'ZIP archive', extensions: ['zip'] }])
        if (!filePath) return { saved: false }

        try {
          const entries: ZipEntry[] = []
          for (const entry of resolved.entries) {
            entries.push({ name: entry.entryName, data: await readFile(entry.absPath) })
          }
          await writeFile(filePath, writeZip(entries, new Date()))
        } catch (err) {
          return {
            saved: false,
            reason: err instanceof Error ? `Could not save the file: ${err.message}` : 'Could not save the file.'
          }
        }

        return {
          saved: true,
          path: filePath,
          ...(resolved.skippedParts.length > 0 ? { skippedParts: resolved.skippedParts } : {})
        }
      }

      // Single-file path: the requested part's active iteration (or the active part's when
      // no partId is given - a single-part project always lands here).
      const active = await projectStore.activeIterationRecord(partId)
      const threeMfPath = format === '3mf' && active ? await resolveThreeMfPath(projectDir, active.stlPath) : undefined
      const resolved = resolveExportSource(active ? { ...active, threeMfPath } : null, projectDir, format)
      if (!resolved.ok) return { saved: false, reason: resolved.reason }

      const filters =
        format === 'step'
          ? [{ name: 'STEP', extensions: ['step', 'stp'] }]
          : format === '3mf'
            ? [{ name: '3MF', extensions: ['3mf'] }]
            : [{ name: 'STL', extensions: ['stl'] }]

      const filePath = await promptSavePath(resolved.fileName, filters)
      if (!filePath) return { saved: false }

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

  // WS-0c: satisfies WS-A's queued `brief:listVersions` request - `BriefStore.listVersions`
  // already reads every locked snapshot; this exposes it so `BriefPanel` can browse history.
  ipcMain.handle(IPC.briefListVersions, async (): Promise<BriefListVersionsResponse> => {
    await projectStore.ensureProject()
    return { versions: await briefStore.listVersions(projectStore.getProjectDir()) }
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
        summary,
        createdBy: 'param'
      })

      // A param edit re-runs the *active* part's script (`recordIteration` with no partId), so tag
      // the payload with that part (WS-I) - otherwise the renderer's `partId ?? 'main'` fallback
      // would load the re-run geometry into the wrong part when the active part isn't `main`.
      const partId = await projectStore.getActivePartId()
      const buffer = await readFile(join(projectStore.getProjectDir(), iteration.stlPath))
      const payload: ModelDisplayedPayload = {
        stlPath: iteration.stlPath,
        stepPath: iteration.stepPath,
        scriptPath: iteration.scriptPath,
        summary: iteration.summary,
        iteration: iteration.n,
        stlBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        partId,
        createdBy: 'param'
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

  // -- WS-C Verification ---------------------------------------------------

  ipcMain.handle(IPC.verificationGet, async (): Promise<VerificationGetResponse> => {
    const active = await projectStore.activeIterationRecord()
    if (!active) return { report: null }
    return { report: await readVerificationForIteration(projectStore.getProjectDir(), active) }
  })

  // -- WS-E Printer profiles ------------------------------------------------
  // App-level (see printerProfileStore above), so unlike the project-mutating handlers these
  // don't need the isBusy() gate - the agent only ever reads profiles (at query start) or writes
  // through the same serialized store. Mutations broadcast printerProfile:updated so every
  // window's panel stays in sync (the agent's save_printer_profile tool broadcasts via the
  // emitPrinterProfilesUpdated dep above).

  ipcMain.handle(
    IPC.printerProfileList,
    async (): Promise<PrinterProfileListResponse> => printerProfileStore.list()
  )

  ipcMain.handle(
    IPC.printerProfileSave,
    async (_event, request: PrinterProfileSaveRequest): Promise<PrinterProfileListResponse> => {
      const response = await printerProfileStore.save(request.profile)
      broadcast(IPC.printerProfileUpdated, response)
      return response
    }
  )

  ipcMain.handle(
    IPC.printerProfileSetActive,
    async (_event, request: PrinterProfileSetActiveRequest): Promise<PrinterProfileListResponse> => {
      const response = await printerProfileStore.setActive(request.id)
      broadcast(IPC.printerProfileUpdated, response)
      return response
    }
  )

  // -- WS-F Graduation package export --------------------------------------
  // Replaces the WS-0b stub at this designated stub-replacement point - the `IPC.modelExportPackage`
  // channel wiring above is unchanged.

  ipcMain.handle(
    IPC.modelExportPackage,
    async (event, request: ExportPackageRequest): Promise<ExportPackageResponse> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const parts = await projectStore.listParts()
      const projectDir = projectStore.getProjectDir()
      const activeProjectId = projectStore.getActiveProjectId()

      // A stale/typo'd part id gets a precise error, matching `model:export`'s convention.
      if (request.partId && !parts.some((p) => p.id === request.partId)) {
        return { saved: false, reason: `Unknown part: ${request.partId}` }
      }
      // Iteration numbers are per-part - an explicit iteration with no part to scope it to is
      // ambiguous across a multi-part project rather than silently picking one.
      if (request.iteration !== undefined && !request.partId) {
        return { saved: false, reason: 'An iteration number requires a specific part - pass partId too.' }
      }

      const scoped = request.partId ? parts.filter((p) => p.id === request.partId) : parts

      const packageParts: PackagePartInput[] = []
      const manifests: Record<string, ScriptManifest | null> = {}
      for (const part of scoped) {
        let iteration: ProjectIteration | null
        if (request.partId && request.iteration !== undefined) {
          const history = await projectStore.listIterations(part.id)
          iteration = history.find((it) => it.n === request.iteration) ?? null
          if (!iteration) {
            return { saved: false, reason: `Unknown iteration: v${request.iteration}` }
          }
        } else {
          iteration = await projectStore.activeIterationRecord(part.id)
        }
        // No model yet for this part - left out of the bundle (format-honesty degrade, mirrors
        // `resolveAllPartsExportSources`' `skippedParts`); `buildGraduationPackage` itself fails
        // if this leaves every part out.
        if (!iteration) continue

        packageParts.push({
          id: part.id,
          name: part.name,
          iteration: {
            n: iteration.n,
            stlPath: iteration.stlPath,
            stepPath: iteration.stepPath,
            scriptPath: iteration.scriptPath,
            scriptSnapshotPath: iteration.scriptSnapshotPath,
            briefVersion: iteration.briefVersion
          }
        })
        manifests[part.id] = await readManifestForIteration(projectDir, iteration)
      }

      // Every await above yields the event loop - the same concurrent-project-switch guard
      // `model:export`'s branches use, since mixing one project's artifacts with another's brief/
      // manifests would be silently wrong.
      if (projectStore.getActiveProjectId() !== activeProjectId) {
        return { saved: false, reason: 'The active project changed while exporting - try again.' }
      }

      // The package always bundles the project's *currently* locked brief (a project-level
      // artifact), not a per-iteration lookup - see `BuildGraduationPackageInput.lockedBrief`'s
      // doc comment. Omitted entirely if the project has never locked one.
      const brief = await briefStore.get(projectDir)
      const lockedBrief = brief.lockedAt
        ? { version: brief.version, json: JSON.stringify(brief, null, 2) }
        : undefined

      const projectName =
        (await projectStore.listProjects()).find((p) => p.id === activeProjectId)?.name ?? 'Voyager project'

      const fsDeps: PackageFsDeps = {
        readFile: (absPath) => readFile(absPath),
        fileExists: (absPath) => stat(absPath).then(() => true, () => false)
      }

      const result = await buildGraduationPackage(
        { projectDir, projectName, parts: packageParts, lockedBrief, manifests },
        fsDeps
      )
      if (!result.ok) return { saved: false, reason: result.reason }

      const dialogOptions = {
        defaultPath: result.zipFileName,
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
      }
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      if (canceled || !filePath) return { saved: false }

      try {
        await writeFile(filePath, result.zipBuffer)
      } catch (err) {
        return {
          saved: false,
          reason: err instanceof Error ? `Could not save the file: ${err.message}` : 'Could not save the file.'
        }
      }

      return { saved: true, path: filePath }
    }
  )

  // -- WS-G External model import & remix ----------------------------------
  // Two-phase for unitless mesh formats (STL/OBJ): the first call (no `unitScaleMm`) copies +
  // measures and, for STL/OBJ, returns `needsUnitConfirmation` instead of finalizing; the second
  // call (`unitScaleMm` set) resumes from `pendingMeshImports` and finalizes. STEP and 3MF already
  // carry real-world units and finalize on the first call. See `ImportModelRequest`'s doc comment
  // in `src/shared/ipc.ts` and `importModel.ts`'s module doc comment for the full design.

  ipcMain.handle(
    IPC.modelImport,
    async (event, request: ImportModelRequest): Promise<ImportModelResponse> => {
      // Mirrors the other project-mutating handlers (param:update, part:setPlacement, ...): an
      // import records a new iteration, so it must not race an in-flight agent turn.
      if (agentSession.isBusy()) {
        return { imported: false, reason: 'Voyager is still working — wait for it to finish before importing a model.' }
      }

      await projectStore.ensureProject()
      const projectDir = projectStore.getProjectDir()
      const projectId = projectStore.getActiveProjectId()
      const importDeps = { pythonPath: envManager.pythonPath(), measureMeshScriptPath: measureMeshScriptPath() }

      /** Records a finalized import as a new iteration and pushes it exactly like any other
       *  displayed model (`param:update`'s handler above does the same broadcast shape). */
      async function recordAndBroadcast(
        partId: string,
        result: { scriptRelPath: string; stlRelPath: string; stepRelPath?: string; summary: string }
      ): Promise<ImportModelResponse> {
        const iteration = await projectStore.recordIteration({
          stlPath: result.stlRelPath,
          stepPath: result.stepRelPath,
          scriptPath: result.scriptRelPath,
          summary: result.summary,
          createdBy: 'import',
          partId
        })
        const buffer = await readFile(join(projectDir, iteration.stlPath))
        const payload: ModelDisplayedPayload = {
          stlPath: iteration.stlPath,
          stepPath: iteration.stepPath,
          scriptPath: iteration.scriptPath,
          summary: iteration.summary,
          iteration: iteration.n,
          stlBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          partId,
          createdBy: 'import'
        }
        broadcast(IPC.modelDisplayed, payload)
        return { imported: true, model: payload }
      }

      // Phase 2: a mesh import awaiting the user's confirmed real-world scale.
      if (request.unitScaleMm !== undefined) {
        const pending = pendingMeshImports.get(projectId)
        if (!pending) {
          return { imported: false, reason: 'No import is awaiting a scale confirmation — pick the file again.' }
        }
        pendingMeshImports.delete(projectId)

        const nextN = ((await projectStore.latestIteration(pending.partId))?.n ?? 0) + 1
        const result = await finalizeMeshImport(importDeps, {
          projectDir,
          importRelPath: pending.importRelPath,
          partId: pending.partId,
          nextN,
          scaleFactor: request.unitScaleMm / pending.measuredMm,
          sourceBaseName: pending.sourceBaseName
        })
        if (!result.ok) return { imported: false, reason: result.reason }
        return recordAndBroadcast(pending.partId, result)
      }

      // Phase 1: resolve the source path (native picker if omitted), copy it into imports/.
      let sourcePath = request.filePath
      if (!sourcePath) {
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
        const dialogOptions: Electron.OpenDialogOptions = {
          filters: [{ name: 'Model files', extensions: ['step', 'stp', 'stl', 'obj', '3mf'] }],
          properties: ['openFile']
        }
        const picked = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
        if (picked.canceled || picked.filePaths.length === 0) return { imported: false }
        sourcePath = picked.filePaths[0]
      }

      const format = detectImportFormat(sourcePath)
      if (!format) {
        return { imported: false, reason: 'Unsupported file type — import a STEP, STL, OBJ, or 3MF file.' }
      }

      const copyResult = await copyImportSource(projectDir, sourcePath, format)
      if (!copyResult.ok) return { imported: false, reason: copyResult.reason }

      const partId = request.partId ? slugifyForFilename(request.partId) : await projectStore.getActivePartId()
      const sourceBaseName = basename(sourcePath)
      const nextN = ((await projectStore.latestIteration(partId))?.n ?? 0) + 1

      if (format === 'step') {
        const result = await finalizeStepImport(importDeps, {
          projectDir,
          importRelPath: copyResult.importRelPath,
          partId,
          nextN,
          sourceBaseName
        })
        if (!result.ok) return { imported: false, reason: result.reason }
        return recordAndBroadcast(partId, result)
      }

      if (!isUnitlessFormat(format)) {
        // 3MF already carries real-world units - finalize immediately (scaleFactor 1).
        const result = await finalizeMeshImport(importDeps, {
          projectDir,
          importRelPath: copyResult.importRelPath,
          partId,
          nextN,
          scaleFactor: 1,
          sourceBaseName
        })
        if (!result.ok) return { imported: false, reason: result.reason }
        return recordAndBroadcast(partId, result)
      }

      // STL/OBJ: unitless - measure and ask the user to confirm/correct one dimension before
      // finalizing (the skill's never-guess-scale rule, enforced at the door - product doc §5.6).
      const measured = await measureMeshImport(importDeps, projectDir, copyResult.importRelPath)
      if (!measured.ok) return { imported: false, reason: measured.reason }

      const { axis, measuredMm } = pickUnitConfirmationAxis(measured.measurement.bboxMm)
      pendingMeshImports.set(projectId, { partId, importRelPath: copyResult.importRelPath, sourceBaseName, measuredMm })
      return { imported: false, needsUnitConfirmation: { measuredMm, axis } }
    }
  )

  // -- WS-I Multi-part projects ------------------------------------------
  // Real ProjectStore-backed parts logic (replacing WS-0c's stubs at the designated
  // stub-replacement points, the same pattern WS-B/WS-C used, without touching the frozen channel
  // wiring above). The write handlers gate on `agentSession.isBusy()` like the other
  // project-mutating handlers - two writers racing on project.json (a placement edit vs. an agent
  // `display_model`) could otherwise clobber each other.

  async function currentPartList(): Promise<PartListResponse> {
    return { parts: await projectStore.listParts(), activePartId: await projectStore.getActivePartId() }
  }

  ipcMain.handle(IPC.partList, async (): Promise<PartListResponse> => {
    await projectStore.ensureProject()
    return currentPartList()
  })

  // Loads one part's active-iteration model (with STL bytes) so the viewer can render every visible
  // part, each at its placement. Same ArrayBuffer-slice as `buildProjectSnapshot`/`modelLoadSample`.
  ipcMain.handle(
    IPC.partGetModel,
    async (_event, request: PartGetModelRequest): Promise<ModelDisplayedPayload | null> => {
      const active = await projectStore.activeIterationRecord(request.partId)
      if (!active) return null
      const buffer = await readFile(join(projectStore.getProjectDir(), active.stlPath))
      return {
        stlPath: active.stlPath,
        stepPath: active.stepPath,
        scriptPath: active.scriptPath,
        summary: active.summary,
        iteration: active.n,
        stlBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        partId: request.partId,
        createdBy: active.createdBy
      }
    }
  )

  ipcMain.handle(
    IPC.partSetPlacement,
    async (_event, request: PartSetPlacementRequest): Promise<PartListResponse> => {
      if (agentSession.isBusy()) {
        throw new Error('Voyager is still working — wait for it to finish before rearranging parts.')
      }
      const parts = await projectStore.setPlacement(request.partId, request.placement)
      const response: PartListResponse = { parts, activePartId: await projectStore.getActivePartId() }
      broadcast(IPC.partUpdated, response)
      return response
    }
  )

  ipcMain.handle(
    IPC.partSetVisibility,
    async (_event, request: PartSetVisibilityRequest): Promise<PartListResponse> => {
      if (agentSession.isBusy()) {
        throw new Error('Voyager is still working — wait for it to finish before changing part visibility.')
      }
      const parts = await projectStore.setVisibility(request.partId, request.visible)
      const response: PartListResponse = { parts, activePartId: await projectStore.getActivePartId() }
      broadcast(IPC.partUpdated, response)
      return response
    }
  )

  ipcMain.handle(
    IPC.partSetActive,
    async (_event, request: PartSetActiveRequest): Promise<PartListResponse> => {
      if (agentSession.isBusy()) {
        throw new Error('Voyager is still working — wait for it to finish before switching parts.')
      }
      const parts = await projectStore.setActivePart(request.partId)
      const response: PartListResponse = { parts, activePartId: request.partId }
      broadcast(IPC.partUpdated, response)
      return response
    }
  )

  ipcMain.handle(
    IPC.partDuplicate,
    async (_event, request: PartDuplicateRequest): Promise<PartListResponse> => {
      if (agentSession.isBusy()) {
        throw new Error('Voyager is still working — wait for it to finish before duplicating parts.')
      }
      const parts = await projectStore.duplicatePart(request.partId)
      const response: PartListResponse = { parts, activePartId: await projectStore.getActivePartId() }
      broadcast(IPC.partUpdated, response)
      return response
    }
  )
}
