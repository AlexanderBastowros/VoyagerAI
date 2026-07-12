import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined'
import HistoryIcon from '@mui/icons-material/History'
import PrintOutlinedIcon from '@mui/icons-material/PrintOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined'

/** Which panel the left dock currently shows - owned by `App.tsx`, switched by this rail. */
export type LeftView = 'parts' | 'history' | 'printer'

interface ActivityRailProps {
  view: LeftView
  onSelectView: (v: LeftView) => void
  /** Opens the existing `ProjectsDrawer` - a one-shot action, never "active" like the view buttons. */
  onOpenProjects: () => void
  leftDockOpen: boolean
}

interface RailButtonProps {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}

/** One rail icon: a thin left accent bar + `primary` icon tint when its view is the active one,
 *  plain `action` tint otherwise. Selecting an already-active view still calls through - `App.tsx`
 *  decides whether that toggles the dock closed or is a no-op. */
function RailButton({ icon, label, active, onClick }: RailButtonProps): React.JSX.Element {
  return (
    <Tooltip title={label} placement="right">
      <Box sx={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}>
        {active && (
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              top: 6,
              bottom: 6,
              width: 2.5,
              borderRadius: 1,
              bgcolor: 'primary.main'
            }}
          />
        )}
        <IconButton size="small" aria-label={label} onClick={onClick} sx={{ width: 36, height: 36 }}>
          {icon}
        </IconButton>
      </Box>
    </Tooltip>
  )
}

/**
 * The 48px-wide activity rail (Studio Workbench): a permanent icon strip that opens the project
 * switcher and switches the left dock between Parts / History / Printer. Purely presentational -
 * `App.tsx` owns `view`/`leftDockOpen` and decides what re-selecting the already-active view means
 * (toggle the dock shut, or just refocus it).
 */
export function ActivityRail({ view, onSelectView, onOpenProjects, leftDockOpen }: ActivityRailProps): React.JSX.Element {
  return (
    <Box
      sx={{
        width: 48,
        flexShrink: 0,
        height: '100%',
        bgcolor: 'background.paper',
        borderRight: 1,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        py: 1,
        gap: 0.5
      }}
    >
      <RailButton
        icon={<FolderOutlinedIcon fontSize="small" color="action" />}
        label="Projects"
        active={false}
        onClick={onOpenProjects}
      />
      <Box sx={{ height: 8 }} />
      <RailButton
        icon={<ViewInArOutlinedIcon fontSize="small" color={leftDockOpen && view === 'parts' ? 'primary' : 'action'} />}
        label="Parts"
        active={leftDockOpen && view === 'parts'}
        onClick={() => onSelectView('parts')}
      />
      <RailButton
        icon={<HistoryIcon fontSize="small" color={leftDockOpen && view === 'history' ? 'primary' : 'action'} />}
        label="History"
        active={leftDockOpen && view === 'history'}
        onClick={() => onSelectView('history')}
      />
      <RailButton
        icon={<PrintOutlinedIcon fontSize="small" color={leftDockOpen && view === 'printer' ? 'primary' : 'action'} />}
        label="Printer"
        active={leftDockOpen && view === 'printer'}
        onClick={() => onSelectView('printer')}
      />
      <Box sx={{ flex: 1 }} />
      <RailButton
        icon={<SettingsOutlinedIcon fontSize="small" color="action" />}
        label="Settings"
        active={false}
        onClick={() => {
          // No settings surface yet - the icon is a visual affordance for now.
        }}
      />
    </Box>
  )
}
