import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  summary: string
  at: string
}

export interface ProjectRecord {
  id: string
  name: string
  createdAt: string
  sessionId?: string
  iterations: ProjectIteration[]
}

export interface ProjectStoreOptions {
  /** Root directory all projects live under, e.g. `<userData>/projects`. */
  baseDir: string
  /** Absolute path to the bundled `resources/skills/printable-cad` directory. */
  skillSourceDir: string
}

const SKILL_DIR_SEGMENTS = ['.claude', 'skills', 'printable-cad'] as const

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Owns the (for M3's MVP) single active Voyager AI project: its on-disk
 * layout under `<baseDir>/<id>/`, the copy of the printable-cad skill it
 * carries, and the `project.json` bookkeeping (session id + iteration
 * history) that survives app restarts.
 *
 * Contains no top-level `electron` import and takes all filesystem roots as
 * constructor options (mirrors `EnvManager`), so it is fully unit-testable
 * under plain Node/vitest. `src/main/ipc.ts` constructs this with
 * `app.getPath('userData')`-derived paths.
 *
 * MVP note: there is exactly one project, with a fixed id ('default'). A
 * later milestone that adds multi-project support would replace the fixed
 * id with a real generator plus a "which project is active" pointer file.
 */
export class ProjectStore {
  private readonly baseDir: string
  private readonly skillSourceDir: string
  private readonly activeProjectId = 'default'

  private record: ProjectRecord | null = null
  private ensured: Promise<{ id: string; dir: string }> | null = null

  constructor(options: ProjectStoreOptions) {
    this.baseDir = options.baseDir
    this.skillSourceDir = options.skillSourceDir
  }

  /** Directory of the active project, e.g. `<baseDir>/default`. No I/O. */
  private dir(): string {
    return join(this.baseDir, this.activeProjectId)
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
    return this.dir()
  }

  /**
   * Ensures the active project's directory, `outputs/` subdirectory, and
   * bundled skill copy exist, and that `project.json` is present - creating
   * everything on first call, and cheaply no-op'ing (beyond a stat + a JSON
   * read) on every call after. Safe to call repeatedly/concurrently.
   */
  async ensureProject(): Promise<{ id: string; dir: string }> {
    if (!this.ensured) {
      this.ensured = this.runEnsureProject()
    }
    return this.ensured
  }

  private async runEnsureProject(): Promise<{ id: string; dir: string }> {
    const dir = this.dir()
    await mkdir(join(dir, 'outputs'), { recursive: true })

    const skillDestDir = join(dir, ...SKILL_DIR_SEGMENTS)
    if (!(await pathExists(skillDestDir))) {
      await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
      await cp(this.skillSourceDir, skillDestDir, { recursive: true })
    }

    this.record = await this.readRecord(dir)
    if (!this.record) {
      this.record = {
        id: this.activeProjectId,
        name: 'Untitled project',
        createdAt: new Date().toISOString(),
        iterations: []
      }
      await this.writeRecord(dir, this.record)
    }

    return { id: this.activeProjectId, dir }
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
    const iteration: ProjectIteration = { ...entry, n, at: new Date().toISOString() }
    record.iterations.push(iteration)
    await this.writeRecord(this.dir(), record)
    return iteration
  }

  /** Persists the Claude Agent SDK session id for `resume` on next launch. */
  async setSessionId(sessionId: string): Promise<void> {
    const record = await this.requireRecord()
    record.sessionId = sessionId
    await this.writeRecord(this.dir(), record)
  }

  /** The persisted session id, if any - used to `resume` on restart. */
  async getSessionId(): Promise<string | undefined> {
    const record = await this.requireRecord()
    return record.sessionId
  }

  /** Most recent iteration, or null if the project has none yet. */
  async latestIteration(): Promise<ProjectIteration | null> {
    const record = await this.requireRecord()
    return record.iterations.at(-1) ?? null
  }

  // -- internal -----------------------------------------------------------

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
      return JSON.parse(raw) as ProjectRecord
    } catch {
      return null
    }
  }

  private async writeRecord(dir: string, record: ProjectRecord): Promise<void> {
    await writeFile(join(dir, 'project.json'), JSON.stringify(record, null, 2), 'utf-8')
  }
}
