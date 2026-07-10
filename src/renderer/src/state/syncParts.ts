import type { ModelViewer } from '../three/viewer'
import { useAppStore } from './appStore'

/**
 * Loads every part's geometry into the viewer at its placement and syncs the `parts`/`selectedPartId`
 * store slice (WS-I, architecture doc §14). Shared by app-mount hydration and project
 * switch/create/revert, replacing the old single-model `viewer.syncModel(...)` pairing so a
 * multi-part project renders all its parts. Hidden parts are still loaded (mesh hidden) so the
 * visibility toggle is instant. Fetches each part's model on demand via `part.getModel` rather than
 * bloating `part.list`.
 */
export async function syncViewportParts(viewer: ModelViewer | null): Promise<void> {
  const { parts, activePartId } = await window.voyager.part.list()

  // Load geometry into the viewer FIRST, then update the store. The store update triggers the
  // Viewport focus/gizmo/parts-sync effects, which need the part meshes to already exist - setting
  // the store before the (async) mesh loads would run those effects against an empty viewer, leaving
  // the gizmo detached and focus a no-op until the user manually re-selects a part.
  if (viewer) {
    viewer.clear()
    for (const part of parts) {
      const model = await window.voyager.part.getModel({ partId: part.id })
      if (model) viewer.loadPart(part.id, model.stlBuffer, part.placement, part.visible)
    }
    if (activePartId) viewer.focusPart(activePartId)
    viewer.frameAll()
  }

  const store = useAppStore.getState()
  store.setParts(parts)
  store.setSelectedPartId(activePartId)
}
