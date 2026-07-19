// Connection-state machine (kernel-owned, design section 22.3). The state, the
// never-connects give-up, and the loading lifecycle are kernel; the visible
// banner is the connectionBanner feature, which renders whatever state this
// emits. This is the DOM-free half of the old status.ts (its banner/toast
// rendering became the connectionBanner feature and the kernel toast surface).
//
// State machine:
//   open         -> no banner.
//   connecting   -> "Reconnecting..." (initial connect, before first open).
//   reconnecting -> "Reconnecting..." (after a close, during retry);
//                   escalates to offline after >3 consecutive failures.
//   offline      -> "Offline".
//   restarted    -> "Server restarted - recent input may have been lost".

import type { ConnState } from "./types.js";

const CONNECTING_GRACE_MS = 600;

// Consecutive failed initial connects (before the first screen frame) after
// which "Offline" is allowed through even while the loading overlay is up, so a
// never-connecting page does not sit on a silent "Loading..." forever. Aligned
// with the post-load escalation threshold (>3).
const INITIAL_FAILURE_LIMIT = 4;

const RESTARTED_CLEAR_MS = 4000;

export interface ConnStateMachine {
  /** Connection opened. */
  open(): void;
  /** Reconnect attempt in progress. */
  reconnecting(): void;
  /** Connection closed / outbox full. */
  closed(): void;
  /** Server restarted (epoch mismatch); recent input may be lost. */
  restarted(): void;
  /** The active session's process exited (the engine's definitive 4001
   *  close). Unlike closed(), this is not a failure to escalate or retry:
   *  the state shows immediately and persists until open() (a switch to a
   *  live session) replaces it. */
  ended(): void;
  /** The engine refused an explicitly incompatible wire revision. This
   *  terminal state bypasses the loading gate and persists until open(). */
  incompatible(): void;
  /** First screen frame rendered: the loading overlay is done, so the banner
   *  may show reconnect state from here on. */
  setLoaded(): void;
  /** Current state. */
  current(): ConnState;
  /** Clear timers (kernel destroy). */
  destroy(): void;
}

export function createConnState(opts: {
  onState: (s: ConnState) => void;
  onGiveUp?: () => void;
}): ConnStateMachine {
  let state: ConnState = "connecting";
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let restartedTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let loaded = false;

  function emit(): void {
    // Suppress transient states until the initial load is over (the loading
    // overlay owns the screen). Terminal states ("ended" and "incompatible")
    // must pass through because no later frame or reconnect will explain the
    // failure; "offline" also passes once the initial-failure limit is reached.
    // connectionBanner renders "open" as hidden.
    const passesLoadingGate =
      state === "ended" ||
      state === "incompatible" ||
      (state === "offline" && consecutiveFailures >= INITIAL_FAILURE_LIMIT);
    if (!loaded && !passesLoadingGate) {
      opts.onState("open"); // nothing to show yet
      return;
    }
    opts.onState(state);
  }

  function setState(next: ConnState, delay: number): void {
    if (stableTimer !== null) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    if (delay === 0) {
      state = next;
      emit();
      return;
    }
    stableTimer = setTimeout(() => {
      stableTimer = null;
      state = next;
      emit();
    }, delay);
  }

  return {
    open(): void {
      consecutiveFailures = 0;
      setState("open", 0);
    },
    reconnecting(): void {
      if (!loaded) {
        return;
      }
      setState("reconnecting", CONNECTING_GRACE_MS);
    },
    closed(): void {
      consecutiveFailures++;
      if (!loaded && consecutiveFailures < INITIAL_FAILURE_LIMIT) {
        return;
      }
      if (!loaded) {
        opts.onGiveUp?.();
      }
      setState(consecutiveFailures > 3 ? "offline" : "reconnecting", CONNECTING_GRACE_MS);
    },
    restarted(): void {
      setState("restarted", 0);
      if (restartedTimer !== null) {
        clearTimeout(restartedTimer);
      }
      restartedTimer = setTimeout(() => {
        restartedTimer = null;
        if (state === "restarted") {
          setState("open", 0);
        }
      }, RESTARTED_CLEAR_MS);
    },
    ended(): void {
      // A definitive end, not a failure: reset the failure streak so a later
      // reconnect to a LIVE session starts its escalation ladder from zero,
      // and show the state immediately (no grace delay — nothing is retrying).
      consecutiveFailures = 0;
      setState("ended", 0);
    },
    incompatible(): void {
      // Wire refusal is terminal for this page instance. Like ended, it is not
      // part of the failure ladder and must remain visible without a timer.
      consecutiveFailures = 0;
      setState("incompatible", 0);
    },
    setLoaded(): void {
      loaded = true;
    },
    current(): ConnState {
      return state;
    },
    destroy(): void {
      if (stableTimer !== null) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      if (restartedTimer !== null) {
        clearTimeout(restartedTimer);
        restartedTimer = null;
      }
    },
  };
}
