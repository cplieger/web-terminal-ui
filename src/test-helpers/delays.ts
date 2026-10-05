// Shorter stand-ins for the production delays a test would otherwise wait out
// in real time. Each module is imported on call, as in mount.ts, so a test
// file's mock of the engine module is in place first.

import { onTestFinished } from "vitest";

const SHORT_SETTLE_MS = 20;
/** Long enough that the clear and the set stay two mutations a frame apart. */
const SHORT_REANNOUNCE_MS = 10;

function restoreOnce(apply: () => void): () => void {
  let done = false;
  const restore = (): void => {
    if (!done) {
      done = true;
      apply();
    }
  };
  onTestFinished(restore);
  return restore;
}

/** Arm every viewport settle started from now on at SHORT_SETTLE_MS. The
 *  returned restore puts the real value back, and runs anyway when the test
 *  ends; restore it before any phase that needs a transition still in flight. */
export async function shortenSettle(): Promise<() => void> {
  const { setSettleMs } = await import("../viewport.js");
  const previous = setSettleMs(SHORT_SETTLE_MS);
  return restoreOnce(() => {
    setSettleMs(previous);
  });
}

/** Past every settle armed under shortenSettle: two frames, so a ResizeObserver
 *  delivery between them has armed its timer, then three short settles. */
export function shortSettled(): Promise<void> {
  return new Promise((r) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(r, 3 * SHORT_SETTLE_MS));
    });
  });
}

/** Re-set every announcement after SHORT_REANNOUNCE_MS until the test ends. */
export async function shortenReannounce(): Promise<void> {
  const { setReannounceDelayMs } = await import("../kernel/a11y.js");
  const previous = setReannounceDelayMs(SHORT_REANNOUNCE_MS);
  restoreOnce(() => {
    setReannounceDelayMs(previous);
  });
}

/** Past every announcement queued under shortenReannounce. */
export function shortAnnounced(): Promise<void> {
  return new Promise((r) => setTimeout(r, 3 * SHORT_REANNOUNCE_MS));
}
