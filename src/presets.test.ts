// @vitest-environment happy-dom
//
// Composition tests (design section 22.10): the presetTouch bundle assembles and
// mounts, each feature contributes its chrome into the right region, the
// clipboard shortcut routes through the sanitizing funnel, and destroy tears the
// whole set down.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "./kernel/kernel.js";
import type * as PresetModule from "./presets.js";
import type { TerminalHandle } from "./kernel/types.js";

const sendBinary = vi.fn<(buf: Uint8Array) => boolean>(() => true);
const connectionInit = vi.fn<(callbacks: Parameters<typeof Engine.connection.init>[0]) => void>();

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
      init: connectionInit,
      connect: vi.fn(),
      sendBinary,
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect: vi.fn(),
    },
  };
});

let createTerminal: (typeof KernelModule)["createTerminal"];
let presetTouch: (typeof PresetModule)["presetTouch"];
const dec = new TextDecoder();
const sentText = (): string => sendBinary.mock.calls.map((c) => dec.decode(c[0])).join("");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  sendBinary.mockClear();
  connectionInit.mockClear();
  document.body.replaceChildren();
  ({ createTerminal } = await import("./kernel/kernel.js"));
  ({ presetTouch } = await import("./presets.js"));
});

function mountTouch(): { root: HTMLElement; term: TerminalHandle } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const term = createTerminal(root, { features: presetTouch() });
  return { root, term };
}

describe("presetTouch composition", () => {
  it("assembles every feature's chrome into its region", async () => {
    const { root } = mountTouch();
    await tick();
    expect(root.querySelector(".key-toolbar")).not.toBeNull(); // mobileToolbar
    expect(root.querySelector(".wt-scroll-bottom")).not.toBeNull(); // scrollToBottom
    expect(root.querySelector(".wt-conn-banner")).not.toBeNull(); // connectionBanner
    expect(root.querySelector(".wt-ctx-menu")).not.toBeNull(); // contextMenu
  });

  it("stacks the key toolbar and scroll button in the same thumb-zone region", async () => {
    const { root } = mountTouch();
    await tick();
    const region = root.querySelector<HTMLElement>(".wt-region-bottom-inset-end");
    expect(region).not.toBeNull();
    // "keys" slot sorts before "scroll" per the region's declared order.
    expect(region?.querySelector(".key-toolbar")).not.toBeNull();
    expect(region?.querySelector(".wt-scroll-bottom")).not.toBeNull();
  });

  it("routes Ctrl+Shift+V clipboard paste through the bracketed funnel", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve("echo hi\nrm x") },
    });
    try {
      const { root } = mountTouch();
      await tick();
      const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, code: "KeyV" }),
      );
      await Promise.resolve();
      await Promise.resolve();
      const sent = sentText();
      expect(sent.startsWith("\x1b[200~")).toBe(true);
      expect(sent).toContain("echo hi\rrm x");
      expect(sent.endsWith("\x1b[201~")).toBe(true);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("destroy tears down all feature chrome", async () => {
    const { root, term } = mountTouch();
    await tick();
    expect(root.querySelector(".key-toolbar")).not.toBeNull();
    term.destroy();
    expect(root.querySelector(".key-toolbar")).toBeNull();
    expect(root.querySelector(".wt-conn-banner")).toBeNull();
    expect(root.childElementCount).toBe(0);
  });
});
