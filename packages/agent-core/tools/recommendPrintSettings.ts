import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { textResult } from './helpers'
import type { VoyagerMcpDeps } from './types'

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
