import { copyFile, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentSettings, PersistedMessage, ProjectSummary } from '../../shared/ipc'

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
   * App-controlled, version-locked copy of the generating script (e.g. `outputs/versions/v3.py`),
   * made by `recordIteration()` at the moment the STL is displayed. Unlike `scriptPath` (the
   * agent-written `<part>_vN.py`, which the agent could in principle reuse or edit in place), this
   * snapshot is guaranteed to correspond to this iteration's STL - so reverting can rebase the
   * agent onto the exact script that produced the model. Optional so `project.json` files written
   * before this field existed still parse; readers fall back to `scriptPath`.
   */
  scriptSnapshotPath?: string
  summary: string
  at: string
}

export interface ProjectRecord {
  id: string
  name: string
  createdAt: string
  sessionId?: string
  agentModel?: AgentSettings['model']
  agentEffort?: AgentSettings['effort']
  iterations: ProjectIteration[]
  /** Durable chat transcript (R3.1) - user/assistant turns only; see `AgentSession`'s
   *  `flushAssistantBuffer` for why routine tool-activity narration isn't included. */
  messages: PersistedMessage[]
  /**
   * The `n` of the iteration currently considered "current" for display/export (R4 version
   * history + revert). Explicit rather than always-latest so `revertTo()` can point back at an
   * older generation without deleting or re-recording anything - the agent keeps working from
   * the live conversation and on-disk files (it never rewrites history), while this pointer is
   * what governs what the viewport shows and `model:export` copies. Undefined for a project with
   * no iterations yet; back-filled to the latest iteration's `n` for older `project.json` files
   * that predate this field (see `readRecord()`).
   */
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

/**
 * Owns every Voyager AI project: each one's on-disk layout under
 * `<baseDir>/<id>/`, the copy of the printable-cad skill it carries, and its
 * `project.json` bookkeeping (name, session id, model/effort, iteration
 * history, chat transcript) that survives app restarts. A small
 * `manifest.json` sibling to the per-project directories tracks which ids
 * exist and which one is active - see `bootstrapManifest()` for the
 * self-healing logic that also doubles as the migration path from the old
 * single-`'default'`-project layout (a `default/project.json` found on disk
 * with no manifest is simply "discovered" the same way any project would be).
 *
 * Contains no top-level `electron` import and takes all filesystem roots as
 * constructor options (mirrors `EnvManager`), so it is fully unit-testable
 * under plain Node/vitest. `src/main/ipc.ts` constructs this with
 * `app.getPath('userData')`-derived paths.
 */
export class ProjectStore {
  private readonly baseDir: string
  private readonly skillSourceDir: string

  /** The currently-active project's loaded record, once `ensureProject()` (or `createProject()`/
   *  `switchProject()`) has resolved at least once. Cleared only by being replaced - there is
   *  always exactly one "active" record once the store has been used. */
  private record: ProjectRecord | null = null

  constructor(options: ProjectStoreOptions) {
    this.baseDir = options.baseDir
    this.skillSourceDir = options.skillSourceDir
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

  /**
   * Records a new versioned iteration (called by the `display_model` MCP
   * tool once an export validates). The iteration number is computed here as
   * `latest + 1` so numbering is single-sourced - callers never pass `n`.
   */
  async recordIteration(entry: {
    stlPath: string
    stepPath?: string
    scriptPath: string
    summary: string
  }): Promise<ProjectIteration> {
    const record = await this.requireRecord()
    const n = (record.iterations.at(-1)?.n ?? 0) + 1
    const dir = this.dirFor(record.id)
    // Snapshot the generating script into an app-controlled, version-locked file so this
    // iteration's `.py` can never drift from its STL (the agent's own `<part>_vN.py` is only
    // convention). Forward-slash relative path to match how every other path in project.json is
    // stored. Throwing on a failed copy surfaces a clear error to the agent via `display_model`.
    const scriptSnapshotPath = `outputs/versions/v${n}.py`
    await mkdir(join(dir, 'outputs', 'versions'), { recursive: true })
    await copyFile(join(dir, entry.scriptPath), join(dir, scriptSnapshotPath))
    const iteration: ProjectIteration = { ...entry, scriptSnapshotPath, n, at: new Date().toISOString() }
    record.iterations.push(iteration)
    // A freshly-generated iteration always becomes the active/current one - if the user had
    // reverted to an older version and then asked Voyager to refine further, the new generation
    // supersedes it.
    record.activeIteration = n
    await this.writeRecord(this.dirFor(record.id), record)
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

  /** Most recent iteration, or null if the project has none yet. */
  async latestIteration(): Promise<ProjectIteration | null> {
    const record = await this.requireRecord()
    return record.iterations.at(-1) ?? null
  }

  /** Every iteration ever recorded for the active project, oldest first. A copy, not the live
   *  array - callers must go through `recordIteration()`/`revertTo()` to mutate it. */
  async listIterations(): Promise<ProjectIteration[]> {
    const record = await this.requireRecord()
    return [...record.iterations]
  }

  /**
   * The iteration that should currently be shown/exported (R4). Prefers the explicit
   * `activeIteration` pointer; falls back to `latestIteration()` for a project that predates
   * `revertTo()` ever having been called (or has no iterations at all). Use this - not
   * `latestIteration()` - anywhere "the current model" is needed.
   */
  async activeIterationRecord(): Promise<ProjectIteration | null> {
    const record = await this.requireRecord()
    if (record.activeIteration !== undefined) {
      const active = record.iterations.find((it) => it.n === record.activeIteration)
      if (active) return active
    }
    return record.iterations.at(-1) ?? null
  }

  /**
   * Points the active project's "current" iteration at an earlier (or later) generation without
   * deleting or re-recording anything - old STLs stay on disk and reachable. A subsequent
   * `recordIteration()` (i.e. the user asks Voyager to keep refining) supersedes this and again
   * becomes active, so continuing the conversation branches from whatever was last reverted to.
   * Throws if `n` doesn't name a known iteration.
   */
  async revertTo(n: number): Promise<ProjectIteration> {
    const record = await this.requireRecord()
    const iteration = record.iterations.find((it) => it.n === n)
    if (!iteration) {
      throw new Error(`Unknown iteration: v${n}`)
    }
    record.activeIteration = n
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
   * messages merged with system-status lines synthesized from `iterations`
   * (`Model vN displayed: ...`), sorted chronologically. Synthesizing from
   * `iterations` (already durable) rather than persisting a separate
   * model-displayed message keeps there from being two sources of truth for
   * the same fact.
   */
  async getChatHistory(): Promise<PersistedMessage[]> {
    const record = await this.requireRecord()
    const fromIterations: PersistedMessage[] = record.iterations.map((it) => ({
      id: `iteration-${it.n}`,
      role: 'system-status',
      text: `Model v${it.n} displayed: ${it.summary}`,
      createdAt: it.at
    }))
    return [...record.messages, ...fromIterations].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // -- internal -----------------------------------------------------------

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
    }

    let record = await this.readRecord(dir)
    if (!record) {
      record = { id, name, createdAt: new Date().toISOString(), iterations: [], messages: [] }
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
      const record = JSON.parse(raw) as ProjectRecord
      // Defends against a pre-R3 project.json with no `messages` field yet, and a pre-R4
      // project.json with no `activeIteration` pointer yet (defaults to "the latest one",
      // matching the pre-R4 always-latest behavior).
      return {
        ...record,
        messages: record.messages ?? [],
        activeIteration: record.activeIteration ?? record.iterations.at(-1)?.n
      }
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

function toSummary(record: ProjectRecord): ProjectSummary {
  return { id: record.id, name: record.name, createdAt: record.createdAt }
}
