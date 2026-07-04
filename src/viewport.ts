// Viewport stability tracker.
//
// Coordinates iOS keyboard transitions, window resizes, font-load reflows,
// and ResizeObserver fires into a single "transition → settle" lifecycle
// so the rest of the app can act on stable viewport state without each
// piece reinventing its own debounce/suppress timers.
//
// Behavior:
//   1. Any viewport-affecting event marks "in transition".
//   2. While in transition: autoscroll is suppressed, input dimensions
//      may shift, no resize is sent to the server.
//   3. After SETTLE_MS of no further events, fire onSettled — the caller
//      then sends the final size, snaps to bottom if was-at-bottom, etc.

import { scroll } from "@cplieger/web-terminal-engine";

// Time to wait after the last viewport-changing event before declaring
// the viewport "settled". Long enough to bridge the iOS keyboard slide
// (~250ms) with margin for fonts and reflow.
const SETTLE_MS = 350;

let termWrap: HTMLElement;
let onSettled: ((wasAtBottom: boolean) => void) | null = null;
let inTransition = false;
let wasAtBottomAtStart = true;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function startTransition(): void {
  // Capture pre-transition scroll state at the *start* of the transition,
  // not on every event in the burst.
  if (!inTransition) {
    inTransition = true;
    wasAtBottomAtStart = !scroll.isUserScrolledUp();
  }

  if (settleTimer !== null) {
    clearTimeout(settleTimer);
  }
  settleTimer = setTimeout(() => {
    settleTimer = null;
    inTransition = false;
    if (wasAtBottomAtStart) {
      scroll.scrollToBottom();
    }
    if (onSettled) {
      onSettled(wasAtBottomAtStart);
    }
  }, SETTLE_MS);
}

export function init(opts: {
  termWrap: HTMLElement;
  onSettled: (wasAtBottom: boolean) => void;
}): void {
  termWrap = opts.termWrap;
  onSettled = opts.onSettled;

  // iOS soft keyboard. interactive-widget=resizes-content makes the
  // layout viewport shrink; we still apply a manual bottom inset as
  // fallback for older iOS / other mobile browsers.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onChange = (): void => {
      // Pin the terminal's fixed box to the exact region the VISUAL viewport
      // occupies inside the layout viewport. On iOS the soft keyboard shrinks
      // (and can offset) the visual viewport WITHOUT resizing the layout
      // viewport — interactive-widget=resizes-content is not honored on iOS
      // Safari — so a `position: fixed; inset: 0` terminal keeps the full-screen
      // height (keyboard overlaying the bottom) while iOS scrolls the focused
      // input into view and shifts the fixed box up, sliding the output and
      // prompt behind the keyboard (the "content jumps up, hidden until I
      // scroll" symptom). Driving top AND bottom from visualViewport keeps the
      // terminal exactly over the visible area in every browser, so nothing is
      // left behind the keyboard for iOS to scroll to.
      const offsetTop = Math.max(0, Math.round(vv.offsetTop));
      const bottomInset = Math.max(0, Math.round(window.innerHeight - vv.offsetTop - vv.height));
      // Reserved bottom chrome (a bottom tab bar) the content must clear, on top
      // of the keyboard inset. A feature sets --wt-reserve-bottom (px) on the
      // root, 0 when none; viewport owns the terminal's fixed-box geometry, so it
      // folds the reserve into the bottom offset here. The reserve excludes the
      // keyboard (it is measured with the keyboard closed), so adding it to
      // bottomInset does not double-count.
      const reserve = Math.max(
        0,
        Math.round(
          parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue("--wt-reserve-bottom"),
          ) || 0,
        ),
      );
      const bottom = bottomInset + reserve;
      termWrap.style.top = offsetTop > 0 ? `${offsetTop}px` : "";
      termWrap.style.bottom = bottom > 0 ? `${bottom}px` : "";
      // Expose the same geometry as CSS vars for the sibling fixed chrome:
      // --kb-inset lifts the bottom banner above the keyboard; --vv-top lets the
      // top key toolbar follow the visual viewport's offset (otherwise it
      // scrolls off the top when iOS shifts the layout up).
      const root = document.documentElement.style;
      root.setProperty("--kb-inset", `${bottomInset}px`);
      root.setProperty("--vv-top", `${offsetTop}px`);
      startTransition();
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    onChange();
  }

  // Term wrap dimension changes: window resize, font load, devtools dock.
  const ro = new ResizeObserver(startTransition);
  ro.observe(termWrap);
  window.addEventListener("resize", startTransition);

  // Orientation change on mobile. iOS Safari often emits the
  // window.resize event late or not at all on rotation while
  // visualViewport.resize fires reliably; screen.orientation.change is
  // the canonical signal that survives both. Modern browsers expose it
  // on screen.orientation; older Safari falls back to the deprecated
  // window.orientationchange event.
  const orientation = (screen as Screen & { orientation?: ScreenOrientation }).orientation;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for older Safari without screen.orientation
  if (orientation) {
    orientation.addEventListener("change", startTransition);
  } else if ("onorientationchange" in window) {
    window.addEventListener("orientationchange", startTransition);
  }
}
