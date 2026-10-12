import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type {} from "@vitest/browser-playwright";
import { cdp, page } from "vitest/browser";
import { shortenSettle, shortSettled } from "../../test-helpers/delays.js";
import {
  chipOf,
  dragAt,
  engineOn,
  fakeDataTransfer,
  fakeServer,
  mountTabbed,
  paneRoot,
  rootIn,
  settle,
  stripSplit,
  type FakeSessionServer,
} from "./test-helpers/split.js";
import {
  softKeyboard,
  span,
  tabbedStylesheet,
  termOf,
  withoutVisualViewport,
  type SoftKeyboard,
} from "./test-helpers/paint.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

let styles: HTMLStyleElement;
beforeAll(() => {
  styles = tabbedStylesheet();
});
afterAll(() => {
  styles.remove();
});

let server: FakeSessionServer;
beforeEach(() => {
  fake.reset();
  server = fakeServer();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function hoverFill(root: HTMLElement): string {
  const probe = document.createElement("div");
  probe.style.background = "var(--tab-hover-bg)";
  root.appendChild(probe);
  const fill = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return fill;
}

describe("the split buttons' on-state", () => {
  it("fills both buttons like the keyboard toggle's open state while the split is open, and only then", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    const strip = stripSplit(root);
    const sw = root.querySelector<HTMLElement>(".wt-switcher-split");
    const fill = hoverFill(root);
    expect(fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(strip).backgroundColor).not.toBe(fill);

    strip.click();
    expect(term.split?.isOpen()).toBe(true);
    expect(getComputedStyle(strip).backgroundColor).toBe(fill);
    expect(sw && getComputedStyle(sw).backgroundColor).toBe(fill);

    strip.click();
    expect(term.split?.isOpen()).toBe(false);
    expect(getComputedStyle(strip).backgroundColor).not.toBe(fill);
    expect(sw && getComputedStyle(sw).backgroundColor).not.toBe(fill);
  });
});

function lightness(color: string): number {
  const m = /^oklch\(([\d.]+)%? /.exec(color);
  if (m?.[1] === undefined) {
    throw new Error(`not an oklch colour: ${color}`);
  }
  return Number(m[1]);
}

describe("the selected pane's chip", () => {
  it("rests a rung brighter than the other shown chip, which keeps the single view's active fill", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    const one = chipOf(root, "one");
    const two = chipOf(root, "two");
    const activeFill = getComputedStyle(one).backgroundColor;

    stripSplit(root).click();
    expect(ctx.shell.selected()).toBe("left");
    const selectedFill = getComputedStyle(one).backgroundColor;
    expect(getComputedStyle(two).backgroundColor).toBe(activeFill);
    expect(lightness(selectedFill)).toBeGreaterThan(lightness(activeFill));
    expect(getComputedStyle(one).borderColor).toBe(getComputedStyle(two).borderColor);

    ctx.shell.select("right");
    expect(getComputedStyle(two).backgroundColor).toBe(selectedFill);
    expect(getComputedStyle(one).backgroundColor).toBe(activeFill);

    term.split?.close();
    expect(getComputedStyle(two).backgroundColor).toBe(activeFill);
  });

  it("still lifts under a hover and again under a press", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    stripSplit(root).click();
    const one = chipOf(root, "one");
    const rest = lightness(getComputedStyle(one).backgroundColor);
    // Real input: :hover and :active are the browser's to set. The test frame
    // sits at the page origin, so its client coordinates are the page's.
    const box = one.getBoundingClientRect();
    const at = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const input = cdp();

    await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    const hovered = lightness(getComputedStyle(one).backgroundColor);
    await input.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...at,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    const pressed = lightness(getComputedStyle(one).backgroundColor);
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...at,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });

    expect(window.frameElement?.getBoundingClientRect().left).toBe(0);
    expect(hovered).toBeGreaterThan(rest);
    expect(pressed).toBeGreaterThan(hovered);
  });
});

describe("the split icon", () => {
  function glyph(root: HTMLElement, button: string): SVGSVGElement {
    const icon = root.querySelector<SVGSVGElement>(`${button} > svg`);
    if (!icon) {
      throw new Error(`no ${button} icon`);
    }
    return icon;
  }

  it("is outlined in the button's colour, never filled", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    const icon = glyph(root, ".wt-tab-split");
    const color = getComputedStyle(stripSplit(root)).color;
    for (const shape of icon.querySelectorAll("rect, path")) {
      expect(getComputedStyle(shape).fill).toBe("none");
      expect(getComputedStyle(shape).stroke).toBe(color);
    }
  });

  // The keyboard button is hidden under a fine pointer, so its glyph is
  // compared by the size and stroke the stylesheet gives it.
  it("draws at the keyboard glyph's size and stroke weight, inside the same rounded square", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    const split = glyph(root, ".wt-tab-split");
    const kb = glyph(root, ".wt-tab-kb");
    const box = split.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([18, 18]);
    const [s, k] = [getComputedStyle(split), getComputedStyle(kb)];
    expect([s.width, s.height, s.strokeWidth]).toEqual([k.width, k.height, k.strokeWidth]);
    expect(split.getAttribute("viewBox")).toBe(kb.getAttribute("viewBox"));
    const frame = (svg: SVGSVGElement): (string | null)[] => {
      const r = svg.querySelector("rect");
      return ["x", "y", "width", "height", "rx"].map((a) => r?.getAttribute(a) ?? null);
    };
    expect(frame(split)).toEqual(frame(kb));
  });
});

describe("the soft keyboard's inset with a fine pointer", () => {
  let keyboard: SoftKeyboard;
  beforeEach(() => {
    keyboard = softKeyboard();
  });
  afterEach(async () => {
    keyboard.restore();
    await page.viewport(1280, 720);
  });

  // iPadOS has reported a keyboard-sized shrink with no keyboard shown; a
  // device with a fine pointer has a hardware keyboard and no soft one.
  it("ignores a keyboard-sized shrink", async () => {
    expect(matchMedia("(any-pointer: fine)").matches).toBe(true);
    await page.viewport(390, 700);
    const root = rootIn(390, 700);
    await mountTabbed(root, server);
    await settle();
    const term = termOf(paneRoot(root, "left"));
    const before = span(term)[1];

    keyboard.open(300);
    await settle();

    expect(span(term)[1]).toBe(before);
    expect(getComputedStyle(root).getPropertyValue("--kb-inset")).toBe("0px");
  });
});

describe("the divider beside the tab bar", () => {
  it("ends where the tab bar begins, with its bar and pill centred in the height above it", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    stripSplit(root).click();
    const handle = root.querySelector<HTMLElement>(":scope > .wt-split-handle");
    const tabBar = root.querySelector<HTMLElement>(".wt-tab-bar");
    if (!handle || !tabBar) {
      throw new Error("no divider or tab bar");
    }
    // The bar's height reaches the stylesheet through a ResizeObserver.
    await settle();
    const box = handle.getBoundingClientRect();
    expect(box.bottom).toBe(tabBar.getBoundingClientRect().top);
    const bar = getComputedStyle(handle, "::before");
    expect([bar.top, bar.bottom]).toEqual(["12px", "12px"]);
    const pill = getComputedStyle(handle, "::after");
    expect(parseFloat(pill.top) + parseFloat(pill.height) / 2).toBe(box.height / 2);
  });
});

describe("the tab strip's own height", () => {
  let taller: HTMLStyleElement;
  let restore: () => void;
  beforeEach(() => {
    taller = document.createElement("style");
    taller.textContent = ".wt-root .wt-tab-bar { min-height: 68px; }";
    restore = () => undefined;
  });
  afterEach(() => {
    taller.remove();
    restore();
  });

  it("re-sends the pane's size when it changes and nothing else resizes", async () => {
    const restoreSettle = await shortenSettle();
    const root = rootIn(1000, 600);
    await mountTabbed(root, server);
    await settle();
    await shortSettled();
    restoreSettle();
    const pane = engineOn(fake, root, "left");
    pane.connection.sendResize.mockClear();

    document.head.appendChild(taller);
    await settle();
    expect(span(termOf(paneRoot(root, "left")))[1]).toBe(532);
    await new Promise((r) => setTimeout(r, 400));

    expect(pane.connection.sendResize).toHaveBeenCalledTimes(1);
  });

  it("re-sends it the same way where the window has no visual viewport", async () => {
    restore = withoutVisualViewport();
    const restoreSettle = await shortenSettle();
    const root = rootIn(1000, 600);
    await mountTabbed(root, server);
    await settle();
    await shortSettled();
    restoreSettle();
    const pane = engineOn(fake, root, "left");
    pane.connection.sendResize.mockClear();

    document.head.appendChild(taller);
    await settle();
    expect(span(termOf(paneRoot(root, "left")))[1]).toBe(532);
    await new Promise((r) => setTimeout(r, 400));

    expect(pane.connection.sendResize).toHaveBeenCalledTimes(1);
  });

  it("raises no event on the page's visual viewport", async () => {
    const vv = window.visualViewport;
    if (!vv) {
      throw new Error("no visual viewport");
    }
    const root = rootIn(1000, 600);
    await mountTabbed(root, server);
    await settle();
    const heard = vi.fn();
    vv.addEventListener("resize", heard);
    restore = () => {
      vv.removeEventListener("resize", heard);
    };

    document.head.appendChild(taller);
    await settle();
    expect(span(termOf(paneRoot(root, "left")))[1]).toBe(532);

    expect(heard).not.toHaveBeenCalled();
  });
});

function highlightBox(
  root: HTMLElement,
  pseudo: "::before" | "::after",
): { top: number; bottom: number; left: number; right: number } {
  const s = getComputedStyle(root, pseudo);
  const rect = root.getBoundingClientRect();
  // width/height here already resolve to the BORDER box (the visible edges the
  // highlight draws), and left/top are the border-box origin for an abs-pos box
  // with no margin.
  const left = rect.left + parseFloat(s.left);
  const top = rect.top + parseFloat(s.top);
  return { top, bottom: top + parseFloat(s.height), left, right: left + parseFloat(s.width) };
}
function highlightSpan(root: HTMLElement, pseudo: "::before" | "::after"): [number, number] {
  const { left, right } = highlightBox(root, pseudo);
  return [left, right];
}
function paneSpan(root: HTMLElement, side: "left" | "right"): [number, number] {
  const r = paneRoot(root, side).getBoundingClientRect();
  return [r.left, r.right];
}

const INSET = 8;

describe("the drop highlights", () => {
  it("cover the terminal area above the tab strip, inset from the pane's edges", async () => {
    const root = rootIn(1000, 600);
    await mountTabbed(root, server);
    // Headless env() is 0, so --safe-bottom must be set explicitly to model an
    // iPad's bottom safe-area inset. Each pane is itself a .wt-root that
    // re-declares --safe-bottom from env(), so a real device's uniform inset
    // needs the same value on every root.
    for (const el of [root, ...root.querySelectorAll<HTMLElement>(".wt-root")]) {
      el.style.setProperty("--safe-bottom", "20px");
    }
    await settle();
    const dt = fakeDataTransfer();
    const chip = chipOf(root, "two");
    const { left, width } = root.getBoundingClientRect();
    const tabBar = root.querySelector<HTMLElement>(".wt-tab-bar");
    if (!tabBar) {
      throw new Error("no tab bar");
    }

    dragAt("dragstart", dt, chip, left + width * 0.25);
    dragAt("dragover", dt, root, left + width * 0.25);
    expect(root.classList.contains("wt-drop-left")).toBe(true);
    const box = highlightBox(root, "::before");
    const term = termOf(paneRoot(root, "left"));
    const termRect = term.getBoundingClientRect();
    expect(box.top).toBe(termRect.top + INSET);
    expect(box.bottom).toBe(termRect.bottom - INSET);
    expect(box.bottom).toBeLessThanOrEqual(tabBar.getBoundingClientRect().top);
    expect([box.left, box.right]).toEqual([left + INSET, left + (width - 10) / 2 - INSET]);
    dragAt("dragend", dt, chip, left + width * 0.25);
  });

  it("draw the active tab chip's border width, colour and corner", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    await settle();
    const dt = fakeDataTransfer();
    const chip = chipOf(root, "two");
    const { left, width } = root.getBoundingClientRect();
    const active = root.querySelector<HTMLElement>(".wt-tab.wt-tab-active");
    if (!active) {
      throw new Error("no active chip");
    }
    const chipStyle = getComputedStyle(active);

    dragAt("dragstart", dt, chip, left + width * 0.25);
    dragAt("dragover", dt, root, left + width * 0.25);
    const style = getComputedStyle(root, "::before");
    expect(style.borderTopWidth).toBe(chipStyle.borderTopWidth);
    expect(style.borderTopWidth).toBe("1px");
    expect(style.borderTopColor).toBe(chipStyle.borderTopColor);
    expect(style.borderTopLeftRadius).toBe(chipStyle.borderTopLeftRadius);
    dragAt("dragend", dt, chip, left + width * 0.25);
  });

  it("cover each pane's own width at the current divider share, inset", async () => {
    const root = rootIn(1280);
    const { term } = await mountTabbed(root, server);
    term.split?.open();
    expect(term.split?.setRatio(0.3, true)).toBe(true);
    const dt = fakeDataTransfer();
    const chip = chipOf(root, "two");
    const [leftStart, leftEnd] = paneSpan(root, "left");
    const [rightStart, rightEnd] = paneSpan(root, "right");
    expect(leftEnd).toBe(root.getBoundingClientRect().left + 381);

    dragAt("dragstart", dt, chip, leftEnd - 5);
    dragAt("dragover", dt, root, leftEnd - 5);
    expect(root.classList.contains("wt-drop-left")).toBe(true);
    expect(highlightSpan(root, "::before")).toEqual([leftStart + INSET, leftEnd - INSET]);

    dragAt("dragover", dt, root, rightStart + 5);
    expect(root.classList.contains("wt-drop-right")).toBe(true);
    expect(highlightSpan(root, "::after")).toEqual([rightStart + INSET, rightEnd - INSET]);
    dragAt("dragend", dt, chip, rightStart + 5);
  });

  // A 1000 px row: the left pane's 990 * share px, drawn rounded to `leftEnd`.
  it.each([
    { share: 400.3 / 990, leftEnd: 400 },
    { share: 400.7 / 990, leftEnd: 401 },
  ])(
    "meet at the drawn gutter's centre, which decides the drop, when the share is not a whole pixel ($leftEnd px)",
    async ({ share, leftEnd }) => {
      const root = rootIn();
      const { term } = await mountTabbed(root, server);
      term.split?.open();
      expect(term.split?.setRatio(share, true)).toBe(true);
      const left = root.getBoundingClientRect().left;
      expect(paneSpan(root, "left")[1]).toBe(left + leftEnd);
      const dt = fakeDataTransfer();
      const chip = chipOf(root, "two");

      dragAt("dragstart", dt, chip, left + leftEnd + 4);
      dragAt("dragover", dt, root, left + leftEnd + 4);
      expect(root.classList.contains("wt-drop-left")).toBe(true);
      expect(highlightSpan(root, "::before")).toEqual([left + INSET, left + leftEnd - INSET]);
      dragAt("dragover", dt, root, left + leftEnd + 5);
      expect(root.classList.contains("wt-drop-right")).toBe(true);
      expect(highlightSpan(root, "::after")).toEqual([
        left + leftEnd + 10 + INSET,
        left + 1000 - INSET,
      ]);
      dragAt("dragend", dt, chip, left + leftEnd + 5);
    },
  );

  it("cover the two halves an open would give while the split is closed, inset", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    const dt = fakeDataTransfer();
    const chip = chipOf(root, "two");
    const { left, width } = root.getBoundingClientRect();

    dragAt("dragstart", dt, chip, left + 100);
    dragAt("dragover", dt, root, left + 100);
    expect(highlightSpan(root, "::before")).toEqual([
      left + INSET,
      left + (width - 10) / 2 - INSET,
    ]);
    dragAt("dragover", dt, root, left + width - 100);
    expect(highlightSpan(root, "::after")).toEqual([
      left + (width + 10) / 2 + INSET,
      left + width - INSET,
    ]);
    dragAt("dragend", dt, chip, left + width - 100);
  });
});
