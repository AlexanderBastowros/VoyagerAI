import { useEffect, useState } from 'react'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Typography from '@mui/material/Typography'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import { useAppStore } from '../state/appStore'
import { hasSetupError, isSetupComplete } from '../state/setupSelectors'
import type { SetupCheck, SetupStatus } from '../../../shared/ipc'

interface CheckRowConfig {
  key: keyof SetupStatus
  label: string
}

const CHECK_ROWS: CheckRowConfig[] = [
  { key: 'claudeCli', label: 'Claude CLI' },
  { key: 'claudeAuth', label: 'Claude sign-in' },
  { key: 'pythonEnv', label: 'Python environment' }
]

function StatusIcon({ state }: { state: SetupCheck['state'] }): React.JSX.Element {
  switch (state) {
    case 'ready':
      return <CheckCircleOutlineIcon fontSize="small" sx={{ color: 'success.main' }} />
    case 'error':
      return <ErrorOutlineIcon fontSize="small" color="error" />
    case 'in_progress':
      return <CircularProgress size={14} />
    case 'unchecked':
      return <RadioButtonUncheckedIcon fontSize="small" sx={{ color: 'text.disabled' }} />
  }
}

/**
 * Full-viewport overlay shown on launch while first-run setup is
 * incomplete. Always mounted (see App.tsx); renders null once every
 * blocking check is ready. For M2, `pythonEnv` alone gates dismissal - see
 * src/renderer/src/state/setupSelectors.ts for the M3 TODO that makes
 * claudeCli/claudeAuth blocking too.
 */
export function SetupScreen(): React.JSX.Element | null {
  const setupStatus = useAppStore((state) => state.setupStatus)
  const setSetupStatus = useAppStore((state) => state.setSetupStatus)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.voyager.setup.getStatus().then((status) => {
      if (!cancelled) setSetupStatus(status)
    })
    const unsubscribe = window.voyager.setup.onProgress((status) => {
      setSetupStatus(status)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const complete = isSetupComplete(setupStatus)
  const errored = hasSetupError(setupStatus)

  if (complete && !errored) return null

  async function handleRetry(): Promise<void> {
    setRetrying(true)
    try {
      const status = await window.voyager.setup.retry()
      setSetupStatus(status)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <Dialog
      open
      disableEscapeKeyDown
      maxWidth="xs"
      fullWidth
      slotProps={{ backdrop: { sx: { backgroundColor: 'rgba(15, 16, 19, 0.82)', backdropFilter: 'blur(2px)' } } }}
    >
      <DialogTitle>Setting up Voyager AI</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          First launch installs a managed Python environment (build123d, trimesh, numpy) used to
          generate and validate 3D models. This can take a few minutes.
        </Typography>
        <List dense>
          {CHECK_ROWS.map((row) => {
            const check = setupStatus[row.key]
            return (
              <ListItem key={row.key} disableGutters>
                <ListItemIcon sx={{ minWidth: 28 }}>
                  <StatusIcon state={check.state} />
                </ListItemIcon>
                <ListItemText
                  primary={row.label}
                  secondary={check.detail}
                  slotProps={{
                    secondary: { color: check.state === 'error' ? 'error.main' : undefined }
                  }}
                />
              </ListItem>
            )
          })}
        </List>
      </DialogContent>
      {errored && (
        <DialogActions>
          <Button variant="contained" onClick={() => void handleRetry()} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </DialogActions>
      )}
    </Dialog>
  )
}
