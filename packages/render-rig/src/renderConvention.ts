import { basename, dirname } from 'node:path'

/**
 * The canonical render set for a given STL always lives in a sibling directory, same basename,
 * `.renders` in place of `.stl` - mirrors `manifestPathForStl`
 * (`packages/agent-core/params/manifestConvention.ts`) / `verificationPathForStl`
 * (`packages/verify/src/reportConvention.ts`)'s exact convention ("what lives next to this
 * iteration's STL" is one rule to remember, not three), except this one names a *directory*
 * (8 PNGs) rather than a single file, since a render set has no single natural filename.
 */
export function renderDirForStl(stlRelPath: string): string {
  const dir = dirname(stlRelPath)
  const base = basename(stlRelPath).replace(/\.stl$/i, '')
  return dir === '.' ? `${base}.renders` : `${dir}/${base}.renders`
}
