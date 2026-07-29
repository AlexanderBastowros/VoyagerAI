import { beforeEach, describe, expect, it } from 'vitest'

// The renderer tests run under vitest's `node` environment, which has no DOM/localStorage.
// Install the same tiny in-memory stand-in `appStore.test.ts` uses before importing the module,
// so the storage helpers have something to talk to.
const localStorageMock = ((): Storage => {
  let store: Record<string, string> = {}
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value)
    },
    removeItem: (key) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
    key: () => null,
    get length() {
      return Object.keys(store).length
    }
  } as Storage
})()
globalThis.localStorage = localStorageMock

const {
  DEFAULT_INSPECTOR_WIDTH,
  HARD_MAX_INSPECTOR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  RESERVED_FOR_VIEWPORT,
  clampInspectorWidth,
  clampRequestedInspectorWidth,
  maxInspectorWidth,
  readStoredInspectorWidth,
  writeStoredInspectorWidth
} = await import('./dockWidth')

/** A window comfortably wider than everything the viewport reservation + hard max need. */
const WIDE_WINDOW = HARD_MAX_INSPECTOR_WIDTH + RESERVED_FOR_VIEWPORT + 200

describe('clampInspectorWidth', () => {
  it('leaves a comfortable width untouched', () => {
    expect(clampInspectorWidth(DEFAULT_INSPECTOR_WIDTH, 1360)).toBe(DEFAULT_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(500, 1360)).toBe(500)
  })

  it('does not clamp the default at the app window minimum (980px)', () => {
    // Regression guard for the "default must not visibly change" rule - a user who never touches
    // the handle must see 372 even with the window squeezed to its floor.
    expect(clampInspectorWidth(DEFAULT_INSPECTOR_WIDTH, 980)).toBe(DEFAULT_INSPECTOR_WIDTH)
  })

  it('clamps below the minimum up to the minimum', () => {
    expect(clampInspectorWidth(0, WIDE_WINDOW)).toBe(MIN_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(-400, WIDE_WINDOW)).toBe(MIN_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(MIN_INSPECTOR_WIDTH - 1, WIDE_WINDOW)).toBe(MIN_INSPECTOR_WIDTH)
  })

  it('clamps above the hard max down to the hard max, however wide the window', () => {
    expect(clampInspectorWidth(HARD_MAX_INSPECTOR_WIDTH + 1, WIDE_WINDOW)).toBe(HARD_MAX_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(100_000, 100_000)).toBe(HARD_MAX_INSPECTOR_WIDTH)
  })

  it('clamps to the viewport-derived cap when that is the tighter bound', () => {
    const windowWidth = 1200
    const cap = windowWidth - RESERVED_FOR_VIEWPORT
    expect(cap).toBeLessThan(HARD_MAX_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(HARD_MAX_INSPECTOR_WIDTH, windowWidth)).toBe(cap)
    expect(maxInspectorWidth(windowWidth)).toBe(cap)
  })

  it('lets the minimum win in a window too narrow to honour the reservation', () => {
    // The derived cap goes negative here; MIN must still come out - never a negative or absurd
    // width, which would collapse the dock or blow up the flex layout.
    const tiny = 200
    expect(tiny - RESERVED_FOR_VIEWPORT).toBeLessThan(0)
    expect(maxInspectorWidth(tiny)).toBe(MIN_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(600, tiny)).toBe(MIN_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(10, tiny)).toBe(MIN_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(0, 0)).toBe(MIN_INSPECTOR_WIDTH)
  })

  it('falls back to the default for a non-finite requested width', () => {
    expect(clampInspectorWidth(Number.NaN, WIDE_WINDOW)).toBe(DEFAULT_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(Number.POSITIVE_INFINITY, WIDE_WINDOW)).toBe(DEFAULT_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(Number.NEGATIVE_INFINITY, WIDE_WINDOW)).toBe(DEFAULT_INSPECTOR_WIDTH)
  })

  it('ignores a non-finite window width but keeps the hard max', () => {
    expect(maxInspectorWidth(Number.NaN)).toBe(HARD_MAX_INSPECTOR_WIDTH)
    expect(clampInspectorWidth(400, Number.NaN)).toBe(400)
    expect(clampInspectorWidth(5000, Number.NaN)).toBe(HARD_MAX_INSPECTOR_WIDTH)
  })

  it('returns whole pixels', () => {
    expect(clampInspectorWidth(400.4, WIDE_WINDOW)).toBe(400)
    expect(clampInspectorWidth(400.6, WIDE_WINDOW)).toBe(401)
  })
})

describe('clampRequestedInspectorWidth', () => {
  it('keeps a width the current window is too narrow for', () => {
    // The whole point: a width dragged on a wide display survives a narrow window, so re-widening
    // the window restores it instead of the narrow cap overwriting the preference.
    const narrow = 980
    expect(maxInspectorWidth(narrow)).toBeLessThan(860)
    expect(clampRequestedInspectorWidth(860)).toBe(860)
    // ...while what actually paints in that window is still capped.
    expect(clampInspectorWidth(clampRequestedInspectorWidth(860), narrow)).toBe(maxInspectorWidth(narrow))
    // Widening the window gives the requested width back, unchanged.
    expect(clampInspectorWidth(clampRequestedInspectorWidth(860), WIDE_WINDOW)).toBe(860)
  })

  it('still enforces the absolute band, so only storable widths are ever persisted', () => {
    expect(clampRequestedInspectorWidth(HARD_MAX_INSPECTOR_WIDTH + 500)).toBe(HARD_MAX_INSPECTOR_WIDTH)
    expect(clampRequestedInspectorWidth(0)).toBe(MIN_INSPECTOR_WIDTH)
    expect(clampRequestedInspectorWidth(Number.NaN)).toBe(DEFAULT_INSPECTOR_WIDTH)
    expect(clampRequestedInspectorWidth(400.6)).toBe(401)
    // Anything it produces round-trips through storage rather than reading back as corrupt.
    for (const requested of [-1000, 0, 300, 860, 5000]) {
      writeStoredInspectorWidth(clampRequestedInspectorWidth(requested))
      expect(readStoredInspectorWidth()).toBe(clampRequestedInspectorWidth(requested))
    }
  })
})

describe('inspector width storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults when nothing is stored', () => {
    expect(readStoredInspectorWidth()).toBe(DEFAULT_INSPECTOR_WIDTH)
  })

  it('round-trips a stored width', () => {
    writeStoredInspectorWidth(540)
    expect(readStoredInspectorWidth()).toBe(540)
    writeStoredInspectorWidth(MIN_INSPECTOR_WIDTH)
    expect(readStoredInspectorWidth()).toBe(MIN_INSPECTOR_WIDTH)
    writeStoredInspectorWidth(HARD_MAX_INSPECTOR_WIDTH)
    expect(readStoredInspectorWidth()).toBe(HARD_MAX_INSPECTOR_WIDTH)
  })

  it('rounds a fractional width on the way in', () => {
    writeStoredInspectorWidth(540.7)
    expect(localStorage.getItem('voyager.inspectorWidth')).toBe('541')
    expect(readStoredInspectorWidth()).toBe(541)
  })

  it('falls back to the default for a corrupt stored value', () => {
    for (const corrupt of ['abc', '', ' ', '-40', 'NaN', 'Infinity', '0', '12', '4000']) {
      localStorage.setItem('voyager.inspectorWidth', corrupt)
      expect(readStoredInspectorWidth()).toBe(DEFAULT_INSPECTOR_WIDTH)
    }
  })
})
