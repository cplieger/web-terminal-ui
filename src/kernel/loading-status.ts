// Progressive status text for the consumer's pre-JS loading overlay.
//
// The problem this solves: the overlay is an opaque full-viewport box the
// consumer paints before any JS runs, and the kernel only lowers it once the
// first terminal frame arrives. Every piece of terminal chrome the library could
// speak through -- the toast layer, the connection banner -- lives inside
// .wt-root and paints UNDER that overlay, so for as long as startup takes, the
// library can say nothing a sighted user can see. On a fast boot that does not
// matter; the overlay is gone in well under a second. On web-terminal-kiro's
// first boot it matters a lot: the server answers session creation with 503
// "tools installing" while its tool engine installs, the session owner retries
// for up to twenty minutes, and the user watched a black screen with an
// unlabelled sweep bar the whole time, unable to tell a server that is
// deliberately waiting from an app that has hung.
//
// The design, in order of what a user experiences:
//
//   1. SILENCE FIRST. Nothing is written for the first few seconds. A message
//      that flashes up and vanishes on a normal boot is worse than no message,
//      and most boots never reach the first threshold at all.
//   2. ONE calm line once the wait is real ("Loading terminal...").
//   3. After a minute, ROTATING reassurance. A single sentence frozen on screen
//      for nineteen more minutes reads exactly as hung as no sentence -- the
//      whole point is to show the system is still alive, so the line changes.
//   4. A LIVE REASON supersedes all of the above the moment one is known. The
//      truthful wording for "tools installing" lives on the server, arrives in
//      the 503 body, and is pushed in by the session owner; it is strictly more
//      useful than anything this module could guess.
//
// Accessibility, and the trap that shapes the DOM here: the overlay is a
// role="status" live region, so anything written into it is ANNOUNCED. Rotating
// four messages every twenty seconds for twenty minutes would interrupt a screen
// reader roughly sixty times to say nothing new. So the visible line is
// aria-hidden and a separate off-screen live line carries only MEANINGFUL
// changes -- the first threshold, and each new live reason. Sighted users get
// motion; assistive tech gets information; neither gets the other's noise.

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
  doc: Document = document,
): LoadingStatus {
  if (!overlay) {
    return { reason: () => undefined, stop: () => undefined };
  }

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
    timers.push(window.setTimeout(fn, ms));
  };

  // Swap the visible text through a fade so a change reads as deliberate rather
  // than as a glitch. The first write skips the fade (there is nothing to fade
  // out) so the line does not arrive half-transparent.
  const show = (text: string): void => {
    if (stopped) {
      return;
    }
    // First write has nothing to fade out, so it must not arrive half-transparent.
    if (visible.textContent === "") {
      visible.textContent = text;
      return;
    }
    visible.classList.add("wt-loading-text-out");
    later(() => {
      if (stopped) {
        return;
      }
      visible.textContent = text;
      visible.classList.remove("wt-loading-text-out");
    }, SWAP_FADE_MS);
  };

  const announce = (text: string): void => {
    if (!stopped) {
      live.textContent = text;
    }
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
    if (pinned || stopped || waiting.length === 0) {
      return;
    }
    // showAt reads through an undefined check rather than an index assertion:
    // under noUncheckedIndexedAccess every element read is `string | undefined`,
    // and the check is the only form both the assertion-style and
    // no-non-null-assertion lint rules accept.
    const showAt = (i: number): void => {
      const text = waiting[i];
      if (text !== undefined) {
        show(text);
      }
    };
    // Deliberately NOT announced, now or on any rotation: these carry no
    // information a screen-reader user has not already been told once.
    showAt(0);
    rotation = window.setInterval(() => {
      // No pinned/stopped guard here: both reason() and stop() clear this
      // interval, so a tick cannot reach this line after either. The guard that
      // matters is the `pinned` check on the ENCLOSING timer above, because the
      // real production sequence puts reason() FIRST -- the server refuses
      // session creation within a second or two, long before this 60s threshold
      // -- and without it the rotation would start late and overwrite the
      // server's own explanation with generic reassurance.
      rotateIndex = (rotateIndex + 1) % waiting.length;
      showAt(rotateIndex);
    }, ROTATE_EVERY_MS);
  }, WAITING_AFTER_MS);

  return {
    reason(text: string): void {
      // Idempotent by text, and that is load-bearing rather than an
      // optimisation: the natural caller is a retry loop that knows the reason
      // on every tick, and re-writing the announced line would re-announce the
      // same sentence to a screen reader every few seconds for the whole wait.
      // Guarding here means a caller may call this as often as it likes.
      if (stopped || text === "" || text === current) {
        return;
      }
      current = text;
      pinned = true;
      if (rotation !== undefined) {
        window.clearInterval(rotation);
        rotation = undefined;
      }
      show(text);
      announce(text);
    },
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const t of timers) {
        window.clearTimeout(t);
      }
      if (rotation !== undefined) {
        window.clearInterval(rotation);
      }
      visible.remove();
      live.remove();
    },
  };
}
