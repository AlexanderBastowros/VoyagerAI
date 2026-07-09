import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined'

/**
 * Mount point for WS-I's parts panel (architecture doc §14, product doc §5.3). Renders a "not yet
 * available" placeholder until WS-I lands the real list (per-part version history, visibility
 * toggles, select/focus) - see `agents/production-roadmap.md`.
 */
export function PartsPanel(): React.JSX.Element {
  return (
    <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ViewInArOutlinedIcon fontSize="small" color="disabled" />
        <Typography variant="body2" color="text.secondary">
          Parts — not yet available
        </Typography>
      </Box>
    </Box>
  )
}
