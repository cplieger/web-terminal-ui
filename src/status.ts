// Connection-state banner. Shows "Reconnecting…" / "Offline" / "Server
// restarted" feedback so users on flaky links understand why typing is
// unresponsive. Hidden by default; appears only when the connection
// state diverges from "open" for more than a brief window (debounced to
// avoid flicker on healthy networks). A "slow connection" indicator is
// intentionally not implemented (see the state machine below).
//
// State machine (matches the `State` union below):
//   open         → no banner.
//   connecting   → "Reconnecting…" (initial connect, before first open).
//   reconnecting → "Reconnecting…" (after a close, during retry);
//                  escalates to offline after >3 consecutive failures.
//   offline      → "Offline".
//   restarted    → "Server restarted — recent input may have been lost".
// A "slow connection" indicator is intentionally not implemented: it would
// need an RTT signal the engine does not currently expose to consumers.

const CONNECTING_GRACE_MS = 600;

// Consecutive failed *initial* connection attempts (before the first screen
// frame, i.e. while `loaded` is still false) after which the "Offline" banner
// is allowed to render anyway. Below this we stay silent and defer to the
// consumer's loading overlay, so a merely-slow first connect raises no false
// alarm; this many failures in a row means the connection genuinely isn't
// coming up and an indefinite silent "Loading…" would be worse than "Offline".
// Aligned with the post-load escalation threshold (consecutiveFailures > 3).
const INITIAL_FAILURE_LIMIT = 4;

type State = "open" | "connecting" | "reconnecting" | "offline" | "restarted";

let banner: HTMLElement | null = null;
let state: State = "connecting";
let stableTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
// True once the first screen frame has rendered (mount calls setLoaded()).
// Until then the initial loading overlay is up and we suppress the
// reconnect/offline banner so the two don't stack — this replaces the old
// `document.getElementById("loading")` probe.
let loaded = false;
// Optional callback supplied by init(): invoked once the initial-connect
// failure limit is reached while still !loaded, so mount can fade its opaque
// loading overlay and let the "Offline" banner underneath become visible.
// mount always supplies this (its dismissLoadingOverlay self-guards when no
// overlay was passed), so onGiveUp is null only when init() is called without
// the callback (e.g. the status unit tests).
let onGiveUp: (() => void) | null = null;

/** Mark the connection as open. Hides the banner. */
export function open(): void {
  consecutiveFailures = 0;
  setState("open", 0);
}

/** Mark the terminal as past its initial load (first screen frame rendered).
 *  Until this is called the connection banner stays suppressed so it never
 *  stacks on top of the consumer's loading overlay. */
export function setLoaded(): void {
  loaded = true;
}

/** Mark a reconnect attempt in progress (after a close, before re-open). */
export function reconnecting(): void {
  if (!loaded) {
    return;
  }
  setState("reconnecting", CONNECTING_GRACE_MS);
}

/** Mark the connection as closed; shows banner after grace period. */
export function closed(): void {
  consecutiveFailures++;
  // Before the first frame, stay suppressed (the loading overlay owns the
  // screen) UNTIL we've failed to connect INITIAL_FAILURE_LIMIT times in a
  // row — at that point the connection clearly isn't coming up, so let the
  // "Offline" banner through rather than leave a silent "Loading…" forever.
  if (!loaded && consecutiveFailures < INITIAL_FAILURE_LIMIT) {
    return;
  }
  // Past the initial-failure limit while the loading overlay is still up: tell
  // mount to fade it so the "Offline" banner below becomes visible rather than
  // staying occluded behind the opaque overlay (which markReady would otherwise
  // never remove on a never-connecting socket). Idempotent, so firing on each
  // subsequent !loaded close is safe.
  if (!loaded) {
    onGiveUp?.();
  }
  setState(consecutiveFailures > 3 ? "offline" : "reconnecting", CONNECTING_GRACE_MS);
}

/** Surface that the server has restarted (epoch mismatch). The
 *  caller has already reset bytesSent/bytesAcked; this just shows
 *  a brief banner so the user knows old input may have been lost. */
export function restarted(): void {
  setState("restarted", 0);
  // Auto-clear the banner after a few seconds; "open" will re-arrive
  // when the next screen frame renders, but we don't want to wait.
  setTimeout(() => {
    if (state === "restarted") {
      setState("open", 0);
    }
  }, 4000);
}

function setState(next: State, delay: number): void {
  if (stableTimer !== null) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
  if (delay === 0) {
    state = next;
    applyState();
    return;
  }
  stableTimer = setTimeout(() => {
    stableTimer = null;
    state = next;
    applyState();
  }, delay);
}

/** Surface a brief transient message (e.g. "Copied") using the same
 *  banner system as connection status. Auto-clears after `ms`. */
export function toast(msg: string, ms = 3000): void {
  if (!banner) {
    return;
  }
  banner.textContent = msg;
  banner.dataset["state"] = "toast";
  banner.classList.add("visible");
  scheduleToastDismiss(ms);
}

let toastDismissTimer: ReturnType<typeof setTimeout> | null = null;
let toastDismissMs = 3000;

function scheduleToastDismiss(ms: number): void {
  toastDismissMs = ms;
  if (toastDismissTimer !== null) {
    clearTimeout(toastDismissTimer);
  }
  toastDismissTimer = setTimeout(dismissToast, ms);
}

function dismissToast(): void {
  toastDismissTimer = null;
  if (!banner) {
    return;
  }
  // Restore the live connection state. applyState() hides the banner when
  // "open" (identical to the old clear) and re-renders "Offline"/"Reconnecting…"
  // when a toast was shown over a non-open status, so the status is never stranded.
  if (banner.dataset["state"] === "toast") {
    applyState();
  }
}

export function init(opts: { banner: HTMLElement; onGiveUp?: () => void }): void {
  banner = opts.banner;
  onGiveUp = opts.onGiveUp ?? null;
  applyState();

  // Hover-pause: stop the auto-dismiss timer while the user hovers
  // (gives them time to read longer messages or click actions).
  banner.addEventListener("mouseenter", () => {
    if (toastDismissTimer !== null) {
      clearTimeout(toastDismissTimer);
      toastDismissTimer = null;
    }
  });
  banner.addEventListener("mouseleave", () => {
    if (banner?.dataset["state"] === "toast" && banner.classList.contains("visible")) {
      scheduleToastDismiss(toastDismissMs);
    }
  });

  // Escape-dismiss: pressing Escape while a toast is visible clears it.
  document.addEventListener("keydown", (ev) => {
    if (
      ev.key === "Escape" &&
      banner?.classList.contains("visible") &&
      banner.dataset["state"] === "toast"
    ) {
      if (toastDismissTimer !== null) {
        clearTimeout(toastDismissTimer);
      }
      dismissToast();
    }
  });
}

function applyState(): void {
  if (!banner) {
    return;
  }
  // Stay fully suppressed until the initial load is over (matches the
  // `loaded` guard in reconnecting()/closed()): the loading overlay, when
  // present, owns the screen until then and a bare page has nothing to show.
  // Exception: once INITIAL_FAILURE_LIMIT consecutive initial connects have
  // failed, let "Offline" through even while !loaded so a never-connecting
  // page doesn't sit on a silent "Loading…" indefinitely.
  if (!loaded && !(state === "offline" && consecutiveFailures >= INITIAL_FAILURE_LIMIT)) {
    banner.classList.remove("visible");
    banner.textContent = "";
    return;
  }
  switch (state) {
    case "open":
      banner.classList.remove("visible");
      banner.textContent = "";
      break;
    case "connecting":
    case "reconnecting":
      banner.textContent = "Reconnecting…";
      banner.dataset["state"] = "reconnecting";
      banner.classList.add("visible");
      break;
    case "offline":
      banner.textContent = "Offline";
      banner.dataset["state"] = "offline";
      banner.classList.add("visible");
      break;
    case "restarted":
      banner.textContent = "Server restarted — recent input may have been lost";
      banner.dataset["state"] = "restarted";
      banner.classList.add("visible");
      break;
  }
}
