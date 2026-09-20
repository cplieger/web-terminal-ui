// gesture.ts — the single boundary between a TAP and a LONG-PRESS on touch.
//
// Two handlers split one gesture and must not overlap or leave a gap (a tap that
// also opens a menu, a hold that does nothing): the kernel's tap-to-focus claims
// a short, low-movement press and opens the soft keyboard or clears a selection,
// and the contextMenu feature claims anything held past the ceiling. One
// threshold pair, imported by both, is what keeps that split exact — two copies
// of the number would drift and re-open the overlap.

/** Movement ceiling for a stationary press (px, compared per axis). Beyond it
 *  the gesture is a scroll or a selection-extend and belongs to the browser. */
export const TAP_MOVEMENT_PX = 10;

/** Duration ceiling for a tap (ms). A stationary press at or below it is a tap
 *  (tap-to-focus / tap-to-deselect); strictly above it, it is a long-press and
 *  belongs to native text selection or the context menu. */
export const TAP_MAX_MS = 500;

/** Whether a press landed on a LINK, in which case neither handler claims it:
 *  the platform's own link affordances (preview on hold, activate on tap) win.
 *  One matcher for both halves of the boundary: the kernel once matched
 *  `.term-link` (the engine linkifier's class) while the menu also matched
 *  `a[href]`, so an ordinary anchor was a link to one half and not the other.
 *  `win` is the target's own realm: an element from another document is not an
 *  `Element` of the importing one. */
export function isLinkTarget(win: Window & typeof globalThis, target: EventTarget | null): boolean {
  return target instanceof win.Element && target.closest("a[href], .term-link") !== null;
}
