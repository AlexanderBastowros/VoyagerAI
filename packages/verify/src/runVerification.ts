import type { ConformanceRow, DesignBrief, VerificationBadge, VerificationFinding, VerificationReport } from '@shared/ipc'
import { defaultExecFile } from './execJson'
import type { ExecFileFn } from './execJson'
import { runLayer1StaticScript } from './layer1StaticScript'
import { runLayer2Geometry } from './layer2Geometry'
import { runLayer3BriefConformance } from './layer3BriefConformance'
import { runPartInterferenceCheck } from './layerPartInterference'
import type { PartInterferenceEntry } from './layerPartInterference'

export interface RunVerificationOptions {
  /** Iteration number this report is for - stamped onto the returned `VerificationReport`. */
  iteration: number
  /** Absolute path to the managed venv's python. */
  pythonPath: string
  staticCheckScriptPath: string
  geometryReportScriptPath: string
  conformanceCheckScriptPath: string
  extractParamsScriptPath?: string
  /** Absolute path to the generating script - layer 1 always runs against this. */
  scriptPath: string
  /** Absolute path to the exported STL - layer 2 runs only when this is set. */
  stlPath?: string
  /** Absolute path to the exported STEP - layer 3 runs only when this is set AND `brief` is
   *  locked (a draft brief isn't a stable enough spec to conform against). */
  stepPath?: string
  brief?: DesignBrief | null
  /** Overrides `brief.printer.nozzleDiameterMm` when no printer profile is set. */
  nozzleMm?: number
  /** Absolute path to the bundled `part_interference.py` (WS-I follow-up) - omit to skip the
   *  cross-part check (e.g. test harnesses/callers that don't exercise multi-part projects). */
  partInterferenceScriptPath?: string
  /** Every part in the active project (active-iteration STL + placement, WS-I follow-up,
   *  architecture doc §14), for the cross-part interference check on the placed arrangement.
   *  Omitted, empty, or a single part - the check is skipped, there's nothing to interfere with. */
  parts?: PartInterferenceEntry[]
}

function computeBadge(findings: VerificationFinding[], conformance: ConformanceRow[]): VerificationBadge {
  if (findings.some((f) => f.severity === 'blocking') || conformance.some((row) => !row.pass)) return 'fail'
  if (findings.some((f) => f.severity === 'suggestion')) return 'warning'
  return 'pass'
}

/**
 * Orchestrates verification layers 1-3 (architecture doc §5) for one recorded iteration, plus the
 * WS-I follow-up cross-part interference check (still tagged onto layer 2's 'geometry' bucket -
 * see `layerPartInterference.ts`). Layer 1 always runs (a script is always present); layer 2 runs
 * whenever an STL export exists; layer 3 runs only once a STEP export exists and the brief is
 * locked; the cross-part check runs only when the caller supplies 2+ parts (single-part projects
 * have nothing to interfere with) - see each layer's own module for what it checks and why. None
 * of these reads another's output, so they all run concurrently (each is its own
 * `execFile`/python-process round trip) rather than paying the sum of their process-startup times
 * on every automatic `recordIteration` verification. Stamps `iteration`/`generatedAt`/`badge`, so
 * callers only need to persist and broadcast the result (see `agents/production-roadmap.md`'s
 * WS-C entry for where this is wired into `ProjectStore.recordIteration`'s hook).
 */
export async function runVerification(
  options: RunVerificationOptions,
  execFileFn: ExecFileFn = defaultExecFile
): Promise<VerificationReport> {
  const nozzleMm = options.nozzleMm ?? options.brief?.printer?.nozzleDiameterMm

  const layer1Promise = runLayer1StaticScript(
    {
      pythonPath: options.pythonPath,
      staticCheckScriptPath: options.staticCheckScriptPath,
      scriptPath: options.scriptPath,
      extractParamsScriptPath: options.extractParamsScriptPath
    },
    execFileFn
  )

  const layer2Promise = options.stlPath
    ? runLayer2Geometry(
        {
          pythonPath: options.pythonPath,
          geometryReportScriptPath: options.geometryReportScriptPath,
          stlPath: options.stlPath,
          bedXMm: options.brief?.printer?.bedXMm,
          bedYMm: options.brief?.printer?.bedYMm,
          bedZMm: options.brief?.printer?.bedZMm,
          nozzleMm
        },
        execFileFn
      )
    : Promise.resolve<VerificationFinding[]>([])

  const layer3Promise =
    options.stepPath && options.brief?.lockedAt
      ? runLayer3BriefConformance(
          {
            pythonPath: options.pythonPath,
            conformanceCheckScriptPath: options.conformanceCheckScriptPath,
            stepPath: options.stepPath,
            envelope: {
              x: { value: options.brief.envelope.x.value, tolerance: options.brief.envelope.x.tolerance },
              y: { value: options.brief.envelope.y.value, tolerance: options.brief.envelope.y.tolerance },
              z: { value: options.brief.envelope.z.value, tolerance: options.brief.envelope.z.tolerance }
            },
            holes: options.brief.features
              .filter((feature) => feature.kind === 'hole')
              .map((feature) => ({
                id: feature.id,
                diameterMm: feature.diameter.value,
                toleranceMm: feature.diameter.tolerance
              })),
            nozzleMm
          },
          execFileFn
        )
      : Promise.resolve<{ findings: VerificationFinding[]; conformance: ConformanceRow[] }>({
          findings: [],
          conformance: []
        })

  const partInterferencePromise =
    options.partInterferenceScriptPath && options.parts && options.parts.length > 1
      ? runPartInterferenceCheck(
          {
            pythonPath: options.pythonPath,
            partInterferenceScriptPath: options.partInterferenceScriptPath,
            parts: options.parts
          },
          execFileFn
        )
      : Promise.resolve<VerificationFinding[]>([])

  const [layer1Findings, layer2Findings, layer3, partInterferenceFindings] = await Promise.all([
    layer1Promise,
    layer2Promise,
    layer3Promise,
    partInterferencePromise
  ])

  const findings = [...layer1Findings, ...layer2Findings, ...layer3.findings, ...partInterferenceFindings]
  const conformance = [...layer3.conformance]

  return {
    iteration: options.iteration,
    badge: computeBadge(findings, conformance),
    findings,
    conformance,
    generatedAt: new Date().toISOString()
  }
}
