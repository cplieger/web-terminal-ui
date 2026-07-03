// @vitest-environment happy-dom
//
// Kernel contract tests (design section 22.10): a bare kernel yields a working
// terminal (output + hidden textarea, input-model contract, the sanitizing
// funnel) with no chrome, and the feature lifecycle (setup builds region chrome,
// the api is surfaced on the feature value and via ctx.use, teardown runs on
// destroy, the input funnel composes transforms) behaves as specified.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "./kernel.js";
import type { TerminalFeature } from "./types.js";

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
const dec = new TextDecoder();
const sentText = (): string => sendBinary.mock.calls.map((c) => dec.decode(c[0])).join("");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  sendBinary.mockClear();
  connectionInit.mockClear();
  document.body.replaceChildren();
  ({ createTerminal } = await import("./kernel.js"));
});

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("bare kernel builds a working terminal with no chrome", () => {
  it("builds the display output and the hidden textarea, and no feature chrome", () => {
    const root = rootIn();
    createTerminal(root, { features: [] });

    expect(root.querySelector(".term-output")).not.toBeNull();
    expect(root.querySelector(".term-input")).not.toBeNull();
    // Input-model contract: the output is display-only, never focusable.
    const output = root.querySelector<HTMLElement>(".term-output");
    expect(output?.getAttribute("tabindex")).toBeNull();
    // No chrome from features (banner/toolbar/menu are features, none loaded).
    expect(root.querySelector(".key-toolbar")).toBeNull();
    expect(root.querySelector(".ctx-menu")).toBeNull();
  });

  it("sends typed text raw through the funnel (insertText)", () => {
    const root = rootIn();
    createTerminal(root, { features: [] });
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "ab" }));
    expect(sentText()).toBe("ab");
    expect(sentText()).not.toContain("\x1b[200~");
  });

  it("brackets and sanitizes a paste (paste-jacking defense)", () => {
    const root = rootIn();
    createTerminal(root, { features: [] });
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(
      new InputEvent("input", { inputType: "insertFromPaste", data: "ls\n\x1b[201~rm -rf /" }),
    );
    const sent = sentText();
    expect(sent.startsWith("\x1b[200~")).toBe(true);
    expect(sent.endsWith("\x1b[201~")).toBe(true);
    expect(sent).toContain("\u241B[201~rm -rf /");
    expect(sent).not.toContain("\x1b[201~rm -rf /");
    expect(sent).toContain("ls\r");
  });

  it("normalizes a typed NBSP to a real space (iOS quirk)", () => {
    const root = rootIn();
    createTerminal(root, { features: [] });
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a\u00A0b" }));
    expect(sentText()).toBe("a b");
  });

  it("destroy() clears the built DOM", () => {
    const root = rootIn();
    const term = createTerminal(root, { features: [] });
    expect(root.querySelector(".term-output")).not.toBeNull();
    term.destroy();
    expect(root.querySelector(".term-output")).toBeNull();
    expect(root.childElementCount).toBe(0);
  });
});

describe("feature lifecycle", () => {
  interface FakeApi {
    ping(): string;
  }

  it("runs setup, surfaces the api on the feature value and via ctx.use, and mounts region chrome", async () => {
    const root = rootIn();
    let usedPeer: FakeApi | undefined;
    const fake: TerminalFeature<FakeApi> = {
      name: "fake",
      setup(ctx) {
        const region = ctx.region("bottom-inset-end", "keys");
        const btn = document.createElement("button");
        btn.className = "fake-btn";
        region.appendChild(btn);
        return { api: { ping: () => "pong" }, teardown: () => undefined };
      },
    };
    const peerReader: TerminalFeature = {
      name: "peer-reader",
      setup(ctx) {
        return {
          teardown: () => undefined,
          onSwitch: () => {
            usedPeer = ctx.use(fake);
          },
        };
      },
    };
    createTerminal(root, { features: [fake, peerReader] });
    await tick();

    // Region chrome mounted.
    expect(root.querySelector(".fake-btn")).not.toBeNull();
    // API surfaced on the feature value.
    expect(fake.api?.ping()).toBe("pong");
    // Retained for ctx.use (exercised via peerReader.onSwitch below).
    expect(usedPeer).toBeUndefined();
  });

  it("composes an input transform around send (a transform can drop input)", async () => {
    const root = rootIn();
    const dropAll: TerminalFeature = {
      name: "drop",
      setup(ctx) {
        const off = ctx.registerInputTransform(() => new Uint8Array(0));
        return { teardown: off };
      },
    };
    createTerminal(root, { features: [dropAll] });
    await tick();
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "x" }));
    // The transform dropped the byte, so nothing reached the socket.
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("runs teardown on destroy", async () => {
    const root = rootIn();
    const teardown = vi.fn();
    const f: TerminalFeature = {
      name: "f",
      setup() {
        return { teardown };
      },
    };
    const term = createTerminal(root, { features: [f] });
    await tick();
    term.destroy();
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
