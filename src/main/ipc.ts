import { app, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { SendMessageRequest, SendMessageResponse, SetupCheck, SetupStatus } from '../shared/ipc'

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
 * Registers all main-process IPC handlers. Only `model:loadSample` is fully
 * implemented in Milestone 1; the rest return clearly-marked placeholder
 * data so the renderer's typed IPC surface (src/preload/api.ts) can be built
 * against the real contract ahead of M2/M3.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.modelLoadSample, async (): Promise<ArrayBuffer> => {
    const filePath = resourcePath('sample', 'cube.stl')
    const buffer = await readFile(filePath)
    // Slice out a standalone ArrayBuffer so we don't hand back a view into
    // Node's shared buffer pool.
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

  // implemented in M2 (pythonEnv) / M3 (claudeCli, claudeAuth)
  ipcMain.handle(IPC.setupGetStatus, async (): Promise<SetupStatus> => ({
    claudeCli: { ...UNIMPLEMENTED_CHECK, detail: 'Claude CLI check arrives in Milestone 3' },
    claudeAuth: { ...UNIMPLEMENTED_CHECK, detail: 'Claude auth check arrives in Milestone 3' },
    pythonEnv: { ...UNIMPLEMENTED_CHECK, detail: 'Python env setup arrives in Milestone 2' }
  }))

  // implemented in M3 (Claude Agent SDK session)
  ipcMain.handle(
    IPC.agentSendMessage,
    async (_event, _request: SendMessageRequest): Promise<SendMessageResponse> => ({
      accepted: false,
      reason: 'Agent not connected yet (Milestone 3)'
    })
  )
}
