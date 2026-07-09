import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import TuneIcon from '@mui/icons-material/Tune'

/**
 * Mount point for WS-B's parameter panel (architecture doc §7 - instant, free dimension tweaks
 * via the PARAMS convention). Renders a "not yet available" placeholder until WS-B lands the real
 * sliders/inputs generated from the active iteration's manifest - see
 * `agents/production-roadmap.md`.
 */
export function ParamPanel(): React.JSX.Element {
  return (
    <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <TuneIcon fontSize="small" color="disabled" />
        <Typography variant="body2" color="text.secondary">
          Parameters — not yet available
        </Typography>
      </Box>
    </Box>
  )
}
