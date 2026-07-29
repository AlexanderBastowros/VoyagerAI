/**
 * Sizing rules for the user-resizable right-hand Inspector dock (`App.tsx`). Pure and
 * DOM-free so the clamp can be unit-tested without a renderer, mirroring `briefSelectors.ts` /
 * `setupSelectors.ts`.
 *
 * The width is renderer-local presentational state, exactly like `rightDockOpen` - it never
 * enters the zustand store or the IPC contract. It is a global display preference, not
 * per-project data, so it persists to `localStorage` following the precedent set by the
 * "full stream" toggle (`readFullStream` in `appStore.ts`) rather than to `project.json`.
 */

/** Today's hard-coded dock width - the starting value, and what a double-click/Home resets to. */
export const DEFAULT_INSPECTOR_WIDTH = 372

/** Below this the chat composer and the five Inspector tabs (Chat / Brief / Params / Verify /
 *  Print - see `Inspector.tsx`) stop being usable: the tab labels start eliding and the
 *  composer's send/attach controls crowd the text field. */
export const MIN_INSPECTOR_WIDTH = 288

/** Absolute ceiling regardless of how wide the window is - past ~900px the Inspector's dense
 *  two-column panels just grow whitespace, and the viewport is the thing worth the pixels. */
export const HARD_MAX_INSPECTOR_WIDTH = 900

const ACTIVITY_RAIL_WIDTH = 48
/** `LeftDock.tsx`'s fixed width. */
const LEFT_DOCK_WIDTH = 250
/** The narrowest 3D viewport we're willing to leave behind. Chosen so the *default* Inspector
 *  width still fits at the app's own `minWidth: 980` (`src/main/index.ts`) with both docks open:
 *  980 - 48 - 250 - 372 = 310 > 280. Otherwise resizing the window down to its floor would
 *  silently shrink an untouched, default-width dock. */
const MIN_VIEWPORT_WIDTH = 280

/** Horizontal space the Inspector may never eat into. Deliberately assumes the left dock is
 *  *open* (the worst case) so toggling it back on never squeezes the viewport to nothing. */
export const RESERVED_FOR_VIEWPORT = ACTIVITY_RAIL_WIDTH + LEFT_DOCK_WIDTH + MIN_VIEWPORT_WIDTH

/**
 * The widest the Inspector may be in a window of `viewportWidth` px. Always >= `MIN` - in a
 * window too narrow to honour the viewport reservation the minimum wins, because a cramped
 * viewport beats an unusable Inspector (and beats a negative width).
 */
export function maxInspectorWidth(viewportWidth: number): number {
  // A non-finite/absent window width (jsdom-less tests, a pre-layout first paint) only means we
  // can't apply the viewport reservation - the absolute ceiling still holds.
  const derived = Number.isFinite(viewportWidth) ? viewportWidth - RESERVED_FOR_VIEWPORT : HARD_MAX_INSPECTOR_WIDTH
  return Math.max(MIN_INSPECTOR_WIDTH, Math.min(HARD_MAX_INSPECTOR_WIDTH, derived))
}

/**
 * Clamps a requested dock width into the legal range for the current window. Single source of
 * truth for every path that can change the width - pointer drag, keyboard nudge, restoring the
 * persisted value on mount, and re-clamping after a window resize.
 */
export function clampInspectorWidth(width: number, viewportWidth: number): number {
  // A NaN/Infinity request (a corrupt stored value, a pointer delta computed against a stale
  // origin) resolves to the default rather than to a boundary - a wrong-but-familiar width is
  // less alarming than a dock snapped to its minimum.
  const requested = Number.isFinite(width) ? width : DEFAULT_INSPECTOR_WIDTH
  const max = maxInspectorWidth(viewportWidth)
  return Math.round(Math.min(max, Math.max(MIN_INSPECTOR_WIDTH, requested)))
}

/**
 * Clamps a width to the absolute `[MIN, HARD_MAX]` band, ignoring the live window. This is the form
 * the *requested* width is kept and persisted in (`App.tsx`): folding the window-derived cap into
 * the stored value would mean a window that is only temporarily narrow - un-maximizing, snapping to
 * half the screen, undocking from an external display - permanently overwrites a width the user
 * deliberately dragged wider, with re-dragging the only way back. Keeping the request whole and
 * clamping only what paints lets a narrow window *compress* the dock and a wide one hand the user
 * their width back.
 */
export function clampRequestedInspectorWidth(width: number): number {
  // A non-finite viewport width means exactly "no viewport reservation to apply", which is the
  // window-independent band this needs - see `maxInspectorWidth`.
  return clampInspectorWidth(width, Number.POSITIVE_INFINITY)
}

/** Key for the persisted Inspector width. Global (not per-project) and purely a display
 *  concern, hence `localStorage` - see the module doc comment. */
const INSPECTOR_WIDTH_KEY = 'voyager.inspectorWidth'

/**
 * Reads the persisted dock width, or `DEFAULT_INSPECTOR_WIDTH` when there is nothing sane
 * stored. Guarded the same way as `readFullStream` in `appStore.ts`: `localStorage` may be
 * absent (vitest's `node` environment) or throw (private mode / blocked storage), and neither
 * should take the window down.
 *
 * Anything outside `[MIN, HARD_MAX]` is treated as corrupt rather than clamped, because we only
 * ever write already-clamped values - a value out of that band was not written by us. The
 * *viewport-derived* cap is not applied here on purpose: it depends on the live window width, so
 * callers pass the result through `clampInspectorWidth` (which is what re-narrows a width saved
 * on a wider display).
 */
export function readStoredInspectorWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_INSPECTOR_WIDTH
    const raw = localStorage.getItem(INSPECTOR_WIDTH_KEY)
    if (raw === null) return DEFAULT_INSPECTOR_WIDTH
    // `Number('')` is 0 and `Number('abc')` is NaN - both fail the band check below.
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < MIN_INSPECTOR_WIDTH || parsed > HARD_MAX_INSPECTOR_WIDTH) {
      return DEFAULT_INSPECTOR_WIDTH
    }
    return Math.round(parsed)
  } catch {
    return DEFAULT_INSPECTOR_WIDTH
  }
}

export function writeStoredInspectorWidth(width: number): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(INSPECTOR_WIDTH_KEY, String(Math.round(width)))
  } catch {
    // Best-effort persistence - a private-mode/quota failure just means the width is session-only.
  }
}
