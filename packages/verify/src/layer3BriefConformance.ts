import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConformanceRow, VerificationFinding } from '@shared/ipc'
import { defaultExecFile, findingsFromCheck, runJsonCheck } from './execJson'
import type { ExecFileFn, RawFindingsOutput } from './execJson'

export interface EnvelopeAxisSpec {
  value: number
  tolerance?: number
}

export interface HoleSpec {
  id: string
  diameterMm: number
  toleranceMm?: number
}

export interface Layer3Options {
  /** Absolute path to the managed venv's python. */
  pythonPath: string
  /** Absolute path to the bundled `conformance_check.py`. */
  conformanceCheckScriptPath: string
  /** Absolute path to the exported STEP. */
  stepPath: string
  envelope: { x: EnvelopeAxisSpec; y: EnvelopeAxisSpec; z: EnvelopeAxisSpec }
  holes: HoleSpec[]
  nozzleMm?: number
}

export interface Layer3Result {
  findings: VerificationFinding[]
  conformance: ConformanceRow[]
}

interface ConformanceCheckOutput extends RawFindingsOutput {
  conformance: ConformanceRow[]
}

/** Layer 3 (architecture doc §5) - the brief-conformance "moat": bbox vs envelope, hole
 *  diameter via cylindrical-face detection, and a ray-cast wall-thickness sample, all measured
 *  off the exact STEP B-rep via OCP. Needs a locked brief - callers only invoke this once one
 *  exists (see `runVerification.ts`). Writes a small scratch JSON file (the minimal subset of the
 *  brief the python script needs) and always cleans it up, even on failure. */
export async function runLayer3BriefConformance(
  options: Layer3Options,
  execFileFn: ExecFileFn = defaultExecFile
): Promise<Layer3Result> {
  const tempDir = join(tmpdir(), `voyager-verify-${randomUUID()}`)
  await mkdir(tempDir, { recursive: true })
  const briefJsonPath = join(tempDir, 'brief.json')

  try {
    await writeFile(
      briefJsonPath,
      JSON.stringify({ envelope: options.envelope, holes: options.holes }),
      'utf-8'
    )

    const args = [options.conformanceCheckScriptPath, options.stepPath, '--brief-json', briefJsonPath]
    if (options.nozzleMm !== undefined) args.push('--nozzle', String(options.nozzleMm))

    const result = await runJsonCheck<ConformanceCheckOutput>(execFileFn, options.pythonPath, args)
    return {
      findings: findingsFromCheck('brief-conformance', result, 'Brief conformance check'),
      conformance: result.ok && result.data ? result.data.conformance : []
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
