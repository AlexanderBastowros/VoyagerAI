import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ModelDisplayedPayload } from '../../shared/ipc'
import type { ProjectIteration } from '../projects/store'

/** The subset of ProjectStore the MCP tools need - kept narrow for testability. */
export interface VoyagerMcpProjectStore {
  getProjectDir(): string
  recordIteration(entry: {
    stlPath: string
    stepPath?: string
    scriptPath: string
    summary: string
  }): Promise<ProjectIteration>
}

/**
 * Domain-level events the MCP tool handlers report back to whoever owns the
 * session (AgentSession). Kept independent of the raw `agent:event` /
 * `model:displayed` IPC channel shapes so mcpTools.ts never needs to know
 * about the current turn's `messageId` - AgentSession attaches that when it
 * turns an emission into an actual IPC push.
 */
export type VoyagerMcpEmission =
  | { kind: 'status'; detail: string }
  | { kind: 'model-displayed'; payload: ModelDisplayedPayload }

export interface VoyagerMcpDeps {
  projectStore: VoyagerMcpProjectStore
  emit: (emission: VoyagerMcpEmission) => void
}

/** Minimum size of a structurally-plausible binary STL (80-byte header + 4-byte triangle count). */
const MIN_STL_BYTES = 84

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

interface ResolvedPath {
  /** Absolute path on disk. */
  abs: string
  /** Path relative to the project directory - what gets persisted/emitted. */
  rel: string
}

/**
 * Resolves `candidate` (relative or absolute) against `projectDir` and
 * rejects anything that escapes it - Claude's tool calls are trusted for
 * *content* but not for *paths*, so a hallucinated or malicious `../../`
 * must never let the app read/expose files outside the project.
 */
function resolveWithinProject(
  projectDir: string,
  candidate: string,
  label: string
): { ok: true; path: ResolvedPath } | { ok: false; error: string } {
  const abs = resolve(projectDir, candidate)
  const rel = relative(projectDir, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `${label} "${candidate}" resolves outside the project directory and was rejected.` }
  }
  return { ok: true, path: { abs, rel } }
}

/**
 * Builds the `display_model` MCP tool: validates and records a versioned
 * export, then hands the STL bytes off via `emit` so the viewport can render
 * them immediately. Exported standalone (not just bundled into the server)
 * so tests can call `.handler(...)` directly without spinning up an MCP
 * transport.
 */
export function createDisplayModelTool(
  deps: VoyagerMcpDeps
): SdkMcpToolDefinition<{
  stl_path: z.ZodString
  step_path: z.ZodOptional<z.ZodString>
  script_path: z.ZodString
  summary: z.ZodString
}> {
  return tool(
    'display_model',
    'Display a validated STL export in Voyager AI\'s 3D viewport. Call this after every ' +
      'successful export + validation (printable-cad skill Phase 5/6). Paths must be inside the ' +
      'project working directory.',
    {
      stl_path: z.string().describe('Path to the exported STL, relative to the project directory.'),
      step_path: z.string().optional().describe('Path to the exported STEP file, if produced.'),
      script_path: z.string().describe('Path to the parametric Python script that generated the model.'),
      summary: z.string().describe('One or two sentences: what the part is, key dimensions, DFM rules applied.')
    },
    async (args) => {
      const projectDir = deps.projectStore.getProjectDir()

      const stl = resolveWithinProject(projectDir, args.stl_path, 'stl_path')
      if (!stl.ok) return textResult(stl.error, true)

      const script = resolveWithinProject(projectDir, args.script_path, 'script_path')
      if (!script.ok) return textResult(script.error, true)

      let step: ResolvedPath | undefined
      if (args.step_path) {
        const resolved = resolveWithinProject(projectDir, args.step_path, 'step_path')
        if (!resolved.ok) return textResult(resolved.error, true)
        step = resolved.path
      }

      let stlStat
      try {
        stlStat = await stat(stl.path.abs)
      } catch {
        return textResult(`stl_path "${args.stl_path}" does not exist.`, true)
      }
      if (!stlStat.isFile() || stlStat.size <= MIN_STL_BYTES) {
        return textResult(
          `stl_path "${args.stl_path}" is missing or too small to be a valid STL (${stlStat.size} bytes).`,
          true
        )
      }

      const buffer = await readFile(stl.path.abs)
      const iteration = await deps.projectStore.recordIteration({
        stlPath: stl.path.rel,
        stepPath: step?.rel,
        scriptPath: script.path.rel,
        summary: args.summary
      })

      deps.emit({
        kind: 'model-displayed',
        payload: {
          stlPath: iteration.stlPath,
          stepPath: iteration.stepPath,
          scriptPath: iteration.scriptPath,
          summary: iteration.summary,
          iteration: iteration.n,
          stlBuffer: toArrayBuffer(buffer)
        }
      })

      return textResult(`Model v${iteration.n} is now displayed in the viewport.`)
    }
  )
}

/**
 * Builds the `set_status` MCP tool: a lightweight way for Claude to narrate
 * a long-running step (running the script, validating the mesh) without
 * that text becoming part of its chat reply. Reported as a `tool-activity`
 * agent event rather than extending the shared IPC contract with a new
 * event type - see VoyagerMcpEmission's doc comment.
 */
export function createSetStatusTool(deps: VoyagerMcpDeps): SdkMcpToolDefinition<{ message: z.ZodString }> {
  return tool(
    'set_status',
    'Report a short status update (e.g. "Running the parametric script...") to show in the chat ' +
      'while you work. Does not count as your reply to the user.',
    { message: z.string() },
    async (args) => {
      deps.emit({ kind: 'status', detail: args.message })
      return textResult('ok')
    }
  )
}

/** Assembles the in-process `voyager` MCP server registered on the agent session's `mcpServers` option. */
export function createVoyagerMcpServer(deps: VoyagerMcpDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'voyager',
    version: '0.1.0',
    tools: [createDisplayModelTool(deps), createSetStatusTool(deps)]
  })
}
