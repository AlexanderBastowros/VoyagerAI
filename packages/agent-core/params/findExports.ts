import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Recursively finds the first file under `rootDir` (depth-first, then alphabetical) whose
 * extension matches `ext` (case-insensitive; with or without a leading dot). Returns an
 * absolute path, or `null` if none exists.
 *
 * A re-run script picks its own export filename (whatever the agent originally wrote, e.g.
 * `bracket_v3.stl`) and, depending on the script's own relative `./outputs/` writes, may land
 * it one level deeper than `rootDir` itself - scanning avoids the caller having to guess either.
 */
export async function findFileByExt(rootDir: string, ext: string): Promise<string | null> {
  const target = ext.toLowerCase().replace(/^\./, '')
  const matches: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(`.${target}`)) {
        matches.push(full)
      }
    }
  }

  await walk(rootDir)
  matches.sort()
  return matches[0] ?? null
}
