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

/**
 * Distinct part colors for multi-part projects (WS-I, §14): part i in the store's parts list wears
 * `partColorFor(i)` everywhere it appears - the viewport mesh and the parts-panel swatch - so
 * "which mesh is which part" reads at a glance. Slot 0 is the accent, so a single-part project
 * (and the first part of a multi-part one) keeps the app's classic model color. Hues are picked to
 * stay distinguishable from each other and from the selection highlight on the dark viewport.
 */
export const partPalette = [
  colors.accent, // blue (the classic model color)
  '#ff9d5c', // orange
  '#57c785', // green (matches `success`)
  '#e879b9', // pink
  '#b78bff', // purple
  '#ffd166', // yellow
  '#4dd0c4', // teal
  '#e5735a' // coral (matches `danger`)
] as const

/** The color for the part at `index` in the parts list, cycling past the palette's end. */
export function partColorFor(index: number): string {
  return partPalette[((index % partPalette.length) + partPalette.length) % partPalette.length]
}
