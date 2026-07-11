/**
 * Graduation package builder (architecture doc §12.1, product doc §5.5's "Tier 1" anti-lock-in
 * bundle): one zip with, per part, its STEP + 3MF + STL + parametric script, plus a single
 * project-level locked-brief snapshot, a combined PARAMS manifest, and a generated README - "how
 * do I keep working on this outside Voyager". No new artifact generation: every file bundled here
 * is something `display_model`/the parameter panel already produced and recorded (architecture doc
 * §12.1's "Implementation is small" note) - this module only decides what to include and how to
 * present it.
 *
 * Pure logic with **injected fs dependencies** (no `electron` import, no direct `node:fs` calls):
 * every byte this module needs is fetched through the small `PackageFsDeps` the caller supplies,
 * so it unit-tests against an in-memory fake instead of a real project directory (mirrors
 * `exportResolver.ts`'s "no filesystem I/O" purity one level up - this module *does* read files,
 * but never decides *how*). `src/main/ipc.ts`'s `model:exportPackage` handler is the thin wrapper
 * that resolves each part's active (or requested) iteration, reads the locked brief and per-part
 * manifests via the already-existing `BriefStore`/`readManifestForIteration`, and passes real
 * `node:fs/promises` functions as the deps.
 *
 * "Bundle only artifacts that exist" (format-honesty, mirrors mesh-lineage iterations having no
 * STEP): a missing STEP/3MF/script is left out rather than failing the whole export, and the
 * generated README says so per part instead of silently pretending the bundle is complete.
 */

import type { ScriptManifest } from '@shared/ipc'
import { containedAbsPath, deriveThreeMfPath, slugifyZipBase } from './exportResolver'
import { writeZip, type ZipEntry } from './zipWriter'

/** Reads/probes files by path relative to the project directory - real `node:fs/promises` in
 *  production, an in-memory fake in tests. Paths are project-relative (matching every other path
 *  already recorded on a `ProjectIteration`); this module resolves + contains them before calling
 *  either function, so `absPath` here is always already-validated. */
export interface PackageFsDeps {
  readFile: (absPath: string) => Promise<Uint8Array>
  fileExists: (absPath: string) => Promise<boolean>
}

/** The subset of `ProjectIteration` a package needs for one part. */
export interface PackagePartIteration {
  n: number
  stlPath: string
  stepPath?: string
  scriptPath: string
  /** Preferred over `scriptPath` when present - the version-locked snapshot guaranteed to match
   *  this exact iteration's STL (see `ProjectIteration.scriptSnapshotPath`'s doc comment). */
  scriptSnapshotPath?: string
  /** Informational only (shown in the README) - the package always bundles the project's
   *  *currently* locked brief (see `BuildGraduationPackageInput.lockedBrief`), not a per-iteration
   *  lookup, since a locked brief is a project-level artifact. */
  briefVersion?: number
}

export interface PackagePartInput {
  id: string
  name: string
  iteration: PackagePartIteration
}

export interface BuildGraduationPackageInput {
  projectDir: string
  projectName: string
  /** Parts to bundle - already filtered to ones with an iteration to package (a part with no
   *  model yet has nothing to include and is simply omitted by the caller). */
  parts: PackagePartInput[]
  /** The project's currently locked Design Brief, pre-serialized by the caller (`BriefStore`) -
   *  omitted when the project has never locked one (no invented spec). */
  lockedBrief?: { version: number; json: string }
  /** Each part's PARAMS manifest (WS-B), pre-read by the caller via `readManifestForIteration` -
   *  null where none was ever recorded for that iteration. Keyed by part id. */
  manifests: Record<string, ScriptManifest | null>
  /** Injected so tests are deterministic (stamps the zip entries and the README). */
  now?: Date
}

export type BuildGraduationPackageResult =
  | { ok: true; zipBuffer: Buffer; zipFileName: string }
  | { ok: false; reason: string }

/** Resolves + reads one per-part artifact (STL/STEP/3MF/script) whose absence just means "not
 *  produced for this iteration" rather than an error - never throws for "doesn't exist", only for
 *  a containment violation, which fails the whole package (a corrupted record must never leak a
 *  file from outside the project dir, matching `exportResolver.ts`'s guard). */
async function readOptionalArtifact(
  projectDir: string,
  partName: string,
  relPath: string | undefined,
  entryName: string,
  deps: PackageFsDeps
): Promise<{ ok: true; artifact: ZipEntry | null } | { ok: false; reason: string }> {
  if (!relPath) return { ok: true, artifact: null }
  const abs = containedAbsPath(projectDir, relPath)
  if (!abs) {
    return {
      ok: false,
      reason: `The recorded path for part "${partName}" resolves outside the project directory and was rejected.`
    }
  }
  if (!(await deps.fileExists(abs))) return { ok: true, artifact: null }
  return { ok: true, artifact: { name: entryName, data: await deps.readFile(abs) } }
}

function generateReadme(input: {
  projectName: string
  now: Date
  parts: Array<{
    id: string
    name: string
    n: number
    hasStep: boolean
    hasThreeMf: boolean
    hasScript: boolean
    briefVersion?: number
  }>
  hasBrief: boolean
  briefVersion?: number
}): string {
  const lines: string[] = []
  lines.push(`# ${input.projectName} - Voyager AI graduation package`)
  lines.push('')
  lines.push(`Generated ${input.now.toISOString()} by Voyager AI.`)
  lines.push('')
  lines.push(
    'This bundle contains everything needed to keep working on this design outside Voyager: ' +
      'the print-ready mesh, the full parametric CAD source, and (when locked) the spec it was ' +
      'built from. Nothing here is regenerated for the package - every file is exactly what ' +
      'Voyager already produced and recorded for that iteration.'
  )
  lines.push('')
  lines.push('## Parts')
  lines.push('')
  for (const part of input.parts) {
    lines.push(`### ${part.name} (v${part.n})`)
    lines.push('')
    lines.push(`- \`${part.id}_v${part.n}.stl\` - print-ready mesh.`)
    lines.push(
      part.hasThreeMf
        ? `- \`${part.id}_v${part.n}.3mf\` - print-ready mesh, for slicers that prefer 3MF over STL.`
        : '- No 3MF was recorded for this part (only STL/STEP).'
    )
    if (part.hasStep) {
      lines.push(
        `- \`${part.id}_v${part.n}.step\` - parametric B-rep. Import into Fusion 360 / Onshape / FreeCAD / SolidWorks.`
      )
    } else {
      lines.push('- No STEP was recorded for this part (mesh-lineage import/remix has no B-rep to export).')
    }
    if (part.hasScript) {
      lines.push(
        `- \`${part.id}_v${part.n}.py\` - the parametric build123d script that generated this iteration. ` +
          `Re-run it yourself with \`pip install build123d\` then \`python ${part.id}_v${part.n}.py\` - ` +
          'no Voyager runtime required, and it is entirely reproducible.'
      )
    }
    if (part.briefVersion !== undefined) {
      lines.push(`- Generated against locked Design Brief v${part.briefVersion}.`)
    }
    lines.push('')
  }
  lines.push('## manifest.json')
  lines.push('')
  lines.push(
    "Every bundled part's tunable PARAMS and feature-to-parameter bindings (the same data Voyager's " +
      'parameter panel reads), for reference before you edit a script by hand.'
  )
  lines.push('')
  if (input.hasBrief) {
    lines.push(`## brief.v${input.briefVersion}.json`)
    lines.push('')
    lines.push("The project's locked Design Brief - the spec Voyager verified this design against.")
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Builds the graduation package zip described above. Fails the whole export only on a
 * containment violation or an empty `parts` list; every other gap (no STEP/3MF/script for a
 * given part, no locked brief) degrades gracefully - the README says what's missing and why.
 */
export async function buildGraduationPackage(
  input: BuildGraduationPackageInput,
  deps: PackageFsDeps
): Promise<BuildGraduationPackageResult> {
  if (input.parts.length === 0) {
    return { ok: false, reason: 'No model has been generated yet.' }
  }

  const entries: ZipEntry[] = []
  const readmeParts: Parameters<typeof generateReadme>[0]['parts'] = []

  for (const part of input.parts) {
    const { id, name, iteration } = part
    const prefix = `${id}_v${iteration.n}`

    // Every iteration is guaranteed an STL at record time (`displayModel.ts` validates it before
    // `recordIteration` ever runs) - reuse the same optional-artifact path anyway so a file that's
    // since vanished from disk degrades to a skip rather than throwing mid-package.
    const stl = await readOptionalArtifact(input.projectDir, name, iteration.stlPath, `${prefix}.stl`, deps)
    if (!stl.ok) return stl
    if (stl.artifact) entries.push(stl.artifact)

    const step = await readOptionalArtifact(input.projectDir, name, iteration.stepPath, `${prefix}.step`, deps)
    if (!step.ok) return step
    if (step.artifact) entries.push(step.artifact)

    const threeMfRelPath = deriveThreeMfPath(iteration.stlPath)
    const threeMf = await readOptionalArtifact(input.projectDir, name, threeMfRelPath, `${prefix}.3mf`, deps)
    if (!threeMf.ok) return threeMf
    if (threeMf.artifact) entries.push(threeMf.artifact)

    const scriptRelPath = iteration.scriptSnapshotPath ?? iteration.scriptPath
    const script = await readOptionalArtifact(input.projectDir, name, scriptRelPath, `${prefix}.py`, deps)
    if (!script.ok) return script
    if (script.artifact) entries.push(script.artifact)

    readmeParts.push({
      id,
      name,
      n: iteration.n,
      hasStep: !!step.artifact,
      hasThreeMf: !!threeMf.artifact,
      hasScript: !!script.artifact,
      briefVersion: iteration.briefVersion
    })
  }

  const now = input.now ?? new Date()

  const manifestDoc = {
    generatedAt: now.toISOString(),
    project: input.projectName,
    parts: Object.fromEntries(
      input.parts.map((p) => [p.id, { name: p.name, iteration: p.iteration.n, manifest: input.manifests[p.id] ?? null }])
    )
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifestDoc, null, 2), 'utf-8') })

  if (input.lockedBrief) {
    entries.push({ name: `brief.v${input.lockedBrief.version}.json`, data: Buffer.from(input.lockedBrief.json, 'utf-8') })
  }

  const readme = generateReadme({
    projectName: input.projectName,
    now,
    parts: readmeParts,
    hasBrief: !!input.lockedBrief,
    briefVersion: input.lockedBrief?.version
  })
  entries.push({ name: 'README.md', data: Buffer.from(readme, 'utf-8') })

  const base = slugifyZipBase(input.projectName) || 'project'
  const zipFileName =
    input.parts.length === 1
      ? `${input.parts[0].id}_v${input.parts[0].iteration.n}-package.zip`
      : `${base}-package.zip`

  return { ok: true, zipBuffer: writeZip(entries, now), zipFileName }
}
