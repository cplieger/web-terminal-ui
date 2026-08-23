import { describe, it, expect, afterEach, vi } from "vitest";

import { createClickSwallow, placeMenuAt } from "./menu-position.js";

// The menu's measured size and the viewport are both INPUTS here, stubbed so the
// derived pixels are pinned exactly. The size stub is not an emulator
// workaround: an empty block div has no intrinsic 100x150, in any engine.
//
// The viewport stub is fakeVisualViewport, and it has to be, because
// menu-position.ts reads window.visualViewport FIRST and only falls back to
// innerWidth/innerHeight. Stubbing the two inner* globals instead leaves the real
// visualViewport in place, so production reads the real window and every derived
// pixel below is computed against the wrong box. The fallback arm has its own
// test at the end of the first block.

function makeMenu(width: number, height: number): HTMLElement {
  const menu = document.createElement("div");
  Object.defineProperty(menu, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(menu, "offsetHeight", { value: height, configurable: true });
  document.body.appendChild(menu);
  return menu;
}

function fakeVisualViewport(box: {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}): void {
  vi.stubGlobal("visualViewport", box);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("placeMenuAt", () => {
  it("opens just below the point when it fits", () => {
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 200, 100);
    expect(menu.style.left).toBe("200px");
    expect(menu.style.top).toBe("100px");
  });

  it("clamps to the right and left edges with the 8px margin", () => {
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 790, 100);
    expect(menu.style.left).toBe("692px"); // 800 - 100 - 8
    placeMenuAt(menu, 2, 100);
    expect(menu.style.left).toBe("8px");
  });

  it("flips above the point near the bottom edge, with the 16px fingertip gap", () => {
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 200, 580);
    // 580 + 150 + 8 > 600 → flip: 580 - 150 - 16 = 414
    expect(menu.style.top).toBe("414px");
  });

  it("clamps to the visual viewport when present (keyboard-aware bounds)", () => {
    // A visual viewport smaller than the layout viewport (soft keyboard up).
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 50, width: 400, height: 300 });
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 380, 340);
    expect(menu.style.left).toBe("292px"); // 0 + 400 - 100 - 8
    // 340 + 150 + 8 > 50 + 300 → flip to 340 - 150 - 16 = 174
    expect(menu.style.top).toBe("174px");
  });

  it("never places above the visible top (clamps the flipped position)", () => {
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 0, width: 800, height: 200 });
    const menu = makeMenu(100, 190);
    placeMenuAt(menu, 10, 195);
    // The flip target (195 - 190 - 16 = -11) is off-screen; the top clamp
    // wins so the menu pins to the 8px margin.
    expect(menu.style.top).toBe("8px");
  });
  it("falls back to the layout viewport where there is no visual viewport", () => {
    // Every other case here goes through visualViewport because that is what
    // production prefers. This one pins the else: a browser without the API (or a
    // context where it is absent) has to place off innerWidth/innerHeight, with
    // the view origin at 0,0. Shadowing it with undefined is the only way to
    // reach that arm in a browser that ships the API.
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 200, 100);
    expect(menu.style.left).toBe("200px");
    expect(menu.style.top).toBe("100px");
    // The same right-edge clamp as the visualViewport case, derived from
    // innerWidth this time.
    placeMenuAt(menu, 790, 100);
    expect(menu.style.left).toBe("692px"); // 800 - 100 - 8
  });
});

describe("placeMenuAt: the flip boundary", () => {
  it("keeps the menu below the point when its bottom lands exactly on the margin", () => {
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 200, 442); // 442 + 150 + 8 === 600, the margin itself
    expect(menu.style.top).toBe("442px");
  });

  it("flips as soon as the menu would cross the bottom margin", () => {
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 200, 445); // 445 + 150 + 8 = 603, three past the margin
    expect(menu.style.top).toBe("279px"); // 445 - 150 - 16
  });

  it("clamps a point below the visible viewport back inside it", () => {
    // The keyboard is up: the layout viewport still extends past the visual one,
    // so a point can sit below the visible bottom and the flip target with it.
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 50, width: 400, height: 300 });
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 200, 400);
    // Flip target 400 - 150 - 16 = 234 is past the bottom clamp 50 + 300 - 150 - 8.
    expect(menu.style.top).toBe("192px");
  });

  it("rebases the viewport-space result onto the offsetParent's box", () => {
    // The menu is absolute-positioned against .wt-root, which need not sit at the
    // viewport origin when the terminal is embedded in a panel.
    fakeVisualViewport({ offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
    const menu = makeMenu(100, 150);
    const hostRect = {
      x: 40,
      y: 60,
      left: 40,
      top: 60,
      right: 740,
      bottom: 560,
      width: 700,
      height: 500,
      toJSON: () => ({}),
    } satisfies DOMRect;
    const host = document.createElement("div");
    host.getBoundingClientRect = (): DOMRect => hostRect;
    Object.defineProperty(menu, "offsetParent", { value: host, configurable: true });

    placeMenuAt(menu, 200, 100);

    expect(menu.style.left).toBe("160px"); // 200 - 40
    expect(menu.style.top).toBe("40px"); // 100 - 60
  });
});

describe("createClickSwallow", () => {
  it("swallows the trailing click for the window after arm()", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const swallow = createClickSwallow();
    swallow.arm();
    now.mockReturnValue(1349);
    expect(swallow.swallowing()).toBe(true);
  });

  it("stops swallowing at exactly the end of the window", () => {
    // A deliberate follow-up tap 350ms after the release must dismiss the menu.
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const swallow = createClickSwallow();
    swallow.arm();
    now.mockReturnValue(1350);
    expect(swallow.swallowing()).toBe(false);
  });
});
