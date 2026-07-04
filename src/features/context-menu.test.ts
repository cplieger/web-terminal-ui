// @vitest-environment happy-dom
//
// contextMenu Paste-on-touch tests (the iOS paste fix). The terminal's keyboard
// target is a 1x1 pointer-events:none textarea, so iOS never shows a native
// paste callout; this menu is the paste path on touch, so it must offer Paste
// (right-click and long-press) and route it to the clipboard feature.

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
      noteResumeBounds: vi.fn(),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      updateReverseVideo: vi.fn(),
      resetScrollback: vi.fn(),
      resetScreen: vi.fn(),
      bind: vi.fn(),
      boundStore: vi.fn(),
    },
    scroll: { init: vi.fn(), scrollToBottom: vi.fn(), isUserScrolledUp: vi.fn(() => false) },
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
const pasteButton = (root: HTMLElement): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>(".wt-ctx-menu button")].find(
    (b) => b.textContent === "Paste",
  );

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
});

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("contextMenu Paste (iOS paste fix)", () => {
  it("offers Paste and routes it to the clipboard feature on right-click / long-press", async () => {
    const root = rootIn();
    const clip = fakeClipboard();
    term = createTerminal(root, { features: [clip, contextMenu({ clipboard: clip })] });
    await tick(); // features set up in the background

    const surface = root.querySelector<HTMLElement>(".term");
    surface?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );

    expect(root.querySelector(".wt-ctx-menu")?.classList.contains("visible")).toBe(true);
    const paste = pasteButton(root);
    expect(paste).toBeTruthy();

    paste?.click();
    expect(pasteSpy).toHaveBeenCalledTimes(1);
  });

  it("opens the menu with Paste on a stationary touch long-press", async () => {
    const root = rootIn();
    const clip = fakeClipboard();
    term = createTerminal(root, { features: [clip, contextMenu({ clipboard: clip })] });
    await tick();

    const surface = root.querySelector<HTMLElement>(".term");
    // happy-dom lacks a TouchEvent constructor, so shape a plain event with the
    // single-touch fields the handler reads.
    const ev = new Event("touchstart", { bubbles: true }) as unknown as TouchEvent;
    Object.defineProperty(ev, "touches", { value: [{ clientX: 30, clientY: 40 }] });
    surface?.dispatchEvent(ev);
    // Held still past LONG_PRESS_MS (500).
    await new Promise((r) => setTimeout(r, 600));

    expect(root.querySelector(".wt-ctx-menu")?.classList.contains("visible")).toBe(true);
    expect(pasteButton(root)).toBeTruthy();
  });

  it("opens above the finger when the anchor is near the bottom (not clipped/under the touch)", async () => {
    const root = rootIn();
    const clip = fakeClipboard();
    term = createTerminal(root, { features: [clip, contextMenu({ clipboard: clip })] });
    await tick();

    const menu = root.querySelector<HTMLElement>(".wt-ctx-menu");
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
    const y = viewBottom - 20; // a long-press near the bottom edge

    root
      .querySelector<HTMLElement>(".term")
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: y }));

    const top = parseFloat(menu.style.top);
    expect(top).toBeLessThan(y); // opened above the tap
    expect(top + 200).toBeLessThanOrEqual(y); // its bottom edge is above the finger
    expect(top).toBeGreaterThanOrEqual(viewTop); // still on-screen
  });

  it("omits Paste when no clipboard feature is present", async () => {
    const root = rootIn();
    term = createTerminal(root, { features: [contextMenu()] });
    await tick();

    const surface = root.querySelector<HTMLElement>(".term");
    surface?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    expect(root.querySelector(".wt-ctx-menu")?.classList.contains("visible")).toBe(true);
    expect(pasteButton(root)).toBeUndefined();
  });

  it("does not open on a touch long-press while text is selected (native selection owns it)", async () => {
    const root = rootIn();
    const clip = fakeClipboard();
    term = createTerminal(root, { features: [clip, contextMenu({ clipboard: clip })] });
    await tick();
    // Simulate a native word-selection made during the hold.
    const spy = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "selected",
    } as unknown as Selection);

    const surface = root.querySelector<HTMLElement>(".term");
    const ev = new Event("touchstart", { bubbles: true }) as unknown as TouchEvent;
    Object.defineProperty(ev, "touches", { value: [{ clientX: 30, clientY: 40 }] });
    surface?.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 600));

    // The OS callout owns a selection long-press; our menu stays out of the way.
    expect(root.querySelector(".wt-ctx-menu")?.classList.contains("visible")).toBe(false);
    spy.mockRestore();
  });

  it("opens the paste menu on an Android touch long-press (contextmenu) over empty space, suppressing the native menu", async () => {
    const root = rootIn();
    const clip = fakeClipboard();
    term = createTerminal(root, { features: [clip, contextMenu({ clipboard: clip })] });
    await tick();

    const surface = root.querySelector<HTMLElement>(".term");
    const pd = new Event("pointerdown", { bubbles: true }) as unknown as PointerEvent;
    Object.defineProperty(pd, "pointerType", { value: "touch" });
    surface?.dispatchEvent(pd);
    // Android fires contextmenu on long-press. Over empty space (no selection)
    // it is the paste path: show our menu and preventDefault so Android's own
    // menu doesn't also appear (the "both menus" bug).
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    });
    surface?.dispatchEvent(ev);

    expect(root.querySelector(".wt-ctx-menu")?.classList.contains("visible")).toBe(true);
    expect(pasteButton(root)).toBeTruthy();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("defers to native selection on an Android touch contextmenu when text is selected", async () => {
    const root = rootIn();
    const clip = fakeClipboard();
    term = createTerminal(root, { features: [clip, contextMenu({ clipboard: clip })] });
    await tick();
    const spy = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "selected",
    } as unknown as Selection);

    const surface = root.querySelector<HTMLElement>(".term");
    const pd = new Event("pointerdown", { bubbles: true }) as unknown as PointerEvent;
    Object.defineProperty(pd, "pointerType", { value: "touch" });
    surface?.dispatchEvent(pd);
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    });
    surface?.dispatchEvent(ev);

    // A selection means the native callout / selection toolbar owns Copy; our
    // menu stays out of the way and we leave the event alone.
    expect(root.querySelector(".wt-ctx-menu")?.classList.contains("visible")).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    spy.mockRestore();
  });

  it("keeps the menu open across the release click after a touch long-press", async () => {
    const root = rootIn();
    const clip = fakeClipboard();
    term = createTerminal(root, { features: [clip, contextMenu({ clipboard: clip })] });
    await tick();

    const surface = root.querySelector<HTMLElement>(".term");
    const ev = new Event("touchstart", { bubbles: true }) as unknown as TouchEvent;
    Object.defineProperty(ev, "touches", { value: [{ clientX: 30, clientY: 40 }] });
    surface?.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 600));
    expect(root.querySelector(".wt-ctx-menu")?.classList.contains("visible")).toBe(true);

    // The long-press emits a trailing click on release; it must NOT dismiss the
    // just-opened menu (the open-then-close-on-release race).
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.querySelector(".wt-ctx-menu")?.classList.contains("visible")).toBe(true);
  });
});
