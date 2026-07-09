import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isVerificationReport } from '@shared/ipc'
import type { VerificationReport } from '@shared/ipc'

/**
 * The verification report for a given STL always lives beside it, same basename,
 * `.verification.json` in place of `.stl` - mirrors `manifestPathForStl`
 * (`packages/agent-core/params/manifestConvention.ts`)'s exact convention so there's one rule to
 * remember for "what lives next to this iteration's STL", not two.
 */
export function verificationPathForStl(stlRelPath: string): string {
  const dir = dirname(stlRelPath)
  const base = basename(stlRelPath).replace(/\.stl$/i, '')
  return dir === '.' ? `${base}.verification.json` : `${dir}/${base}.verification.json`
}

/** Reads the report for one iteration, by convention from its STL path. Returns `null` (not a
 *  placeholder report) when nothing has been computed yet for this iteration. */
export async function readVerificationForIteration(
  projectDir: string,
  iteration: { stlPath: string }
): Promise<VerificationReport | null> {
  const relPath = verificationPathForStl(iteration.stlPath)
  try {
    const raw = await readFile(join(projectDir, relPath), 'utf-8')
    const parsed = JSON.parse(raw)
    return isVerificationReport(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Persists a computed report beside its iteration's STL, per `verificationPathForStl`. */
export async function writeVerificationForIteration(
  projectDir: string,
  iteration: { stlPath: string },
  report: VerificationReport
): Promise<void> {
  const relPath = verificationPathForStl(iteration.stlPath)
  const absPath = join(projectDir, relPath)
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, JSON.stringify(report, null, 2), 'utf-8')
}
