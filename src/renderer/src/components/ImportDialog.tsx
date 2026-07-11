import { useState } from 'react'
import type { DragEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Paper from '@mui/material/Paper'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import type { ImportModelResponse } from '../../../shared/ipc'
import { colors } from '../colors'
import { useAppStore } from '../state/appStore'

/** What the dialog is doing right now - drives which body it renders. */
type Phase = 'idle' | 'busy' | 'confirming'

interface PendingConfirmation {
  measuredMm: number
  axis: 'x' | 'y' | 'z'
}

/**
 * WS-G's external-model import flow (architecture doc §12.5, product doc §5.6): a file
 * picker/drag-drop path into the project's `imports/` directory, the two-phase unit-confirmation
 * step for unitless STL/OBJ ("this reads as 120mm wide - correct?"), and error surfacing. The
 * actual copy/measure/repair/finalize pipeline runs entirely in the main process
 * (`src/main/ipc.ts`'s `model:import` handler, backed by `packages/agent-core/src/projects/
 * importModel.ts`) - this component only drives the two-phase `window.voyager.model.import()`
 * contract and lets a successful import's `model:displayed` broadcast do the rest (the same
 * subscription `App.tsx` already has for the agent's `display_model` and the parameter panel's
 * re-run - a freshly imported iteration is displayed/verified identically to either of those).
 *
 * No mount point in the app currently opens `importDialogOpen` (WS-0c pre-landed the store flag
 * and this placeholder, but no toolbar button was wired up yet - see the store's own doc comment:
 * "any trigger - a toolbar button, drag-drop, an empty-project prompt - can open it"). Since every
 * other candidate location (`ViewportControls.tsx`, `PartsPanel.tsx`, `App.tsx`'s mount list) is
 * owned by another work order, this component renders its own small floating trigger alongside the
 * dialog rather than leaving the feature unreachable - the same pattern `SetupScreen` uses for a
 * self-contained overlay.
 */
export function ImportDialog(): React.JSX.Element {
  const open = useAppStore((state) => state.importDialogOpen)
  const setImportDialogOpen = useAppStore((state) => state.setImportDialogOpen)

  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const [confirmValue, setConfirmValue] = useState('')
  const [dragActive, setDragActive] = useState(false)

  function reset(): void {
    setPhase('idle')
    setError(null)
    setPending(null)
    setConfirmValue('')
    setDragActive(false)
  }

  function handleClose(): void {
    if (phase === 'busy') return // an in-flight import shouldn't be dismissed mid-request
    setImportDialogOpen(false)
    reset()
  }

  /** Applies the main process's response: closes on success, moves to the confirmation step for
   *  an unitless mesh, or surfaces an error (silently resets on a bare user-cancel). */
  function applyResponse(response: ImportModelResponse): void {
    if (response.imported) {
      setImportDialogOpen(false)
      reset()
      return
    }
    if (response.needsUnitConfirmation) {
      setPending(response.needsUnitConfirmation)
      setConfirmValue(response.needsUnitConfirmation.measuredMm.toFixed(1))
      setPhase('confirming')
      setError(null)
      return
    }
    // No reason set = a bare user-cancel (native picker dismissed) - go back to idle quietly.
    setPhase('idle')
    setError(response.reason ?? null)
  }

  async function runImport(request: Parameters<typeof window.voyager.model.import>[0]): Promise<void> {
    setPhase('busy')
    setError(null)
    try {
      const response = await window.voyager.model.import(request)
      applyResponse(response)
    } catch (err) {
      setPhase('idle')
      setError(err instanceof Error ? err.message : 'Could not import the model.')
    }
  }

  function handleBrowse(): void {
    // Omitting filePath has the main process open a native picker - the only reliable way to get
    // an absolute path in this Electron version (see the contract-change request filed in
    // agents/production-roadmap.md re: drag-drop needing a preload `webUtils.getPathForFile`
    // bridge this work order isn't able to add - src/preload/** is a frozen shared contract).
    void runImport({})
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragActive(false)
    if (phase === 'busy') return
    const file = event.dataTransfer.files[0]
    // Electron 32+ removed the renderer-side `File.path` shortcut in favor of a preload
    // `webUtils.getPathForFile()` bridge this work order can't add (frozen `src/preload/**`) - so
    // a dropped file's absolute path usually isn't resolvable here. Use it if some future preload
    // change ever exposes it; otherwise fall back to the native picker rather than silently doing
    // nothing with the drop.
    const droppedPath = (file as unknown as { path?: string })?.path
    if (droppedPath) {
      void runImport({ filePath: droppedPath })
    } else {
      handleBrowse()
    }
  }

  function handleConfirm(): void {
    if (!pending) return
    const value = Number(confirmValue)
    if (!confirmValue.trim() || !Number.isFinite(value) || value <= 0) {
      setError('Enter a positive number of millimeters.')
      return
    }
    void runImport({ unitScaleMm: value })
  }

  function handleCancelConfirmation(): void {
    reset()
  }

  return (
    <>
      <Paper
        elevation={4}
        sx={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 10,
          bgcolor: colors.bgPanelRaised
        }}
      >
        <Button
          startIcon={<UploadFileIcon />}
          onClick={() => {
            reset()
            setImportDialogOpen(true)
          }}
        >
          Import model
        </Button>
      </Paper>

      <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
        <DialogTitle>Import a model</DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {phase === 'confirming' && pending ? (
            <Box>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                This file has no built-in units. It reads as{' '}
                <strong>{pending.measuredMm.toFixed(1)} mm</strong> along its {pending.axis.toUpperCase()} axis -
                confirm or correct the real-world size.
              </Typography>
              <TextField
                label={`Real ${pending.axis.toUpperCase()}-axis size (mm)`}
                type="number"
                size="small"
                fullWidth
                autoFocus
                value={confirmValue}
                onChange={(e) => setConfirmValue(e.target.value)}
                slotProps={{ htmlInput: { min: 0, step: 'any' } }}
              />
            </Box>
          ) : (
            <Box
              onDragOver={(e) => {
                e.preventDefault()
                if (phase !== 'busy') setDragActive(true)
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              sx={{
                border: '1px dashed',
                borderColor: dragActive ? 'primary.main' : colors.borderStrong,
                borderRadius: 1,
                p: 3,
                textAlign: 'center',
                bgcolor: dragActive ? 'action.hover' : 'transparent'
              }}
            >
              {phase === 'busy' ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                  <CircularProgress size={24} />
                  <Typography variant="body2" color="text.secondary">
                    Importing…
                  </Typography>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
                  <Typography variant="body2" color="text.secondary">
                    Drag a STEP, STL, OBJ, or 3MF file here, or browse for one.
                  </Typography>
                  <Button variant="outlined" size="small" onClick={handleBrowse}>
                    Browse…
                  </Button>
                  <Typography variant="caption" color="text.secondary">
                    STEP keeps full parametric remix; STL/OBJ/3MF import as a mesh you can repair,
                    split, and cut boolean features into.
                  </Typography>
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          {phase === 'confirming' ? (
            <>
              <Button onClick={handleCancelConfirmation}>Cancel</Button>
              <Button variant="contained" onClick={handleConfirm}>
                Confirm
              </Button>
            </>
          ) : (
            <Button onClick={handleClose} disabled={phase === 'busy'}>
              Close
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  )
}
