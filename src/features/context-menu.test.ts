// @vitest-environment happy-dom
//
// contextMenu tests. The terminal's keyboard target is a 1x1
// pointer-events:none textarea, so no platform can offer a native Paste over the
// output; this menu is the paste path, on a desktop right-click and on a touch
// long-press. The touch half is classified entirely at `touchend` (see the
// module header), so these tests drive complete gestures and assert the
// classification rather than any mid-press timing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "../kernel/kernel.js";
import type * as CtxMenuModule from "./context-menu.js";
import type { TerminalFeature } from "../kernel/types.js";
import type { ClipboardApi } from "./clipboard.js";

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    render: {
      init: vi.fn(),
      updateFontMetrics: vi.fn(),
      setPredictedCursor: vi.fn(),
      computeSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getCursorPx: vi.fn(() => ({ left: 0, top: 0, cellH: 16 })),
      getHighestIndex: vi.fn(() => -1),
      pendingRowCount: vi.fn(() => 0),
      noteResumeBounds: vi.fn(),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      updateReverseVideo: vi.fn(),
      resetScrollback: vi.fn(),
      resetScreen: vi.fn(),
      bind: vi.fn(),
      boundStore: vi.fn(),
    },
    scroll: {
      init: vi.fn(),
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      restoreScrollTop: vi.fn(),
      restoreView: vi.fn(),
    },
    connection: {
      init: vi.fn(),
      connect: vi.fn(),
      sendBinary: vi.fn(() => true),
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect: vi.fn(),
      setSession: vi.fn(),
      forgetSession: vi.fn(),
    },
  };
});

let createTerminal: (typeof KernelModule)["createTerminal"];
let contextMenu: (typeof CtxMenuModule)["contextMenu"];
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

const pasteSpy = vi.fn();
const copySpy = vi.fn();
function fakeClipboard(): TerminalFeature<ClipboardApi> {
  return {
    name: "clipboard",
    setup() {
      return { api: { copy: copySpy, paste: pasteSpy }, teardown: () => undefined };
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const menuIn = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>(".wt-ctx-menu");
const isOpen = (root: HTMLElement): boolean => menuIn(root)?.classList.contains("visible") ?? false;
const itemLabels = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLButtonElement>(".wt-ctx-menu button")].map(
    (b) => b.textContent ?? "",
  );
const itemNamed = (root: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>(".wt-ctx-menu button")].find(
    (b) => b.textContent === label,
  );

// happy-dom has no TouchEvent constructor, so shape a plain event with the
// single-touch fields the handlers read. `timeStamp` is set explicitly: the touch
// classifier measures the press from touchstart to touchend, so a hold of any
// length is expressed here without the test actually waiting for it.
interface TouchPoint {
  x: number;
  y: number;
}
function touch(type: string, at: TouchPoint | TouchPoint[], timeStamp: number): TouchEvent {
  const points = Array.isArray(at) ? at : [at];
  const ev = new Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
  Object.defineProperty(ev, "touches", {
    value: points.map((p) => ({ clientX: p.x, clientY: p.y })),
  });
  Object.defineProperty(ev, "timeStamp", { value: timeStamp });
  return ev;
}
/** A stationary single-finger press of `heldMs`, released. Returns nothing; the
 *  caller asserts on the menu afterwards. */
function longPress(el: Element, at: TouchPoint, heldMs: number, startTarget: Element = el): void {
  startTarget.dispatchEvent(touch("touchstart", at, 1000));
  el.dispatchEvent(touch("touchend", at, 1000 + heldMs));
}
function touchPointer(el: Element): void {
  const pd = new Event("pointerdown", { bubbles: true }) as unknown as PointerEvent;
  Object.defineProperty(pd, "pointerType", { value: "touch" });
  el.dispatchEvent(pd);
}
function stubSelection(text: string): { mockRestore: () => void } {
  return vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: text === "",
    toString: () => text,
    removeAllRanges: () => undefined,
    selectAllChildren: () => undefined,
  } as unknown as Selection);
}

beforeEach(async () => {
  vi.resetModules();
  pasteSpy.mockClear();
  copySpy.mockClear();
  document.body.replaceChildren();
  ({ createTerminal } = await import("../kernel/kernel.js"));
  ({ contextMenu } = await import("./context-menu.js"));
});
afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

async function mount(withClipboard = true): Promise<{ root: HTMLElement; surface: HTMLElement }> {
  const root = rootIn();
  const clip = fakeClipboard();
  term = createTerminal(root, {
    features: () => (withClipboard ? [clip, contextMenu({ clipboard: clip })] : [contextMenu()]),
  });
  await tick(); // features set up in the background
  const surface = root.querySelector<HTMLElement>(".term");
  if (!surface) {
    throw new Error("no .term surface");
  }
  return { root, surface };
}

describe("contextMenu — desktop right-click", () => {
  it("offers Paste and routes it to the clipboard feature", async () => {
    const { root, surface } = await mount();

    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );

    expect(isOpen(root)).toBe(true);
    itemNamed(root, "Paste")?.click();
    expect(pasteSpy).toHaveBeenCalledTimes(1);
  });

  it("offers Copy for the current selection and suppresses the browser menu", async () => {
    const { root, surface } = await mount();
    const sel = stubSelection("selected text");

    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    });
    surface.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(itemLabels(root)).toEqual(["Copy", "Select All", "Paste"]);
    itemNamed(root, "Copy")?.click();
    expect(copySpy).toHaveBeenCalledWith("selected text");
    sel.mockRestore();
  });

  it("omits Copy with nothing selected, and Paste with no clipboard feature", async () => {
    const { root, surface } = await mount();
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    expect(itemLabels(root)).toEqual(["Select All", "Paste"]);

    term?.destroy();
    const bare = await mount(false);
    bare.surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    expect(itemLabels(bare.root)).toEqual(["Select All"]);
  });

  it("opens above the pointer near the bottom edge (not clipped, not under the finger)", async () => {
    const { root, surface } = await mount();
    const menu = menuIn(root);
    expect(menu).toBeTruthy();
    if (!menu) {
      return;
    }
    // happy-dom has no layout, so give the menu a measurable size.
    Object.defineProperty(menu, "offsetHeight", { configurable: true, value: 200 });
    Object.defineProperty(menu, "offsetWidth", { configurable: true, value: 160 });

    const vv = window.visualViewport;
    const viewTop = vv ? vv.offsetTop : 0;
    const viewBottom = viewTop + (vv ? vv.height : window.innerHeight);
    const y = viewBottom - 20;

    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: y }),
    );

    const top = parseFloat(menu.style.top);
    expect(top).toBeLessThan(y); // opened above the pointer
    expect(top + 200).toBeLessThanOrEqual(y); // its bottom edge clears the pointer
    expect(top).toBeGreaterThanOrEqual(viewTop); // still on-screen
  });
});

describe("contextMenu — touch long-press, classified at release", () => {
  it("opens with Paste on a stationary hold over empty space", async () => {
    const { root, surface } = await mount();

    longPress(surface, { x: 30, y: 40 }, 700);

    expect(isOpen(root)).toBe(true);
    expect(itemLabels(root)).toEqual(["Select All", "Paste"]);
  });

  it("survives the release click however long the finger was held (the reported bug)", async () => {
    // The trailing click of a long-press must never read as a click-away. The
    // swallow window is a fixed 350ms, so a menu armed when it OPENED (the old
    // 550ms hold timer) lost its guard at ~900ms of hold and dismissed itself the
    // instant the finger lifted. Opening at the release edge makes the hold
    // length irrelevant — assert that with a hold far past the old budget.
    const { root, surface } = await mount();

    longPress(surface, { x: 30, y: 40 }, 5000);
    expect(isOpen(root)).toBe(true);

    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen(root)).toBe(true);
  });

  it("survives the release click after a REAL hold past the old swallow budget", async () => {
    // The same guarantee driven by the clock instead of a synthetic timeStamp, so
    // the assertion covers the swallow window itself and not just the release
    // classification. Real events, real elapsed time: the menu opened at 550ms of
    // hold with a 350ms window died on any release after ~900ms, which is what a
    // person holding a finger on a phone actually does.
    const { root, surface } = await mount();
    const start = new Event("touchstart", { bubbles: true }) as unknown as TouchEvent;
    Object.defineProperty(start, "touches", { value: [{ clientX: 30, clientY: 40 }] });
    surface.dispatchEvent(start);

    await new Promise((r) => setTimeout(r, 1100));

    const end = new Event("touchend", { bubbles: true }) as unknown as TouchEvent;
    Object.defineProperty(end, "touches", { value: [] });
    surface.dispatchEvent(end);
    expect(isOpen(root)).toBe(true);

    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen(root)).toBe(true);
  });

  it("still dismisses on a genuine later tap outside the menu", async () => {
    const { root, surface } = await mount();
    longPress(surface, { x: 30, y: 40 }, 5000);
    expect(isOpen(root)).toBe(true);

    // Past the swallow window: a deliberate follow-up tap is a click-away.
    await new Promise((r) => setTimeout(r, 400));
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen(root)).toBe(false);
  });

  it("leaves a tap alone (the kernel's tap-to-focus owns it)", async () => {
    const { root, surface } = await mount();
    longPress(surface, { x: 30, y: 40 }, 200);
    expect(isOpen(root)).toBe(false);
  });

  it("leaves a drag alone (a scroll or a selection-extend)", async () => {
    const { root, surface } = await mount();
    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    surface.dispatchEvent(touch("touchmove", { x: 30, y: 90 }, 1200));
    surface.dispatchEvent(touch("touchend", { x: 30, y: 90 }, 1700));
    expect(isOpen(root)).toBe(false);
  });

  it("stands down when the press selected text (the OS callout owns Copy)", async () => {
    const { root, surface } = await mount();
    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    // The platform's word-select landed during the hold — whenever it landed,
    // because the decision is read at release rather than predicted.
    const sel = stubSelection("word");
    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 1700));

    expect(isOpen(root)).toBe(false);
    sel.mockRestore();
  });

  it("opens over a selection that predates the press, and offers Copy for it", async () => {
    const { root, surface } = await mount();
    const sel = stubSelection("earlier selection");
    // Selected before the press and untouched by it: the platform did nothing
    // with this hold, so it is ours — and Copy is worth offering.
    longPress(surface, { x: 30, y: 40 }, 700);

    expect(isOpen(root)).toBe(true);
    expect(itemLabels(root)).toEqual(["Copy", "Select All", "Paste"]);
    sel.mockRestore();
  });

  it("stands down on a link (the platform's link preview owns it)", async () => {
    const { root, surface } = await mount();
    const output = root.querySelector<HTMLElement>(".term-output");
    const link = document.createElement("a");
    link.className = "term-link";
    link.href = "https://example.com/";
    link.textContent = "https://example.com/";
    output?.appendChild(link);

    longPress(surface, { x: 30, y: 40 }, 700, link);

    expect(isOpen(root)).toBe(false);
  });

  it("stands down when a second finger joins (a pinch, not a hold)", async () => {
    const { root, surface } = await mount();
    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    surface.dispatchEvent(
      touch(
        "touchstart",
        [
          { x: 30, y: 40 },
          { x: 90, y: 40 },
        ],
        1100,
      ),
    );
    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 1800));
    expect(isOpen(root)).toBe(false);
  });

  it("stands down when the gesture is cancelled", async () => {
    const { root, surface } = await mount();
    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    surface.dispatchEvent(touch("touchcancel", { x: 30, y: 40 }, 1600));
    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 1700));
    expect(isOpen(root)).toBe(false);
  });
});

describe("contextMenu — the platform's own touch menu", () => {
  it("never cancels a touch contextmenu on Apple, and never opens from it", async () => {
    // WebKit reads preventDefault on a touch contextmenu as "cancel every
    // remaining default of this gesture", which takes a word selection that has
    // not registered yet with it. That is what once left an iPad unable to select
    // at all. Our menu opens from touchend, so there is nothing to do here.
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    const { root, surface } = await mount();
    touchPointer(surface);

    const cm = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 30,
    });
    surface.dispatchEvent(cm);

    expect(cm.defaultPrevented).toBe(false);
    expect(isOpen(root)).toBe(false);
  });

  it("suppresses the platform menu elsewhere (Android) over empty space, without opening ours", async () => {
    // Android fires contextmenu mid-press. Cancelling it is how its menu and ours
    // do not both appear once the release opens ours.
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/140",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    const { root, surface } = await mount();
    touchPointer(surface);

    const cm = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    });
    surface.dispatchEvent(cm);

    expect(cm.defaultPrevented).toBe(true);
    expect(isOpen(root)).toBe(false);

    // The same gesture's release is what opens ours.
    surface.dispatchEvent(touch("touchstart", { x: 20, y: 20 }, 1000));
    surface.dispatchEvent(touch("touchend", { x: 20, y: 20 }, 1700));
    expect(isOpen(root)).toBe(true);
  });

  it("leaves the platform's selection toolbar alone when text is selected (Android)", async () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/140",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    const { root, surface } = await mount();
    const sel = stubSelection("selected");
    touchPointer(surface);

    const cm = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    });
    surface.dispatchEvent(cm);

    expect(cm.defaultPrevented).toBe(false);
    expect(isOpen(root)).toBe(false);
    sel.mockRestore();
  });
});

describe("contextMenu — dismissal", () => {
  it("closes on Escape", async () => {
    const { root, surface } = await mount();
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    expect(isOpen(root)).toBe(true);

    const input = root.querySelector<HTMLTextAreaElement>(".term-input");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isOpen(root)).toBe(false);
  });

  it("closes on a click outside, and lets an item's own click own the close", async () => {
    const { root, surface } = await mount();
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    const selectAll = itemNamed(root, "Select All");
    expect(selectAll).toBeTruthy();

    // A click routed through the item closes via the item's handler; the document
    // handler must not run its own hide() over the top (Select All deliberately
    // does not refocus the input, or Firefox collapses the selection).
    selectAll?.click();
    expect(isOpen(root)).toBe(false);

    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    expect(isOpen(root)).toBe(true);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen(root)).toBe(false);
  });
});
