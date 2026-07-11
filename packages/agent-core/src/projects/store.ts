import { copyFile, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  AgentSettings,
  IterationCreatedBy,
  PartRecord,
  PersistedMessage,
  Placement,
  ProjectSummary
} from '@shared/ipc'
import { identityPlacement, MAIN_PART_ID } from '@shared/ipc'

/**
 * One versioned export produced by the `display_model` MCP tool. Paths are
 * stored relative to the project directory (e.g. `outputs/bracket_v2.stl`)
 * so `project.json` stays portable if `baseDir` ever moves.
 */
export interface ProjectIteration {
  n: number
  stlPath: string
  stepPath?: string
  scriptPath: string
  /**
   * App-controlled, version-locked copy of the generating script (e.g. `outputs/versions/main/v3.py`),
   * made by `recordIteration()` at the moment the STL is displayed. Unlike `scriptPath` (the
   * agent-written `<part>_vN.py`, which the agent could in principle reuse or edit in place), this
   * snapshot is guaranteed to correspond to this iteration's STL - so reverting can rebase the
   * agent onto the exact script that produced the model. Optional so `project.json` files written
   * before this field existed still parse; readers fall back to `scriptPath`.
   */
  scriptSnapshotPath?: string
  summary: string
  at: string
  /** The Design Brief version locked at the moment this iteration was recorded, if any (WS-A,
   *  architecture doc §4.4: "the locked brief version is stamped onto every iteration it
   *  produces"). Undefined for an iteration recorded before a brief was ever locked. */
  briefVersion?: number
  /** How this iteration came to exist (WS-0c, architecture doc §8). WS-G stamps `'import'`, WS-B's
   *  param path `'param'`; a plain agent `display_model` leaves it undefined. */
  createdBy?: IterationCreatedBy
}

/**
 * One part of a project (WS-I, architecture doc §14): its own script lineage, iteration history,
 * active-iteration pointer, placement, and visibility. The on-disk superset of the renderer-safe
 * `PartRecord` (`src/shared/parts.ts`) - it additionally carries the full `iterations` array and a
 * `createdAt`, exactly as `ProjectIteration` is the on-disk superset of `IterationInfo`.
 */
export interface StoredPart {
  /** Stable slug, unique within the project. A migrated single-part project has one part, `main`. */
  id: string
  name: string
  createdAt: string
  iterations: ProjectIteration[]
  /**
   * The `n` of the iteration currently shown/exported for this part. Explicit rather than
   * always-latest so `revertTo()` can point back at an older generation per part. Undefined for a
   * part with no iterations yet; back-filled to the latest on read for records that predate it.
   */
  activeIteration?: number
  /** Layout in the shared build space (position + orientation), edited by the viewport gizmo.
   *  Layout only - never modifies the part's script or mesh (§14). */
  placement: Placement
  /** Whether the part is shown in the viewport (per-part visibility toggle). */
  visible: boolean
}

export interface ProjectRecord {
  id: string
  name: string
  createdAt: string
  sessionId?: string
  agentModel?: AgentSettings['model']
  agentEffort?: AgentSettings['effort']
  /**
   * The project's parts (WS-I, §14) - always ≥1 after migration. Replaces the pre-WS-I flat
   * top-level `iterations`/`activeIteration`, which `readRecord()` migrates into a single `main`
   * part (discover-don't-recreate, the same style the pre-R3 single-project migration used).
   */
  parts: StoredPart[]
  /**
   * Which part unscoped operations target: the model shown as "current", the part
   * `param:*`/`verification:get`/export/`revertTo` resolve against, and the default for a
   * `display_model` with no explicit part. A project-level pointer (like a part's `activeIteration`),
   * set by the last `display_model` and by `setActivePart()`. Back-filled to the first part on read.
   */
  activePartId?: string
  /** Durable chat transcript (R3.1) - user/assistant turns only; see `AgentSession`'s
   *  `flushAssistantBuffer` for why routine tool-activity narration isn't included. */
  messages: PersistedMessage[]
}

/** A `project.json` as it may exist on disk before the WS-I parts migration - flat top-level
 *  `iterations`/`activeIteration` and no `parts`. Used only by the migration in `readRecord()`. */
interface LegacyProjectRecord extends Omit<ProjectRecord, 'parts' | 'activePartId'> {
  parts?: StoredPart[]
  activePartId?: string
  iterations?: ProjectIteration[]
  activeIteration?: number
}

/** Applied whenever a project has no explicit model/effort recorded yet - matches the MVP's
 *  original hardcoded Opus + xhigh behavior. */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = { model: 'claude-opus-4-8', effort: 'xhigh' }

export interface ProjectStoreOptions {
  /** Root directory all projects live under, e.g. `<userData>/projects`. */
  baseDir: string
  /** Absolute path to the bundled `resources/skills/printable-cad` directory. */
  skillSourceDir: string
  /** Absolute path to the bundled `validate_stl.py` (owned by `packages/verify`) - copied into
   *  every project's skill copy at `scripts/validate_stl.py` since it lives outside
   *  `skillSourceDir` (see `packages/verify`'s single-source-of-truth ownership of the validator). */
  verifyScriptPath: string
  /** Absolute path to the bundled `extract_params.py` (owned by `packages/agent-core/params`) -
   *  copied into every project's skill copy at `scripts/extract_params.py`, mirroring
   *  `verifyScriptPath`, so the skill's Phase 4 can run it with a plain relative path. Optional
   *  (skips the copy when omitted) so existing callers/tests that predate WS-B keep compiling. */
  extractParamsScriptPath?: string
  /**
   * Fired at the end of every `recordIteration()` call - the single choke point every current
   * (agent `display_model`, WS-B's `param:update`) and future iteration path already goes
   * through, so verification (WS-C) hooks in here once instead of at each call site. Fire-and-
   * forget: `recordIteration()` does not await this, and the callback owns its own async work
   * and error handling (see `src/main/ipc.ts`'s wiring) - a slow or failing verification run must
   * never block or fail the display path.
   */
  onIterationRecorded?: (iteration: ProjectIteration, projectDir: string) => void
}

const SKILL_DIR_SEGMENTS = ['.claude', 'skills', 'printable-cad'] as const
const MANIFEST_FILENAME = 'manifest.json'

/** Tracks only ids/order - never display data (name, createdAt), which would duplicate what
 *  each project's own `project.json` already holds and could drift out of sync. */
interface Manifest {
  activeProjectId: string
  projectOrder: string[]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A part's active-iteration number: its explicit pointer, or the latest recorded, or null. */
function activeIterationNumber(part: StoredPart): number | null {
  if (part.activeIteration !== undefined && part.iterations.some((it) => it.n === part.activeIteration)) {
    return part.activeIteration
  }
  return part.iterations.at(-1)?.n ?? null
}

/** The renderer-safe view of a part (drops the full iteration history + createdAt). */
function toPartRecord(part: StoredPart): PartRecord {
  return {
    id: part.id,
    name: part.name,
    placement: part.placement,
    visible: part.visible,
    activeIteration: activeIterationNumber(part)
  }
}

/** A blank part (no iterations), placed at the origin and visible. */
function freshPart(id: string, name: string, createdAt: string): StoredPart {
  return { id, name, createdAt, iterations: [], placement: identityPlacement(), visible: true }
}

/** A human-ish default name for an agent-created part slug (`lid` -> `Lid`, `main` -> `Main`). */
function defaultPartName(partId: string): string {
  if (!partId) return 'Part'
  return partId.charAt(0).toUpperCase() + partId.slice(1)
}

/**
 * Normalizes an agent- or import-supplied part id into a safe filesystem slug. Part ids become
 * directory names (`outputs/versions/<partId>/`), so this is also the guard that keeps a hostile or
 * sloppy id (`../escape`, `a/b`, spaces) from escaping the project dir: lowercased, every run of
 * non-`[a-z0-9]` collapsed to a single `-`, leading/trailing `-` stripped, falling back to `part`.
 */
export function slugifyPartId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'part'
}

/**
 * Owns every Voyager AI project: each one's on-disk layout under
 * `<baseDir>/<id>/`, the copy of the printable-cad skill it carries, and its
 * `project.json` bookkeeping (name, session id, model/effort, parts + their
 * iteration histories, chat transcript) that survives app restarts. A small
 * `manifest.json` sibling to the per-project directories tracks which ids
 * exist and which one is active - see `bootstrapManifest()` for the
 * self-healing logic that also doubles as the migration path from the old
 * single-`'default'`-project layout (a `default/project.json` found on disk
 * with no manifest is simply "discovered" the same way any project would be).
 *
 * Multi-part (WS-I, §14): a project holds `parts`, each with its own iteration
 * history and active pointer. Every unscoped method (`recordIteration`,
 * `activeIterationRecord`, `listIterations`, `revertTo`, `latestIteration`)
 * operates on the **active part** by default, preserving pre-WS-I single-part
 * behavior for existing callers; pass a `partId` to target a specific part.
 *
 * Contains no top-level `electron` import and takes all filesystem roots as
 * constructor options (mirrors `EnvManager`), so it is fully unit-testable
 * under plain Node/vitest. `src/main/ipc.ts` constructs this with
 * `app.getPath('userData')`-derived paths.
 */
export class ProjectStore {
  private readonly baseDir: string
  private readonly skillSourceDir: string
  private readonly verifyScriptPath: string
  private readonly extractParamsScriptPath?: string
  private readonly onIterationRecorded?: (iteration: ProjectIteration, projectDir: string) => void

  /** The currently-active project's loaded record, once `ensureProject()` (or `createProject()`/
   *  `switchProject()`) has resolved at least once. Cleared only by being replaced - there is
   *  always exactly one "active" record once the store has been used. */
  private record: ProjectRecord | null = null

  constructor(options: ProjectStoreOptions) {
    this.baseDir = options.baseDir
    this.skillSourceDir = options.skillSourceDir
    this.verifyScriptPath = options.verifyScriptPath
    this.extractParamsScriptPath = options.extractParamsScriptPath
    this.onIterationRecorded = options.onIterationRecorded
  }

  private dirFor(id: string): string {
    return join(this.baseDir, id)
  }

  /**
   * Absolute path to the active project directory. Throws if
   * `ensureProject()` has not resolved yet - callers that need this
   * synchronously (e.g. building `cwd` for the agent SDK) must have already
   * awaited `ensureProject()` earlier in the same flow.
   */
  getProjectDir(): string {
    if (!this.record) {
      throw new Error('ProjectStore.getProjectDir() called before ensureProject() resolved')
    }
    return this.dirFor(this.record.id)
  }

  /** The active project's id. Same throws-before-ensure contract as `getProjectDir()`. */
  getActiveProjectId(): string {
    if (!this.record) {
      throw new Error('ProjectStore.getActiveProjectId() called before ensureProject() resolved')
    }
    return this.record.id
  }

  /**
   * Ensures the active project's directory, `outputs/` subdirectory, and
   * bundled skill copy exist, and that `project.json` is present - creating
   * everything (including a first-ever project, on a totally fresh install)
   * on first call. Cheap on every call after: once `this.record` is loaded,
   * later calls just return it - `switchProject()`/`createProject()` are what
   * update `this.record` when the active project actually changes, so this
   * never needs to re-check the manifest itself. Safe to call repeatedly.
   */
  async ensureProject(): Promise<{ id: string; dir: string }> {
    if (this.record) {
      return { id: this.record.id, dir: this.dirFor(this.record.id) }
    }
    const manifest = await this.bootstrapManifest()
    this.record = await this.materializeProject(manifest.activeProjectId, 'Untitled project')
    return { id: this.record.id, dir: this.dirFor(this.record.id) }
  }

  /** Every known project, in stable (creation/discovery) order. */
  async listProjects(): Promise<ProjectSummary[]> {
    const manifest = await this.bootstrapManifest()
    const records = await Promise.all(manifest.projectOrder.map((id) => this.readRecord(this.dirFor(id))))
    return records.filter((r): r is ProjectRecord => r !== null).map(toSummary)
  }

  /** Creates a brand-new project, materializes its on-disk layout, and makes it active. */
  async createProject(name?: string): Promise<ProjectSummary> {
    const manifest = await this.bootstrapManifest()
    const id = randomUUID()
    const record = await this.materializeProject(id, name?.trim() || 'Untitled project')
    manifest.projectOrder.push(id)
    manifest.activeProjectId = id
    await this.writeManifest(manifest)
    this.record = record
    return toSummary(record)
  }

  /** Switches the active project. Throws if `id` isn't a known project. */
  async switchProject(id: string): Promise<ProjectSummary> {
    const manifest = await this.bootstrapManifest()
    if (!manifest.projectOrder.includes(id)) {
      throw new Error(`Unknown project: ${id}`)
    }
    manifest.activeProjectId = id
    await this.writeManifest(manifest)
    this.record = await this.materializeProject(id, 'Untitled project')
    return toSummary(this.record)
  }

  /** Renames any project by id (not just the active one). Throws if `id` isn't known. */
  async renameProject(id: string, name: string): Promise<ProjectSummary> {
    const dir = this.dirFor(id)
    const record = await this.readRecord(dir)
    if (!record) {
      throw new Error(`Unknown project: ${id}`)
    }
    const trimmed = name.trim()
    if (trimmed) record.name = trimmed
    await this.writeRecord(dir, record)
    if (this.record?.id === id) this.record = record
    return toSummary(record)
  }

  // -- parts (WS-I, §14) --------------------------------------------------

  /** Every part in the active project, in creation order (renderer-safe view). */
  async listParts(): Promise<PartRecord[]> {
    const record = await this.requireRecord()
    return record.parts.map(toPartRecord)
  }

  /** The active part's id - the part unscoped operations target. */
  async getActivePartId(): Promise<string> {
    const record = await this.requireRecord()
    return this.activePart(record).id
  }

  /** Makes `partId` the active part. Throws if `partId` isn't a known part. */
  async setActivePart(partId: string): Promise<PartRecord[]> {
    const record = await this.requireRecord()
    if (!record.parts.some((p) => p.id === partId)) {
      throw new Error(`Unknown part: ${partId}`)
    }
    record.activePartId = partId
    await this.writeRecord(this.dirFor(record.id), record)
    return record.parts.map(toPartRecord)
  }

  /** Persists a part's placement (layout only - never touches its script/mesh). Throws if unknown. */
  async setPlacement(partId: string, placement: Placement): Promise<PartRecord[]> {
    const record = await this.requireRecord()
    const part = record.parts.find((p) => p.id === partId)
    if (!part) throw new Error(`Unknown part: ${partId}`)
    part.placement = placement
    await this.writeRecord(this.dirFor(record.id), record)
    return record.parts.map(toPartRecord)
  }

  /** Shows/hides a part in the viewport. Throws if `partId` isn't a known part. */
  async setVisibility(partId: string, visible: boolean): Promise<PartRecord[]> {
    const record = await this.requireRecord()
    const part = record.parts.find((p) => p.id === partId)
    if (!part) throw new Error(`Unknown part: ${partId}`)
    part.visible = visible
    await this.writeRecord(this.dirFor(record.id), record)
    return record.parts.map(toPartRecord)
  }

  /**
   * Duplicates a part: a new part with a `-copy` id/name suffix (uniqued against existing ids),
   * a deep copy of the source's iteration history and active-iteration pointer, and a placement
   * offset on the plate so the copy doesn't sit inside its source. The copied iteration records
   * reference the *same* on-disk artifacts as the source - safe because iterations are immutable
   * (never overwritten or deleted), so a duplicate costs no file copies. From there the copy's
   * history diverges independently (a param edit or agent refinement records into the copy only).
   * The duplicate becomes the active part (the user duplicates in order to arrange/refine it
   * next) and is always born visible, even from a hidden source. Throws if `partId` isn't known.
   */
  async duplicatePart(partId: string): Promise<PartRecord[]> {
    const record = await this.requireRecord()
    const source = record.parts.find((p) => p.id === partId)
    if (!source) throw new Error(`Unknown part: ${partId}`)

    const existingIds = new Set(record.parts.map((p) => p.id))
    let id = `${source.id}-copy`
    let name = `${source.name} copy`
    for (let n = 2; existingIds.has(id); n++) {
      id = `${source.id}-copy-${n}`
      name = `${source.name} copy ${n}`
    }

    const copy: StoredPart = {
      id,
      name,
      createdAt: new Date().toISOString(),
      iterations: structuredClone(source.iterations),
      activeIteration: source.activeIteration,
      // Diagonal plate offset (world x/z; index 1 is the ground-clamped height) so the duplicate
      // appears next to its source instead of z-fighting inside it.
      placement: {
        position: [source.placement.position[0] + 25, source.placement.position[1], source.placement.position[2] + 25],
        rotation: [source.placement.rotation[0], source.placement.rotation[1], source.placement.rotation[2]]
      },
      visible: true
    }
    record.parts.push(copy)
    record.activePartId = id
    await this.writeRecord(this.dirFor(record.id), record)
    return record.parts.map(toPartRecord)
  }

  /**
   * Records a new versioned iteration for a part (called by the `display_model`
   * MCP tool once an export validates, and by WS-B's `param:update`). The part
   * is `entry.partId` (created on first use with `entry.partName`), or the
   * active part when omitted; it becomes the active part. The iteration number
   * is per-part (`latest + 1` within that part) so numbering is single-sourced.
   */
  async recordIteration(entry: {
    stlPath: string
    stepPath?: string
    scriptPath: string
    summary: string
    briefVersion?: number
    /** Provenance of this iteration (WS-0c) - passed through onto the recorded `ProjectIteration`.
     *  Undefined for a plain agent `display_model` call. */
    createdBy?: IterationCreatedBy
    /** Which part to record into (WS-I); defaults to the active part. Created on first use. */
    partId?: string
    /** Display name to give the part if it's created on first use (ignored for an existing part). */
    partName?: string
  }): Promise<ProjectIteration> {
    const record = await this.requireRecord()
    // Slugify a caller-supplied id (path-traversal guard - it becomes a directory name below); the
    // active part's own id is already a slug, so this is idempotent for the default case.
    const partId = entry.partId !== undefined ? slugifyPartId(entry.partId) : this.activePart(record).id
    const existing = record.parts.find((p) => p.id === partId)

    const n = (existing?.iterations.at(-1)?.n ?? 0) + 1
    const dir = this.dirFor(record.id)
    // Snapshot the generating script into an app-controlled, version-locked file so this
    // iteration's `.py` can never drift from its STL (the agent's own `<part>_vN.py` is only
    // convention). Part-scoped (`outputs/versions/<partId>/`) so two parts' v1 snapshots can't
    // collide. Forward-slash relative path to match how every other path in project.json is stored.
    // Copy BEFORE mutating the record so a failed copy (disk full, permission) can't leave a
    // phantom, never-persisted part or iteration in the in-memory record.
    const scriptSnapshotPath = `outputs/versions/${partId}/v${n}.py`
    await mkdir(join(dir, 'outputs', 'versions', partId), { recursive: true })
    await copyFile(join(dir, entry.scriptPath), join(dir, scriptSnapshotPath))

    const iteration: ProjectIteration = {
      stlPath: entry.stlPath,
      stepPath: entry.stepPath,
      scriptPath: entry.scriptPath,
      summary: entry.summary,
      briefVersion: entry.briefVersion,
      createdBy: entry.createdBy,
      scriptSnapshotPath,
      n,
      at: new Date().toISOString()
    }
    // Copy succeeded - now safe to mutate + persist the record (creating the part on first use).
    const part = existing ?? freshPart(partId, entry.partName ?? defaultPartName(partId), new Date().toISOString())
    part.iterations.push(iteration)
    // A freshly-generated iteration always becomes its part's active/current one, and that part
    // becomes the project's active part - if the user had reverted or focused elsewhere and then
    // asked Voyager to refine this part, the new generation supersedes it and pulls focus.
    part.activeIteration = n
    if (!existing) record.parts.push(part)
    record.activePartId = partId
    await this.writeRecord(dir, record)
    // Guarded, not just fire-and-forget: the iteration is already persisted and active at this
    // point, so a hook that throws *synchronously* (rather than rejecting a promise it started)
    // must not turn into a rejected `recordIteration()` and make display_model/param:update
    // report failure for a write that actually succeeded.
    try {
      this.onIterationRecorded?.(iteration, dir)
    } catch {
      // The hook owns its own error handling/logging - see its doc comment above.
    }
    return iteration
  }

  /** Persists the Claude Agent SDK session id for `resume` on next launch. */
  async setSessionId(sessionId: string): Promise<void> {
    const record = await this.requireRecord()
    record.sessionId = sessionId
    await this.writeRecord(this.dirFor(record.id), record)
  }

  /** The persisted session id, if any - used to `resume` on restart. */
  async getSessionId(): Promise<string | undefined> {
    const record = await this.requireRecord()
    return record.sessionId
  }

  /** Persists the user's model/effort choice; applied by `AgentSession` on the next turn. */
  async setAgentSettings(settings: AgentSettings): Promise<void> {
    const record = await this.requireRecord()
    record.agentModel = settings.model
    record.agentEffort = settings.effort
    await this.writeRecord(this.dirFor(record.id), record)
  }

  /** The project's model/effort choice, defaulting to `DEFAULT_AGENT_SETTINGS` when unset. */
  async getAgentSettings(): Promise<AgentSettings> {
    const record = await this.requireRecord()
    return {
      model: record.agentModel ?? DEFAULT_AGENT_SETTINGS.model,
      effort: record.agentEffort ?? DEFAULT_AGENT_SETTINGS.effort
    }
  }

  /** Most recent iteration of `partId` (default: the active part), or null if it has none yet. */
  async latestIteration(partId?: string): Promise<ProjectIteration | null> {
    const record = await this.requireRecord()
    const part = this.resolvePart(record, partId)
    return part?.iterations.at(-1) ?? null
  }

  /** Every iteration ever recorded for `partId` (default: the active part), oldest first. A copy,
   *  not the live array - callers go through `recordIteration()`/`revertTo()` to mutate it. */
  async listIterations(partId?: string): Promise<ProjectIteration[]> {
    const record = await this.requireRecord()
    const part = this.resolvePart(record, partId)
    return part ? [...part.iterations] : []
  }

  /**
   * The iteration that should currently be shown/exported for `partId` (default: the active part).
   * Prefers the part's explicit `activeIteration` pointer; falls back to its latest. Use this - not
   * `latestIteration()` - anywhere "the current model" is needed.
   */
  async activeIterationRecord(partId?: string): Promise<ProjectIteration | null> {
    const record = await this.requireRecord()
    const part = this.resolvePart(record, partId)
    if (!part) return null
    if (part.activeIteration !== undefined) {
      const active = part.iterations.find((it) => it.n === part.activeIteration)
      if (active) return active
    }
    return part.iterations.at(-1) ?? null
  }

  /**
   * Points a part's "current" iteration at an earlier (or later) generation without deleting or
   * re-recording anything - old STLs stay on disk and reachable. Reverts `partId` (default: the
   * active part) and makes it the active part. A subsequent `recordIteration()` supersedes this and
   * again becomes active. Throws if `n` doesn't name a known iteration of that part.
   */
  async revertTo(n: number, partId?: string): Promise<ProjectIteration> {
    const record = await this.requireRecord()
    const part = this.resolvePart(record, partId)
    const iteration = part?.iterations.find((it) => it.n === n)
    if (!part || !iteration) {
      throw new Error(`Unknown iteration: v${n}`)
    }
    part.activeIteration = n
    record.activePartId = part.id
    await this.writeRecord(this.dirFor(record.id), record)
    return iteration
  }

  /** Appends one durable chat entry (user or assistant text) - see `AgentSession`. */
  async appendMessage(message: PersistedMessage): Promise<void> {
    const record = await this.requireRecord()
    record.messages.push(message)
    await this.writeRecord(this.dirFor(record.id), record)
  }

  /**
   * The active project's full restorable history: persisted user/assistant
   * messages merged with system-status lines synthesized from every part's
   * `iterations` (`Model vN displayed: ...`, tagged with the part name once a
   * project has more than one part), sorted chronologically. Synthesizing from
   * `iterations` (already durable) rather than persisting a separate
   * model-displayed message keeps there from being two sources of truth for
   * the same fact.
   */
  async getChatHistory(): Promise<PersistedMessage[]> {
    const record = await this.requireRecord()
    const multiPart = record.parts.length > 1
    const fromIterations: PersistedMessage[] = record.parts.flatMap((part) =>
      part.iterations.map((it) => ({
        id: `iteration-${part.id}-${it.n}`,
        role: 'system-status' as const,
        text: multiPart
          ? `Model v${it.n} displayed (${part.name}): ${it.summary}`
          : `Model v${it.n} displayed: ${it.summary}`,
        createdAt: it.at
      }))
    )
    return [...record.messages, ...fromIterations].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // -- internal -----------------------------------------------------------

  /** The active part: the one named by `activePartId`, or the first part as a fallback. */
  private activePart(record: ProjectRecord): StoredPart {
    return record.parts.find((p) => p.id === record.activePartId) ?? record.parts[0]
  }

  /** Resolves an explicit `partId` (or the active part when omitted) to a `StoredPart`. */
  private resolvePart(record: ProjectRecord, partId?: string): StoredPart | undefined {
    if (partId !== undefined) return record.parts.find((p) => p.id === partId)
    return this.activePart(record)
  }

  /**
   * Reads `manifest.json` (defaulting to empty), reconciles `projectOrder`
   * against what's actually on disk (drops ids no longer present, appends
   * ids found on disk but unlisted), creates a first project if none exist
   * anywhere, and fixes up `activeProjectId` if it no longer names a listed
   * project. Writes the reconciled manifest back before returning it. This
   * single function is both the manifest bootstrap AND the migration path:
   * a pre-R3 install's `default/project.json` with no manifest yet is just
   * "discovered" here, the same code path a fresh install's empty `baseDir`
   * takes when it finds nothing and creates `'default'` itself.
   */
  private async bootstrapManifest(): Promise<Manifest> {
    let manifest: Manifest
    try {
      const raw = await readFile(join(this.baseDir, MANIFEST_FILENAME), 'utf-8')
      manifest = JSON.parse(raw) as Manifest
    } catch {
      manifest = { activeProjectId: '', projectOrder: [] }
    }

    const onDisk = await this.discoverProjectIds()
    const stillPresent = manifest.projectOrder.filter((id) => onDisk.includes(id))
    const discovered = onDisk.filter((id) => !stillPresent.includes(id))
    manifest.projectOrder = [...stillPresent, ...discovered]

    if (manifest.projectOrder.length === 0) {
      // Keep id 'default' for the very first project (fresh install or not) rather than a
      // random id - it's never user-visible, and it keeps this the same code path a pre-R3
      // install's existing 'default' dir would take (discovered above, not created here).
      await this.materializeProject('default', 'Untitled project')
      manifest.projectOrder = ['default']
    }
    if (!manifest.projectOrder.includes(manifest.activeProjectId)) {
      manifest.activeProjectId = manifest.projectOrder[0]
    }

    await this.writeManifest(manifest)
    return manifest
  }

  /** Project ids on disk: subdirectories of `baseDir` that contain a `project.json`. */
  private async discoverProjectIds(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true })
    } catch {
      return []
    }
    const ids: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory() && (await pathExists(join(this.baseDir, entry.name, 'project.json')))) {
        ids.push(entry.name)
      }
    }
    return ids
  }

  /**
   * Ensures one project's directory, `outputs/` subdirectory, and bundled
   * skill copy exist on disk, creating `project.json` (with `name` as given)
   * if it isn't already there. Idempotent - safe to call for a project that
   * already fully exists, which is exactly how `switchProject()` uses it to
   * (cheaply) guarantee the target is ready without a separate code path.
   */
  private async materializeProject(id: string, name: string): Promise<ProjectRecord> {
    const dir = this.dirFor(id)
    await mkdir(join(dir, 'outputs'), { recursive: true })

    const skillDestDir = join(dir, ...SKILL_DIR_SEGMENTS)
    if (!(await pathExists(skillDestDir))) {
      await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
      await cp(this.skillSourceDir, skillDestDir, { recursive: true })
      // The validator lives in packages/verify (single source of truth for verification), not
      // under skillSourceDir - copy it into the same scripts/ location the skill's Phase 5
      // documents (`python scripts/validate_stl.py ...`) so the on-disk layout the agent sees is
      // unchanged even though the file's real origin moved. mkdir first: skillSourceDir isn't
      // guaranteed to already have a scripts/ subdirectory (e.g. a skill with no other scripts).
      await mkdir(join(skillDestDir, 'scripts'), { recursive: true })
      await copyFile(this.verifyScriptPath, join(skillDestDir, 'scripts', 'validate_stl.py'))
      // Same reasoning as validate_stl.py above: the PARAMS extractor's source of truth is
      // packages/agent-core/params (WS-B), not skillSourceDir, but the skill's Phase 4 documents
      // running it as `python scripts/extract_params.py ...` so it needs to land at that path too.
      if (this.extractParamsScriptPath) {
        await copyFile(this.extractParamsScriptPath, join(skillDestDir, 'scripts', 'extract_params.py'))
      }
    }

    let record = await this.readRecord(dir)
    if (!record) {
      const now = new Date().toISOString()
      record = {
        id,
        name,
        createdAt: now,
        parts: [freshPart(MAIN_PART_ID, 'Main', now)],
        activePartId: MAIN_PART_ID,
        messages: []
      }
      await this.writeRecord(dir, record)
    }
    return record
  }

  private async requireRecord(): Promise<ProjectRecord> {
    await this.ensureProject()
    if (!this.record) {
      throw new Error('ProjectStore: project.json failed to load after ensureProject()')
    }
    return this.record
  }

  private async readRecord(dir: string): Promise<ProjectRecord | null> {
    try {
      const raw = await readFile(join(dir, 'project.json'), 'utf-8')
      return migrateRecord(JSON.parse(raw) as LegacyProjectRecord)
    } catch {
      return null
    }
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await writeFile(join(this.baseDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  private async writeRecord(dir: string, record: ProjectRecord): Promise<void> {
    await writeFile(join(dir, 'project.json'), JSON.stringify(record, null, 2), 'utf-8')
  }
}

/**
 * Normalizes a `project.json` into the current `ProjectRecord` shape (WS-I migration).
 * - Defends against a pre-R3 record with no `messages` field.
 * - A record that already has `parts` (WS-I+) is back-filled with an `activePartId` and each
 *   part's `activeIteration` (both default to "the latest", matching pre-explicit-pointer behavior).
 * - A pre-WS-I record (flat top-level `iterations`/`activeIteration`, no `parts`) is migrated into a
 *   single `main` part carrying those iterations (discover-don't-recreate, §14) - the old top-level
 *   fields are dropped from the returned shape. Ephemeral (not persisted until the next write),
 *   mirroring how the pre-R4 `activeIteration` back-fill worked.
 */
function migrateRecord(parsed: LegacyProjectRecord): ProjectRecord {
  const messages = parsed.messages ?? []

  if (parsed.parts && parsed.parts.length > 0) {
    const parts = parsed.parts.map((part) => {
      // Defend against a malformed part missing `iterations` - a bare deref would throw, which
      // `readRecord`'s catch turns into `null`, which `materializeProject` then "recovers" by
      // overwriting the file with a fresh empty project (data loss). Coerce instead.
      const iterations = part.iterations ?? []
      return {
        ...part,
        iterations,
        placement: part.placement ?? identityPlacement(),
        visible: part.visible ?? true,
        activeIteration: part.activeIteration ?? iterations.at(-1)?.n
      }
    })
    return {
      id: parsed.id,
      name: parsed.name,
      createdAt: parsed.createdAt,
      sessionId: parsed.sessionId,
      agentModel: parsed.agentModel,
      agentEffort: parsed.agentEffort,
      parts,
      activePartId: parsed.activePartId ?? parts[0].id,
      messages
    }
  }

  const iterations = parsed.iterations ?? []
  const mainPart: StoredPart = {
    id: MAIN_PART_ID,
    name: 'Main',
    createdAt: parsed.createdAt,
    iterations,
    activeIteration: parsed.activeIteration ?? iterations.at(-1)?.n,
    placement: identityPlacement(),
    visible: true
  }
  return {
    id: parsed.id,
    name: parsed.name,
    createdAt: parsed.createdAt,
    sessionId: parsed.sessionId,
    agentModel: parsed.agentModel,
    agentEffort: parsed.agentEffort,
    parts: [mainPart],
    activePartId: MAIN_PART_ID,
    messages
  }
}

function toSummary(record: ProjectRecord): ProjectSummary {
  return { id: record.id, name: record.name, createdAt: record.createdAt }
}
