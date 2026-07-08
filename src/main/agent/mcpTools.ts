import { readFile, stat } from 'node:fs/promises'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ModelDisplayedPayload, PrintSettings } from '../../shared/ipc'
import type { ProjectIteration } from '../projects/store'
import { resolveWithinProject } from './paths'
import type { ResolvedPath } from './paths'

/** The subset of ProjectStore the MCP tools need - kept narrow for testability. */
export interface VoyagerMcpProjectStore {
  getProjectDir(): string
  recordIteration(entry: {
    stlPath: string
    stepPath?: string
    scriptPath: string
    summary: string
  }): Promise<ProjectIteration>
  /** The iteration currently shown/exported, or null if the project has none yet - used by
   *  `recommend_print_settings` to tag its output with the model version it applies to. */
  activeIterationRecord(): Promise<ProjectIteration | null>
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
  | { kind: 'print-settings'; payload: PrintSettings }

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
 * Builds the `recommend_print_settings` MCP tool: emits an on-demand FDM slicer-settings
 * recommendation for whatever model is currently active, shown in Voyager's print-settings
 * panel. Modeled exactly on `createDisplayModelTool` - no filesystem work here, just tagging the
 * agent's recommendation with the server-computed `iteration` (never trusted from the agent,
 * since a stale/mismatched iteration would be silently confusing in the panel).
 */
export function createRecommendPrintSettingsTool(
  deps: VoyagerMcpDeps
): SdkMcpToolDefinition<{
  material: z.ZodString
  layer_height_mm: z.ZodNumber
  wall_count: z.ZodNumber
  top_bottom_layers: z.ZodNumber
  infill_percent: z.ZodNumber
  infill_pattern: z.ZodOptional<z.ZodString>
  supports: z.ZodString
  adhesion: z.ZodString
  nozzle_temp_c: z.ZodNumber
  bed_temp_c: z.ZodNumber
  print_speed_mm_s: z.ZodNumber
  orientation: z.ZodString
  notes: z.ZodOptional<z.ZodString>
}> {
  return tool(
    'recommend_print_settings',
    'Recommend FDM slicer settings for the currently displayed model. Call this when the user ' +
      "asks for print settings, slicer settings, or how to print the part. Appears in Voyager's " +
      'print-settings panel.',
    {
      material: z.string().describe('Recommended filament material, e.g. "PLA", "PETG", "ABS".'),
      layer_height_mm: z.number().describe('Recommended layer height in millimeters, e.g. 0.2.'),
      wall_count: z.number().describe('Number of perimeter walls/loops, e.g. 3.'),
      top_bottom_layers: z.number().describe('Number of solid top and bottom layers, e.g. 4.'),
      infill_percent: z.number().describe('Infill density as a percentage, e.g. 20.'),
      infill_pattern: z.string().optional().describe('Infill pattern, e.g. "gyroid" or "grid", if relevant.'),
      supports: z.string().describe('Support strategy: e.g. "None", "Touching build plate", or "Everywhere".'),
      adhesion: z.string().describe('Build-plate adhesion aid: e.g. "None", "Skirt", "Brim", or "Raft".'),
      nozzle_temp_c: z.number().describe('Recommended nozzle temperature in degrees Celsius.'),
      bed_temp_c: z.number().describe('Recommended bed temperature in degrees Celsius.'),
      print_speed_mm_s: z.number().describe('Recommended print speed in millimeters per second.'),
      orientation: z.string().describe('How to orient the part on the print bed, and why.'),
      notes: z.string().optional().describe('Any extra rationale or advice worth surfacing to the user.')
    },
    async (args) => {
      const active = await deps.projectStore.activeIterationRecord()
      if (!active) {
        return textResult('No model is displayed yet — generate a model before recommending print settings.', true)
      }

      deps.emit({
        kind: 'print-settings',
        payload: {
          iteration: active.n,
          material: args.material,
          layerHeightMm: args.layer_height_mm,
          wallCount: args.wall_count,
          topBottomLayers: args.top_bottom_layers,
          infillPercent: args.infill_percent,
          infillPattern: args.infill_pattern,
          supports: args.supports,
          adhesion: args.adhesion,
          nozzleTempC: args.nozzle_temp_c,
          bedTempC: args.bed_temp_c,
          printSpeedMmS: args.print_speed_mm_s,
          orientation: args.orientation,
          notes: args.notes
        }
      })

      return textResult('Recommended print settings are now shown in the print-settings panel.')
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
    tools: [createDisplayModelTool(deps), createRecommendPrintSettingsTool(deps), createSetStatusTool(deps)]
  })
}
