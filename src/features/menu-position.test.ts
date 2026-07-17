// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";

import { placeMenuAt } from "./menu-position.js";

// happy-dom does no layout: stub the menu's measured size and the viewport.

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
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 200, 100);
    expect(menu.style.left).toBe("200px");
    expect(menu.style.top).toBe("100px");
  });

  it("clamps to the right and left edges with the 8px margin", () => {
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);
    const menu = makeMenu(100, 150);
    placeMenuAt(menu, 790, 100);
    expect(menu.style.left).toBe("692px"); // 800 - 100 - 8
    placeMenuAt(menu, 2, 100);
    expect(menu.style.left).toBe("8px");
  });

  it("flips above the point near the bottom edge, with the 16px fingertip gap", () => {
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);
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
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 200);
    const menu = makeMenu(100, 190);
    placeMenuAt(menu, 10, 195);
    // The flip target (195 - 190 - 16 = -11) is off-screen; the top clamp
    // wins so the menu pins to the 8px margin.
    expect(menu.style.top).toBe("8px");
  });
});
