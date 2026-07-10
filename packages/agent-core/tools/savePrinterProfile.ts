import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { textResult } from './helpers'
import type { VoyagerMcpDeps } from './types'

/** Raw zod shape (not wrapped in `z.object`) so it can be passed straight to the SDK's `tool()`,
 *  matching every other Voyager MCP tool. Field names use the same flattened snake_case
 *  convention as `update_brief`'s `briefAgentPatchShape`. */
export const savePrinterProfileShape = {
  name: z.string().describe('A short label for the printer, e.g. "Prusa MK4" or "Bambu A1 Mini".'),
  bed_x_mm: z.number().describe('Print bed size along X, in millimeters.'),
  bed_y_mm: z.number().describe('Print bed size along Y, in millimeters.'),
  bed_z_mm: z.number().describe('Maximum build height (Z), in millimeters.'),
  nozzle_diameter_mm: z.number().describe('Nozzle diameter in millimeters, e.g. 0.4.'),
  materials: z
    .array(z.string())
    .optional()
    .describe('Filament materials the user has on hand, e.g. ["PLA", "PETG"]. Omit if unknown.')
}

/**
 * Builds the `save_printer_profile` MCP tool (WS-E, product doc §4.4): when a session had no
 * saved printer profile and the agent had to ask the skill's Phase-1 printer questions, this
 * lets it offer to persist the answers as a reusable profile so every future project skips
 * those questions. The saved profile becomes the active one (see `PrinterProfileStore.save`),
 * and the emission keeps the settings panel's list in sync.
 */
export function createSavePrinterProfileTool(
  deps: VoyagerMcpDeps
): SdkMcpToolDefinition<typeof savePrinterProfileShape> {
  return tool(
    'save_printer_profile',
    "Save the user's printer as a reusable profile (bed size, nozzle diameter, materials on " +
      'hand) so future projects skip the printer questions entirely. Call this only after the ' +
      'user has confirmed the values AND agreed to save them - typically right after they answer ' +
      'the Phase-1 nozzle/bed questions in a session with no saved profile, or when they say ' +
      'they are using a different printer than their saved one. The profile becomes active ' +
      'immediately and shows up in the Printer panel.',
    savePrinterProfileShape,
    async (args) => {
      if (!deps.printerProfiles) {
        return textResult('Printer profiles are not available in this session.', true)
      }

      let saved
      try {
        saved = await deps.printerProfiles.save({
          id: '', // empty id = new profile; the store derives a unique slug from the name
          name: args.name,
          bedXMm: args.bed_x_mm,
          bedYMm: args.bed_y_mm,
          bedZMm: args.bed_z_mm,
          nozzleDiameterMm: args.nozzle_diameter_mm,
          materials: args.materials ?? []
        })
      } catch (err) {
        // Store-side validation (blank name, non-positive dimensions) comes back as an error
        // result the model can correct, rather than an opaque tool crash.
        return textResult(err instanceof Error ? err.message : 'Could not save the printer profile.', true)
      }

      deps.emit({ kind: 'printer-profiles-updated', payload: saved })

      const active = saved.profiles.find((profile) => profile.id === saved.activeId)
      return textResult(
        `Saved printer profile "${active?.name ?? args.name}" - it is now the active profile, so ` +
          'future projects will use it instead of asking the printer questions again.'
      )
    }
  )
}
