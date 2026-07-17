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
// The terminal root (.wt-root): the geometry CSS vars (--kb-inset, --vv-top)
// are published here so the terminal subtree — and nothing else on the host
// page — inherits them. Falls back to termWrap if init was somehow given no
// root (never in practice; the kernel always passes it).
let varTarget: HTMLElement;
let onSettled: ((wasAtBottom: boolean) => void) | null = null;
let inTransition = false;
let wasAtBottomAtStart = true;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
// When true, ignore the visualViewport keyboard geometry entirely (a hardware
// keyboard/trackpad is present, so the soft keyboard never opens). Set at init
// from the kernel's hasFinePointer; see the onChange note below.
let suppressKeyboardInset: () => boolean = () => false;
// Removals for every listener/observer init() attaches, so teardown() can
// release them on kernel destroy(). Without it the window/visualViewport/
// screen.orientation listeners and the ResizeObserver survive destroy() and a
// re-created terminal double-binds them.
let cleanup: (() => void)[] = [];

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
  /** The terminal root (.wt-root): receives the geometry CSS vars the sibling
   *  chrome reads (--kb-inset, --vv-top), so they scope to the terminal
   *  subtree instead of leaking onto the host document. */
  root?: HTMLElement;
  onSettled: (wasAtBottom: boolean) => void;
  /** Ignore the visualViewport keyboard geometry (a hardware-keyboard device
   *  has no soft keyboard to accommodate); only reserved bottom chrome insets
   *  the terminal. The kernel passes its hasFinePointer here. */
  suppressKeyboardInset?: () => boolean;
}): void {
  termWrap = opts.termWrap;
  varTarget = opts.root ?? opts.termWrap;
  onSettled = opts.onSettled;
  suppressKeyboardInset = opts.suppressKeyboardInset ?? (() => false);

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
      // suppressKeyboardInset (set at init from the kernel's hasFinePointer): on
      // a device with a hardware keyboard/trackpad (a desktop, or an iPad with a
      // Magic Keyboard) the on-screen keyboard never opens, so there is no
      // keyboard geometry to accommodate. iPadOS has been seen to briefly report
      // a keyboard-sized visualViewport shrink with no keyboard shown, which this
      // handler then pinned as a bottom inset and left stuck (the terminal "moved
      // up ~50%", black below, surviving tab switches because nothing recomputes
      // it — only a reload cleared it). Ignore the keyboard geometry there and
      // keep the terminal full-height; only the reserved bottom chrome applies.
      const offsetTop = suppressKeyboardInset() ? 0 : Math.max(0, Math.round(vv.offsetTop));
      const bottomInset = suppressKeyboardInset()
        ? 0
        : Math.max(0, Math.round(window.innerHeight - vv.offsetTop - vv.height));
      // Reserved bottom chrome (a bottom tab bar) the content must clear, on top
      // of the keyboard inset. A feature sets --wt-reserve-bottom (px) on the
      // root, 0 when none; viewport owns the terminal's fixed-box geometry, so it
      // folds the reserve into the bottom offset here. The reserve excludes the
      // keyboard (it is measured with the keyboard closed), so adding it to
      // bottomInset does not double-count.
      // Read the reserve off the terminal itself: tabs publishes it on the
      // root (.wt-root), and termWrap inherits it — nothing terminal-scoped
      // lives on the document root anymore.
      const rawReserve = Math.max(
        0,
        Math.round(
          parseFloat(getComputedStyle(termWrap).getPropertyValue("--wt-reserve-bottom")) || 0,
        ),
      );
      // Sanity cap: the reserve is bottom chrome (a tab bar), tens of px. A value
      // near half the screen is a bad measurement — e.g. the switcher bar
      // measured while a phantom keyboard inset had lifted it — that would
      // otherwise strand the lower half of the terminal black. Never let it
      // exceed a third of the viewport height.
      const reserve = Math.min(rawReserve, Math.round(window.innerHeight / 3));
      const bottom = bottomInset + reserve;
      termWrap.style.top = offsetTop > 0 ? `${offsetTop}px` : "";
      termWrap.style.bottom = bottom > 0 ? `${bottom}px` : "";
      // Expose the same geometry as CSS vars for the sibling chrome, on the
      // terminal ROOT (scoped: the host page never sees them): --kb-inset
      // lifts the bottom banner above the keyboard; --vv-top lets the top key
      // toolbar follow the visual viewport's offset (otherwise it scrolls off
      // the top when iOS shifts the layout up).
      varTarget.style.setProperty("--kb-inset", `${bottomInset}px`);
      varTarget.style.setProperty("--vv-top", `${offsetTop}px`);
      startTransition();
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    // Self-heal a stuck inset (see the fine-pointer note above): recompute when
    // the window regains focus or is restored from the bfcache, so a one-off bad
    // visualViewport reading that got pinned clears on the next natural
    // interaction instead of surviving until a full page reload.
    window.addEventListener("focus", onChange);
    window.addEventListener("pageshow", onChange);
    cleanup.push(() => {
      window.removeEventListener("focus", onChange);
      window.removeEventListener("pageshow", onChange);
    });
    cleanup.push(() => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    });
    onChange();
  }

  // Term wrap dimension changes: window resize, font load, devtools dock.
  const ro = new ResizeObserver(startTransition);
  ro.observe(termWrap);
  window.addEventListener("resize", startTransition);
  cleanup.push(() => {
    ro.disconnect();
    window.removeEventListener("resize", startTransition);
  });

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
    cleanup.push(() => {
      orientation.removeEventListener("change", startTransition);
    });
  } else if ("onorientationchange" in window) {
    window.addEventListener("orientationchange", startTransition);
    cleanup.push(() => {
      window.removeEventListener("orientationchange", startTransition);
    });
  }
}

// Release every listener/observer init() attached and stop the settle timer.
// The kernel calls this from destroy() so a create->destroy->create remount
// does not leave stale global listeners double-bound.
export function teardown(): void {
  for (const fn of cleanup) {
    fn();
  }
  cleanup = [];
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  // Clear the CSS vars onChange published on the terminal root, so a destroy
  // without a remount (which would recompute them) leaves no stale inset.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- teardown may run before any init in tests
  if (varTarget) {
    varTarget.style.removeProperty("--kb-inset");
    varTarget.style.removeProperty("--vv-top");
  }
  inTransition = false;
  onSettled = null;
  suppressKeyboardInset = () => false;
}
