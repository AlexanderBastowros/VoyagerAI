import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Placement, VerificationFinding } from '@shared/ipc'
import { defaultExecFile, findingsFromCheck, runJsonCheck } from './execJson'
import type { ExecFileFn, RawFindingsOutput } from './execJson'

export interface PartInterferenceEntry {
  partId: string
  /** Absolute path to the part's active-iteration STL. */
  stlPath: string
  placement: Placement
}

export interface PartInterferenceOptions {
  /** Absolute path to the managed venv's python. */
  pythonPath: string
  /** Absolute path to the bundled `part_interference.py`. */
  partInterferenceScriptPath: string
  /** Every part in the active project, each with its active-iteration STL and placement. */
  parts: PartInterferenceEntry[]
}

/**
 * Cross-part interference check (WS-I follow-up to WS-C's layer 2, architecture doc §14): tests
 * the *placed* multi-part arrangement for interpenetration between parts - each mesh transformed
 * by its placement (position mm + XYZ-Euler rotation degrees), min-corner-aligned first to match
 * the renderer's convention (`src/renderer/src/three/placement.ts`/`viewer.ts` - see
 * `part_interference.py`'s docstring for the exact transform). A no-op (no process spawned) for
 * zero or one part - there's nothing to interfere with, and this keeps every existing single-part
 * project's verification run unchanged. Findings are tagged `layer: 'geometry'` (the same bucket
 * `layer2Geometry.ts` populates) - this is the same caliper-class, LLM-free check the
 * verification pyramid already favors, just spanning the assembled arrangement instead of one
 * part's own STL, not a new layer.
 */
export async function runPartInterferenceCheck(
  options: PartInterferenceOptions,
  execFileFn: ExecFileFn = defaultExecFile
): Promise<VerificationFinding[]> {
  if (options.parts.length < 2) return []

  const tempDir = join(tmpdir(), `voyager-verify-${randomUUID()}`)
  await mkdir(tempDir, { recursive: true })
  const partsJsonPath = join(tempDir, 'parts.json')

  try {
    await writeFile(
      partsJsonPath,
      JSON.stringify(
        options.parts.map((part) => ({
          partId: part.partId,
          stlPath: part.stlPath,
          position: part.placement.position,
          rotation: part.placement.rotation
        }))
      ),
      'utf-8'
    )

    const args = [options.partInterferenceScriptPath, '--parts-json', partsJsonPath]
    const result = await runJsonCheck<RawFindingsOutput>(execFileFn, options.pythonPath, args)
    return findingsFromCheck('geometry', result, 'Cross-part interference check')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
