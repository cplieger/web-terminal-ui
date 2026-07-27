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
import { STARTUP_FAILURE_COPY } from "./startup-copy.js";
import type { TerminalContext, TerminalFeature, TerminalStartupFailure } from "./types.js";

const sendBinary = vi.fn<(buf: Uint8Array) => boolean>(() => true);
const connectionInit = vi.fn<(callbacks: Parameters<typeof Engine.connection.init>[0]) => void>();
const connect = vi.fn();
const setSession = vi.fn<(id: string) => void>();
const disconnect = vi.fn();
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
    scroll: {
      init: vi.fn(),
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      restoreScrollTop: vi.fn(),
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
