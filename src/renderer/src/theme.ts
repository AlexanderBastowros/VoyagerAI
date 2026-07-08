import { createTheme } from '@mui/material/styles'
import { colors } from './colors'

const fontSans =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, Helvetica, Arial, sans-serif"

export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: colors.bgApp,
      paper: colors.bgPanel
    },
    primary: {
      main: colors.accent,
      dark: colors.accentDim,
      contrastText: colors.onAccent
    },
    error: {
      main: colors.danger
    },
    warning: {
      main: colors.warning,
      contrastText: '#1a1508'
    },
    success: {
      main: colors.success
    },
    divider: colors.borderSubtle,
    text: {
      primary: colors.textPrimary,
      secondary: colors.textSecondary,
      disabled: colors.textMuted
    }
  },
  typography: {
    fontFamily: fontSans,
    body1: {
      fontSize: '0.8125rem'
    },
    body2: {
      fontSize: '0.75rem'
    },
    caption: {
      fontSize: '0.6875rem'
    },
    overline: {
      fontSize: '0.6875rem',
      fontWeight: 600,
      letterSpacing: '0.06em'
    },
    button: {
      textTransform: 'none',
      fontWeight: 600
    }
  },
  shape: {
    borderRadius: 6
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        'html, body, #root': {
          height: '100%'
        }
      }
    },
    MuiButtonBase: {
      defaultProps: {
        disableRipple: true
      }
    },
    MuiButton: {
      defaultProps: {
        size: 'small',
        variant: 'outlined',
        disableElevation: true
      },
      styleOverrides: {
        outlined: {
          borderColor: colors.borderStrong
        }
      }
    },
    MuiIconButton: {
      defaultProps: {
        size: 'small'
      }
    },
    MuiTextField: {
      defaultProps: {
        size: 'small'
      }
    },
    MuiSelect: {
      defaultProps: {
        size: 'small'
      }
    },
    MuiChip: {
      defaultProps: {
        size: 'small'
      }
    },
    MuiToggleButton: {
      defaultProps: {
        size: 'small'
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          // Kill MUI's dark-mode elevation gradient so panels stay exactly bgPanel.
          backgroundImage: 'none'
        }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: colors.bgInput
        },
        notchedOutline: {
          borderColor: colors.borderStrong
        }
      }
    },
    MuiMenuItem: {
      defaultProps: {
        dense: true
      }
    }
  }
})
