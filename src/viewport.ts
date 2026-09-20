// Viewport stability tracker: iOS keyboard transitions, window resizes,
// font-load reflows and ResizeObserver fires fold into one "transition, then
// settle" lifecycle, so nothing else needs its own debounce. While in
// transition no resize is sent; after SETTLE_MS of quiet onSettled fires and the
// caller sends the final size.

import type { ScrollController } from "@cplieger/web-terminal-engine";

// Long enough to bridge the iOS keyboard slide (~250ms) with margin for fonts
// and reflow.
const SETTLE_MS = 350;

export interface ViewportOptions {
  termWrap: HTMLElement;
  /** The terminal root: receives the geometry CSS vars the sibling chrome reads
   *  (--kb-inset, --vv-top), so they scope to the terminal subtree instead of
   *  leaking onto the host document. */
  root?: HTMLElement;
  /** This pane's scroll controller, read at settle. */
  scroll: Pick<ScrollController, "isUserScrolledUp" | "stickToBottom">;
  onSettled: (wasAtBottom: boolean) => void;
  /** Ignore the visualViewport keyboard geometry (a hardware-keyboard device
   *  has no soft keyboard to accommodate); only reserved bottom chrome insets
   *  the terminal. */
  suppressKeyboardInset?: () => boolean;
}

/** One pane's viewport tracker. */
export interface Viewport {
  /** Whether a transition is in flight, so geometry measured now is provisional. */
  isInTransition(): boolean;
  /** Release every listener and observer, stop the settle timer, and clear the
   *  CSS vars published on the root. */
  teardown(): void;
}

export function createViewport(opts: ViewportOptions): Viewport {
  const { termWrap, scroll } = opts;
  const varTarget = opts.root ?? opts.termWrap;
  const suppressKeyboardInset = opts.suppressKeyboardInset ?? ((): boolean => false);
  let inTransition = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanup: (() => void)[] = [];

  function startTransition(): void {
    inTransition = true;
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
    }
    settleTimer = setTimeout(() => {
      settleTimer = null;
      inTransition = false;
      // Read at SETTLE, not at the start of the burst: every further event
      // re-arms the timer without re-reading, and on iOS a wake emits a stream
      // of them, so a latch taken at the start would yank a reader who scrolled
      // up mid-burst back down.
      const stillFollowing = !scroll.isUserScrolledUp();
      if (stillFollowing) {
        scroll.stickToBottom();
      }
      opts.onSettled(stillFollowing);
    }, SETTLE_MS);
  }

  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onChange = (): void => {
      // iOS shrinks (and can offset) the visual viewport without resizing the
      // layout viewport, so a `position: fixed; inset: 0` box keeps the
      // full-screen height behind the keyboard; driving top and bottom from
      // visualViewport keeps the terminal over the visible area everywhere.
      // iPadOS has been seen to report a keyboard-sized shrink with no keyboard
      // shown and pin it, which is what suppressKeyboardInset defends against.
      const offsetTop = suppressKeyboardInset() ? 0 : Math.max(0, Math.round(vv.offsetTop));
      const bottomInset = suppressKeyboardInset()
        ? 0
        : Math.max(0, Math.round(window.innerHeight - vv.offsetTop - vv.height));
      // A feature sets --wt-reserve-bottom (px) on the root for bottom chrome the
      // content must clear; it is measured with the keyboard closed, so adding it
      // to the keyboard inset does not double-count.
      const rawReserve = Math.max(
        0,
        Math.round(
          parseFloat(getComputedStyle(termWrap).getPropertyValue("--wt-reserve-bottom")) || 0,
        ),
      );
      // The reserve is a tab bar, tens of px; a value near half the screen is a
      // bad measurement that would strand the lower half of the terminal black.
      const reserve = Math.min(rawReserve, Math.round(window.innerHeight / 3));
      const bottom = bottomInset + reserve;
      termWrap.style.top = offsetTop > 0 ? `${offsetTop}px` : "";
      termWrap.style.bottom = bottom > 0 ? `${bottom}px` : "";
      varTarget.style.setProperty("--kb-inset", `${bottomInset}px`);
      varTarget.style.setProperty("--vv-top", `${offsetTop}px`);
      startTransition();
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    // Recompute on focus and bfcache restore, so a one-off bad visualViewport
    // reading clears on the next natural interaction instead of at reload.
    window.addEventListener("focus", onChange);
    window.addEventListener("pageshow", onChange);
    cleanup.push(() => {
      window.removeEventListener("focus", onChange);
      window.removeEventListener("pageshow", onChange);
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    });
    onChange();
  }

  const ro = new ResizeObserver(startTransition);
  ro.observe(termWrap);
  window.addEventListener("resize", startTransition);
  cleanup.push(() => {
    ro.disconnect();
    window.removeEventListener("resize", startTransition);
  });

  // iOS Safari often emits window.resize late or not at all on rotation while
  // screen.orientation.change survives; older Safari has only the deprecated
  // window event.
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

  return {
    isInTransition: () => inTransition,
    teardown() {
      for (const fn of cleanup) {
        fn();
      }
      cleanup.length = 0;
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      varTarget.style.removeProperty("--kb-inset");
      varTarget.style.removeProperty("--vv-top");
      inTransition = false;
    },
  };
}
