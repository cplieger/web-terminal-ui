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

// Hoisted so a test can read what reached the PTY: the Escape rule is "close the
// menu WITHOUT also sending ESC", and the second half is only visible here.
const sendBinary = vi.hoisted(() => vi.fn<(buf: Uint8Array) => boolean>(() => true));

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
      sendBinary,
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
  sendBinary.mockClear();
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

describe("contextMenu — which devices may have their touch contextmenu cancelled", () => {
  // isAppleTouchDevice decides exactly one thing, and both halves of its test
  // matter: WebKit reads preventDefault on a touch contextmenu as "cancel every
  // remaining default of this gesture", so cancelling there once left an iPad
  // unable to select text at all. The MacIntel cases above cover iPadOS Safari's
  // desktop mode; these cover the device the function is named for, and the
  // desktop Mac it must not mistake for one.
  const touchContextMenu = async (): Promise<MouseEvent> => {
    const { surface } = await mount();
    touchPointer(surface);
    const cm = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    });
    surface.dispatchEvent(cm);
    return cm;
  };

  it("recognises an iPhone from its user agent alone", async () => {
    // navigator.platform is deprecated and some browsers report nothing for it,
    // so the user agent has to be sufficient on its own.
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Version/26.0 Safari",
      platform: "",
      maxTouchPoints: 5,
    });

    expect((await touchContextMenu()).defaultPrevented).toBe(false);
  });

  it("does not mistake a trackpad Mac for a touch device", async () => {
    // The same platform string iPadOS desktop mode reports, with the fact that
    // separates them: a Mac has no touch screen.
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });

    expect((await touchContextMenu()).defaultPrevented).toBe(true);
  });

  it("takes more than one touch point to count as a touch Mac", async () => {
    // A single point is what a stylus digitiser or a trackpad driver reports; an
    // iPad reports five.
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari",
      platform: "MacIntel",
      maxTouchPoints: 1,
    });

    expect((await touchContextMenu()).defaultPrevented).toBe(true);
  });
});

describe("contextMenu — where the keyboard goes when the menu closes", () => {
  const input = (root: HTMLElement): HTMLTextAreaElement | null =>
    root.querySelector<HTMLTextAreaElement>(".term-input");

  const openAt = (surface: HTMLElement): void => {
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
  };

  it("returns the keyboard to the terminal after an item the user had focused", async () => {
    // The menu's buttons are real focusable controls, so activating one with the
    // keyboard leaves focus inside a menu that is about to be emptied. Focus has
    // to land back on the terminal's input or the next keystroke goes nowhere.
    const { root, surface } = await mount();
    openAt(surface);
    const paste = itemNamed(root, "Paste");
    paste?.focus();

    paste?.click();

    expect(document.activeElement).toBe(input(root));
  });

  it("returns the keyboard to the terminal when Escape closes a focused menu", async () => {
    // Escape reaches the menu through the kernel's keydown intercept, which does
    // not pass a refocus preference — so this is the DEFAULT that has to be
    // "yes", the same as an item's.
    const { root, surface } = await mount();
    openAt(surface);
    itemNamed(root, "Select All")?.focus();

    input(root)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.activeElement).toBe(input(root));
  });

  it("leaves the keyboard alone after Select All, or Firefox collapses the new selection", async () => {
    // The one item that must NOT hand focus back: Firefox drops a selection made
    // in the output the moment focus leaves it, so refocusing the input here
    // would undo the item's own work.
    const { root, surface } = await mount();
    openAt(surface);
    const selectAll = itemNamed(root, "Select All");
    selectAll?.focus();

    selectAll?.click();

    expect(document.activeElement).not.toBe(input(root));
  });

  it("does not take focus from elsewhere on the page when it closes", async () => {
    // A menu dismissal is not a reason to move the keyboard: the refocus only
    // exists to recover focus the MENU held, and a page with its own controls
    // would otherwise lose the caret every time a menu closed.
    const { root, surface } = await mount();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    openAt(surface);
    outside.focus();

    outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(isOpen(root)).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("empties the menu when it closes, so nothing stale is left in the DOM", async () => {
    const { root, surface } = await mount();
    openAt(surface);
    expect(itemLabels(root)).toEqual(["Select All", "Paste"]);

    input(root)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(menuIn(root)?.childElementCount).toBe(0);
  });

  it("rebuilds its items on every open rather than appending to the last set", async () => {
    // Opening twice without a dismissal in between is ordinary (right-click,
    // then right-click somewhere else): the second menu must be a menu, not two.
    const { root, surface } = await mount();

    openAt(surface);
    openAt(surface);

    expect(itemLabels(root)).toEqual(["Select All", "Paste"]);
  });
});

describe("contextMenu — Select All", () => {
  it("selects the terminal output, which is the only thing worth selecting", async () => {
    // The item exists because the platform's own menu is suppressed here; if it
    // selected nothing, Copy would have nothing to copy the next time round.
    const { root, surface } = await mount();
    const output = root.querySelector<HTMLElement>(".term-output");
    output?.append(document.createTextNode("line one\nline two"));
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );

    itemNamed(root, "Select All")?.click();

    const sel = window.getSelection();
    expect(sel?.anchorNode).toBe(output);
    expect(sel?.toString()).toBe("line one\nline two");
  });
});

describe("contextMenu — Escape belongs to the menu only while it is open", () => {
  const escapeOn = (root: HTMLElement): KeyboardEvent => {
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    root.querySelector<HTMLTextAreaElement>(".term-input")?.dispatchEvent(ev);
    return ev;
  };

  it("keeps Escape out of the PTY while the menu is open", async () => {
    // The intercept exists so one Escape does one thing. Sending it as well
    // would also dismiss whatever the program has on screen.
    const { root, surface } = await mount();
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );

    const ev = escapeOn(root);

    expect(ev.defaultPrevented).toBe(true);
    expect(isOpen(root)).toBe(false);
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("lets Escape through to the PTY when no menu is open", async () => {
    // The other half, and the one a `menu.classList` assertion cannot see: with
    // nothing to close, Escape is the program's key and must arrive. (The
    // kernel cancels the keystroke's default either way, so the event's own
    // defaultPrevented says nothing about which of the two happened.)
    const { root } = await mount();

    escapeOn(root);

    expect(sendBinary).toHaveBeenCalledTimes(1);
  });

  it("leaves every other key to the terminal", async () => {
    const { root, surface } = await mount();
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );

    root
      .querySelector<HTMLTextAreaElement>(".term-input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));

    expect(isOpen(root)).toBe(true);
  });
});

describe("contextMenu — dismissal by another menu", () => {
  it("closes when a right-click lands outside the terminal", async () => {
    // A right-click on a tab, on the page, or on the browser's own chrome is a
    // request for a different menu; two open at once is the failure.
    const { root, surface } = await mount();
    surface.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    expect(isOpen(root)).toBe(true);

    document.body.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 500, clientY: 500 }),
    );

    expect(isOpen(root)).toBe(false);
  });
});

describe("contextMenu — what counts as a stationary press", () => {
  it("survives a touchmove that did not move", async () => {
    // Browsers emit touchmove for sub-pixel jitter while a finger rests, and iOS
    // emits one for the same coordinates. Treating any move event as a drag would
    // stand the menu down on most real long presses.
    const { root, surface } = await mount();

    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    surface.dispatchEvent(touch("touchmove", { x: 30, y: 40 }, 1200));
    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 1700));

    expect(isOpen(root)).toBe(true);
  });

  it("stands down for a HORIZONTAL drag as well as a vertical one", async () => {
    // A sideways drag over terminal text is a selection-extend, which is the
    // browser's gesture and not a request for this menu.
    const { root, surface } = await mount();

    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    surface.dispatchEvent(touch("touchmove", { x: 90, y: 40 }, 1200));
    surface.dispatchEvent(touch("touchend", { x: 90, y: 40 }, 1700));

    expect(isOpen(root)).toBe(false);
  });

  it("allows a wobble of exactly the shared tap allowance", async () => {
    // TAP_MOVEMENT_PX is shared with the kernel's tap-to-focus so the two cannot
    // both claim one press; a press at exactly the allowance is still a press on
    // both sides of that split, and it is a finger on glass, so it happens.
    const { root, surface } = await mount();

    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    surface.dispatchEvent(touch("touchmove", { x: 40, y: 50 }, 1200));
    surface.dispatchEvent(touch("touchend", { x: 40, y: 50 }, 1700));

    expect(isOpen(root)).toBe(true);
  });

  it("stands down when a second finger joins mid-press", async () => {
    // The existing case starts the pinch with a second touchstart; a pinch that
    // begins as a drag reports its extra finger on touchmove instead.
    const { root, surface } = await mount();

    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    surface.dispatchEvent(
      touch(
        "touchmove",
        [
          { x: 30, y: 40 },
          { x: 90, y: 40 },
        ],
        1200,
      ),
    );
    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 1700));

    expect(isOpen(root)).toBe(false);
  });

  it("treats a press held to exactly the tap ceiling as a tap", async () => {
    // The ceiling is the boundary between the kernel's tap-to-focus and this
    // menu. Both sides read it, so the press that lands ON it must belong to
    // exactly one of them, and by this rule that is the tap.
    const { root, surface } = await mount();

    longPress(surface, { x: 30, y: 40 }, 500);

    expect(isOpen(root)).toBe(false);
  });

  it("opens for a press that CLEARED a selection rather than making one", async () => {
    // The rule is "this press produced a selection", not "a selection is
    // involved": a press that dismissed an old selection produced nothing for the
    // OS callout to own, so it is ours and Paste is the point of it.
    const { root, surface } = await mount();
    const before = stubSelection("an earlier selection");
    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    before.mockRestore();
    const after = stubSelection("");

    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 1700));

    expect(isOpen(root)).toBe(true);
    after.mockRestore();
  });

  it("opens nothing for a touchend that no press preceded", async () => {
    // Touch events arrive from the platform, not from this module: a stray
    // release (a gesture that started on another element, a synthesised event)
    // must not be classified as a long press that nothing measured.
    const { root, surface } = await mount();

    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 9000));

    expect(isOpen(root)).toBe(false);
  });

  it("does not classify one press twice", async () => {
    // iOS emits a second touchend for a gesture whose touches ended on different
    // elements. The press is consumed by its first release, so the second has
    // nothing of its own and its elapsed time is measured from a press that is
    // already over — which is how a tap turns into a long press.
    const { root, surface } = await mount();
    surface.dispatchEvent(touch("touchstart", { x: 30, y: 40 }, 1000));
    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 1200));
    expect(isOpen(root)).toBe(false);

    surface.dispatchEvent(touch("touchend", { x: 30, y: 40 }, 3000));

    expect(isOpen(root)).toBe(false);
  });
});
