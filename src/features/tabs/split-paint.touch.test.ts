import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type {} from "@vitest/browser-playwright";
import { page } from "vitest/browser";
import {
  fakeServer,
  mountTabbed,
  paneRoot,
  rootIn,
  separatorOf,
  settle,
  type FakeSessionServer,
} from "./test-helpers/split.js";
import {
  ICON_GRIDS,
  clearDeviceScale,
  deviceBox,
  deviceEdges,
  emulateDeviceScale,
  softKeyboard,
  span,
  splitIcon,
  switcherBar,
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
  expect(matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(matchMedia("(any-pointer: fine)").matches).toBe(false);
  fake.reset();
  server = fakeServer();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the switcher bar's split icon on the device pixel grid", () => {
  afterEach(async () => {
    await clearDeviceScale(styles);
  });

  // Layout puts this icon at CSS (W - 136, H - 40) in a root at most 500 px
  // tall, a quarter or half device pixel off at 1.25 and 1.5 dppx; `box` is the
  // nearest whole device pixel.
  const button = ".wt-switcher-split";
  const placements = [
    { width: 1279, height: 451, dpr: 1, box: [1143, 411, 20, 20] },
    { width: 1279, height: 451, dpr: 1.25, box: [1429, 514, 25, 25] },
    { width: 1279, height: 451, dpr: 1.5, box: [1715, 617, 30, 30] },
    { width: 1279, height: 451, dpr: 2, box: [2286, 822, 40, 40] },
    { width: 1280, height: 450, dpr: 1, box: [1144, 410, 20, 20] },
    { width: 1280, height: 450, dpr: 1.25, box: [1430, 513, 25, 25] },
    { width: 1280, height: 450, dpr: 1.5, box: [1716, 615, 30, 30] },
    { width: 1280, height: 450, dpr: 2, box: [2288, 820, 40, 40] },
    { width: 1441, height: 449, dpr: 1, box: [1305, 409, 20, 20] },
    { width: 1441, height: 449, dpr: 1.25, box: [1631, 511, 25, 25] },
    { width: 1441, height: 449, dpr: 1.5, box: [1958, 614, 30, 30] },
    { width: 1441, height: 449, dpr: 2, box: [2610, 818, 40, 40] },
  ];
  const edgesAt = new Map(ICON_GRIDS.map((g) => [g.dpr, { across: g.across, down: g.down }]));
  it.each(placements)(
    "moves the icon onto whole device pixels in a $width x $height root at $dpr dppx, split closed and open",
    async ({ width, height, dpr, box }) => {
      await emulateDeviceScale(dpr, styles);
      expect(matchMedia(`(resolution: ${String(dpr)}dppx)`).matches).toBe(true);
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
});

// The switcher bar is 60 px tall and anchored to the root's bottom edge; the
// terminal content stops above it.
describe("the soft keyboard's inset", () => {
  let keyboard: SoftKeyboard;
  beforeEach(() => {
    keyboard = softKeyboard();
  });
  afterEach(async () => {
    keyboard.restore();
    await page.viewport(1280, 720);
  });

  it("lifts the switcher bar onto the keyboard in the split topology with the split closed, and insets the pane once", async () => {
    await page.viewport(390, 700);
    const root = rootIn(390, 700);
    await mountTabbed(root, server);
    await settle();
    const bar = switcherBar(root);
    const pane = paneRoot(root, "left");
    expect(span(bar)).toEqual([640, 700]);
    expect(span(termOf(pane))[1]).toBe(640);

    keyboard.open(300);
    await settle();

    expect(span(bar)).toEqual([340, 400]);
    expect(span(termOf(pane))[1]).toBe(340);
    expect(getComputedStyle(pane).getPropertyValue("--kb-inset")).toBe("300px");
  });

  it("lifts the bar with the split open, and insets each pane once", async () => {
    await page.viewport(932, 430);
    const root = rootIn(932, 430);
    const { term } = await mountTabbed(root, server);
    term.split?.open();
    expect(term.split?.isOpen()).toBe(true);
    await settle();

    keyboard.open(200);
    await settle();

    expect(span(switcherBar(root))).toEqual([170, 230]);
    for (const side of ["left", "right"] as const) {
      const pane = paneRoot(root, side);
      expect(span(termOf(pane))[1]).toBe(170);
      expect(getComputedStyle(pane).getPropertyValue("--kb-inset")).toBe("200px");
    }
  });

  it("ends the divider where the switcher bar begins, with the keyboard closed and open", async () => {
    await page.viewport(932, 430);
    const root = rootIn(932, 430);
    const { term } = await mountTabbed(root, server);
    term.split?.open();
    await settle();
    const divider = separatorOf(root);
    expect(span(divider)[1]).toBe(370);

    keyboard.open(200);
    await settle();

    expect(span(divider)[1]).toBe(170);
  });

  it("ends the divider at the keyboard on a wide touch screen, where the strip stays docked", async () => {
    await page.viewport(1000, 600);
    const root = rootIn(1000, 600);
    const { term } = await mountTabbed(root, server);
    term.split?.open();
    await settle();
    const divider = separatorOf(root);
    const strip = root.querySelector<HTMLElement>(".wt-tab-bar");
    if (!strip) {
      throw new Error("no tab strip");
    }
    expect(span(divider)[1]).toBe(span(strip)[0]);

    keyboard.open(300);
    await settle();

    expect(span(divider)[1]).toBe(300);
    expect(span(termOf(paneRoot(root, "left")))[1]).toBe(300);
  });

  it("gives the shell's chrome the visual viewport's offset, and offsets the pane once", async () => {
    await page.viewport(390, 700);
    const root = rootIn(390, 700);
    await mountTabbed(root, server);
    await settle();

    keyboard.scroll(40);
    await settle();

    expect(getComputedStyle(switcherBar(root)).getPropertyValue("--vv-top")).toBe("40px");
    expect(span(termOf(paneRoot(root, "left")))[0]).toBe(40);
  });

  it("lifts the bar the same way in the single-pane topology", async () => {
    await page.viewport(390, 700);
    const root = rootIn(390, 700);
    await mountTabbed(root, server, { opts: { split: false } });
    await settle();
    expect(root.classList.contains("wt-split")).toBe(false);

    keyboard.open(300);
    await settle();

    expect(span(switcherBar(root))).toEqual([340, 400]);
    expect(span(termOf(root))[1]).toBe(340);
    expect(getComputedStyle(root).getPropertyValue("--kb-inset")).toBe("300px");
  });
});

describe("the switcher bar's reserve", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => undefined;
  });
  afterEach(async () => {
    restore();
    await page.viewport(1280, 720);
  });

  it("ends the terms on the bar where the window has no visual viewport", async () => {
    restore = withoutVisualViewport();
    await page.viewport(390, 700);
    const root = rootIn(390, 700);
    await mountTabbed(root, server);
    await settle();

    expect(span(switcherBar(root))).toEqual([640, 700]);
    expect(span(termOf(paneRoot(root, "left")))[1]).toBe(640);
  });

  it("raises no event on the page's visual viewport", async () => {
    await page.viewport(390, 700);
    await settle();
    const vv = window.visualViewport;
    if (!vv) {
      throw new Error("no visual viewport");
    }
    const heard = vi.fn();
    vv.addEventListener("resize", heard);
    restore = () => {
      vv.removeEventListener("resize", heard);
    };
    const root = rootIn(390, 700);
    await mountTabbed(root, server);
    await settle();
    expect(span(termOf(paneRoot(root, "left")))[1]).toBe(640);

    expect(heard).not.toHaveBeenCalled();
  });
});

// A root 450 px tall is narrow and one 600 px tall is not, so each resize swaps
// the strip and the switcher bar. Chromium reports an observation it had to
// carry to the next frame as a window `error` event and nothing fails, so the
// cases count those events.
describe("crossing the narrow boundary", () => {
  let notices: string[];
  const onError = (e: ErrorEvent): void => {
    if (e.message.includes("ResizeObserver loop")) {
      notices.push(e.message);
    }
  };
  beforeEach(() => {
    notices = [];
    window.addEventListener("error", onError);
  });
  afterEach(async () => {
    window.removeEventListener("error", onError);
    await page.viewport(1280, 720);
  });

  async function resize(root: HTMLElement, height: number): Promise<void> {
    await page.viewport(1000, height);
    root.style.height = `${String(height)}px`;
    await settle();
    await settle();
  }
  function strip(root: HTMLElement): HTMLElement {
    const el = root.querySelector<HTMLElement>(".wt-tab-bar");
    if (!el) {
      throw new Error("no tab strip");
    }
    return el;
  }
  /** Narrow, then wide again: the bar the terms end on at each size. */
  async function crossTwice(root: HTMLElement): Promise<[number, number][]> {
    await resize(root, 450);
    expect(strip(root).getBoundingClientRect().height).toBe(0);
    const narrow = span(switcherBar(root));
    await resize(root, 600);
    expect(switcherBar(root).getBoundingClientRect().height).toBe(0);
    return [narrow, span(strip(root))];
  }

  it("delivers every observation in its frame in the split topology, split closed", async () => {
    await page.viewport(1000, 600);
    const root = rootIn(1000, 600);
    await mountTabbed(root, server);
    await settle();

    const bars = await crossTwice(root);

    expect(notices).toEqual([]);
    expect(bars).toEqual([
      [390, 450],
      [539, 600],
    ]);
    expect(span(termOf(paneRoot(root, "left")))[1]).toBe(539);
  });

  it("delivers every observation in its frame in the split topology, split open", async () => {
    await page.viewport(1000, 600);
    const root = rootIn(1000, 600);
    const { term } = await mountTabbed(root, server);
    term.split?.open();
    expect(term.split?.isOpen()).toBe(true);
    await settle();

    await crossTwice(root);

    expect(notices).toEqual([]);
    for (const side of ["left", "right"] as const) {
      expect(span(termOf(paneRoot(root, side)))[1]).toBe(539);
    }
  });

  it("delivers every observation in its frame in the single-pane topology", async () => {
    await page.viewport(1000, 600);
    const root = rootIn(1000, 600);
    await mountTabbed(root, server, { opts: { split: false } });
    await settle();

    await crossTwice(root);

    expect(notices).toEqual([]);
    expect(span(termOf(root))[1]).toBe(539);
  });
});
