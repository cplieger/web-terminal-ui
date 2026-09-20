import { afterEach, describe, expect, it, vi } from "vitest";
import { fadeOutOverlay } from "./fatal.js";

describe("fadeOutOverlay: an overlay in a second document", () => {
  // The fallback removal (no transitionend) runs on the overlay's own window: a
  // frame that goes away takes the timer with it, and the importing page's clock
  // has no say over the frame's overlay.
  afterEach(() => {
    vi.useRealTimers();
    for (const frame of document.querySelectorAll("iframe")) {
      frame.remove();
    }
  });

  it("removes the overlay on the frame's clock, not the importing page's", () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) {
      throw new Error("no frame document");
    }
    const due: (() => void)[] = [];
    Object.defineProperty(win, "setTimeout", {
      configurable: true,
      value: (fn: () => void): number => due.push(fn),
    });
    const overlay = doc.createElement("div");
    doc.body.appendChild(overlay);

    fadeOutOverlay(overlay);
    expect(overlay.classList.contains("fade")).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(overlay.isConnected).toBe(true);

    expect(due).toHaveLength(1);
    due[0]?.();
    expect(overlay.isConnected).toBe(false);
  });
});
