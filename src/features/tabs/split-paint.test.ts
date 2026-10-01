import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type {} from "@vitest/browser-playwright";
import { cdp, page } from "vitest/browser";
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
  ICON_GRIDS,
  clearDeviceScale,
  deviceBox,
  deviceEdges,
  emulateDeviceScale,
  iconShapes,
  softKeyboard,
  span,
  splitIcon,
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
  it("is drawn in its own CSS pixels: the viewBox is the 20 px box it renders in", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    const icon = splitIcon(root);
    const box = icon.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([20, 20]);
    const vb = icon.viewBox.baseVal;
    expect([vb.x, vb.y, vb.width, vb.height]).toEqual([0, 0, 20, 20]);
  });

  it("is filled in the button's colour and carries no stroke", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    const color = getComputedStyle(stripSplit(root)).color;
    for (const shape of iconShapes(splitIcon(root))) {
      expect(getComputedStyle(shape).fill).toBe(color);
      expect(getComputedStyle(shape).stroke).toBe("none");
    }
  });

  it("is two equal panes with a thinner, taller divider centred between them", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    const [left, divider, right] = iconShapes(splitIcon(root)).map((r) => r.getBBox());
    expect([left?.x, left?.y, left?.width, left?.height]).toEqual([1, 4, 6, 12]);
    expect([divider?.x, divider?.y, divider?.width, divider?.height]).toEqual([9, 2, 2, 16]);
    expect([right?.x, right?.y, right?.width, right?.height]).toEqual([13, 4, 6, 12]);
  });

  describe("on the device pixel grid", () => {
    afterEach(async () => {
      await clearDeviceScale(styles);
    });
    async function emulate(dpr: number): Promise<void> {
      await emulateDeviceScale(dpr, styles);
      expect(matchMedia(`(resolution: ${String(dpr)}dppx)`).matches).toBe(true);
    }

    // `box` is the svg's left, top, width and height in the page's device pixels.
    const boxes = [
      { dpr: 1, box: [960, 560, 20, 20] },
      { dpr: 1.25, box: [1200, 700, 25, 25] },
      { dpr: 1.5, box: [1440, 840, 30, 30] },
      { dpr: 2, box: [1920, 1120, 40, 40] },
    ];
    it.each(boxes)(
      "puts the icon's box on whole device pixels at $dpr dppx, split closed and open",
      async ({ dpr, box }) => {
        await emulate(dpr);
        const root = rootIn();
        const { term } = await mountTabbed(root, server);
        await settle();
        expect(deviceBox(splitIcon(root))).toEqual(box);
        stripSplit(root).click();
        expect(term.split?.isOpen()).toBe(true);
        expect(deviceBox(splitIcon(root))).toEqual(box);
      },
    );

    it.each(ICON_GRIDS)(
      "puts every shape edge on a whole device pixel at $dpr dppx",
      async ({ dpr, across, down }) => {
        await emulate(dpr);
        const root = rootIn();
        await mountTabbed(root, server);
        expect(deviceEdges(splitIcon(root))).toEqual({ across, down });
      },
    );

    // Layout puts this icon at CSS (W - 40, H - 40), a quarter or half device
    // pixel off at 1.25 and 1.5 dppx; `box` is the nearest whole device pixel.
    // The switcher bar's placements need a coarse pointer and run in
    // split-paint.touch.test.ts.
    const button = ".wt-tab-split";
    const placements = [
      { width: 1279, height: 601, dpr: 1, box: [1239, 561, 20, 20] },
      { width: 1279, height: 601, dpr: 1.25, box: [1549, 701, 25, 25] },
      { width: 1279, height: 601, dpr: 1.5, box: [1859, 842, 30, 30] },
      { width: 1279, height: 601, dpr: 2, box: [2478, 1122, 40, 40] },
      { width: 1280, height: 600, dpr: 1, box: [1240, 560, 20, 20] },
      { width: 1280, height: 600, dpr: 1.25, box: [1550, 700, 25, 25] },
      { width: 1280, height: 600, dpr: 1.5, box: [1860, 840, 30, 30] },
      { width: 1280, height: 600, dpr: 2, box: [2480, 1120, 40, 40] },
      { width: 1441, height: 599, dpr: 1, box: [1401, 559, 20, 20] },
      { width: 1441, height: 599, dpr: 1.25, box: [1751, 699, 25, 25] },
      { width: 1441, height: 599, dpr: 1.5, box: [2102, 839, 30, 30] },
      { width: 1441, height: 599, dpr: 2, box: [2802, 1118, 40, 40] },
    ];
    const edgesAt = new Map(ICON_GRIDS.map((g) => [g.dpr, { across: g.across, down: g.down }]));
    it.each(placements)(
      "moves the strip's icon onto whole device pixels in a $width x $height root at $dpr dppx, split closed and open",
      async ({ width, height, dpr, box }) => {
        await emulate(dpr);
        const root = rootIn(width, height);
        const { term } = await mountTabbed(root, server);
        await settle();
        const icon = splitIcon(root, button);
        expect(deviceBox(icon)).toEqual(box);
        expect(deviceEdges(icon)).toEqual(edgesAt.get(dpr));
        root.querySelector<HTMLElement>(button)?.click();
        expect(term.split?.isOpen()).toBe(true);
        await settle();
        expect(deviceBox(icon)).toEqual(box);
      },
    );

    it("follows the root through a resize, from wherever the last one left it", async () => {
      await emulate(1.25);
      const root = rootIn(1280, 600);
      await mountTabbed(root, server);
      await settle();
      const icon = splitIcon(root);
      expect(deviceBox(icon)).toEqual([1550, 700, 25, 25]);
      root.style.width = "1279px";
      await settle();
      expect(deviceBox(icon)).toEqual([1549, 700, 25, 25]);
      root.style.width = "1441px";
      root.style.height = "599px";
      await settle();
      expect(deviceBox(icon)).toEqual([1751, 699, 25, 25]);
    });

    it("follows every change of the device pixel ratio at the same layout", async () => {
      // CDP's scale-factor emulation fires no media change event in this frame
      // (measured; a top-level page gets one once a frame runs), so the test
      // delivers it to the resolution query the page listens on.
      const queries: MediaQueryList[] = [];
      const real = window.matchMedia.bind(window);
      vi.stubGlobal("matchMedia", (query: string) => {
        const list = real(query);
        queries.push(list);
        return list;
      });
      const change = (media: string): void => {
        for (const list of queries.filter((q) => q.media === media)) {
          list.dispatchEvent(new MediaQueryListEvent("change", { media, matches: false }));
        }
      };
      await emulate(1);
      const root = rootIn(1279, 601);
      await mountTabbed(root, server);
      await settle();
      const icon = splitIcon(root);
      expect(deviceBox(icon)).toEqual([1239, 561, 20, 20]);
      await emulate(1.25);
      change("(resolution: 1dppx)");
      await settle();
      expect(deviceBox(icon)).toEqual([1549, 701, 25, 25]);
      await emulate(1.5);
      change("(resolution: 1.25dppx)");
      await settle();
      expect(deviceBox(icon)).toEqual([1859, 842, 30, 30]);
    });
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
    const root = rootIn(1000, 600);
    await mountTabbed(root, server);
    await settle();
    await new Promise((r) => setTimeout(r, 400));
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
    const root = rootIn(1000, 600);
    await mountTabbed(root, server);
    await settle();
    await new Promise((r) => setTimeout(r, 400));
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

function highlightSpan(root: HTMLElement, pseudo: "::before" | "::after"): [number, number] {
  const style = getComputedStyle(root, pseudo);
  const start = root.getBoundingClientRect().left + parseFloat(style.left);
  return [start, start + parseFloat(style.width)];
}
function paneSpan(root: HTMLElement, side: "left" | "right"): [number, number] {
  const r = paneRoot(root, side).getBoundingClientRect();
  return [r.left, r.right];
}

describe("the drop highlights", () => {
  it("cover each pane's own width at the current divider share", async () => {
    const root = rootIn(1280);
    const { term } = await mountTabbed(root, server);
    term.split?.open();
    expect(term.split?.setRatio(0.3, true)).toBe(true);
    const dt = fakeDataTransfer();
    const chip = chipOf(root, "two");
    const [, leftEnd] = paneSpan(root, "left");
    const [rightStart, rightEnd] = paneSpan(root, "right");
    expect(leftEnd).toBe(root.getBoundingClientRect().left + 381);

    dragAt("dragstart", dt, chip, leftEnd - 5);
    dragAt("dragover", dt, root, leftEnd - 5);
    expect(root.classList.contains("wt-drop-left")).toBe(true);
    expect(highlightSpan(root, "::before")).toEqual(paneSpan(root, "left"));

    dragAt("dragover", dt, root, rightStart + 5);
    expect(root.classList.contains("wt-drop-right")).toBe(true);
    expect(highlightSpan(root, "::after")).toEqual([rightStart, rightEnd]);
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
      expect(highlightSpan(root, "::before")).toEqual([left, left + leftEnd]);
      dragAt("dragover", dt, root, left + leftEnd + 5);
      expect(root.classList.contains("wt-drop-right")).toBe(true);
      expect(highlightSpan(root, "::after")).toEqual([left + leftEnd + 10, left + 1000]);
      dragAt("dragend", dt, chip, left + leftEnd + 5);
    },
  );

  it("cover the two halves an open would give while the split is closed", async () => {
    const root = rootIn();
    await mountTabbed(root, server);
    const dt = fakeDataTransfer();
    const chip = chipOf(root, "two");
    const { left, width } = root.getBoundingClientRect();

    dragAt("dragstart", dt, chip, left + 100);
    dragAt("dragover", dt, root, left + 100);
    expect(highlightSpan(root, "::before")).toEqual([left, left + (width - 10) / 2]);
    dragAt("dragover", dt, root, left + width - 100);
    expect(highlightSpan(root, "::after")).toEqual([left + (width + 10) / 2, left + width]);
    dragAt("dragend", dt, chip, left + width - 100);
  });
});
