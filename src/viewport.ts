// Viewport stability tracker: iOS keyboard transitions, window resizes,
// font-load reflows and ResizeObserver fires fold into one "transition, then
// settle" lifecycle, so nothing else needs its own debounce. While in
// transition no resize is sent; after SETTLE_MS of quiet onSettled fires and the
// caller sends the final size.

import type { ScrollController } from "@cplieger/web-terminal-engine";
import { windowOf } from "./kernel/realm.js";

// Long enough to bridge the iOS keyboard slide (~250ms) with margin for fonts
// and reflow.
let SETTLE_MS = 350;

/** @internal Test seam: arm every settle started from now on at `ms`; returns the
 *  previous value so the caller can restore it. */
export function setSettleMs(ms: number): number {
  const previous = SETTLE_MS;
  SETTLE_MS = ms;
  return previous;
}

/** The visual viewport against the layout viewport, in whole CSS px. */
interface KeyboardGeometry {
  /** How far the visual viewport is scrolled down the layout viewport. */
  readonly top: number;
  /** How much of the layout viewport's bottom the soft keyboard covers. */
  readonly bottom: number;
}

export interface KeyboardInsetsOptions {
  /** The outermost terminal root: receives --kb-inset and --vv-top, which every
   *  pane and chrome element beneath it inherits, so they scope to the terminal
   *  subtree instead of leaking onto the host document. */
  root: HTMLElement;
  /** Ignore the visualViewport keyboard geometry (a hardware-keyboard device
   *  has no soft keyboard to accommodate). */
  suppressKeyboardInset?: () => boolean;
  /** Called with `softKeyboardHeight()` at every reading, before
   *  `suppressKeyboardInset` is consulted for it. */
  onSoftKeyboard?: (heightPx: number) => void;
}

/** The document's one reading of its visual viewport. */
export interface KeyboardInsets {
  /** The latest geometry; zero where the window has no visual viewport. */
  current(): KeyboardGeometry;
  /** The visual-viewport keyboard inset now in CSS px, never suppressed. */
  softKeyboardHeight(): number;
  /** Call `fn` with the geometry on every visual-viewport resize and scroll, on
   *  every window focus and bfcache restore, and on every `refresh()`; returns
   *  the release. */
  onChange(fn: (geometry: KeyboardGeometry) => void): () => void;
  /** Read again and call every `onChange` subscriber. A no-op after teardown. */
  refresh(): void;
  /** Release every listener and clear the CSS vars published on the root. */
  teardown(): void;
}

export interface ViewportOptions {
  termWrap: HTMLElement;
  /** The box termWrap is pinned within, observed in its place: termWrap's
   *  insets follow chrome measured in ResizeObserver callbacks on boxes deeper
   *  than termWrap, and an observed box resized from such a callback is a
   *  ResizeObserver loop. So a caller that moves termWrap's insets other than
   *  through `keyboard` calls `keyboard.refresh()`, which pins again and starts
   *  a transition. */
  box: HTMLElement;
  /** The document's keyboard geometry, which pins the term wrap over the visible
   *  area. */
  keyboard: KeyboardInsets;
  /** This pane's scroll controller, read at settle. */
  scroll: Pick<ScrollController, "isUserScrolledUp" | "stickToBottom">;
  onSettled: (wasAtBottom: boolean) => void;
}

/** One pane's viewport tracker. */
export interface Viewport {
  /** Whether a transition is in flight, so geometry measured now is provisional. */
  isInTransition(): boolean;
  /** Start a transition as a resize would, for a box about to move that has not
   *  moved yet; it settles SETTLE_MS after the last resize, as any other does. */
  beginTransition(): void;
  /** Release every listener and observer and stop the settle timer. */
  teardown(): void;
}

// The release is pushed as the listener is acquired, so a registration that
// throws drains what came before it.
function listenInto(
  cleanup: (() => void)[],
  target: EventTarget,
  type: string,
  handler: () => void,
): void {
  target.addEventListener(type, handler);
  cleanup.push(() => {
    target.removeEventListener(type, handler);
  });
}

function drain(cleanup: (() => void)[]): void {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
}

export function createKeyboardInsets(opts: KeyboardInsetsOptions): KeyboardInsets {
  const { root } = opts;
  const suppressKeyboardInset = opts.suppressKeyboardInset ?? ((): boolean => false);
  // The terminal's own window: its viewport and its keyboard, not the importing
  // page's.
  const win = windowOf(root.ownerDocument);
  const vv = win.visualViewport;
  const subscribers = new Set<(geometry: KeyboardGeometry) => void>();
  let geometry: KeyboardGeometry = { top: 0, bottom: 0 };
  let live = true;
  const cleanup: (() => void)[] = [];
  function release(): void {
    live = false;
    drain(cleanup);
    subscribers.clear();
    root.style.removeProperty("--kb-inset");
    root.style.removeProperty("--vv-top");
  }

  function readVisual(): KeyboardGeometry {
    return vv
      ? {
          top: Math.max(0, Math.round(vv.offsetTop)),
          bottom: Math.max(0, Math.round(win.innerHeight - vv.offsetTop - vv.height)),
        }
      : { top: 0, bottom: 0 };
  }

  function update(): void {
    const raw = readVisual();
    opts.onSoftKeyboard?.(raw.bottom);
    // iPadOS has been seen to report a keyboard-sized shrink with no keyboard
    // shown and pin it, which is what suppressKeyboardInset defends against.
    geometry = suppressKeyboardInset() ? { top: 0, bottom: 0 } : raw;
    root.style.setProperty("--kb-inset", `${geometry.bottom}px`);
    root.style.setProperty("--vv-top", `${geometry.top}px`);
    for (const fn of [...subscribers]) {
      fn(geometry);
    }
  }

  try {
    if (vv) {
      listenInto(cleanup, vv, "resize", update);
      listenInto(cleanup, vv, "scroll", update);
      // Recompute on focus and bfcache restore, so a one-off bad visualViewport
      // reading clears on the next natural interaction instead of at reload.
      listenInto(cleanup, win, "focus", update);
      listenInto(cleanup, win, "pageshow", update);
    }
    update();
  } catch (err) {
    release();
    throw err;
  }

  return {
    current: () => geometry,
    softKeyboardHeight: () => readVisual().bottom,
    onChange(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    refresh() {
      if (live) {
        update();
      }
    },
    teardown: release,
  };
}

export function createViewport(opts: ViewportOptions): Viewport {
  const { termWrap, keyboard, scroll } = opts;
  // The terminal's own window: its viewport and its rotation, not the importing
  // page's.
  const win = windowOf(termWrap.ownerDocument);
  let inTransition = false;
  let settleTimer: number | null = null;
  const cleanup: (() => void)[] = [];
  function release(): void {
    drain(cleanup);
    if (settleTimer !== null) {
      win.clearTimeout(settleTimer);
      settleTimer = null;
    }
    inTransition = false;
  }

  function startTransition(): void {
    inTransition = true;
    if (settleTimer !== null) {
      win.clearTimeout(settleTimer);
    }
    settleTimer = win.setTimeout(() => {
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

  // iOS shrinks (and can offset) the visual viewport without resizing the layout
  // viewport, so a `position: fixed; inset: 0` box keeps the full-screen height
  // behind the keyboard; driving top and bottom from the keyboard geometry keeps
  // the terminal over the visible area everywhere.
  function pin(geometry: KeyboardGeometry): void {
    // A feature sets --wt-reserve-bottom (px) on the root for bottom chrome the
    // content must clear; it is measured with the keyboard closed, so adding it
    // to the keyboard inset does not double-count.
    const rawReserve = Math.max(
      0,
      Math.round(
        parseFloat(win.getComputedStyle(termWrap).getPropertyValue("--wt-reserve-bottom")) || 0,
      ),
    );
    // The reserve is a tab bar, tens of px; a value near half the screen is a
    // bad measurement that would strand the lower half of the terminal black.
    const reserve = Math.min(rawReserve, Math.round(win.innerHeight / 3));
    const bottom = geometry.bottom + reserve;
    termWrap.style.top = geometry.top > 0 ? `${geometry.top}px` : "";
    termWrap.style.bottom = bottom > 0 ? `${bottom}px` : "";
    startTransition();
  }

  try {
    cleanup.push(keyboard.onChange(pin));
    pin(keyboard.current());

    const ro = new win.ResizeObserver(startTransition);
    cleanup.push(() => {
      ro.disconnect();
    });
    ro.observe(opts.box);
    listenInto(cleanup, win, "resize", startTransition);

    // iOS Safari often emits window.resize late or not at all on rotation while
    // screen.orientation.change survives; older Safari has only the deprecated
    // window event.
    const orientation = (win.screen as Screen & { orientation?: ScreenOrientation }).orientation;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for older Safari without screen.orientation
    if (orientation) {
      listenInto(cleanup, orientation, "change", startTransition);
    } else if ("onorientationchange" in win) {
      listenInto(cleanup, win, "orientationchange", startTransition);
    }
  } catch (err) {
    release();
    throw err;
  }

  return {
    isInTransition: () => inTransition,
    beginTransition: startTransition,
    teardown: release,
  };
}
