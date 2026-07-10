import { readFile, stat } from 'node:fs/promises'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resolveWithinProject } from '../src/agent/paths'
import type { ResolvedPath } from '../src/agent/paths'
import { slugifyPartId } from '../src/projects/store'
import { MIN_STL_BYTES, textResult, toArrayBuffer } from './helpers'
import type { VoyagerMcpDeps } from './types'

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
  part: z.ZodOptional<z.ZodString>
  part_name: z.ZodOptional<z.ZodString>
}> {
  return tool(
    'display_model',
    'Display a validated STL export in Voyager AI\'s 3D viewport. Call this after every ' +
      'successful export + validation (printable-cad skill Phase 5/6). Paths must be inside the ' +
      'project working directory. For a multi-part project (a box AND its lid, a gear pair), pass ' +
      '`part` so each part keeps its own version history and placement.',
    {
      stl_path: z.string().describe('Path to the exported STL, relative to the project directory.'),
      step_path: z.string().optional().describe('Path to the exported STEP file, if produced.'),
      script_path: z.string().describe('Path to the parametric Python script that generated the model.'),
      summary: z.string().describe('One or two sentences: what the part is, key dimensions, DFM rules applied.'),
      part: z
        .string()
        .optional()
        .describe(
          'Slug of the part this model is (e.g. "lid", "gear_small"). Omit for a single-part ' +
            'project or to keep refining the part currently in focus. A new slug creates a new part.'
        ),
      part_name: z
        .string()
        .optional()
        .describe('Human-readable name shown in the parts panel when the part is first created (e.g. "Lid").')
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

      // The script must exist on disk: `recordIteration` snapshots it into a version-locked copy,
      // so a missing script would fail the copy. Check here to give the agent a clear, actionable
      // error rather than an opaque filesystem throw.
      let scriptStat
      try {
        scriptStat = await stat(script.path.abs)
      } catch {
        return textResult(`script_path "${args.script_path}" does not exist.`, true)
      }
      if (!scriptStat.isFile()) {
        return textResult(`script_path "${args.script_path}" is not a file.`, true)
      }

      // Stamps the locked brief's version onto this iteration (WS-A, architecture doc §4.4) - the
      // brief store is optional on `VoyagerMcpDeps` for older test fixtures that don't touch the
      // brief at all, so an unlocked/absent brief just leaves `briefVersion` unset.
      const brief = deps.briefStore ? await deps.briefStore.get(projectDir) : null
      const briefVersion = brief?.lockedAt ? brief.version : undefined

      // Resolve the part this display records into: an explicit slug (created on first use), or the
      // part currently in focus. Resolving it here (rather than only inside recordIteration) lets us
      // tag the emission with the part so the viewer keys its per-part mesh map correctly.
      const partId = args.part ? slugifyPartId(args.part) : await deps.projectStore.getActivePartId()

      const buffer = await readFile(stl.path.abs)
      const iteration = await deps.projectStore.recordIteration({
        stlPath: stl.path.rel,
        stepPath: step?.rel,
        scriptPath: script.path.rel,
        summary: args.summary,
        partId,
        ...(args.part_name ? { partName: args.part_name } : {}),
        ...(briefVersion !== undefined ? { briefVersion } : {})
      })

      deps.emit({
        kind: 'model-displayed',
        payload: {
          stlPath: iteration.stlPath,
          stepPath: iteration.stepPath,
          scriptPath: iteration.scriptPath,
          summary: iteration.summary,
          iteration: iteration.n,
          stlBuffer: toArrayBuffer(buffer),
          partId
        }
      })

      return textResult(`Model v${iteration.n} is now displayed in the viewport.`)
    }
  )
}
