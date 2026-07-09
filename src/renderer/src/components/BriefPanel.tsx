import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'

/**
 * Mount point for WS-A's Design Brief panel (architecture doc §6, product doc §4.4/§5.2). Renders
 * a "not yet available" placeholder until WS-A lands the real fields/provenance styling/
 * completeness meter/lock button/version history - see `agents/production-roadmap.md`.
 */
export function BriefPanel(): React.JSX.Element {
  return (
    <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <DescriptionOutlinedIcon fontSize="small" color="disabled" />
        <Typography variant="body2" color="text.secondary">
          Design brief — not yet available
        </Typography>
      </Box>
    </Box>
  )
}
