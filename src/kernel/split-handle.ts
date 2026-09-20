import { clampRatio, MIN_PANE_PX, SPLIT_GUTTER_PX } from "./layout-policy.js";
import { windowOf } from "./realm.js";
import type { PaneSide, ShellContext, SplitState, Unsubscribe } from "./types.js";

/** A press that travels less than this is a tap, not a drag. */
const DRAG_START_PX = 8;
/** At most one resize pair per this interval while a drag or a held key moves
 *  the divider; the engine drops a size equal to the last sent. */
const RESIZE_INTERVAL_MS = 100;
/** One arrow press moves the divider this far: two fallback cells of 8 px. */
const KEY_STEP_PX = 16;

const NUDGE_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** The handle as the shell holds it. */
export interface SplitHandle {
  /** The `role="separator"` element, kept between the two pane roots. */
  readonly element: HTMLElement;
  dispose(): void;
}

/** What the handle reads off the shell: the root it measures, the controller it
 *  drives, and the panes it resizes. */
export type SplitHandleShell = Pick<ShellContext, "root" | "split" | "panes">;

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startLeftPx: number;
  /** The pane row minus the gutter: the width the ratio is a share of. */
  readonly span: number;
  /** Whether the pointer has travelled DRAG_START_PX yet. */
  moving: boolean;
  /** The pane under the minimum right now: dimmed, and closed on release. */
  squeezed: PaneSide | null;
  /** Whether any move of this drag put a pane under the minimum. */
  dipped: boolean;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** The grip handle between the two panes: a focusable separator a pointer drags
 *  and the arrow keys nudge. The caller places the element between the pane
 *  roots; the stylesheet shows it only while the split is open and not
 *  collapsed. Transactional: a throw during construction releases the
 *  subscription and the listeners taken before it. */
export function createSplitHandle(shell: SplitHandleShell): SplitHandle {
  const root = shell.root;
  const doc = root.ownerDocument;
  const win = windowOf(doc);
  const split = shell.split;
  const own = new AbortController();

  const el = doc.createElement("div");
  el.className = "wt-split-handle";
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", "vertical");
  el.setAttribute("aria-label", "Pane divider");
  el.tabIndex = 0;

  const bounds = (): { min: number; max: number } => {
    const width = root.clientWidth;
    return { min: clampRatio(0, width), max: clampRatio(1, width) };
  };
  const percent = (ratio: number): string => String(Math.round(ratio * 100));
  function paint(state: SplitState): void {
    const { min, max } = bounds();
    el.setAttribute("aria-valuenow", percent(state.ratio));
    el.setAttribute("aria-valuemin", percent(min));
    el.setAttribute("aria-valuemax", percent(max));
    el.dataset["faces"] = state.selected;
    if (drag !== null && (!state.open || state.collapsed)) {
      abandonDrag();
    }
  }

  let lastSentAt = -Infinity;
  let trailing: number | null = null;
  function announceNow(): void {
    lastSentAt = win.Date.now();
    for (const pane of shell.panes()) {
      pane.announceSize();
    }
  }
  function cancelTrailing(): void {
    if (trailing !== null) {
      win.clearTimeout(trailing);
      trailing = null;
    }
  }
  function announceThrottled(): void {
    const elapsed = win.Date.now() - lastSentAt;
    if (elapsed >= RESIZE_INTERVAL_MS) {
      cancelTrailing();
      announceNow();
      return;
    }
    trailing ??= win.setTimeout(() => {
      trailing = null;
      announceNow();
    }, RESIZE_INTERVAL_MS - elapsed);
  }
  function flushAnnounce(): void {
    cancelTrailing();
    announceNow();
  }

  function squeezedAt(ratio: number, span: number): PaneSide | null {
    const leftPx = ratio * span;
    if (leftPx < MIN_PANE_PX) {
      return "left";
    }
    return span - leftPx < MIN_PANE_PX ? "right" : null;
  }
  function paintSqueezed(side: PaneSide | null): void {
    for (const s of ["left", "right"] as const) {
      root
        .querySelector(`:scope > .wt-split-pane.wt-side-${s}`)
        ?.classList.toggle("wt-pane-closing", s === side);
    }
  }

  let drag: Drag | null = null;
  let gesture: AbortController | null = null;
  function endDrag(): void {
    gesture?.abort();
    gesture = null;
    drag = null;
    el.classList.remove("wt-handle-held");
  }
  /** The split closed or collapsed under the pointer: the drag decides nothing. */
  function abandonDrag(): void {
    endDrag();
    cancelTrailing();
    paintSqueezed(null);
  }
  function onPointerDown(ev: PointerEvent): void {
    const state = split.state();
    if (drag !== null || ev.button !== 0 || !state.open || state.collapsed) {
      return;
    }
    // Keeps focus in the terminal and stops a text selection from starting.
    ev.preventDefault();
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* a pointer the browser no longer tracks; the window listeners follow it */
    }
    const span = root.clientWidth - SPLIT_GUTTER_PX;
    drag = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startLeftPx: state.ratio * span,
      span,
      moving: false,
      squeezed: null,
      dipped: false,
    };
    el.classList.add("wt-handle-held");
    gesture = new AbortController();
    const opts = { signal: gesture.signal };
    win.addEventListener("pointermove", onPointerMove, opts);
    win.addEventListener("pointerup", onPointerEnd, opts);
    win.addEventListener("pointercancel", onPointerEnd, opts);
  }
  function onPointerMove(ev: PointerEvent): void {
    const d = drag;
    if (d?.pointerId !== ev.pointerId) {
      return;
    }
    const dx = ev.clientX - d.startX;
    if (!d.moving) {
      if (Math.abs(dx) < DRAG_START_PX) {
        return;
      }
      d.moving = true;
    }
    const ratio = clamp01((d.startLeftPx + dx) / d.span);
    split.setRatio(ratio, false);
    d.squeezed = squeezedAt(ratio, d.span);
    if (d.squeezed !== null) {
      d.dipped = true;
    }
    paintSqueezed(d.squeezed);
    announceThrottled();
  }
  function onPointerEnd(ev: PointerEvent): void {
    const d = drag;
    if (d?.pointerId !== ev.pointerId) {
      return;
    }
    endDrag();
    if (!d.moving) {
      return;
    }
    cancelTrailing();
    paintSqueezed(null);
    if (d.squeezed !== null && split.closeSide(d.squeezed)) {
      return;
    }
    // A drag that dipped under the minimum was a close gesture, so releasing
    // above it, or a close the split refuses, cancels the drag rather than
    // committing a share at or past the threshold.
    const state = split.state();
    split.setRatio(d.dipped ? state.committedRatio : state.ratio, true);
    announceNow();
  }
  let nudgePending = false;
  function onKeydown(ev: KeyboardEvent): void {
    if (!NUDGE_KEYS.has(ev.key)) {
      return;
    }
    const state = split.state();
    if (!state.open || state.collapsed) {
      return;
    }
    ev.preventDefault();
    const span = root.clientWidth - SPLIT_GUTTER_PX;
    const { min, max } = bounds();
    let next: number;
    if (ev.key === "ArrowLeft") {
      next = (Math.round(state.ratio * span) - KEY_STEP_PX) / span;
    } else if (ev.key === "ArrowRight") {
      next = (Math.round(state.ratio * span) + KEY_STEP_PX) / span;
    } else {
      next = ev.key === "Home" ? min : max;
    }
    // The separator declares aria-valuemin and aria-valuemax as the values that
    // exist, so a key never crosses them, and a held key has no release to
    // confirm a close with; closing from the keyboard is the split button's.
    next = Math.min(Math.max(next, min), max);
    if (next === state.ratio) {
      return;
    }
    split.setRatio(next, false);
    nudgePending = true;
    announceThrottled();
  }
  // A key's release edge is the analogue of the pointer's release, so a held key
  // writes one record.
  function commitNudge(): void {
    if (!nudgePending) {
      return;
    }
    nudgePending = false;
    flushAnnounce();
    split.setRatio(split.state().ratio, true);
  }
  function onKeyup(ev: KeyboardEvent): void {
    if (NUDGE_KEYS.has(ev.key)) {
      commitNudge();
    }
  }

  let offChange: Unsubscribe = () => undefined;
  function dispose(): void {
    own.abort();
    endDrag();
    cancelTrailing();
    nudgePending = false;
    offChange();
    el.remove();
  }
  try {
    paint(split.state());
    offChange = split.onChange(paint);
    const opts = { signal: own.signal };
    el.addEventListener("pointerdown", onPointerDown, opts);
    el.addEventListener("keydown", onKeydown, opts);
    el.addEventListener("keyup", onKeyup, opts);
    el.addEventListener("blur", commitNudge, opts);
  } catch (err) {
    dispose();
    throw err;
  }

  return { element: el, dispose };
}
