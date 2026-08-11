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

/**
 * Whether a press landed on a LINK, in which case neither handler claims it: the
 * platform's own link affordances (preview on hold, activate on tap) win.
 *
 * Shared for the same reason the thresholds are, and it was NOT: the kernel
 * matched `.term-link` only while the menu matched `a[href], .term-link`, so an
 * ordinary anchor in the output was a link to one half of the boundary and not the
 * other — the menu stood down for the platform while tap-to-focus stole the press.
 * `.term-link` is the engine linkifier's class; `a[href]` covers anchors a consumer
 * or an application wrote itself.
 */
export function isLinkTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("a[href], .term-link") !== null;
}
