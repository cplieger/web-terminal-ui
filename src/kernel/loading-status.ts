// Progressive status text for the consumer's pre-JS loading overlay: the one
// surface the library can speak through during startup, because the overlay
// paints over every piece of chrome inside .wt-root until the first frame lands.
// Silence first, one calm line once the wait is real, rotating reassurance after
// a minute, and a live reason from the server supersedes all of it.

import { windowOf } from "./realm.js";

/** Wording for the progressive loading status. Every field has a library
 *  default; a consumer overrides only what it wants to reword. */
export interface LoadingMessages {
  /** Shown once the wait passes the first threshold. */
  readonly initial: string;
  /** Rotated, in order, once the wait passes the second threshold. Keep them
   *  interchangeable: a user joins the rotation at an arbitrary point. */
  readonly waiting: readonly string[];
}

export const DEFAULT_LOADING_MESSAGES: LoadingMessages = {
  initial: "Loading terminal…",
  waiting: [
    "Still working — this can take a while on first start.",
    "Still working — preparing the environment.",
    "Still working — almost there.",
    "Still working — thanks for your patience.",
  ],
};

/** Delay before the first line appears. Long enough that a normal boot finishes
 *  in silence (the overlay is typically gone inside a second), short enough that
 *  a user who is about to start wondering gets an answer first. */
const INITIAL_DELAY_MS = 5000;
/** When the rotation takes over from the single initial line. */
const WAITING_AFTER_MS = 60000;
/** How often the rotation advances. Slow enough not to read as nervous chatter,
 *  brisk enough that a glance a few seconds later shows something changed. */
const ROTATE_EVERY_MS = 20000;
/** The fade-out half of a message swap; must stay under ROTATE_EVERY_MS and
 *  match the .wt-loading-text transition in css/page.css. */
const SWAP_FADE_MS = 400;

/** Controls the status line on one overlay. Every method is safe to call after
 *  stop(), so the kernel never has to sequence teardown against a pending
 *  timer. */
export interface LoadingStatus {
  /** Replace the wording with a known, specific reason and keep it until the
   *  reason CHANGES. Cancels the rotation: a real reason outranks reassurance,
   *  and alternating between them would be incoherent. Safe to call on every
   *  tick of a retry loop -- an identical string is a no-op, so the announced
   *  line is not re-read to a screen reader every few seconds. */
  reason(text: string): void;
  /** Cancel every timer and remove the text nodes. Idempotent. */
  stop(): void;
}

/** Attach a progressive status line to `overlay`.
 *
 *  `overlay` is the consumer's element, so this only ever APPENDS two children
 *  and removes them again on stop(); it never touches the overlay's own markup,
 *  attributes or classes. A consumer that supplies no overlay gets an inert
 *  controller, so callers need no null handling. */
export function attachLoadingStatus(
  overlay: HTMLElement | undefined,
  messages: LoadingMessages = DEFAULT_LOADING_MESSAGES,
): LoadingStatus {
  if (!overlay) {
    return { reason: () => undefined, stop: () => undefined };
  }
  const doc = overlay.ownerDocument;
  const win = windowOf(doc);

  // The visible line. aria-hidden because the overlay is a live region and this
  // element's whole job is to CHANGE often; the live line below is what speaks.
  const visible = doc.createElement("p");
  visible.className = "wt-loading-text";
  visible.setAttribute("aria-hidden", "true");

  // The announced line. Off-screen by the same clip technique the kernel
  // announcer uses, and written only on meaningful transitions.
  const live = doc.createElement("p");
  live.className = "wt-loading-live";
  Object.assign(live.style, {
    position: "absolute",
    inlineSize: "1px",
    blockSize: "1px",
    margin: "-1px",
    padding: "0",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    border: "0",
  });

  overlay.append(visible, live);

  const timers: number[] = [];
  let rotation: number | undefined;
  let rotateIndex = 0;
  let stopped = false;
  let pinned = false; // a live reason has superseded the scripted wording
  let current = ""; // last reason shown, so a repeat call is a no-op

  const later = (fn: () => void, ms: number): void => {
    timers.push(win.setTimeout(fn, ms));
  };

  // Swap through a fade so a change reads as deliberate. No `stopped` check here
  // or in the deferred half: stop() owns that invariant.
  const show = (text: string): void => {
    // The first write has nothing to fade out, so it must not arrive half-transparent.
    if (visible.textContent === "") {
      visible.textContent = text;
      return;
    }
    visible.classList.add("wt-loading-text-out");
    later(() => {
      visible.textContent = text;
      visible.classList.remove("wt-loading-text-out");
    }, SWAP_FADE_MS);
  };

  const announce = (text: string): void => {
    live.textContent = text;
  };

  later(() => {
    if (pinned) {
      return;
    }
    show(messages.initial);
    announce(messages.initial);
  }, INITIAL_DELAY_MS);

  later(() => {
    const waiting = messages.waiting;
    // `pinned` only, not `stopped`: this callback is held by `timers`, so stop()
    // has cancelled it before it could read the flag.
    if (pinned || waiting.length === 0) {
      return;
    }
    const showAt = (i: number): void => {
      const text = waiting[i];
      if (text !== undefined) {
        show(text);
      }
    };
    // Deliberately NOT announced, now or on any rotation: these carry no
    // information a screen-reader user has not already been told once.
    showAt(0);
    rotation = win.setInterval(() => {
      // No pinned/stopped guard: reason() and stop() both clear this interval.
      // The `pinned` check on the enclosing timer is the one that matters, since
      // the server's refusal arrives within seconds, long before this threshold.
      rotateIndex = (rotateIndex + 1) % waiting.length;
      showAt(rotateIndex);
    }, ROTATE_EVERY_MS);
  }, WAITING_AFTER_MS);

  return {
    reason(text: string): void {
      // Idempotent by text: the caller is a retry loop that knows the reason on
      // every tick, and a re-written live line is re-announced to a screen reader.
      if (stopped || text === "" || text === current) {
        return;
      }
      current = text;
      pinned = true;
      if (rotation !== undefined) {
        win.clearInterval(rotation);
        rotation = undefined;
      }
      show(text);
      announce(text);
    },
    stop(): void {
      // The one owner of "nothing further happens": every callback is armed
      // through later() and lands in `timers`, the rotation is the one handle
      // held apart, so after this line only reason(), the one entry outside a
      // cancellable callback, can run, and it is the one reader of `stopped`.
      // show() and announce() do not re-test it; a timer armed outside later()
      // is what the "stop() leaves no timer armed" test catches.
      if (stopped) {
        return;
      }
      stopped = true;
      for (const t of timers) {
        win.clearTimeout(t);
      }
      if (rotation !== undefined) {
        win.clearInterval(rotation);
      }
      visible.remove();
      live.remove();
    },
  };
}
