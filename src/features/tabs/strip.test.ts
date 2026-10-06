// The strip's markup factories. index.test.ts drives the built chrome; these pin
// the two things a caller of chipContent can only get from the string itself,
// because the desktop chip is assembled at module scope and never re-rendered.
import { describe, it, expect } from "vitest";

import {
  PEN_DRAG,
  REORDER_MOVE_EPS_PX,
  REORDER_REST_MS,
  REORDER_SETTLE_MS,
  REORDER_SHIFT_TRANS,
  REORDER_SLOT_FADE_MS,
  REORDER_STILL_MS,
  TOUCH_DRAG,
  chipContent,
  exceedsSlop,
  noteRestSample,
  pointerDragActivation,
  viewportMoved,
  type RestState,
} from "./strip.js";

function parse(html: string): HTMLElement | null {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector("button");
}

describe("chipContent: the close button", () => {
  it("carries the caller's extra attributes verbatim", () => {
    // The whole chip is the switch target and the close is nested inside it, so
    // tabindex="-1" is what keeps Tab from stopping on the close button. It is the
    // caller's to pass, which means the markup has to emit it untouched.
    const { close } = chipContent({
      dot: "wt-tab-dot",
      label: "wt-tab-label",
      close: "wt-tab-close",
      closeAttr: ' tabindex="-1"',
    });

    const button = parse(close);

    expect(button?.getAttribute("tabindex")).toBe("-1");
    expect(button?.getAttribute("aria-label")).toBe("Close terminal");
  });

  it("emits no stray attribute when the caller passes none", () => {
    // The absent case must interpolate to nothing at all. Anything else lands
    // inside the open tag, where a browser parses it as an attribute name.
    const { close } = chipContent({ dot: "d", label: "l", close: "c" });

    const button = parse(close);

    expect(button?.getAttributeNames().sort()).toEqual(["aria-label", "class", "type"]);
  });
});

describe("pointerDragActivation: how a press becomes a drag", () => {
  it("leaves a mouse to native drag-and-drop, with no hold of its own", () => {
    expect(pointerDragActivation("mouse")).toBeNull();
  });

  it("holds touch 150ms inside an 8px slop", () => {
    expect(pointerDragActivation("touch")).toEqual({ holdMs: 150, slopPx: 8 });
  });

  it("holds a pen exactly as long and as still as a finger", () => {
    // A pen on a touchscreen pans the strip like a finger does, so a pen swipe
    // must reach the same scroll a finger's does.
    expect(pointerDragActivation("pen")).toEqual({ holdMs: 150, slopPx: 8 });
  });

  it("gives an unknown pointer the touch rule, which can never hijack a scroll", () => {
    expect(pointerDragActivation("")).toEqual({ holdMs: 150, slopPx: 8 });
  });
});

describe("the reorder vocabulary shared with marotte's tabs-drag.ts", () => {
  // These values are a twin of marotte's: both strips must reorder at one cadence
  // and one activation, so a change here is a change there.
  it("names the activation rules and the reorder timings at their shared values", () => {
    expect(TOUCH_DRAG).toEqual({ holdMs: 150, slopPx: 8 });
    expect(PEN_DRAG).toEqual({ holdMs: 150, slopPx: 8 });
    expect({
      REORDER_STILL_MS,
      REORDER_REST_MS,
      REORDER_MOVE_EPS_PX,
      REORDER_SHIFT_TRANS,
      REORDER_SETTLE_MS,
      REORDER_SLOT_FADE_MS,
    }).toEqual({
      REORDER_STILL_MS: 50,
      REORDER_REST_MS: 450,
      REORDER_MOVE_EPS_PX: 3,
      REORDER_SHIFT_TRANS: "translate 0.2s cubic-bezier(0.2, 0, 0, 1)",
      REORDER_SETTLE_MS: 300,
      REORDER_SLOT_FADE_MS: 300,
    });
  });
});

describe("exceedsSlop: travel measured against a rule", () => {
  it("holds a tremor of exactly the slop", () => {
    expect(exceedsSlop(8, 0, TOUCH_DRAG)).toBe(false);
  });

  it("is a distance, so travel under the slop on each axis can still exceed it", () => {
    // 6px on each axis is 8.49px.
    expect(exceedsSlop(6, 6, TOUCH_DRAG)).toBe(true);
  });
});

describe("noteRestSample: telling a stop from a sweep", () => {
  it("never calls the first sample still", () => {
    const rest: RestState = { at: null, movedAt: 0 };

    expect(noteRestSample(rest, 100, 1000)).toBe(false);
  });

  it("calls the pointer still only once it has held within 3px for 50ms", () => {
    const rest: RestState = { at: null, movedAt: 0 };
    noteRestSample(rest, 100, 1000);

    expect(noteRestSample(rest, 101, 1049)).toBe(false);
    expect(noteRestSample(rest, 102, 1050)).toBe(true);
  });

  it("restarts the clock on a move past 3px", () => {
    const rest: RestState = { at: null, movedAt: 0 };
    noteRestSample(rest, 100, 1000);

    expect(noteRestSample(rest, 104, 1060)).toBe(false);
    expect(noteRestSample(rest, 104, 1100)).toBe(false);
    expect(noteRestSample(rest, 104, 1110)).toBe(true);
  });

  it("counts a step of exactly 3px as still", () => {
    const rest: RestState = { at: null, movedAt: 0 };
    noteRestSample(rest, 100, 1000);

    expect(noteRestSample(rest, 103, 1050)).toBe(true);
  });
});

describe("viewportMoved: whether the box moved under a still pointer", () => {
  const box = { offsetLeft: 0, offsetTop: 0, width: 1000, height: 600 };

  it("absorbs sub-pixel jitter", () => {
    expect(
      viewportMoved(box, { offsetLeft: 0.4, offsetTop: 0.9, width: 999.5, height: 600.2 }),
    ).toBe(false);
  });

  it("reads a zoomed-in pan that has not moved since the press as unmoved", () => {
    const panned = { offsetLeft: 240, offsetTop: 180, width: 500, height: 300 };
    expect(viewportMoved(panned, { ...panned })).toBe(false);
  });

  it.each(["offsetLeft", "offsetTop", "width", "height"] as const)(
    "reads a 1px change of %s as a move",
    (field) => {
      expect(viewportMoved(box, { ...box, [field]: box[field] + 1 })).toBe(true);
    },
  );
});
