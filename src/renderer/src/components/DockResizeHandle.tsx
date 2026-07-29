import { useEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'

interface DockResizeHandleProps {
  /** The dock's current width, in px - reported back verbatim as `aria-valuenow`. */
  width: number
  min: number
  max: number
  /** Called with a *requested* width; the owner clamps it (`clampInspectorWidth`) and feeds the
   *  clamped result back in through `width`. */
  onChange: (width: number) => void
  onReset: () => void
}

/** Keyboard nudge per ArrowLeft/ArrowRight press, and the coarser Shift-modified step. */
const KEY_STEP = 16
const KEY_STEP_LARGE = 64

/**
 * The drag grabber for the right-hand Inspector dock: a 5px full-height strip sitting on the
 * dock's left seam. Purely presentational - `App.tsx` owns the width, this only reports deltas.
 *
 * Layout: the strip takes its own flex basis in the workbench row rather than overlaying the
 * seam absolutely, so the dock's content box stays *exactly* the state value (the 5px comes out
 * of the flexible viewport column, which has pixels to spare and no fixed width to preserve).
 * A 3px negative right margin then slides it over the seam, so the divider the user actually aims
 * at falls inside the target instead of just past its edge; those 3px come out of the same
 * flexible column and reach only into the dock's 1px border and its padding - never the Inspector's
 * scroll content, which is what a full absolute overlay would have swallowed clicks on.
 * Idle it is transparent, so all the user sees is the dock's existing 1px divider -
 * the app's default appearance is unchanged and the affordance shows up on hover (the VS Code
 * sash convention).
 */
export function DockResizeHandle({ width, min, max, onChange, onReset }: DockResizeHandleProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  // Drag origin captured at pointerdown. Deltas are measured against it rather than accumulated
  // frame-to-frame so a dropped/coalesced pointermove can't make the width drift.
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  // Always hand the document body's selection back, including if we unmount mid-drag (the dock
  // being toggled shut while dragging) - a stuck `userSelect: none` would silently break
  // text selection everywhere else in the app.
  useEffect(() => {
    return () => {
      document.body.style.userSelect = ''
    }
  }, [])

  function beginDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    // `preventDefault` keeps the press from starting a native text selection or drag gesture;
    // `stopPropagation` keeps it away from the viewport's OrbitControls / marquee-selection
    // pointerdown listeners, which would otherwise start an orbit behind the drag.
    event.preventDefault()
    event.stopPropagation()
    // Capturing on the handle retargets every subsequent pointermove/up to us, so the drag keeps
    // tracking while the pointer is over the three.js canvas (which would otherwise eat the
    // moves) or outside the window entirely.
    event.currentTarget.setPointerCapture(event.pointerId)
    // That same `preventDefault` also suppresses the compatibility `mousedown`, and with it the
    // focus default action - so without this the handle never takes focus from a click, and the
    // Arrow/Home resizing it advertises is unreachable to anyone who reached for the mouse first
    // (the keystrokes would go to whatever was focused before, e.g. the chat composer). Focusing
    // explicitly after preventing the default is what MUI's own Slider does; `preventScroll` keeps
    // it from nudging the workbench.
    event.currentTarget.focus({ preventScroll: true })
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
    setDragging(true)
    document.body.style.userSelect = 'none'
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    // The dock is anchored to the RIGHT edge, so its width grows as the pointer moves LEFT:
    // the delta is *subtracted*, not added.
    onChange(drag.startWidth - (event.clientX - drag.startX))
  }

  function endDrag(): void {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    document.body.style.userSelect = ''
  }

  function releaseDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    endDrag()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    // Same sign convention as the drag: left widens the right-hand dock.
    if (event.key === 'ArrowLeft') onChange(width + step)
    else if (event.key === 'ArrowRight') onChange(width - step)
    else if (event.key === 'Home') onReset()
    else return
    event.preventDefault()
  }

  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={releaseDrag}
      onPointerCancel={releaseDrag}
      // Belt and braces against a stuck-dragging state: `lostpointercapture` fires whenever the
      // capture ends for a reason we did not see (pointer released off-window, the OS cancelling
      // the gesture, the node being detached), where no pointerup/cancel of ours ever arrives.
      onLostPointerCapture={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      sx={{
        flex: '0 0 5px',
        // Centre the strip *on* the seam instead of ending where the seam begins. The only thing
        // visible at rest is the dock's own 1px `borderLeft`, and a flex child laid out before the
        // dock stops exactly at that border's outer edge - so a press on the line the user is
        // aiming at, or a pixel right of it, landed on the Inspector and did nothing. Shifting
        // 3px right puts the divider inside the target with tolerance either side; the shift still
        // comes out of the flexible viewport column, so the dock's content box is untouched.
        marginRight: '-3px',
        // Those 3px overhang the Inspector, which follows in DOM order and would otherwise paint
        // (and hit-test) over them. The overlap only ever covers the divider plus 2px of the
        // Inspector's padding, never its content.
        position: 'relative',
        zIndex: 1,
        alignSelf: 'stretch',
        cursor: 'col-resize',
        // Pointer events on a touch/pen device would otherwise be stolen by the browser's own
        // pan gesture the moment the drag turns into a scroll.
        touchAction: 'none',
        bgcolor: dragging ? 'primary.main' : 'transparent',
        transition: (theme) =>
          theme.transitions.create('background-color', { duration: theme.transitions.duration.shortest }),
        '&:hover': { bgcolor: dragging ? 'primary.main' : 'primary.dark' },
        // Keyboard resizing is only discoverable if focus is visible; the tinted strip *is* the
        // focus ring, so the default outline would just double it up.
        '&:focus-visible': { outline: 'none', bgcolor: 'primary.main' }
      }}
    />
  )
}
