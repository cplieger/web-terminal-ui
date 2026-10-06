import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { TerminalContext } from "../../kernel/types.js";
import type { TabsApi } from "./index.js";
import {
  activeLabels,
  chipOf,
  chips,
  fakeDataTransfer,
  fakeServer,
  mountTabbed,
  rootIn,
  shown,
  until,
  type FakeSessionServer,
} from "./test-helpers/split.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const FINGER = 7;

let server: FakeSessionServer;
let ctx: TerminalContext;
let api: TabsApi;
beforeEach(() => {
  expect(matchMedia("(pointer: coarse)").matches).toBe(true);
  fake.reset();
  server = fakeServer();
  server.list = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
    { id: "s3", title: "three", createdAt: "3", status: "idle" },
  ];
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Mounted with the desktop strip (a 1000 x 600 root on a touch device is an
 *  iPad), then on fake timers so a hold can be measured to the millisecond. */
async function mountStrip(): Promise<HTMLElement> {
  const root = rootIn(1000, 600);
  ({ ctx, api } = await mountTabbed(root, server));
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  return root;
}

function centre(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pointer(
  type: string,
  target: EventTarget,
  x: number,
  y: number,
  init: PointerEventInit = {},
): PointerEvent {
  const e = new PointerEvent(type, {
    pointerId: FINGER,
    pointerType: "touch",
    isPrimary: true,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

const lifted = (root: HTMLElement): boolean =>
  root.querySelector(".wt-tab-scroll .wt-tab-dragging") !== null;
function scrollerOf(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>(".wt-tab-scroll");
  if (!el) {
    throw new Error("no tab scroller");
  }
  return el;
}
const labels = (root: HTMLElement): string[] =>
  chips(root).map((c) => c.querySelector(".wt-tab-label")?.textContent ?? "");
const orderWrites = (): unknown[] =>
  server.fetch.mock.calls
    .filter((c) => String(c[0]).endsWith("/order") && c[1]?.method === "PUT")
    .map((c) => JSON.parse(String(c[1]?.body)) as unknown);

/** A point inside the strip past the midpoint of `label`'s chip. */
function pastChip(root: HTMLElement, label: string): { x: number; y: number } {
  const r = chipOf(root, label).getBoundingClientRect();
  return { x: r.right - 4, y: r.top + r.height / 2 };
}

interface FakeViewport extends EventTarget {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

/** A visual viewport whose box a test can move, as a raised keyboard or a pinch-zoom
 *  pan moves the real one. */
function stubViewport(): FakeViewport {
  const vv: FakeViewport = Object.assign(new EventTarget(), {
    offsetLeft: 0,
    offsetTop: 0,
    width: 1000,
    height: 600,
  });
  vi.stubGlobal("visualViewport", vv);
  expect(window.visualViewport).toBe(vv);
  return vv;
}

/** Press `label`, hold it long enough to lift, and drag it to `to`, resting there
 *  long enough for the slot under it to open. */
function liftAndDrag(root: HTMLElement, label: string, to: { x: number; y: number }): void {
  const chip = chipOf(root, label);
  const from = centre(chip);
  pointer("pointerdown", chip, from.x, from.y);
  vi.advanceTimersByTime(150);
  pointer("pointermove", chip, to.x, to.y);
  vi.advanceTimersByTime(120);
}

describe("a touch press on a strip chip", () => {
  it("lifts into a drag after a 150ms hold, and not a millisecond sooner", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(149);
    expect(lifted(root)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(lifted(root)).toBe(true);
    expect(root.querySelectorAll(".wt-tab-ghost")).toHaveLength(1);

    pointer("pointerup", chip, at.x, at.y);
    expect(lifted(root)).toBe(false);
    expect(root.querySelectorAll(".wt-tab-ghost")).toHaveLength(0);
  });

  it("lifts a pen on the same hold", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y, { pointerType: "pen" });
    vi.advanceTimersByTime(150);

    expect(lifted(root)).toBe(true);
  });

  it("never lifts a mouse press by holding it, and leaves the chip natively draggable", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y, { pointerType: "mouse" });
    vi.advanceTimersByTime(1000);

    expect(lifted(root)).toBe(false);
    expect(chip.draggable).toBe(true);
  });

  it("is a scroll, not a drag, once it strays more than 8px from where it landed", async () => {
    // 6px on each axis is 8.49px of travel: under the slop on either axis alone,
    // over it as a distance.
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(100);
    pointer("pointermove", chip, at.x + 6, at.y + 6);
    vi.advanceTimersByTime(100);

    expect(lifted(root)).toBe(false);
    expect(chip.draggable).toBe(true);
  });

  it("still lifts after a tremor of exactly 8px", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(100);
    pointer("pointermove", chip, at.x + 8, at.y);
    vi.advanceTimersByTime(50);

    expect(lifted(root)).toBe(true);
  });

  it("is one drag: the platform's own drag cannot start beside it", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    expect(chip.draggable).toBe(false);
    vi.advanceTimersByTime(150);
    const dt = fakeDataTransfer();
    const native = new DragEvent("dragstart", { bubbles: true, cancelable: true, clientX: at.x });
    Object.defineProperty(native, "dataTransfer", { value: dt });
    chip.dispatchEvent(native);

    expect(native.defaultPrevented).toBe(true);
    expect(dt.data).toEqual({});
    expect(root.querySelectorAll(".wt-tab-ghost")).toHaveLength(1);
    pointer("pointerup", chip, at.x, at.y);
    expect(chip.draggable).toBe(true);
  });

  it("keeps the hold through a viewport event that moved nothing", async () => {
    const root = await mountStrip();
    const vv = stubViewport();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(100);
    vv.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(50);

    expect(lifted(root)).toBe(true);
  });

  it("drops the hold, needing a fresh press, when the viewport moved before the lift", async () => {
    // The chip that was under the finger may not be under it now, so the press is
    // not re-based onto the moved frame: travel afterwards starts no drag.
    const root = await mountStrip();
    const vv = stubViewport();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(100);
    vv.height -= 300;
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(100);
    pointer("pointermove", chip, at.x + 40, at.y);
    vi.advanceTimersByTime(200);

    expect(lifted(root)).toBe(false);
    expect(chip.draggable).toBe(true);
    pointer("pointerup", chip, at.x + 40, at.y);
    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(150);
    expect(lifted(root)).toBe(true);
  });

  it("drops the hold when a move reads a viewport that moved before its event", async () => {
    const root = await mountStrip();
    const vv = stubViewport();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(100);
    vv.height -= 300;
    pointer("pointermove", chip, at.x + 1, at.y);
    vi.advanceTimersByTime(50);

    expect(lifted(root)).toBe(false);
    expect(chip.draggable).toBe(true);
  });

  it("ends the drag when a viewport move from before the lift is reported after it", async () => {
    // The hold's timer can run after the geometry moved and before its viewport event
    // is delivered, so the live drag is judged against the frame at the press.
    const root = await mountStrip();
    const vv = stubViewport();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vv.height -= 300;
    vi.advanceTimersByTime(150);
    expect(lifted(root)).toBe(true);

    vv.dispatchEvent(new Event("resize"));

    expect(lifted(root)).toBe(false);
    expect(root.querySelectorAll(".wt-tab-ghost")).toHaveLength(0);
    expect(orderWrites()).toEqual([]);
  });

  it("drops a pending hold on Escape and leaves the key to the terminal", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(100);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    vi.advanceTimersByTime(100);

    expect(e.defaultPrevented).toBe(false);
    expect(lifted(root)).toBe(false);
    expect(chip.draggable).toBe(true);
  });

  it("keeps the strip from panning only once the chip has lifted", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);
    const touchmove = (): TouchEvent => {
      const touch = new Touch({ identifier: FINGER, target: chip, clientX: at.x, clientY: at.y });
      const e = new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        changedTouches: [touch],
      });
      chip.dispatchEvent(e);
      return e;
    };

    pointer("pointerdown", chip, at.x, at.y);
    expect(touchmove().defaultPrevented).toBe(false);
    vi.advanceTimersByTime(150);
    expect(touchmove().defaultPrevented).toBe(true);
  });

  it("lifts nothing from the chip being renamed", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const field = chip.querySelector(".wt-tab-rename");
    if (!field) {
      throw new Error("no rename field");
    }
    const at = centre(chip);

    pointer("pointerdown", field, at.x, at.y);
    vi.advanceTimersByTime(150);

    expect(lifted(root)).toBe(false);
    expect(root.querySelectorAll(".wt-tab-ghost")).toHaveLength(0);
  });

  it("leaves a chip renamed mid-press undraggable once the finger lifts", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(50);
    chip.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }),
    );
    pointer("pointerup", chip, at.x, at.y);

    expect(chip.querySelector(".wt-tab-rename")).not.toBeNull();
    expect(chip.draggable).toBe(false);
  });

  it("is a scroll, not a drag, once the strip scrolls under the held finger", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(100);
    scrollerOf(root).dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(50);

    expect(lifted(root)).toBe(false);
    expect(chip.draggable).toBe(true);
  });

  it("gives a press right after a tap its own full hold", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(100);
    pointer("pointerup", chip, at.x, at.y);
    vi.advanceTimersByTime(20);
    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(40);
    expect(lifted(root)).toBe(false);
    vi.advanceTimersByTime(110);
    expect(lifted(root)).toBe(true);
  });
});

describe("a touch drag along the strip", () => {
  it("reorders through the shared preview and publishes the order on release", async () => {
    const root = await mountStrip();
    const to = pastChip(root, "three");

    liftAndDrag(root, "one", to);
    expect(labels(root)).toEqual(["two", "three", "one"]);
    expect(orderWrites()).toEqual([]);
    pointer("pointerup", chipOf(root, "one"), to.x, to.y);

    expect(labels(root)).toEqual(["two", "three", "one"]);
    expect(orderWrites()).toEqual([{ order: ["s2", "s3", "s1"] }]);
    expect(lifted(root)).toBe(false);
  });

  it.each([
    [
      "pointercancel",
      (root: HTMLElement): void => {
        pointer("pointercancel", chipOf(root, "one"), 0, 0);
      },
    ],
    [
      "a second finger",
      (root: HTMLElement): void => {
        pointer("pointerdown", chipOf(root, "two"), 0, 0, { pointerId: 8, isPrimary: false });
      },
    ],
    [
      "lostpointercapture",
      (root: HTMLElement): void => {
        const bar = root.querySelector(".wt-tab-bar");
        if (!bar) {
          throw new Error("no tab bar");
        }
        pointer("lostpointercapture", bar, 0, 0, { bubbles: false });
      },
    ],
    [
      "the viewport moving",
      (_root: HTMLElement, vv: FakeViewport): void => {
        vv.height -= 300;
        vv.dispatchEvent(new Event("resize"));
      },
    ],
    [
      "a window resize that moved the viewport",
      (_root: HTMLElement, vv: FakeViewport): void => {
        vv.width -= 200;
        window.dispatchEvent(new Event("resize"));
      },
    ],
    [
      "the window losing focus",
      (): void => {
        window.dispatchEvent(new Event("blur"));
      },
    ],
    [
      "the page going hidden",
      (): void => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
    [
      "Escape",
      (): void => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      },
    ],
  ])("puts the strip back when %s ends it", async (_name, end) => {
    const root = await mountStrip();
    const vv = stubViewport();

    liftAndDrag(root, "one", pastChip(root, "three"));
    expect(labels(root)).toEqual(["two", "three", "one"]);
    end(root, vv);

    expect(labels(root)).toEqual(["one", "two", "three"]);
    expect(lifted(root)).toBe(false);
    expect(root.querySelectorAll(".wt-tab-ghost")).toHaveLength(0);
    expect(orderWrites()).toEqual([]);
    expect(chipOf(root, "one").draggable).toBe(true);
  });

  it("keeps a live drag through viewport events that moved nothing", async () => {
    // visualViewport fires scroll on an ordinary page scroll, and a resize can carry
    // sub-pixel jitter: neither moved the chip under the finger.
    const root = await mountStrip();
    const vv = stubViewport();
    const to = pastChip(root, "three");

    liftAndDrag(root, "one", to);
    vv.dispatchEvent(new Event("scroll"));
    vv.height += 0.5;
    vv.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));

    expect(lifted(root)).toBe(true);
    expect(labels(root)).toEqual(["two", "three", "one"]);
    pointer("pointerup", chipOf(root, "one"), to.x, to.y);
    expect(orderWrites()).toEqual([{ order: ["s2", "s3", "s1"] }]);
  });

  it("ends a lifted drag's Escape there, so the key is not typed into the terminal", async () => {
    const root = await mountStrip();
    const reached = vi.fn();
    document.addEventListener("keydown", reached);

    liftAndDrag(root, "one", pastChip(root, "three"));
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    document.removeEventListener("keydown", reached);

    expect(e.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
    expect(lifted(root)).toBe(false);
  });

  it("swallows the click its own release would deliver", async () => {
    const root = await mountStrip();
    const to = pastChip(root, "three");
    expect(activeLabels(root)).toEqual(["one"]);

    liftAndDrag(root, "two", to);
    pointer("pointerup", chipOf(root, "two"), to.x, to.y);
    chipOf(root, "two").click();

    expect(activeLabels(root)).toEqual(["one"]);
  });

  it("lets the next tap through when the drop's own release delivered no click", async () => {
    const root = await mountStrip();
    const to = pastChip(root, "three");
    liftAndDrag(root, "two", to);
    pointer("pointerup", chipOf(root, "two"), to.x, to.y);
    const chip = chipOf(root, "three");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    pointer("pointerup", chip, at.x, at.y);
    chip.click();

    expect(activeLabels(root)).toEqual(["three"]);
  });

  it("carries the lifted chip's image with the finger", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "one");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(150);
    pointer("pointermove", chip, at.x + 40, at.y + 3);

    expect(root.querySelector<HTMLElement>(".wt-tab-ghost")?.style.translate).toBe("40px 3px");
  });

  it.each([
    [
      "another pointer's cancel",
      (): void => {
        pointer("pointercancel", document.body, 0, 0, { pointerId: 9, pointerType: "pen" });
      },
    ],
    [
      "the chip's own capture ending as the bar takes it over",
      (root: HTMLElement): void => {
        pointer("lostpointercapture", chipOf(root, "one"), 0, 0);
      },
    ],
    [
      "a strip scroll",
      (root: HTMLElement): void => {
        scrollerOf(root).dispatchEvent(new Event("scroll"));
      },
    ],
    [
      "a visibility change that leaves the page visible",
      (): void => {
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
    [
      "a key other than Escape",
      (): void => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", cancelable: true }));
      },
    ],
  ])("keeps the drag through %s", async (_name, event) => {
    const root = await mountStrip();
    const to = pastChip(root, "three");

    liftAndDrag(root, "one", to);
    event(root);
    expect(lifted(root)).toBe(true);
    pointer("pointerup", chipOf(root, "one"), to.x, to.y);

    expect(orderWrites()).toEqual([{ order: ["s2", "s3", "s1"] }]);
  });

  it("starts a later drag from rest, untouched by the last one's finger", async () => {
    const root = await mountStrip();
    const to = pastChip(root, "three");
    liftAndDrag(root, "one", to);
    pointer("pointerup", chipOf(root, "one"), to.x, to.y);
    expect(labels(root)).toEqual(["two", "three", "one"]);
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(450);

    expect(lifted(root)).toBe(true);
    expect(labels(root)).toEqual(["two", "three", "one"]);
  });
});

describe("a touch press that lifts but never moves", () => {
  it("is a tap: nothing reorders and its click switches tabs", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(150);
    pointer("pointerup", chip, at.x, at.y);
    chip.click();

    expect(activeLabels(root)).toEqual(["two"]);
    expect(labels(root)).toEqual(["one", "two", "three"]);
    expect(orderWrites()).toEqual([]);
  });

  it("still opens the tab menu on a long press", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(500);
    const e = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
    });
    chip.dispatchEvent(e);

    expect(root.querySelector(".wt-tab-menu")?.classList.contains("visible")).toBe(true);
    expect(lifted(root)).toBe(false);
  });

  it("opens no menu once the drag has moved", async () => {
    const root = await mountStrip();
    const to = pastChip(root, "three");

    liftAndDrag(root, "one", to);
    const e = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: to.x,
      clientY: to.y,
    });
    chipOf(root, "one").dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    expect(root.querySelector(".wt-tab-menu")?.classList.contains("visible")).toBe(false);
    expect(lifted(root)).toBe(true);
  });
});

describe("a touch drag onto a split half", () => {
  it("with one tab, creates the other pane's tab and opens the split", async () => {
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const root = await mountStrip();
    const r = root.getBoundingClientRect();
    const right = { x: r.left + r.width * 0.75, y: r.top + r.height * 0.4 };

    liftAndDrag(root, "one", right);
    expect(root.classList.contains("wt-drop-right")).toBe(true);
    pointer("pointerup", chipOf(root, "one"), right.x, right.y);
    vi.useRealTimers();
    await until(() => shown(ctx, "left") === "s-new");

    expect(root.classList.contains("wt-drop-right")).toBe(false);
    expect(shown(ctx, "right")).toBe("s1");
    expect(chips(root)).toHaveLength(2);
    expect(server.posts()).toBe(1);
  });

  it("lights the half under the finger as it arrives, and clears it back over the strip", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "one");
    const at = centre(chip);
    const r = root.getBoundingClientRect();

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(150);
    pointer("pointermove", chip, r.left + r.width * 0.75, r.top + r.height * 0.4);
    expect(root.classList.contains("wt-drop-right")).toBe(true);
    pointer("pointermove", chip, at.x + 40, at.y);

    expect(root.classList.contains("wt-drop-right")).toBe(false);
  });
});

describe("a touch press that lifts and only trembles", () => {
  it("is still a tap: nothing is published and its click switches tabs", async () => {
    const root = await mountStrip();
    const chip = chipOf(root, "two");
    const at = centre(chip);

    pointer("pointerdown", chip, at.x, at.y);
    vi.advanceTimersByTime(150);
    pointer("pointermove", chip, at.x + 3, at.y + 2);
    pointer("pointerup", chip, at.x + 3, at.y + 2);
    chip.click();

    expect(activeLabels(root)).toEqual(["two"]);
    expect(orderWrites()).toEqual([]);
  });
});

describe("a tab closed during a touch drag", () => {
  it("leaves the drag of another chip running", async () => {
    const root = await mountStrip();
    const to = pastChip(root, "three");
    liftAndDrag(root, "one", to);

    void api.close("s2");
    expect(lifted(root)).toBe(true);
    pointer("pointerup", chipOf(root, "one"), to.x, to.y);

    expect(lifted(root)).toBe(false);
    expect(orderWrites()).toEqual([{ order: ["s3", "s1"] }]);
  });

  it("ends the drag of its own chip, handing the strip back to panning at once", async () => {
    const root = await mountStrip();
    liftAndDrag(root, "one", pastChip(root, "three"));
    const chip = chipOf(root, "two");
    const at = centre(chip);

    void api.close("s1");
    const touch = new Touch({ identifier: FINGER, target: chip, clientX: at.x, clientY: at.y });
    const e = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      changedTouches: [touch],
    });
    chip.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
    expect(root.querySelectorAll(".wt-tab-ghost")).toHaveLength(0);
  });
});
