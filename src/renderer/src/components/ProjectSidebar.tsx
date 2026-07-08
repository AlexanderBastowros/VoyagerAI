import { useState } from 'react'
import type { MutableRefObject } from 'react'
import { useAppStore } from '../state/appStore'
import type { ModelViewer } from '../three/viewer'

interface ProjectSidebarProps {
  viewerRef: MutableRefObject<ModelViewer | null>
}

/**
 * Right-hand project switcher: lists every project, creates new ones, switches the active one,
 * and supports inline rename. Create/switch are blocked while a turn is in flight - there is
 * exactly one shared agent session/subprocess, so "switch without stopping" can't mean "keep
 * the old turn running in the background" (the main process enforces this too; see
 * `project:switch`/`project:create` in `src/main/ipc.ts` - this is defense in depth, not the
 * only guard).
 */
export function ProjectSidebar({ viewerRef }: ProjectSidebarProps): React.JSX.Element {
  const projects = useAppStore((state) => state.projects)
  const activeProjectId = useAppStore((state) => state.activeProjectId)
  const agentBusy = useAppStore((state) => state.agentBusy)
  const hydrateProject = useAppStore((state) => state.hydrateProject)
  const updateProject = useAppStore((state) => state.updateProject)

  const [creating, setCreating] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(): Promise<void> {
    if (agentBusy || creating) return
    setCreating(true)
    setError(null)
    try {
      const snapshot = await window.voyager.project.create({})
      hydrateProject(snapshot)
      viewerRef.current?.syncModel(snapshot.model?.stlBuffer ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create a new project')
    } finally {
      setCreating(false)
    }
  }

  async function handleSwitch(id: string): Promise<void> {
    if (id === activeProjectId || switchingId) return
    if (agentBusy) {
      setError('Voyager is still working — stop or wait before switching projects.')
      return
    }
    setSwitchingId(id)
    setError(null)
    try {
      const snapshot = await window.voyager.project.switch({ id })
      hydrateProject(snapshot)
      viewerRef.current?.syncModel(snapshot.model?.stlBuffer ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch projects')
    } finally {
      setSwitchingId(null)
    }
  }

  function startRename(id: string, currentName: string): void {
    setError(null)
    setRenamingId(id)
    setRenameDraft(currentName)
  }

  async function commitRename(): Promise<void> {
    const id = renamingId
    if (!id) return
    setRenamingId(null)
    const trimmed = renameDraft.trim()
    if (!trimmed) return
    try {
      const summary = await window.voyager.project.rename({ id, name: trimmed })
      updateProject(summary)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename the project')
    }
  }

  return (
    <div className="project-sidebar">
      <div className="project-sidebar-header">
        <span className="project-sidebar-title">Projects</span>
        <button
          type="button"
          className="project-new-button"
          onClick={() => void handleCreate()}
          disabled={agentBusy || creating}
          title="New project"
        >
          {creating ? '…' : '+ New'}
        </button>
      </div>
      {error && <div className="project-sidebar-error">{error}</div>}
      <div className="project-list">
        {projects.map((project) => {
          const isActive = project.id === activeProjectId

          if (renamingId === project.id) {
            return (
              <input
                key={project.id}
                className="project-row-input"
                value={renameDraft}
                autoFocus
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onBlur={() => void commitRename()}
              />
            )
          }

          return (
            <div key={project.id} className={isActive ? 'project-row project-row-active' : 'project-row'}>
              <button
                type="button"
                className="project-row-name"
                onClick={() => void handleSwitch(project.id)}
                disabled={agentBusy && !isActive}
                aria-pressed={isActive}
                title={project.name}
              >
                {switchingId === project.id ? 'Switching…' : project.name}
              </button>
              <button
                type="button"
                className="project-row-rename"
                onClick={() => startRename(project.id, project.name)}
                aria-label={`Rename ${project.name}`}
                title="Rename"
              >
                ✎
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
