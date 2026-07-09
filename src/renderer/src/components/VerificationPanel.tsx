import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined'

/**
 * Mount point for WS-C's verification panel (architecture doc §5 - the trust artifact: layers
 * 1-3 findings + the brief-conformance table + badge). Renders a "not yet available" placeholder
 * until WS-C lands the real report rendering - see `agents/production-roadmap.md`.
 */
export function VerificationPanel(): React.JSX.Element {
  return (
    <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <VerifiedOutlinedIcon fontSize="small" color="disabled" />
        <Typography variant="body2" color="text.secondary">
          Verification — not yet available
        </Typography>
      </Box>
    </Box>
  )
}
