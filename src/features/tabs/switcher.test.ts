// The switcher's row enter/leave animations. index.test.ts drives the switcher
// chrome as a whole but never these two, because they only run when a row has a
// measured height — and the test document loads no stylesheet, so an empty row
// measures zero however real the layout engine is. The height is therefore
// supplied here as what it is, an engine reading, and the assertions are on the
// inline styles the functions actually write.
//
// Both are inline-driven and self-clearing (the caller gates motion), so the
// behaviour under test is a TIMELINE: what the row looks like on the frame it is
// added, on the next animation frame, and after the transition's own window.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { animateRowIn, animateRowOut } from "./switcher.js";

// Kept in step with switcher.ts deliberately: the cleanup window is the
// transition plus a margin, and a test that read the constant from the module
// could not tell a changed window from an unchanged one.
const ROW_ANIM_MS = 220;
const CLEANUP_AFTER_MS = ROW_ANIM_MS + 60;

/** A listed row of `heightPx`, attached, with the layout the package stylesheet
 *  would give it. That stylesheet is not loaded here, so the row's own height is
 *  supplied rather than measured: it is the one input these functions read from
 *  outside. */
function rowOf(heightPx: number): HTMLElement {
  const list = document.createElement("ul");
  list.className = "wt-switcher-list";
  const row = document.createElement("li");
  row.className = "wt-switcher-row";
  list.appendChild(row);
  document.body.appendChild(list);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
    height: heightPx,
    width: 320,
    top: 0,
    left: 0,
    right: 320,
    bottom: heightPx,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return row;
}

/** Run the queued animation frame callbacks, which is where both functions put
 *  the state the transition animates TOWARDS. */
function nextFrame(): void {
  vi.advanceTimersByTime(16);
}

describe("animateRowIn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a new row collapsed and transparent so the tray grows into it", () => {
    const row = rowOf(44);

    animateRowIn(row);

    // The first frame is the "from" state, written with transitions off so it
    // takes effect immediately rather than animating from the row's full height.
    // A real CSSOM normalizes a LENGTH on read-back: production writes `0` and
    // `element.style` reports `0px`. Same value, the platform's spelling. A bare
    // number (opacity) is not a length and stays `0`.
    expect(row.style.maxHeight).toBe("0px");
    expect(row.style.opacity).toBe("0");
    expect(row.style.transition).toBe("none");
    expect(row.style.overflow).toBe("hidden");
  });

  it("animates to the row's measured height on the next frame", () => {
    const row = rowOf(44);

    animateRowIn(row);
    nextFrame();

    // The flex list's height follows the row, so the tray height animates rather
    // than snapping. The target is the row's own measured height.
    expect(row.style.maxHeight).toBe("44px");
    expect(row.style.opacity).toBe("1");
    expect(row.style.transition).toContain("max-height 220ms");
    expect(row.style.transition).toContain("opacity 220ms");
  });

  it("rounds a fractional measured height up, so the last text line is not clipped", () => {
    const row = rowOf(43.2);

    animateRowIn(row);
    nextFrame();

    expect(row.style.maxHeight).toBe("44px");
  });

  it("leaves a row with no measured height completely alone", () => {
    // A row the caller adds while the list is display:none measures zero, and a
    // zero-height "from" state would collapse it permanently: the cleanup below
    // is what restores it, and it is scheduled on the same path. Standing down
    // entirely is the only safe answer.
    const row = rowOf(0);

    animateRowIn(row);
    nextFrame();

    expect(row.getAttribute("style")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands the row back to the stylesheet once the transition has run", () => {
    const row = rowOf(44);
    animateRowIn(row);
    nextFrame();

    vi.advanceTimersByTime(CLEANUP_AFTER_MS - 16);

    // Every property it wrote is inline, so leaving any of them behind pins the
    // row's height for the rest of the page's life.
    expect(row.style.maxHeight).toBe("");
    expect(row.style.opacity).toBe("");
    expect(row.style.transition).toBe("");
    expect(row.style.overflow).toBe("");
  });

  it("does not clear the inline state before the transition has finished", () => {
    // The cleanup window has to outlast the transition; clearing at 220ms or
    // earlier drops max-height mid-flight and the row jumps to full size.
    const row = rowOf(44);
    animateRowIn(row);
    nextFrame();

    vi.advanceTimersByTime(ROW_ANIM_MS - 16);

    expect(row.style.maxHeight).toBe("44px");
    expect(row.style.opacity).toBe("1");
  });
});

describe("animateRowOut", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pins the row at its measured height and stops accepting presses", () => {
    const row = rowOf(44);

    animateRowOut(row);

    // Collapsing from `auto` does not animate, so the leaving row's height has to
    // be stated before the transition is armed. pointer-events go with it: the
    // row is on its way out and its close button must not fire again.
    expect(row.style.maxHeight).toBe("44px");
    expect(row.style.opacity).toBe("1");
    expect(row.style.transition).toBe("none");
    expect(row.style.pointerEvents).toBe("none");
  });

  it("collapses to nothing on the next frame", () => {
    const row = rowOf(44);

    animateRowOut(row);
    nextFrame();

    expect(row.style.maxHeight).toBe("0px");
    expect(row.style.opacity).toBe("0");
    expect(row.style.transition).toContain("max-height 220ms");
  });

  it("removes the row from the list once it has collapsed", () => {
    const row = rowOf(44);
    const list = row.parentElement;

    animateRowOut(row);
    nextFrame();
    vi.advanceTimersByTime(CLEANUP_AFTER_MS - 16);

    expect(row.isConnected).toBe(false);
    expect(list?.childElementCount).toBe(0);
  });

  it("keeps the row in the list until the collapse has finished", () => {
    // Removing at 220ms or earlier deletes the row mid-collapse, which reads as
    // the tray snapping shut rather than closing.
    const row = rowOf(44);

    animateRowOut(row);
    nextFrame();
    vi.advanceTimersByTime(ROW_ANIM_MS - 16);

    expect(row.isConnected).toBe(true);
  });

  it("still leaves, and still animates, a row that measures zero", () => {
    // The enter path stands down on a zero height; the leave path must not. A
    // row that cannot be measured still has to disappear, or closing a tab in a
    // collapsed tray leaves its row behind forever.
    const row = rowOf(0);

    animateRowOut(row);
    nextFrame();
    expect(row.style.maxHeight).toBe("0px");

    vi.advanceTimersByTime(CLEANUP_AFTER_MS - 16);
    expect(row.isConnected).toBe(false);
  });
});
