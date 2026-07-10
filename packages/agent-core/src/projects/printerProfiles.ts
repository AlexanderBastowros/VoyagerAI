import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PrinterProfileRefSchema } from '@shared/ipc'
import type { PrinterProfileRef } from '@shared/ipc'

const PROFILES_FILENAME = 'printer-profiles.json'

/** On-disk shape - deliberately identical to the `printerProfile:*` IPC responses
 *  (`PrinterProfileListResponse`), so handlers return reads/mutation results verbatim. */
const PrinterProfileFileSchema = z.object({
  profiles: z.array(PrinterProfileRefSchema),
  activeId: z.string().nullable()
})

/** Every saved profile plus which one is active (null when none is). Structurally the same as
 *  `PrinterProfileListResponse` in `src/shared/ipc.ts`; redeclared here so this module doesn't
 *  depend on the IPC-surface names for its own domain type. */
export interface PrinterProfileList {
  profiles: PrinterProfileRef[]
  activeId: string | null
}

export interface PrinterProfileStoreOptions {
  /**
   * Directory the profiles file lives in, e.g. `app.getPath('userData')`. Profiles are app-level
   * user settings (product doc §4.4: per printer, per user - not per project), so unlike
   * `BriefStore` there is no per-call project dir; the one storage root is injected here.
   */
  baseDir: string
}

const EMPTY_LIST: PrinterProfileList = { profiles: [], activeId: null }

/** Lowercased, dash-separated id derived from the profile name, e.g. "Prusa MK4!" -> "prusa-mk4". */
function slugifyProfileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'printer'
}

function uniqueProfileId(name: string, taken: ReadonlySet<string>): string {
  const base = slugifyProfileName(name)
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Persists the user's printer profiles (WS-E, product doc §4.4) as one app-level JSON file,
 * `<baseDir>/printer-profiles.json` - bed size, nozzle diameter, and materials on hand are
 * settings, not per-project questions. Consumers: the `printerProfile:*` IPC handlers (settings
 * panel), `AgentSession` (the active profile pre-answers the skill's Phase-1 printer questions),
 * and `verifyIteration` in `src/main/ipc.ts` (layer-2 bed-fit falls back to the active profile
 * when the brief never recorded a printer).
 *
 * Follows the house store pattern (`BriefStore`, `ProjectStore`): plain `node:fs/promises`, no
 * `electron` imports, storage root injected via options, zod-validated reads that fall back to an
 * empty default on any parse failure. Mutations are serialized through an internal promise chain
 * so concurrent writers (the settings panel and the agent's `save_printer_profile` tool) can't
 * interleave their read-modify-write cycles.
 */
export class PrinterProfileStore {
  private readonly baseDir: string
  private readonly filePath: string
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: PrinterProfileStoreOptions) {
    this.baseDir = options.baseDir
    this.filePath = join(options.baseDir, PROFILES_FILENAME)
  }

  async list(): Promise<PrinterProfileList> {
    return this.read()
  }

  /** The profile `activeId` points at, or null when none is set (or it dangles). */
  async getActive(): Promise<PrinterProfileRef | null> {
    const { profiles, activeId } = await this.read()
    return profiles.find((profile) => profile.id === activeId) ?? null
  }

  /**
   * Upserts one profile and returns the full refreshed list. An empty `id` means "new" - the
   * store derives a unique slug id from the name. A newly added profile (or any save while
   * nothing is active) becomes the active one: saving a printer means you're about to use it,
   * and the panel/agent flows both expect the fresh save to take effect without a second
   * set-active step. Saving over an existing profile never steals the active slot.
   */
  async save(profile: PrinterProfileRef): Promise<PrinterProfileList> {
    return this.enqueue(async () => {
      const normalized = normalizeProfile(profile)
      const current = await this.read()

      const existingIndex = normalized.id
        ? current.profiles.findIndex((p) => p.id === normalized.id)
        : -1
      const saved: PrinterProfileRef = {
        ...normalized,
        id:
          existingIndex >= 0
            ? normalized.id
            : uniqueProfileId(normalized.name, new Set(current.profiles.map((p) => p.id)))
      }

      const profiles =
        existingIndex >= 0
          ? current.profiles.map((p, i) => (i === existingIndex ? saved : p))
          : [...current.profiles, saved]
      const isNew = existingIndex < 0
      const next: PrinterProfileList = {
        profiles,
        activeId: isNew || current.activeId === null ? saved.id : current.activeId
      }

      await this.write(next)
      return next
    })
  }

  /** Points `activeId` at an already-saved profile. Throws on an unknown id. */
  async setActive(id: string): Promise<PrinterProfileList> {
    return this.enqueue(async () => {
      const current = await this.read()
      if (!current.profiles.some((profile) => profile.id === id)) {
        throw new Error(`Unknown printer profile: ${id}`)
      }
      const next: PrinterProfileList = { ...current, activeId: id }
      await this.write(next)
      return next
    })
  }

  // -- internal -------------------------------------------------------------

  /** Runs mutations one at a time, in call order, regardless of earlier failures. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.chain.then(op, op)
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async read(): Promise<PrinterProfileList> {
    let parsed: PrinterProfileList
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      parsed = PrinterProfileFileSchema.parse(JSON.parse(raw))
    } catch {
      return EMPTY_LIST
    }
    // A dangling pointer (e.g. a hand-edited file) reads as "no active profile" rather than
    // erroring - repaired on read only; the next mutation persists whatever it computes.
    if (parsed.activeId !== null && !parsed.profiles.some((p) => p.id === parsed.activeId)) {
      return { ...parsed, activeId: null }
    }
    return parsed
  }

  private async write(list: PrinterProfileList): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await writeFile(this.filePath, JSON.stringify(list, null, 2), 'utf-8')
  }
}

/**
 * Shape-validates and tidies a profile before persisting: trimmed non-empty name, positive finite
 * bed/nozzle dimensions (data sanity, not DFM thresholds - those live in design-for-printing.md),
 * and trimmed non-empty material names. Throws with a user-showable message; the IPC handler
 * surfaces it as a rejected promise and the MCP tool as an error result.
 */
function normalizeProfile(profile: PrinterProfileRef): PrinterProfileRef {
  const parsed = PrinterProfileRefSchema.parse(profile)
  const name = parsed.name.trim()
  if (!name) throw new Error('The printer profile needs a name.')

  const dims: Array<[string, number]> = [
    ['bed X', parsed.bedXMm],
    ['bed Y', parsed.bedYMm],
    ['bed Z', parsed.bedZMm],
    ['nozzle diameter', parsed.nozzleDiameterMm]
  ]
  for (const [label, value] of dims) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`The printer profile's ${label} must be a positive number of millimeters.`)
    }
  }

  return {
    ...parsed,
    name,
    materials: parsed.materials.map((m) => m.trim()).filter((m) => m.length > 0)
  }
}
