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
});
