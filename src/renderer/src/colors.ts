/**
 * Single source of truth for the app palette. Values mirror the CSS custom
 * properties in `styles.css` `:root` — keep the two in sync until the CSS
 * variables are retired.
 */
export const colors = {
  bgApp: '#1e1f22',
  bgPanel: '#232427',
  bgPanelRaised: '#28292d',
  bgInput: '#1a1b1e',
  borderSubtle: '#34353a',
  borderStrong: '#45464c',
  textPrimary: '#e6e6e8',
  textSecondary: '#9a9ba1',
  textMuted: '#6c6d73',
  accent: '#66aaff',
  accentDim: '#3d6aa8',
  danger: '#e5735a',
  warning: '#e0a94e',
  warningDim: 'rgba(224, 169, 78, 0.12)',
  success: '#57c785',
  onAccent: '#0f1115'
} as const

export const fontMono = "'SF Mono', 'Menlo', 'Consolas', monospace"
