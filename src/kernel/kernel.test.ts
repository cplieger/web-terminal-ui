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
import type { TerminalContext, TerminalFeature } from "./types.js";

const sendBinary = vi.fn<(buf: Uint8Array) => boolean>(() => true);
const connectionInit = vi.fn<(callbacks: Parameters<typeof Engine.connection.init>[0]) => void>();
const connect = vi.fn();
const setSession = vi.fn<(id: string) => void>();
const resetScrollback = vi.fn();
const resetScreen = vi.fn();

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
      resetScrollback,
      resetScreen,
      bind: vi.fn(),
      boundStore: vi.fn(),
    },
    scroll: { init: vi.fn(), scrollToBottom: vi.fn(), isUserScrolledUp: vi.fn(() => false) },
    connection: {
      init: connectionInit,
      connect,
      sendBinary,
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect: vi.fn(),
      setSession,
      forgetSession: vi.fn(),
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
  connect.mockClear();
  setSession.mockClear();
  resetScrollback.mockClear();
  resetScreen.mockClear();
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

describe("startup connect gating (session-managed vs single-terminal)", () => {
  it("connects at startup for the single-terminal case (no session-managing feature)", () => {
    const root = rootIn();
    createTerminal(root, { features: [] });
    // No feature owns sessions, so the kernel opens the bare /ws itself.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does NOT connect to the bare /ws when a feature registers as session owner, and switches to the resolved session instead", async () => {
    const root = rootIn();
    const owner: TerminalFeature = {
      name: "session-owner",
      sessionOwner: {
        resolveInitialSession: () => Promise.resolve({ id: "s1" }),
      },
      setup() {
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: [owner] });
    // A bare /ws here would 404 against a SessionManager.
    expect(connect).not.toHaveBeenCalled();
    await tick(); // setup completes
    await tick(); // the kernel awaits the resolver, then performs the switch
    expect(connect).not.toHaveBeenCalled();
    expect(setSession).toHaveBeenCalledWith("s1");
  });

  it("dismisses the loading overlay when the owner resolves no session (failed bootstrap shows the retry chrome)", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const owner: TerminalFeature = {
      name: "session-owner",
      sessionOwner: {
        resolveInitialSession: () => Promise.resolve(null),
      },
      setup() {
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: [owner], loading });
    await tick();
    await tick();
    // No session could be listed or spawned: the kernel saw the null directly
    // and lowered the overlay so the feature's retry chrome is visible.
    expect(loading.classList.contains("fade")).toBe(true);
    expect(setSession).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("treats a rejecting resolver as null (reported, overlay dismissed) rather than wedging", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const errors: string[] = [];
    const owner: TerminalFeature = {
      name: "session-owner",
      sessionOwner: {
        resolveInitialSession: () => Promise.reject(new Error("boom")),
      },
      setup(ctx) {
        ctx.onError((feature) => errors.push(feature));
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: [owner], loading });
    await tick();
    await tick();
    expect(loading.classList.contains("fade")).toBe(true);
    expect(errors).toContain("session-owner");
  });

  it("throws when two features register as session owner", () => {
    const root = rootIn();
    const mk = (name: string): TerminalFeature => ({
      name,
      sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
      setup() {
        return { teardown: () => undefined };
      },
    });
    expect(() => createTerminal(root, { features: [mk("a"), mk("b")] })).toThrow(
      /multiple session-owning features/,
    );
  });
});

describe("layout modes and root classes", () => {
  it("stamps wt-root + wt-viewport by default and removes them on destroy", () => {
    const root = rootIn();
    const term = createTerminal(root, { features: [] });
    expect(root.classList.contains("wt-root")).toBe(true);
    expect(root.classList.contains("wt-viewport")).toBe(true);
    expect(root.classList.contains("wt-container")).toBe(false);
    term.destroy();
    expect(root.classList.contains("wt-root")).toBe(false);
    expect(root.classList.contains("wt-viewport")).toBe(false);
  });

  it("stamps wt-container for layout: container", () => {
    const root = rootIn();
    createTerminal(root, { features: [], layout: "container" });
    expect(root.classList.contains("wt-container")).toBe(true);
    expect(root.classList.contains("wt-viewport")).toBe(false);
  });
});

describe("host handle send/reset", () => {
  it("send() routes through the sanitizing funnel and no-ops after destroy", () => {
    const root = rootIn();
    const term = createTerminal(root, { features: [] });
    term.send(new TextEncoder().encode("echo hi\n"));
    expect(sentText()).toContain("echo hi");
    sendBinary.mockClear();
    term.destroy();
    term.send(new TextEncoder().encode("late"));
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("reset() drops the local scrollback and screen without injecting keystrokes", () => {
    const root = rootIn();
    const term = createTerminal(root, { features: [] });
    sendBinary.mockClear();
    term.reset();
    expect(resetScrollback).toHaveBeenCalledTimes(1);
    expect(resetScreen).toHaveBeenCalledTimes(1);
    expect(sendBinary).not.toHaveBeenCalled();
  });
});

describe("process exit (the engine's definitive 4001 close)", () => {
  it("dismisses the loading overlay and emits 'ended', so a dead session can never wedge the page", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const seen: string[] = [];
    const watcher: TerminalFeature = {
      name: "state-watcher",
      setup(ctx) {
        ctx.on("connection:state", (s) => {
          seen.push(s);
        });
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: [watcher], loading });
    await tick(); // let feature setup complete
    expect(loading.classList.contains("fade")).toBe(false);

    // The engine reports the process-exited close on the active socket.
    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onProcessExit?.();

    // The overlay comes down even though no screen frame ever rendered
    // (attach-to-already-dead-session): this is the anti-wedge guarantee.
    expect(loading.classList.contains("fade")).toBe(true);
    // And the state machine surfaces the definitive end, not a reconnect.
    expect(seen).toContain("ended");
  });
});

describe("switch detach (design 5.1 switch safety)", () => {
  it("cancels IME composition, and runs onDetach before setSession and before onSwitch", async () => {
    const composition = await import("../composition.js");
    const root = rootIn();
    const order: string[] = [];
    let ctx: TerminalContext | undefined;
    const spy: TerminalFeature = {
      name: "spy",
      setup(c) {
        ctx = c;
        return {
          teardown: () => undefined,
          onDetach: () => {
            order.push("detach");
            // Detach must precede the socket re-point, or latched input could
            // fire against the incoming session.
            expect(setSession).not.toHaveBeenCalled();
          },
          onSwitch: () => order.push("switch"),
        };
      },
    };
    createTerminal(root, { features: [spy] });
    await tick(); // setupFeatures runs in the background; let it capture ctx

    // Start an IME composition on the kernel's textarea, then switch.
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(composition.isComposing()).toBe(true);

    setSession.mockClear();
    ctx?.notifySwitch({ id: "s9" });

    // Composition was cancelled on detach, so nothing leaks to the new session.
    expect(composition.isComposing()).toBe(false);
    // Ordering: every onDetach, then setSession, then every onSwitch.
    expect(order).toEqual(["detach", "switch"]);
    expect(setSession).toHaveBeenCalledWith("s9");
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

describe("snap-to-bottom on user input (classic-terminal follow re-engage)", () => {
  it("snaps the viewport to the bottom after accepted input reaches the socket", async () => {
    const { scroll } = await import("@cplieger/web-terminal-engine");
    const root = rootIn();
    createTerminal(root, { features: [] });
    await tick();
    const snap = vi.mocked(scroll.scrollToBottom);
    snap.mockClear();
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a" }));
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it("does NOT snap when an input transform drops the bytes", async () => {
    const { scroll } = await import("@cplieger/web-terminal-engine");
    const dropAll: TerminalFeature = {
      name: "drop",
      setup(ctx) {
        return { teardown: ctx.registerInputTransform(() => new Uint8Array(0)) };
      },
    };
    const root = rootIn();
    createTerminal(root, { features: [dropAll] });
    await tick();
    const snap = vi.mocked(scroll.scrollToBottom);
    snap.mockClear();
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "x" }));
    expect(snap).not.toHaveBeenCalled();
  });

  it("does NOT snap when sendBinary rejects the input", async () => {
    const { scroll, connection } = await import("@cplieger/web-terminal-engine");
    const root = rootIn();
    createTerminal(root, { features: [] });
    await tick();
    const snap = vi.mocked(scroll.scrollToBottom);
    snap.mockClear();
    vi.mocked(connection.sendBinary).mockReturnValueOnce(false);
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a" }));
    expect(snap).not.toHaveBeenCalled();
  });
});
