import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DesignBriefSchema, emptyDesignBrief } from '@shared/ipc'
import type { DesignBrief } from '@shared/ipc'
import { isBriefComplete, missingBriefFields } from './completeness'
import { mergeAgentPatch } from './agentPatch'
import type { BriefAgentPatch } from './agentPatch'

const BRIEF_DIRNAME = 'brief'
const BRIEF_FILENAME = 'brief.json'
const VERSIONS_DIRNAME = 'versions'

export interface DesignBriefVersionSummary {
  version: number
  lockedAt: string
  brief: DesignBrief
}

/**
 * Persists one project's Design Brief (architecture doc §6) - the co-authored, machine-checkable
 * spec that gates generation and powers verification layer 3. Every method takes the project
 * directory explicitly (mirrors `resolveWithinProject`'s style) rather than tracking "the active
 * project" itself - `ProjectStore` already owns that; this store only needs to know where to read
 * and write within whichever directory it's given, so it stays trivially unit-testable and never
 * needs updating when projects are created/switched.
 *
 * On-disk layout under `<projectDir>/brief/`:
 *  - `brief.json` - the current draft, or (once locked) the current locked version.
 *  - `versions/v{n}.json` - an immutable snapshot written every time a version is locked, for the
 *    brief panel's version history.
 *
 * Locking is immutable (architecture doc §6, product doc §4.4): editing a locked brief starts a
 * new draft version (`version + 1`, `lockedAt` cleared) rather than mutating the locked snapshot -
 * see `replace()` and `applyAgentPatch()`.
 */
export class BriefStore {
  async get(projectDir: string): Promise<DesignBrief> {
    return this.readCurrent(projectDir)
  }

  /**
   * Full-replacement path for the brief panel's direct edits. The caller's `version`/`lockedAt`
   * are never trusted - if the stored brief is currently locked, this starts a new draft version
   * instead of mutating it; otherwise the edit lands on the current (still-unlocked) version.
   */
  async replace(projectDir: string, edited: DesignBrief): Promise<DesignBrief> {
    const current = await this.readCurrent(projectDir)
    const next: DesignBrief = {
      ...edited,
      version: current.lockedAt ? current.version + 1 : current.version,
      lockedAt: undefined
    }
    await this.writeCurrent(projectDir, next)
    return next
  }

  /**
   * Agent-authored merge path (`update_brief` MCP tool) - see `agentPatch.ts` for the patch shape
   * and per-field merge/provenance semantics. Bumps the version first if the current brief is
   * locked, matching `replace()`'s immutability rule, so the agent revising a brief after
   * generation always starts a fresh draft rather than silently rewriting history.
   */
  async applyAgentPatch(projectDir: string, patch: BriefAgentPatch): Promise<DesignBrief> {
    const current = await this.readCurrent(projectDir)
    const base = current.lockedAt ? { ...current, version: current.version + 1, lockedAt: undefined } : current
    const next = mergeAgentPatch(base, patch)
    await this.writeCurrent(projectDir, next)
    return next
  }

  /**
   * Locks the current draft, snapshotting it into `versions/v{n}.json`. Throws (with the specific
   * missing fields named) if the brief doesn't validate yet - "completeness gates generation, not
   * form-filling" (product doc §4.4). A no-op returning the already-locked brief if called again
   * on a version that's already locked.
   */
  async lock(projectDir: string): Promise<DesignBrief> {
    const current = await this.readCurrent(projectDir)
    if (current.lockedAt) return current
    if (!isBriefComplete(current)) {
      throw new Error(`Brief is missing required fields: ${missingBriefFields(current).join(', ')}`)
    }
    const locked: DesignBrief = { ...current, lockedAt: new Date().toISOString() }
    await this.writeCurrent(projectDir, locked)
    await this.snapshotVersion(projectDir, locked)
    return locked
  }

  /** Every version ever locked, oldest first - the brief panel's version history. Empty for a
   *  project that has never locked a brief. */
  async listVersions(projectDir: string): Promise<DesignBriefVersionSummary[]> {
    const dir = join(projectDir, BRIEF_DIRNAME, VERSIONS_DIRNAME)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }

    const versions = await Promise.all(
      entries
        .filter((name) => name.endsWith('.json'))
        .map(async (name): Promise<DesignBriefVersionSummary | null> => {
          try {
            const raw = await readFile(join(dir, name), 'utf-8')
            const brief = DesignBriefSchema.parse(JSON.parse(raw))
            return { version: brief.version, lockedAt: brief.lockedAt ?? '', brief }
          } catch {
            return null
          }
        })
    )
    return versions.filter((v): v is DesignBriefVersionSummary => v !== null).sort((a, b) => a.version - b.version)
  }

  // -- internal -------------------------------------------------------------

  private async readCurrent(projectDir: string): Promise<DesignBrief> {
    try {
      const raw = await readFile(join(projectDir, BRIEF_DIRNAME, BRIEF_FILENAME), 'utf-8')
      return DesignBriefSchema.parse(JSON.parse(raw))
    } catch {
      return emptyDesignBrief()
    }
  }

  private async writeCurrent(projectDir: string, brief: DesignBrief): Promise<void> {
    const dir = join(projectDir, BRIEF_DIRNAME)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, BRIEF_FILENAME), JSON.stringify(brief, null, 2), 'utf-8')
  }

  private async snapshotVersion(projectDir: string, brief: DesignBrief): Promise<void> {
    const dir = join(projectDir, BRIEF_DIRNAME, VERSIONS_DIRNAME)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `v${brief.version}.json`), JSON.stringify(brief, null, 2), 'utf-8')
  }
}
