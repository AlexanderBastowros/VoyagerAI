import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isScriptManifest } from '@shared/ipc'
import type { ScriptManifest } from '@shared/ipc'

/**
 * The manifest for a given STL always lives beside it, same basename, `.manifest.json` in
 * place of `.stl` - mirrors how the skill already keeps `script.py`/`.stl`/`.step` co-located
 * and uniquely named per version (SKILL.md Phase 4), so no new field on `ProjectIteration` is
 * needed to locate it. `dirname`/`basename` (not `path.posix`) match how every other relative
 * path in `project.json` is built (see `ProjectStore.recordIteration`) - Node's implementations
 * accept `/`-separated input on every platform.
 */
export function manifestPathForStl(stlRelPath: string): string {
  const dir = dirname(stlRelPath)
  const base = basename(stlRelPath).replace(/\.stl$/i, '')
  return dir === '.' ? `${base}.manifest.json` : `${dir}/${base}.manifest.json`
}

/**
 * Reads the manifest for one iteration, by convention from its STL path. Returns `null` (not an
 * empty manifest) when no manifest was ever recorded for this iteration - callers use that to
 * distinguish "nothing to show yet" from "recorded, but declares zero tunable parameters".
 */
export async function readManifestForIteration(
  projectDir: string,
  iteration: { stlPath: string }
): Promise<ScriptManifest | null> {
  const relPath = manifestPathForStl(iteration.stlPath)
  try {
    const raw = await readFile(join(projectDir, relPath), 'utf-8')
    const parsed = JSON.parse(raw)
    return isScriptManifest(parsed) ? parsed : null
  } catch {
    return null
  }
}
