import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { SendMessageRequest, SendMessageResponse, SetupCheck, SetupStatus } from '../shared/ipc'
import { EnvManager } from './python/envManager'
import { runPreflight } from './setup/preflight'

/**
 * Resolves a path under the app's `resources/` directory, in both dev (where
 * it lives at the project root) and packaged builds (where electron-builder's
 * `extraResources` config copies it under `process.resourcesPath`).
 */
function resourcePath(...segments: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  return join(base, ...segments)
}

const UNIMPLEMENTED_CHECK: SetupCheck = {
  state: 'unchecked',
  detail: 'Not implemented yet'
}

/**
 * Registers all main-process IPC handlers. `model:loadSample` and the
 * `setup:*` channels (pythonEnv check) are fully implemented; `claudeCli` /
 * `claudeAuth` checks and `agent:sendMessage` return clearly-marked
 * placeholder data until Milestone 3.
 */
export function registerIpcHandlers(): void {
  const envManager = new EnvManager({
    baseDir: join(app.getPath('userData'), 'pyenv'),
    binDir: join(app.getPath('userData'), 'bin'),
    smokeTestScriptPath: resourcePath('python', 'smoke_test.py')
  })

  let cachedStatus: SetupStatus = {
    claudeCli: { ...UNIMPLEMENTED_CHECK, detail: 'Claude CLI check arrives in Milestone 3' },
    claudeAuth: { ...UNIMPLEMENTED_CHECK, detail: 'Claude auth check arrives in Milestone 3' },
    pythonEnv: { state: 'unchecked', detail: 'Not checked yet' }
  }
  let preflightPromise: Promise<SetupStatus> | null = null

  function broadcastProgress(status: SetupStatus): void {
    cachedStatus = status
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.setupProgress, status)
    }
  }

  // Kicks off (or reuses) the single in-flight preflight run. Never runs two
  // preflight passes concurrently - repeated `setup:getStatus` invokes (e.g.
  // from multiple windows, or React effect re-runs) just await/observe the
  // same run.
  function startPreflight(): Promise<SetupStatus> {
    if (!preflightPromise) {
      preflightPromise = runPreflight({ envManager }, broadcastProgress).then((status) => {
        cachedStatus = status
        return status
      })
    }
    return preflightPromise
  }

  ipcMain.handle(IPC.modelLoadSample, async (): Promise<ArrayBuffer> => {
    const filePath = resourcePath('sample', 'cube.stl')
    const buffer = await readFile(filePath)
    // Slice out a standalone ArrayBuffer so we don't hand back a view into
    // Node's shared buffer pool.
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

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

  // implemented in M3 (Claude Agent SDK session)
  ipcMain.handle(
    IPC.agentSendMessage,
    async (_event, _request: SendMessageRequest): Promise<SendMessageResponse> => ({
      accepted: false,
      reason: 'Agent not connected yet (Milestone 3)'
    })
  )
}
