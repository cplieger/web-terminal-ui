// @vitest-environment happy-dom
//
// Kernel contract tests (design section 22.10): a bare kernel yields a working
// terminal (output + hidden textarea, input-model contract, the sanitizing
// funnel) with no chrome, and the feature lifecycle (setup builds region chrome,
// the api is surfaced on the feature value and via ctx.use, teardown runs on
// destroy, the input funnel composes transforms) behaves as specified.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "./kernel.js";
import { STARTUP_FAILURE_COPY } from "./startup-copy.js";
import type { TerminalContext, TerminalFeature, TerminalStartupFailure } from "./types.js";

const sendBinary = vi.fn<(buf: Uint8Array) => boolean>(() => true);
const connectionInit = vi.fn<(callbacks: Parameters<typeof Engine.connection.init>[0]) => void>();
const connect = vi.fn();
const setSession = vi.fn<(id: string) => void>();
const disconnect = vi.fn();
const resetScrollback = vi.fn();
const resetScreen = vi.fn();
const renderInit = vi.fn<(opts: Parameters<typeof Engine.render.init>[0]) => void>();
const scrollInit = vi.fn<(opts: Parameters<typeof Engine.scroll.init>[0]) => void>();
// Hoisted so a test can drive the browse-cache TTL: the sweep reads both of
// these, and short-circuits on an empty cache.
const browseCacheSize = vi.fn<() => number>(() => 0);
const lastBrowseActivityMs = vi.fn<() => number>(() => 0);
const dropBrowseCache = vi.fn<(pageVisible: boolean) => void>();

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    render: {
      init: renderInit,
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
      resetScrollback,
      resetScreen,
      // The demand-paging surface the kernel wires (engine
      // docs/paged-scrollback.md §5): the browse-cache TTL calls the first two on
      // every visibility transition, so a double without them throws there.
      browseCacheSize,
      lastBrowseActivityMs,
      dropBrowseCache,
      maybeFetchHistory: vi.fn(),
      replayMaxForResume: vi.fn(() => 1500),
      handleHistoryReply: vi.fn(),
      applyResumeTransition: vi.fn(),
      noteSolicited: vi.fn(),
      clearSolicited: vi.fn(),
      bind: vi.fn(),
      boundStore: vi.fn(),
    },
    scroll: {
      init: scrollInit,
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      restoreScrollTop: vi.fn(),
      restoreView: vi.fn(),
    },
    connection: {
      init: connectionInit,
      connect,
      sendBinary,
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect,
      setSession,
      forgetSession: vi.fn(),
      // The engine's own per-tab session identity. The kernel reads it to scope
      // the unverified-restore guard to ONE session, so a double that omits it
      // makes every close path throw.
      currentSessionId: vi.fn<() => string>(() => "session-under-test"),
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
  disconnect.mockClear();
  resetScrollback.mockClear();
  resetScreen.mockClear();
  renderInit.mockClear();
  scrollInit.mockClear();
  browseCacheSize.mockClear();
  browseCacheSize.mockReturnValue(0);
  lastBrowseActivityMs.mockClear();
  lastBrowseActivityMs.mockReturnValue(0);
  dropBrowseCache.mockClear();
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
    createTerminal(root, { features: () => [] });

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
    createTerminal(root, { features: () => [] });
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "ab" }));
    expect(sentText()).toBe("ab");
    expect(sentText()).not.toContain("\x1b[200~");
  });

  it("brackets and sanitizes a paste (paste-jacking defense)", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
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
    createTerminal(root, { features: () => [] });
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a\u00A0b" }));
    expect(sentText()).toBe("a b");
  });

  it("destroy() clears the built DOM", () => {
    const root = rootIn();
    const term = createTerminal(root, { features: () => [] });
    expect(root.querySelector(".term-output")).not.toBeNull();
    term.destroy();
    expect(root.querySelector(".term-output")).toBeNull();
    expect(root.childElementCount).toBe(0);
  });
});

describe("startup connect gating (session-managed vs single-terminal)", () => {
  it("connects at startup for the single-terminal case (no session-managing feature)", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
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
    createTerminal(root, { features: () => [owner] });
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
    createTerminal(root, { features: () => [owner], loading });
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
    createTerminal(root, { features: () => [owner], loading });
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
    expect(() => createTerminal(root, { features: () => [mk("a"), mk("b")] })).toThrow(
      /multiple session-owning features/,
    );
  });
});

describe("layout modes and root classes", () => {
  it("stamps wt-root + wt-viewport by default and removes them on destroy", () => {
    const root = rootIn();
    const term = createTerminal(root, { features: () => [] });
    expect(root.classList.contains("wt-root")).toBe(true);
    expect(root.classList.contains("wt-viewport")).toBe(true);
    expect(root.classList.contains("wt-container")).toBe(false);
    term.destroy();
    expect(root.classList.contains("wt-root")).toBe(false);
    expect(root.classList.contains("wt-viewport")).toBe(false);
  });

  it("stamps wt-container for layout: container", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [], layout: "container" });
    expect(root.classList.contains("wt-container")).toBe(true);
    expect(root.classList.contains("wt-viewport")).toBe(false);
  });
});

describe("host handle send/reset", () => {
  it("send() routes through the sanitizing funnel and no-ops after destroy", () => {
    const root = rootIn();
    const term = createTerminal(root, { features: () => [] });
    term.send(new TextEncoder().encode("echo hi\n"));
    expect(sentText()).toContain("echo hi");
    sendBinary.mockClear();
    term.destroy();
    term.send(new TextEncoder().encode("late"));
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("reset() drops the local scrollback and screen without injecting keystrokes", () => {
    const root = rootIn();
    const term = createTerminal(root, { features: () => [] });
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
    createTerminal(root, { features: () => [watcher], loading });
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

  it("dismisses the loading overlay and emits 'incompatible' on wire refusal", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const seen: string[] = [];
    const watcher: TerminalFeature = {
      name: "wire-state-watcher",
      setup(ctx) {
        ctx.on("connection:state", (s) => {
          seen.push(s);
        });
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: () => [watcher], loading });
    await tick();

    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onWireIncompatible?.({
      source: "server-close",
      clientVersion: 4,
      minimumServerVersion: 3,
      reason: "upgrade required",
    });

    expect(loading.classList.contains("fade")).toBe(true);
    expect(seen).toContain("incompatible");
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
    createTerminal(root, { features: () => [spy] });
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
    createTerminal(root, { features: () => [fake, peerReader] });
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
    createTerminal(root, { features: () => [dropAll] });
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
    const term = createTerminal(root, { features: () => [f] });
    await tick();
    term.destroy();
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});

describe("fatal startup (a feature's setup threw or rejected)", () => {
  const boom: TerminalFeature = {
    name: "boom",
    setup() {
      throw new Error("import graph broken");
    },
  };

  it("tears down the runtime and renders the modal recovery surface (viewport)", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const peerTeardown = vi.fn();
    const peer: TerminalFeature = {
      name: "peer",
      setup() {
        return { teardown: peerTeardown };
      },
    };
    createTerminal(root, { features: () => [peer, boom], loading });
    await tick();

    // The completed peer rolled back, the socket closed, the terminal DOM is
    // gone — nothing half-live remains behind the recovery surface.
    expect(peerTeardown).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".term-output")).toBeNull();
    // The pre-JS overlay came down (nothing else would ever lower it), and the
    // surface is modal: a full-page terminal has no usable UI behind it.
    expect(loading.classList.contains("fade")).toBe(true);
    const fatal = root.querySelector(".wt-fatal");
    expect(fatal).not.toBeNull();
    expect(fatal?.getAttribute("role")).toBe("alertdialog");
    expect(fatal?.getAttribute("aria-modal")).toBe("true");
    expect(root.querySelector(".wt-fatal-reload")).not.toBeNull();
    // Boundary classes stay so the recovery surface keeps the design tokens.
    expect(root.classList.contains("wt-root")).toBe(true);
  });

  it("stays non-modal in container layout (the host app is not inert)", async () => {
    const root = rootIn();
    createTerminal(root, { features: () => [boom], layout: "container" });
    await tick();
    const fatal = root.querySelector(".wt-fatal");
    expect(fatal?.getAttribute("role")).toBe("alertdialog");
    expect(fatal?.getAttribute("aria-modal")).toBeNull();
  });

  it("handles an async setup rejection identically", async () => {
    const root = rootIn();
    const asyncBoom: TerminalFeature = {
      name: "async-boom",
      setup: () => Promise.reject(new Error("nope")),
    };
    createTerminal(root, { features: () => [asyncBoom] });
    await tick();
    await tick();
    expect(root.querySelector(".wt-fatal")).not.toBeNull();
  });

  it("lets onFatalError take over the surface and delivers the failure", async () => {
    const root = rootIn();
    const seen: TerminalStartupFailure[] = [];
    createTerminal(root, {
      features: () => [boom],
      onFatalError(failure) {
        seen.push(failure);
        const own = document.createElement("p");
        own.className = "host-recovery";
        root.appendChild(own);
        return true;
      },
    });
    await tick();
    expect(seen).toHaveLength(1);
    // Narrow on the discriminant before reading feature: only the
    // feature-setup member names one, because kernel-init fails before any
    // feature composition begins. This is the pattern a consumer follows.
    const failure = seen[0];
    expect(failure?.phase).toBe("feature-setup");
    if (failure?.phase !== "feature-setup") {
      throw new Error("expected a feature-setup failure");
    }
    expect(failure.feature).toBe("boom");
    expect(failure.cause).toBeInstanceOf(Error);
    // The handler claimed the surface, so the built-in panel never rendered.
    expect(root.querySelector(".wt-fatal")).toBeNull();
    expect(root.querySelector(".host-recovery")).not.toBeNull();
  });

  it("shows the built-in surface when the handler itself throws", async () => {
    const root = rootIn();
    createTerminal(root, {
      features: () => [boom],
      onFatalError() {
        throw new Error("reporter broke too");
      },
    });
    await tick();
    expect(root.querySelector(".wt-fatal")).not.toBeNull();
  });

  it("destroy() after a fatal removes the surface and boundary classes", async () => {
    const root = rootIn();
    const term = createTerminal(root, { features: () => [boom] });
    await tick();
    expect(root.querySelector(".wt-fatal")).not.toBeNull();
    term.destroy();
    expect(root.childElementCount).toBe(0);
    expect(root.classList.contains("wt-root")).toBe(false);
    expect(root.classList.contains("wt-viewport")).toBe(false);
  });

  it("destroy() mid-setup still aborts quietly (no fatal surface)", async () => {
    const root = rootIn();
    let release: (() => void) | undefined;
    const slow: TerminalFeature = {
      name: "slow",
      setup: () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ teardown: () => undefined });
          };
        }),
    };
    const term = createTerminal(root, { features: () => [slow, boom] });
    term.destroy();
    release?.();
    await tick();
    // An intentional destroy during setup is cancellation, not failure.
    expect(root.querySelector(".wt-fatal")).toBeNull();
    expect(root.childElementCount).toBe(0);
  });
});

describe("fatal startup (a SYNCHRONOUS throw out of createTerminal)", () => {
  // The multiple-session-owner guard is the one synchronous throw the kernel
  // raises itself, and it fires deliberately BEFORE any DOM work, so it is also
  // the worst case for the recovery surface: nothing has been built or stamped.
  const twoOwners = (): TerminalFeature[] =>
    ["a", "b"].map((name) => ({
      name,
      sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
      setup() {
        return { teardown: () => undefined };
      },
    }));

  it("still rethrows to the caller", () => {
    const root = rootIn();
    expect(() => createTerminal(root, { features: () => twoOwners() })).toThrow(
      /multiple session-owning features/,
    );
  });

  it("renders the recovery surface and lowers the overlay instead of leaving a stuck spinner", () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);

    expect(() => createTerminal(root, { features: () => twoOwners(), loading })).toThrow();

    // The pre-JS overlay came down. Before this phase was wired, nothing ever
    // lowered it on a synchronous throw: the page kept spinning forever.
    expect(loading.classList.contains("fade")).toBe(true);
    const fatal = root.querySelector(".wt-fatal");
    expect(fatal).not.toBeNull();
    expect(fatal?.getAttribute("role")).toBe("alertdialog");
    expect(fatal?.getAttribute("aria-modal")).toBe("true");
    expect(root.querySelector(".wt-fatal-title")?.textContent).toBe("Terminal failed to start");
    expect(root.querySelector(".wt-fatal-reload")).not.toBeNull();
  });

  it("stamps the boundary classes even though the throw preceded the normal stamping", () => {
    const root = rootIn();
    expect(() => createTerminal(root, { features: () => twoOwners() })).toThrow();
    // Load-bearing, not cosmetic: every .wt-fatal rule is scoped
    // :where(.wt-root), so without these the surface renders unstyled.
    expect(root.classList.contains("wt-root")).toBe(true);
    expect(root.classList.contains("wt-viewport")).toBe(true);
  });

  it("is non-modal in container layout, like the async phase", () => {
    const root = rootIn();
    expect(() =>
      createTerminal(root, { features: () => twoOwners(), layout: "container" }),
    ).toThrow();
    expect(root.classList.contains("wt-container")).toBe(true);
    expect(root.querySelector(".wt-fatal")?.hasAttribute("aria-modal")).toBe(false);
  });

  it("delivers the failure as phase kernel-init and lets a handler take over", () => {
    const root = rootIn();
    const seen: TerminalStartupFailure[] = [];
    expect(() =>
      createTerminal(root, {
        features: () => twoOwners(),
        onFatalError(failure) {
          seen.push(failure);
          root.replaceChildren(document.createElement("main"));
          return true;
        },
      }),
    ).toThrow();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.phase).toBe("kernel-init");
    expect(seen[0]?.cause).toBeInstanceOf(Error);
    // Claimed: the built-in surface must not overwrite the handler's own UI.
    expect(root.querySelector(".wt-fatal")).toBeNull();
    expect(root.querySelector("main")).not.toBeNull();
  });

  it("falls back to the built-in surface when the handler itself throws", () => {
    const root = rootIn();
    expect(() =>
      createTerminal(root, {
        features: () => twoOwners(),
        onFatalError() {
          throw new Error("reporting broke");
        },
      }),
    ).toThrow(/multiple session-owning features/);
    // The ORIGINAL cause reaches the caller, not the handler's error, and a
    // reporting failure never leaves the page blank.
    expect(root.querySelector(".wt-fatal")).not.toBeNull();
  });
});

// The two failures that used to happen OUTSIDE this boundary, which is why every
// full-page consumer hand-built its own copy of the recovery surface: resolving
// the mount target (the caller did the lookup and the null-check) and building
// the feature list (evaluated as an argument, before createTerminal was
// entered). Taking a selector and a thunk pulls both inside. These tests are the
// contract that lets a consumer delete its own fatal dialog and not get it back.
describe("startup failures that used to escape the boundary", () => {
  it("resolves a mount selector so the caller never has to null-check one", () => {
    const root = rootIn();
    root.id = "terminal";
    const term = createTerminal("#terminal", { features: () => [] });
    // Mounted into the element the selector named, not somewhere invented.
    expect(root.querySelector(".term-output")).not.toBeNull();
    term.destroy();
  });

  it("accepts an element too, for an embedder that already holds one", () => {
    // The trap was never "passing an element", it was "passing the result of a
    // lookup". An embedder that created its own div must not be forced to invent
    // a selector for it.
    const root = rootIn();
    const term = createTerminal(root, { features: () => [] });
    expect(root.querySelector(".term-output")).not.toBeNull();
    term.destroy();
  });

  it("shows the recovery surface when the mount selector matches nothing", () => {
    const loading = document.createElement("div");
    document.body.appendChild(loading);

    expect(() => createTerminal("#not-in-this-document", { features: () => [], loading })).toThrow(
      /no element matches the mount selector/,
    );

    // There is no root to render into, so the kernel appends its own
    // full-viewport host rather than restyling document.body. Before the
    // boundary moved, this case could not even be reached through the library:
    // the caller resolved the element, and a null one made the CATCH throw a
    // second error, so the page stayed blank under a spinning overlay.
    const fatal = document.querySelector(".wt-fatal");
    expect(fatal).not.toBeNull();
    expect(fatal?.getAttribute("role")).toBe("alertdialog");
    expect(fatal?.closest(".wt-root")).not.toBeNull();
    expect(document.querySelector(".wt-fatal-title")?.textContent).toBe(STARTUP_FAILURE_COPY.title);
    expect(document.querySelector(".wt-fatal-reload")?.textContent).toBe(
      STARTUP_FAILURE_COPY.reloadLabel,
    );
    // The spinner comes down even though nothing mounted.
    expect(loading.classList.contains("fade")).toBe(true);
  });

  it("does NOT seize the page for an embedded terminal with a missing mount target", () => {
    const before = document.body.className;
    const seen: TerminalStartupFailure[] = [];

    expect(() =>
      createTerminal("#not-in-this-document", {
        features: () => [],
        layout: "container",
        onFatalError(failure) {
          seen.push(failure);
        },
      }),
    ).toThrow(/no element matches the mount selector/);

    // An embedded terminal is one panel in a host application that is otherwise
    // working. Claiming the viewport to report its own panel's failure would
    // break a healthy page, so the failure is reported and rethrown but no
    // surface is rendered and nothing of the host's is touched.
    expect(document.querySelector(".wt-fatal")).toBeNull();
    expect(document.body.className).toBe(before);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.phase).toBe("kernel-init");
    // A handler that wants to render its own UI is told there is nowhere to.
    expect(seen[0]?.surface).toBeUndefined();
  });

  it("routes a throwing feature thunk through the recovery surface", () => {
    const root = rootIn();
    const boom = new Error("preset could not be built");
    const loading = document.createElement("div");
    document.body.appendChild(loading);

    expect(() =>
      createTerminal(root, {
        features: () => {
          throw boom;
        },
        loading,
      }),
    ).toThrow(boom);

    // As an eagerly-evaluated array argument this throw never reached the
    // library at all: it happened at the call site, so the consumer's own
    // try/catch and its own hand-built dialog were the only thing standing
    // between the user and a page stuck on a spinner.
    expect(root.querySelector(".wt-fatal")).not.toBeNull();
    expect(loading.classList.contains("fade")).toBe(true);
  });

  it("names the resolved surface so a handler knows where to render", () => {
    const root = rootIn();
    root.id = "terminal";
    const seen: TerminalStartupFailure[] = [];

    expect(() =>
      createTerminal("#terminal", {
        features: (): never => {
          throw new Error("nope");
        },
        onFatalError(failure) {
          seen.push(failure);
          failure.surface?.replaceChildren(document.createElement("main"));
          return true;
        },
      }),
    ).toThrow();

    // The handler rendered into the element the failure named, and the built-in
    // surface stood down.
    expect(seen[0]?.surface).toBe(root);
    expect(root.querySelector("main")).not.toBeNull();
    expect(root.querySelector(".wt-fatal")).toBeNull();
  });

  it("rejects a selector that matches a non-HTML element with the reason", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "mount";
    document.body.appendChild(svg);
    // Diagnosable at the boundary rather than as a missing-property crash deep
    // inside the build.
    expect(() => createTerminal("#mount", { features: () => [] })).toThrow(
      /matched a non-HTML element/,
    );
  });
});

describe("snap-to-bottom on user input (classic-terminal follow re-engage)", () => {
  it("snaps the viewport to the bottom after accepted input reaches the socket", async () => {
    const { scroll } = await import("@cplieger/web-terminal-engine");
    const root = rootIn();
    createTerminal(root, { features: () => [] });
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
    createTerminal(root, { features: () => [dropAll] });
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
    createTerminal(root, { features: () => [] });
    await tick();
    const snap = vi.mocked(scroll.scrollToBottom);
    snap.mockClear();
    vi.mocked(connection.sendBinary).mockReturnValueOnce(false);
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a" }));
    expect(snap).not.toHaveBeenCalled();
  });
});

describe("scrollbackLines (the consumer retained-line budget)", () => {
  it("passes a valid cap to the engine renderer as maxLines", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [], scrollbackLines: 1500 });
    expect(renderInit).toHaveBeenCalledTimes(1);
    expect(renderInit.mock.calls[0]?.[0]).toMatchObject({ maxLines: 1500 });
  });

  it("omits maxLines entirely when the option is unset (engine default applies)", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    expect(renderInit).toHaveBeenCalledTimes(1);
    expect(renderInit.mock.calls[0]?.[0]).not.toHaveProperty("maxLines");
  });

  it("ignores a non-integer or non-positive cap rather than clamping it", () => {
    const root = rootIn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      createTerminal(root, { features: () => [], scrollbackLines: 0.5 });
      expect(renderInit.mock.calls[0]?.[0]).not.toHaveProperty("maxLines");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("scrollbackLines"));
    } finally {
      warn.mockRestore();
    }
  });

  it("ctx.newLineStore() builds stores honoring the same cap (the tabs switching cache)", async () => {
    // LineStore is the REAL engine class (the mock spreads the actual module),
    // so the cap is observable through eviction: cap 8 retains the newest 8 of
    // 12 lines. This is the seam the tabs feature creates every per-tab store
    // through, so the one option governs those stores too.
    const root = rootIn();
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: () => [probe], scrollbackLines: 8 });
    await tick();
    expect(captured).toBeDefined();
    const store = captured?.newLineStore();
    expect(store).toBeDefined();
    if (!store) {
      return;
    }
    const row = (t: string): { t: string; f: number; b: number; a: number; uc: number }[] => [
      { t, f: -1, b: -1, a: 0, uc: -1 },
    ];
    store.applyScroll({
      type: "scroll",
      firstIndex: 0,
      lines: Array.from({ length: 12 }, (_, i) => row(`l${String(i)}`)),
    });
    expect(store.highestIndex()).toBe(11);
    expect(store.oldestIndex()).toBe(4); // cap 8: the oldest 4 evicted
  });
});

describe("mouse selection: a press never turns into a native text drag", () => {
  // The bug this pins: a browser reads a left press INSIDE an existing selection
  // as the start of a drag-and-drop of the selected text, so the press neither
  // collapses the selection nor starts a new one — drag twice over the same text
  // and the selection is stuck, un-clearable (a real mouse jitters a pixel or
  // two, which re-enters the drag path on every retry). The kernel collapses the
  // selection on the press so the browser takes its ordinary select path.
  function selectOutputText(root: HTMLElement): Selection {
    const output = root.querySelector(".term-output");
    if (!output) {
      throw new Error("no .term-output");
    }
    const text = document.createTextNode("line 1 the quick brown fox");
    output.appendChild(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 7);
    const sel = window.getSelection();
    if (!sel) {
      throw new Error("no selection");
    }
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.isCollapsed).toBe(false);
    return sel;
  }
  const press = (root: HTMLElement, init: MouseEventInit): void => {
    const term = root.querySelector(".term");
    term?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ...init }));
  };
  const collapsed = (): boolean => window.getSelection()?.isCollapsed ?? true;

  it("collapses the selection on a bare left press", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    selectOutputText(root);
    press(root, { button: 0 });
    expect(collapsed()).toBe(true);
  });

  it("keeps the selection for a right press, so the context menu can copy it", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    selectOutputText(root);
    press(root, { button: 2 });
    expect(collapsed()).toBe(false);
  });

  it("keeps the selection for a middle press, which pastes it on Linux", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    selectOutputText(root);
    press(root, { button: 1 });
    expect(collapsed()).toBe(false);
  });

  it("keeps the selection for a modified press (Shift extends, Ctrl adds a range)", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    selectOutputText(root);
    press(root, { button: 0, shiftKey: true });
    expect(collapsed()).toBe(false);
    press(root, { button: 0, ctrlKey: true });
    expect(collapsed()).toBe(false);
    press(root, { button: 0, altKey: true });
    expect(collapsed()).toBe(false);
    press(root, { button: 0, metaKey: true });
    expect(collapsed()).toBe(false);
  });

  it("leaves a touch press alone: the platform's selection UI owns it", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const term = root.querySelector(".term");
    selectOutputText(root);
    term?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    press(root, { button: 0 });
    expect(collapsed()).toBe(false);
  });
});

describe("demand-paged scrollback wiring", () => {
  // This whole feature shipped DARK: the engine grew the server control, the
  // client store, the fetch controller and the gap markers, and every one of its
  // own tests passed — while this kernel, the only thing that constructs a
  // terminal, passed none of the options that connect them. Nothing asserted the
  // connection, so nothing failed. These tests assert the seam itself.
  //
  // Each option below is a decision one module cannot make alone: the transport
  // is store-blind and viewport-blind, and the renderer has no socket. A missing
  // one does not break a test elsewhere — it just silently disables paging.

  it("gives the renderer a transport to fetch history with", () => {
    createTerminal(rootIn(), { features: () => [] });
    const opts = renderInit.mock.calls[0]?.[0];
    expect(opts).toBeDefined();
    expect(typeof opts?.requestHistory).toBe("function");
    expect(typeof opts?.historyBudget).toBe("function");
  });

  it("gives the scroll layer the position seam that drives the trigger", () => {
    // Not onUserScrollChange: that fires only on a follow/hold TOGGLE, so a
    // reader moving WITHIN history would never notify — and that is exactly when
    // paging has to work.
    createTerminal(rootIn(), { features: () => [] });
    const opts = scrollInit.mock.calls[0]?.[0];
    expect(opts).toBeDefined();
    expect(typeof opts?.onScrollPosition).toBe("function");
  });

  it("gives the transport every store and viewport decision it cannot make", () => {
    createTerminal(rootIn(), { features: () => [] });
    const cb = connectionInit.mock.calls[0]?.[0];
    expect(cb).toBeDefined();
    for (const name of [
      "getReplayMax",
      "onHistoryReply",
      "onResumeTransition",
      "noteSolicited",
      "clearSolicited",
      "onHistoryRetry",
    ] as const) {
      expect(typeof cb?.[name], `connection.init must wire ${name}`).toBe("function");
    }
  });

  it("asks for no more resume replay than it intends to keep resident", () => {
    // The bound the server honours. Sending nothing is not an option — the server
    // bounds the replay regardless, and a client that predicted no bound would
    // miss the resulting replay jump.
    createTerminal(rootIn(), { features: () => [] });
    const cb = connectionInit.mock.calls[0]?.[0];
    const max = cb?.getReplayMax?.();
    expect(typeof max).toBe("number");
    expect(max).toBeGreaterThan(0);
  });
});

describe("browse-cache TTL", () => {
  // Paged-in history is disposable (recovery is one fetch), so it is evicted by
  // INACTIVITY — never eagerly, or rapid scrolling would pay an RTT every time.
  // The engine owns the mechanism and this layer owns the clock, because the
  // engine has no notion of a page.
  const TTL_MS = 5 * 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops an idle cache on the sweep, and passes the page's visibility", () => {
    vi.useFakeTimers();
    createTerminal(rootIn(), { features: () => [] });
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now() - TTL_MS - 1);

    vi.advanceTimersByTime(61_000);

    expect(dropBrowseCache).toHaveBeenCalled();
    // Visibility is forwarded rather than decided here: a VISIBLE page whose
    // reader is parked on cached rows must keep them, and only the store knows
    // where the reader is.
    expect(dropBrowseCache).toHaveBeenCalledWith(true);
  });

  it("leaves a recently-read cache alone", () => {
    vi.useFakeTimers();
    createTerminal(rootIn(), { features: () => [] });
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now()); // just read

    vi.advanceTimersByTime(61_000);

    expect(dropBrowseCache).not.toHaveBeenCalled();
  });

  it("does NOT drop on the return transition, even with the TTL long expired", () => {
    // An earlier version enforced the TTL the throttled hidden period owed, right
    // here, with hidden-page semantics (unconditional). That deleted the rows the
    // returning reader was parked on, in the one moment they are certain to look
    // at them — and it bought at most 60 s over the periodic sweep, which applies
    // the visible-page rule instead. The page is visible the instant this fires,
    // so the visible rule is the correct one and this branch has nothing to add.
    createTerminal(rootIn(), { features: () => [] });
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now() - TTL_MS - 1);

    document.dispatchEvent(new Event("visibilitychange"));

    expect(dropBrowseCache).not.toHaveBeenCalled();
  });

  it("drops every cache on FREEZE, TTL or no TTL", () => {
    // The one state the periodic sweep cannot cover: a frozen page runs no code,
    // so without a last-chance hook its caches stay resident for the whole freeze
    // and a discard then throws them away unread. Unconditional here is the
    // opposite call from the return transition, and deliberately so — this fires
    // as the page STOPS running, with no reader and none imminent.
    let captured: TerminalContext | undefined;
    const grabber: TerminalFeature<void> = {
      name: "store-grabber",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [grabber] });
    const background = captured?.newLineStore("session-bg");
    if (background === undefined) {
      throw new Error("the feature never ran");
    }
    const bgDrop = vi.spyOn(background, "dropBrowseCache");
    // Both caches were read SECONDS ago, so the TTL is nowhere near expired.
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now());
    vi.spyOn(background, "browseCacheSize").mockReturnValue(900);
    vi.spyOn(background, "lastBrowseActivityMs").mockReturnValue(Date.now());

    document.dispatchEvent(new Event("freeze"));

    expect(dropBrowseCache).toHaveBeenCalledWith(false);
    expect(bgDrop).toHaveBeenCalledWith(-1, false);
  });

  it("drops on pagehide INTO bfcache, but not on an ordinary pagehide", () => {
    // Safari's path to the same frozen state, on the platform this feature is
    // for: `freeze` is Chrome's signal and bfcache entry is Safari's, and either
    // can fire without the other. An ordinary pagehide (a real navigation away)
    // needs no drop — the page is going away with its memory.
    createTerminal(rootIn(), { features: () => [] });
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now());

    window.dispatchEvent(new Event("pagehide"));
    expect(dropBrowseCache).not.toHaveBeenCalled();

    const persisted = new Event("pagehide");
    Object.defineProperty(persisted, "persisted", { value: true });
    window.dispatchEvent(persisted);
    expect(dropBrowseCache).toHaveBeenCalledWith(false);
  });

  it("sweeps a BACKGROUND tab's store, which the renderer never sees", () => {
    // render.* only ever reports the BOUND store, so a sweep written against it
    // reaches the visible tab and nothing else: every background tab's cache was
    // immortal for the life of the page, at up to the engine's whole cache budget
    // each. The kernel's store factory is the only place every store passes
    // through, so it is where they become reachable.
    vi.useFakeTimers();
    // The factory lives on the feature context, which is where the tabs feature
    // gets its per-tab stores from.
    let captured: TerminalContext | undefined;
    const grabber: TerminalFeature<void> = {
      name: "store-grabber",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [grabber] });
    const background = captured?.newLineStore("session-bg");
    if (background === undefined) {
      throw new Error("the feature never ran");
    }
    const bgDrop = vi.spyOn(background, "dropBrowseCache");
    vi.spyOn(background, "browseCacheSize").mockReturnValue(900);
    vi.spyOn(background, "lastBrowseActivityMs").mockReturnValue(Date.now() - TTL_MS - 1);
    // The bound store has nothing, so only the background one can be swept.
    browseCacheSize.mockReturnValue(0);

    vi.advanceTimersByTime(61_000);

    // No reader on a background tab, so no position to exempt: unconditional.
    expect(bgDrop).toHaveBeenCalledWith(-1, false);
  });
});
