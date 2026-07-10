import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import { useAppStore } from '../state/appStore'

/**
 * Mount point for WS-G's external-model import flow (architecture doc §12.5, product doc §5.6).
 * Renders a "not yet available" placeholder dialog, opened via the store's `importDialogOpen` flag
 * (so any trigger can open it without threading props through `App.tsx`). WS-G replaces the body
 * with the real picker / drag-drop → measure → unit-confirmation → import pipeline - see
 * `agents/production-roadmap.md`.
 */
export function ImportDialog(): React.JSX.Element {
  const open = useAppStore((state) => state.importDialogOpen)
  const setImportDialogOpen = useAppStore((state) => state.setImportDialogOpen)

  return (
    <Dialog open={open} onClose={() => setImportDialogOpen(false)} maxWidth="xs" fullWidth>
      <DialogTitle>Import a model</DialogTitle>
      <DialogContent>
        <DialogContentText variant="body2">
          Importing an external STL/STEP/3MF to remix is not yet available.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setImportDialogOpen(false)}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
