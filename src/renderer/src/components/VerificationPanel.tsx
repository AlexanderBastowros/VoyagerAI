import { useEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import type { FindingSeverity, VerificationReport } from '../../../shared/ipc'
import { badgeLabel, badgeTone, groupFindingsByLayer, hasAnyContent, isUpdateForCurrentIteration } from '../state/verificationSelectors'
import { useAppStore } from '../state/appStore'

function SeverityIcon({ severity }: { severity: FindingSeverity }): React.JSX.Element {
  switch (severity) {
    case 'blocking':
      return <ErrorOutlineIcon fontSize="small" color="error" />
    case 'suggestion':
      return <WarningAmberIcon fontSize="small" color="warning" />
    case 'info':
      return <InfoOutlinedIcon fontSize="small" color="disabled" />
  }
}

function FindingsList({ report }: { report: VerificationReport }): React.JSX.Element {
  const groups = groupFindingsByLayer(report.findings)
  return (
    <Stack spacing={1.25}>
      {groups.map((group) => (
        <Stack key={group.layer} spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            {group.label}
          </Typography>
          {group.findings.map((finding, i) => (
            <Stack key={i} direction="row" spacing={0.75} alignItems="flex-start">
              <SeverityIcon severity={finding.severity} />
              <Typography variant="body2">{finding.message}</Typography>
            </Stack>
          ))}
        </Stack>
      ))}
    </Stack>
  )
}

function ConformanceTable({ report }: { report: VerificationReport }): React.JSX.Element | null {
  if (report.conformance.length === 0) return null
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Field</TableCell>
          <TableCell>Spec</TableCell>
          <TableCell>Measured</TableCell>
          <TableCell></TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {report.conformance.map((row) => (
          <TableRow key={row.briefField} sx={{ bgcolor: row.pass ? undefined : 'error.main', '& td': row.pass ? {} : { color: 'error.contrastText' } }}>
            <TableCell>{row.briefField}</TableCell>
            <TableCell>{row.spec}</TableCell>
            <TableCell>{row.measured}</TableCell>
            <TableCell align="right">
              {row.pass ? <CheckCircleOutlineIcon fontSize="small" /> : <ErrorOutlineIcon fontSize="small" />}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * WS-C's verification panel (architecture doc §5 - the trust artifact). Fetches the active
 * iteration's report on mount and whenever `model.iteration` changes (same effect shape as
 * `ParamPanel.tsx`), and subscribes to `verification:updated` for live pushes from the automatic
 * `recordIteration` hook and the on-demand `run_verification` tool.
 */
export function VerificationPanel({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const model = useAppStore((state) => state.model)
  const report = useAppStore((state) => state.verificationReport)
  const setReport = useAppStore((state) => state.setVerificationReport)

  const [expanded, setExpanded] = useState(true)
  const [loaded, setLoaded] = useState(false)

  const iteration = model?.iteration ?? null
  // A long-lived subscription (below) closes over whatever `iteration` was at subscribe time -
  // this ref lets it always compare against the *current* one without re-subscribing on every
  // model change.
  const iterationRef = useRef(iteration)
  iterationRef.current = iteration

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    void window.voyager.verification.get().then((response) => {
      if (cancelled) return
      setReport(response.report)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iteration, setReport])

  useEffect(
    () =>
      window.voyager.verification.onUpdated((updated) => {
        if (isUpdateForCurrentIteration(updated, iterationRef.current)) setReport(updated)
      }),
    [setReport]
  )

  const emptyMessage = !model
    ? 'Generate a model first'
    : loaded && report === null
      ? 'Not yet verified for this version'
      : loaded && !hasAnyContent(report)
        ? 'Verified — no findings'
        : null

  const open = embedded || expanded

  return (
    <Box
      sx={{
        p: 0,
        borderBottom: embedded ? 0 : 1,
        borderColor: 'divider',
        bgcolor: embedded ? 'transparent' : 'background.paper',
        flexShrink: 0
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        gap={1}
        sx={{ px: 1.75, py: 1, cursor: embedded ? 'default' : 'pointer' }}
        onClick={embedded ? undefined : () => setExpanded((prev) => !prev)}
      >
        <Stack direction="row" alignItems="center" gap={1}>
          <VerifiedOutlinedIcon fontSize="small" color={report ? 'inherit' : 'disabled'} />
          <Typography variant="overline" color="text.secondary">
            Verification
          </Typography>
          {report && <Chip size="small" label={badgeLabel(report.badge)} color={badgeTone(report.badge)} />}
        </Stack>
        {!embedded && (
          <IconButton
            size="small"
            aria-label={expanded ? 'Collapse verification' : 'Expand verification'}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((prev) => !prev)
            }}
          >
            {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </IconButton>
        )}
      </Stack>
      <Collapse in={open}>
        <Box sx={{ px: 1.75, pb: 1.5 }}>
          {!loaded ? (
            <Stack direction="row" alignItems="center" gap={1}>
              <CircularProgress size={14} />
              <Typography variant="body2" color="text.disabled">
                Loading…
              </Typography>
            </Stack>
          ) : emptyMessage ? (
            <Typography variant="body2" color="text.disabled">
              {emptyMessage}
            </Typography>
          ) : (
            report && (
              <Stack spacing={1.5}>
                <FindingsList report={report} />
                <ConformanceTable report={report} />
              </Stack>
            )
          )}
        </Box>
      </Collapse>
    </Box>
  )
}
