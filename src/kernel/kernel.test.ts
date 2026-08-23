// Kernel contract tests (design section 22.10): a bare kernel yields a working
// terminal (output + hidden textarea, input-model contract, the sanitizing
// funnel) with no chrome, and the feature lifecycle (setup builds region chrome,
// the api is surfaced on the feature value and via ctx.use, teardown runs on
// destroy, the input funnel composes transforms) behaves as specified.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "./kernel.js";
import { STARTUP_FAILURE_COPY } from "./startup-copy.js";
import { clipboard } from "../features/clipboard.js";
import type {
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
  TerminalStartupFailure,
} from "./types.js";

const sendBinary = vi.fn<(buf: Uint8Array) => boolean>(() => true);
const connectionInit = vi.fn<(callbacks: Parameters<typeof Engine.connection.init>[0]) => void>();
const connect = vi.fn();
const setSession = vi.fn<(id: string) => void>();
const disconnect = vi.fn();
const reconnectNow = vi.fn();
const resetScrollback = vi.fn();
const resetScreen = vi.fn();
const renderInit = vi.fn<(opts: Parameters<typeof Engine.render.init>[0]) => void>();
const scrollInit = vi.fn<(opts: Parameters<typeof Engine.scroll.init>[0]) => void>();
// Hoisted so a test can drive the browse-cache TTL: the sweep reads both of
// these, and short-circuits on an empty cache.
const browseCacheSize = vi.fn<() => number>(() => 0);
const lastBrowseActivityMs = vi.fn<() => number>(() => 0);
const dropBrowseCache = vi.fn<(pageVisible: boolean) => void>();
// Hoisted so the scroll seam test can assert the callback the kernel builds
// actually REACHES the renderer, not merely that it is a function.
const handleScrollPosition = vi.fn();
// Hoisted so a test can say "this store is the visible tab's": the sweep splits
// the bound store (conditional drop, through the renderer) from every background
// one (unconditional, direct), and without a bound store to name, the split is
// invisible.
const boundStore = vi.fn<() => Engine.LineStore | undefined>(() => undefined);

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
      handleScrollPosition,
      replayMaxForResume: vi.fn(() => 1500),
      handleHistoryReply: vi.fn(),
      applyResumeTransition: vi.fn(),
      noteSolicited: vi.fn(),
      clearSolicited: vi.fn(),
      bind: vi.fn(),
      boundStore,
    },
    scroll: {
      init: scrollInit,
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      restoreScrollTop: vi.fn(),
      restoreView: vi.fn(),
      // Reached through viewport.ts's settle handler, which a real browser fires
      // on its own: viewport.init() observes the term wrap with a ResizeObserver,
      // and a real one delivers its first observation asynchronously, so every
      // mount opens a transition that settles ~350ms later and pins to the bottom.
      // Absent from this double the settle threw "stickToBottom is not a
      // function" out of a timer, 16 times over.
      stickToBottom: vi.fn(),
    },
    connection: {
      init: connectionInit,
      connect,
      sendBinary,
      sendResize: vi.fn(),
      reconnectNow,
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
  reconnectNow.mockClear();
  resetScrollback.mockClear();
  resetScreen.mockClear();
  renderInit.mockClear();
  scrollInit.mockClear();
  browseCacheSize.mockClear();
  browseCacheSize.mockReturnValue(0);
  lastBrowseActivityMs.mockClear();
  lastBrowseActivityMs.mockReturnValue(0);
  dropBrowseCache.mockClear();
  boundStore.mockClear();
  boundStore.mockReturnValue(undefined);
  document.body.replaceChildren();
  ({ createTerminal } = await import("./kernel.js"));
});

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

/** Declare a scroll container's geometry, INCLUDING a writable scrollTop.
 *
 *  All three readings are INPUTS to the paging arithmetic, and the arithmetic is
 *  the subject: production reads clientHeight/scrollHeight and writes the offset
 *  it computed. In a real browser `scrollTop` is clamped by actual overflow, so an
 *  assignment to a container with nothing to scroll silently stays 0 and the
 *  offset production wrote is unobservable — which would let a helper that only
 *  called preventDefault pass every assertion below. The own accessor records what
 *  production wrote and deliberately does NOT clamp, because production clamping
 *  for itself is exactly what is under test (see the ceiling note: WebKit does not
 *  reliably clamp an out-of-range offset). */
function declareScrollGeometry(
  el: HTMLElement,
  geom: { clientHeight: number; scrollHeight: number; scrollTop: number },
): void {
  Object.defineProperty(el, "clientHeight", { value: geom.clientHeight, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: geom.scrollHeight, configurable: true });
  let top = geom.scrollTop;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      top = next;
    },
  });
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
      // Names the collision: a consumer composing presets sees two features it
      // did not know both claimed sessions, and the names are the only way to
      // know which one to drop.
      /multiple session-owning features: a, b/,
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

  it("tells the host, after doing its own work, so a throwing handler costs nothing", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const seen: string[] = [];
    const watcher: TerminalFeature = {
      name: "throwing-host-watcher",
      setup(ctx) {
        ctx.on("connection:state", (s) => {
          seen.push(s);
        });
        return { teardown: () => undefined };
      },
    };
    const onSessionEnded = vi.fn(() => {
      throw new Error("host blew up");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createTerminal(root, { features: () => [watcher], loading, onSessionEnded });
    await tick();

    const cbs = connectionInit.mock.calls[0]![0]!;
    // The kernel must not rethrow into the engine's close handler either: the
    // socket teardown is mid-flight and has nowhere to put an exception.
    expect(() => {
      cbs.onProcessExit?.();
    }).not.toThrow();

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    // Both unconditional halves survived the throw.
    expect(loading.classList.contains("fade")).toBe(true);
    expect(seen).toContain("ended");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("leaves the host uninformed about an ordinary close, which is not an end", async () => {
    const onSessionEnded = vi.fn();
    createTerminal(rootIn(), { features: () => [], onSessionEnded });
    await tick();

    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onClose();

    expect(onSessionEnded).not.toHaveBeenCalled();
  });
});

// The host's way out of `ended`, which is the one connection state the kernel
// cannot leave on its own: the engine will not reconnect a definitively closed
// session, and only the host knows whether its endpoint yields a new one on the
// next connect.
describe("reattach", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the dead session's content, leaves the ended state, and reconnects", async () => {
    const root = rootIn();
    const seen: string[] = [];
    const watcher: TerminalFeature = {
      name: "reattach-state-watcher",
      setup(ctx) {
        ctx.on("connection:state", (s) => {
          seen.push(s);
        });
        return { teardown: () => undefined };
      },
    };
    const term = createTerminal(root, { features: () => [watcher] });
    await tick();
    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onProcessExit?.(); // the definitive close; also marks the kernel loaded
    resetScrollback.mockClear();
    resetScreen.mockClear();
    seen.length = 0;
    vi.useFakeTimers();

    term.reattach();

    // The old PTY's screen goes before the connect, so the resume cannot claim
    // lines above what the replacement has committed.
    expect(resetScrollback).toHaveBeenCalledTimes(1);
    expect(resetScreen).toHaveBeenCalledTimes(1);
    expect(reconnectNow).toHaveBeenCalledTimes(1);
    // And the banner stops saying "Session ended" over the blanked screen. The
    // transition carries the machine's grace delay, so a connect that lands
    // promptly shows nothing at all.
    expect(seen).not.toContain("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(seen).toContain("reconnecting");
  });

  it("injects no keystrokes, and starts nothing: reconnecting is all it does", async () => {
    const term = createTerminal(rootIn(), { features: () => [] });
    await tick();
    sendBinary.mockClear();

    term.reattach();

    expect(sendBinary).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
  });

  it("is a no-op after destroy, like every other handle member", async () => {
    const term = createTerminal(rootIn(), { features: () => [] });
    await tick();
    term.destroy();
    reconnectNow.mockClear();
    resetScrollback.mockClear();

    term.reattach();

    expect(reconnectNow).not.toHaveBeenCalled();
    expect(resetScrollback).not.toHaveBeenCalled();
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

describe("type-to-focus: a mouse selection must not swallow the next keystroke", () => {
  // The bug this pins: a mouse gesture over the display output leaves the browser
  // no focusable target, so the key target becomes <body> and the hidden textarea
  // stops receiving keys. Select one cell and typing silently does nothing. The
  // click handler cannot fix it (focusing collapses the selection, so it declines
  // while one exists), so a document-level listener takes the keyboard back on the
  // first typed character, sending that character itself.
  //
  // Load-bearing for these tests: every event below pins getModifierState
  // explicitly rather than leaving it derived from the modifier flags, so a test
  // asserts the kernel's rule and not one engine's derivation of the modifier
  // state. Real engines differ from each other here, which is why the kernel
  // grants the AltGraph exception only to a printable character: Firefox reports
  // AltGraph for plain Option on macOS and for ordinary Ctrl+Alt on Windows.
  const ta = (root: HTMLElement): HTMLTextAreaElement =>
    root.querySelector(".term-input") as HTMLTextAreaElement;

  /** Appends text to the output and selects part of it (both endpoints inside). */
  function selectInOutput(root: HTMLElement, from = 0, to = 7): void {
    const output = root.querySelector(".term-output");
    if (!output) {
      throw new Error("no .term-output");
    }
    const text = document.createTextNode("line 1 the quick brown fox");
    output.appendChild(text);
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    const sel = window.getSelection();
    if (!sel) {
      throw new Error("no selection");
    }
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.isCollapsed).toBe(false);
  }

  /** A keydown on the document, as a body-targeted key arrives in a browser. */
  function typeOnDocument(
    init: KeyboardEventInit & { key: string },
    opts: { altGraph?: boolean } = {},
  ): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(ev, "getModifierState", {
      value: (name: string): boolean => (name === "AltGraph" ? (opts.altGraph ?? false) : false),
    });
    document.body.dispatchEvent(ev);
    return ev;
  }

  const armed = (): HTMLElement => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    ta(root).blur();
    selectInOutput(root);
    return root;
  };

  it("sends the character and takes the keyboard back", () => {
    const root = armed();
    typeOnDocument({ key: "x" });
    expect(sentText()).toBe("x");
    expect(sendBinary).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(ta(root));
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it("cancels the keystroke it sends, so no input event can duplicate it", () => {
    armed();
    const ev = typeOnDocument({ key: "x" });
    expect(ev.defaultPrevented).toBe(true);
  });

  it("sends a space, and an astral character, as one character each", () => {
    // A fresh arming per case: the first send focuses the input and collapses the
    // selection, so a second key in the same state is correctly NOT armed.
    for (const key of [" ", "\u{1F600}"]) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      armed();
      typeOnDocument({ key });
      expect(sentText()).toBe(key);
    }
  });

  it("stays out of the way while the textarea holds focus", () => {
    // The textarea path owns a focused terminal: its keydown maps a printable to
    // "ignore" and the `input` event sends it. The document listener must not add
    // a second send when that keydown bubbles up to it.
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    selectInOutput(root);
    ta(root).focus();
    ta(root).dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }),
    );
    expect(sentText()).toBe("");
  });

  it("sends nothing while any control holds focus", () => {
    const cases: (() => void)[] = [
      () => {
        const b = document.createElement("button");
        document.body.appendChild(b);
        b.focus();
      },
      () => {
        const i = document.createElement("input");
        document.body.appendChild(i);
        i.focus();
      },
      () => {
        // The tabindex="0" ARIA widget: the standard accessible pattern, and the
        // case a blocklist of interactive TAG NAMES would miss.
        const w = document.createElement("div");
        w.setAttribute("tabindex", "0");
        w.setAttribute("role", "listbox");
        document.body.appendChild(w);
        w.focus();
      },
      () => {
        // Focus inside a shadow tree: activeElement reports the HOST, which is
        // still not the body, so the gate holds without knowing about shadow DOM.
        const host = document.createElement("div");
        document.body.appendChild(host);
        const sr = host.attachShadow({ mode: "open" });
        const i = document.createElement("input");
        sr.appendChild(i);
        i.focus();
      },
    ];
    for (const focusSomething of cases) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      const root = armed();
      focusSomething();
      typeOnDocument({ key: "x" });
      expect(sentText()).toBe("");
      expect(document.activeElement).not.toBe(ta(root));
    }
  });

  it("sends nothing unless this terminal owns a real selection", () => {
    // A caret is not a selection.
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    ta(root).blur();
    const output = root.querySelector(".term-output");
    const text = document.createTextNode("line 1 the quick brown fox");
    output?.appendChild(text);
    const caret = document.createRange();
    caret.setStart(text, 3);
    caret.setEnd(text, 3);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(caret);
    typeOnDocument({ key: "x" });
    expect(sentText()).toBe("");

    // A selection in the host page is the host's business.
    const hostText = document.createTextNode("host page paragraph");
    document.body.appendChild(hostText);
    const outside = document.createRange();
    outside.setStart(hostText, 0);
    outside.setEnd(hostText, 4);
    sel?.removeAllRanges();
    sel?.addRange(outside);
    typeOnDocument({ key: "x" });
    expect(sentText()).toBe("");
  });

  it("sends nothing for a selection that spans out of the output, either way", () => {
    for (const reverse of [false, true]) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      const root = rootIn();
      createTerminal(root, { features: () => [] });
      ta(root).blur();
      const output = root.querySelector(".term-output");
      const inside = document.createTextNode("terminal output text");
      output?.appendChild(inside);
      const outside = document.createTextNode("host page paragraph");
      document.body.appendChild(outside);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      // setBaseAndExtent lets the anchor be the LATER node, which is what a
      // right-to-left drag produces; an anchor-only containment test passes one
      // direction and fails the other.
      if (reverse) {
        sel?.setBaseAndExtent(outside, 4, inside, 2);
      } else {
        sel?.setBaseAndExtent(inside, 2, outside, 4);
      }
      typeOnDocument({ key: "x" });
      expect(sentText()).toBe("");
    }
  });

  it("leaves modified keys to the browser, so Ctrl+C still copies the selection", () => {
    for (const init of [
      { key: "c", ctrlKey: true },
      { key: "c", metaKey: true },
      { key: "ArrowLeft", altKey: true },
      { key: "ArrowLeft", ctrlKey: true },
      { key: "Backspace", altKey: true },
    ]) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      armed();
      typeOnDocument(init);
      expect(sentText()).toBe("");
      // The selection has to survive, or Ctrl+C would copy nothing.
      expect(window.getSelection()?.isCollapsed).toBe(false);
    }
  });

  it("recovers an AltGr character, which arrives with the AltGraph modifier", () => {
    armed();
    typeOnDocument({ key: "\u20AC", ctrlKey: true, altKey: true }, { altGraph: true });
    expect(sentText()).toBe("\u20AC");
  });

  it("leaves Tab to the browser, so a keyboard user can move on", () => {
    for (const init of [{ key: "Tab" }, { key: "Tab", shiftKey: true }]) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      armed();
      typeOnDocument(init);
      expect(sentText()).toBe("");
    }
  });

  it("encodes the functional keys exactly as the focused path does", () => {
    for (const [init, bytes] of [
      [{ key: "Enter" }, "\r"],
      [{ key: "Backspace" }, "\x7f"],
      [{ key: "ArrowUp" }, "\x1b[A"],
      [{ key: "Escape" }, "\x1b"],
    ] as [KeyboardEventInit & { key: string }, string][]) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      armed();
      typeOnDocument(init);
      expect(sentText()).toBe(bytes);
    }
  });

  it("leaves a dead key and an IME start to the platform", () => {
    // A dead key has no bytes and no character, so it delivers nothing and must
    // not touch the selection or the focus. The composed character arrives on the
    // NEXT keydown, which this listener then recovers normally, so the accent
    // survives rather than being traded for focus.
    for (const key of ["Dead", "Process", "Unidentified"]) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      const root = armed();
      const ev = typeOnDocument({ key });
      expect(sentText()).toBe("");
      expect(ev.defaultPrevented).toBe(false);
      expect(document.activeElement).not.toBe(ta(root));
      expect(window.getSelection()?.isCollapsed).toBe(false);
    }
  });

  it("leaves the selection alone for a key that delivers nothing", () => {
    // The blocker this pins: taking focus before deciding what the key does meant
    // a bare Shift cleared the selection. Shift is how a user reaches Shift+click
    // to extend a selection and Ctrl+Shift+C to copy one, so clearing on it broke
    // the two gestures the selection exists for. Lock keys and media keys are the
    // same shape: no bytes, no character, no business touching the selection.
    for (const key of [
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "CapsLock",
      "AltGraph",
      "AudioVolumeUp",
      "BrowserSearch",
    ]) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      const root = armed();
      typeOnDocument({ key });
      expect(sentText()).toBe("");
      expect(window.getSelection()?.isCollapsed).toBe(false);
      expect(document.activeElement).not.toBe(ta(root));
    }
  });

  it("survives the Shift-first chord order of Ctrl+Shift+C", () => {
    // Pressing Shift before Ctrl is an ordinary way to form the chord, and each
    // press is its own keydown. The two lead presses must leave the selection for
    // the third to copy.
    const seen: string[] = [];
    const probe: TerminalFeature<void> = {
      name: "copy-probe",
      setup(ctx) {
        ctx.registerKeydown((ev) => {
          if (ev.code === "KeyC" && ev.ctrlKey && ev.shiftKey) {
            seen.push(window.getSelection()?.toString() ?? "");
            return true;
          }
          return false;
        });
        return { api: undefined, teardown: vi.fn() };
      },
    };
    const root = rootIn();
    createTerminal(root, { features: () => [probe] });
    ta(root).blur();
    selectInOutput(root);
    typeOnDocument({ key: "Shift", shiftKey: true });
    typeOnDocument({ key: "Control", ctrlKey: true, shiftKey: true });
    typeOnDocument({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(seen).toEqual(["line 1 "]);
    expect(sentText()).toBe("");
  });

  it("leaves a key the host page already handled", () => {
    // preventDefault is the platform's own way to say "handled", so an embedder
    // with a document-level keymap needs no option to opt out of this listener.
    armed();
    const ev = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "getModifierState", { value: () => false });
    document.addEventListener("keydown", (e) => e.preventDefault(), { capture: true, once: true });
    document.body.dispatchEvent(ev);
    expect(sentText()).toBe("");
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });

  it("grants the AltGraph exception to a character, never to a mapped key", () => {
    // AltGraph is not a reliable signal by itself: Firefox reports it for plain
    // Option on macOS and for ordinary Ctrl+Alt on Windows. Admitting every
    // AltGraph event would hand the terminal Option+ArrowLeft, which is back.
    armed();
    typeOnDocument({ key: "ArrowLeft", altKey: true }, { altGraph: true });
    expect(sentText()).toBe("");
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });

  it("leaves the keystroke to the IME while a composition is running", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    ta(root).blur();
    selectInOutput(root);
    ta(root).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    typeOnDocument({ key: "a" });
    expect(sentText()).toBe("");
    expect(window.getSelection()?.isCollapsed).toBe(false);
    // The composition has to be closed before this test ends. composition.ts holds
    // `composing` in a module-level singleton, and in a real browser the module is
    // evaluated ONCE for the whole file: the browser's module map is URL-keyed, so
    // the beforeEach's `vi.resetModules()` + re-import hands back the SAME
    // instance rather than a fresh graph. A composition left open here therefore
    // stays open for every later test in this file, each of which then bails at
    // the kernel's isComposing() gate and passes for the wrong reason (measured:
    // six of them). destroy() resets the singleton — the contract
    // kernel.mutants.test.ts pins directly.
    handle.destroy();
  });

  it("normalizes a typed NBSP to a space, as the focused path does", () => {
    // One physical key must not produce two byte sequences depending on which
    // listener caught it. AltGr+Space yields U+00A0 on some Linux keymaps.
    armed();
    typeOnDocument({ key: "\u00A0" });
    expect(sentText()).toBe(" ");
  });

  it("sends nothing when the input cannot actually take focus", () => {
    // Focus can fail to land: an inert subtree under an open modal dialog, or a
    // released root. Bytes whose effect the user cannot see must not reach the
    // shell, so the listener fails closed rather than sending blind.
    const root = armed();
    Object.defineProperty(ta(root), "focus", { value: () => undefined });
    typeOnDocument({ key: "x" });
    expect(sentText()).toBe("");
  });

  it("scrolls the viewport for Shift+PageUp and Shift+PageDown", () => {
    // The test document loads no stylesheet, so the terminal pane has nothing to
    // overflow and the scroll arms need declared geometry to move against;
    // without it this test would pass against a helper that only called
    // preventDefault.
    const root = armed();
    const term = root.querySelector(".term") as HTMLElement;
    declareScrollGeometry(term, { clientHeight: 400, scrollHeight: 4000, scrollTop: 1000 });
    typeOnDocument({ key: "PageUp", shiftKey: true });
    expect(term.scrollTop).toBe(600);
    expect(sentText()).toBe("");
    selectInOutput(root);
    ta(root).blur();
    typeOnDocument({ key: "PageDown", shiftKey: true });
    expect(term.scrollTop).toBe(1000);
    expect(sentText()).toBe("");
  });

  it("stops a page down at the maximum offset, not one screen past it", () => {
    // The ceiling used to be scrollHeight, which is one clientHeight past the end
    // of the content, so a page down from near the bottom handed the container an
    // offset it cannot legally hold and relied on it to clamp. WebKit does not
    // reliably do that, and an out-of-range offset is what leaves the viewport
    // over empty space.
    const root = armed();
    const term = root.querySelector(".term") as HTMLElement;
    declareScrollGeometry(term, { clientHeight: 400, scrollHeight: 4000, scrollTop: 3500 });
    selectInOutput(root);
    ta(root).blur();
    typeOnDocument({ key: "PageDown", shiftKey: true });
    expect(term.scrollTop).toBe(3600); // 4000 - 400, the bottom
    expect(sentText()).toBe("");
  });

  it("lets the real clipboard feature copy the selection with focus on the body", () => {
    // The design promised this integration, and the probe test above cannot stand
    // in for it: the real handler keys on `ev.code`, not `ev.key`, and reads the
    // ambient selection itself.
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const root = rootIn();
    createTerminal(root, { features: () => [clipboard()] });
    ta(root).blur();
    selectInOutput(root);
    typeOnDocument({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(writeText).toHaveBeenCalledWith("line 1 ");
    expect(sentText()).toBe("");
    vi.unstubAllGlobals();
  });

  it("runs the feature keydown chain with the selection still intact", () => {
    // This is what makes clipboard's Ctrl+Shift+C reachable after a mouse
    // selection: the chain has to see the key BEFORE anything takes focus, or the
    // selection it copies is already gone.
    let sawSelection: string | null = null;
    const probe: TerminalFeature<void> = {
      name: "claims-keys",
      setup(ctx) {
        ctx.registerKeydown((ev) => {
          if (ev.key === "C" && ev.ctrlKey && ev.shiftKey) {
            sawSelection = window.getSelection()?.toString() ?? null;
            return true;
          }
          return false;
        });
        // FeatureInstance requires teardown. registerKeydown returns an
        // unsubscribe the kernel also drops wholesale on destroy, so this probe
        // has nothing of its own to release.
        return { api: undefined, teardown: vi.fn() };
      },
    };
    const root = rootIn();
    createTerminal(root, { features: () => [probe] });
    ta(root).blur();
    selectInOutput(root);
    typeOnDocument({ key: "C", ctrlKey: true, shiftKey: true });
    expect(sawSelection).toBe("line 1 ");
    expect(sentText()).toBe("");
    // A claimed key never focuses, so a second copy is still possible.
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });

  it("stops listening once the terminal is destroyed", () => {
    // destroy() also removes the output DOM, which would invalidate the selection
    // and make this pass for the wrong reason. A real browser will not select
    // detached nodes at all (addRange is ignored, and the selection reads back
    // empty), so the output is re-ATTACHED and armed against afterwards: it is
    // still the element the listener's `ownsSelection` closure captured, the
    // selection is genuine, and the only thing left to stop the send is the
    // aborted listener.
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    const output = root.querySelector(".term-output");
    if (!output) {
      throw new Error("no .term-output");
    }
    handle.destroy();
    document.body.appendChild(output);
    const text = document.createTextNode("detached output text");
    output.appendChild(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    expect(sel?.toString()).toBe("detached");
    sendBinary.mockClear();
    typeOnDocument({ key: "x" });
    expect(sentText()).toBe("");
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

  it("routes that seam to the renderer's scroll-position hook, and INVOKES it", () => {
    // Asserting the callback exists is what let the feature ship dark the first
    // time. The seam is only wired if calling it reaches the renderer, so call it.
    // One hook, not two: the renderer owns the ordering of the paging trigger and
    // the drain resume, precisely so a consumer cannot wire half of it.
    createTerminal(rootIn(), { features: () => [] });
    const opts = scrollInit.mock.calls[0]?.[0];
    handleScrollPosition.mockClear();
    opts?.onScrollPosition?.();
    expect(handleScrollPosition).toHaveBeenCalledTimes(1);
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

describe("the document title is composed from a base and a feature prefix", () => {
  // The kernel owns document.title precisely so these two inputs cannot erase each
  // other. Before it did, the OSC 0/2 branch assigned the title directly, so any
  // shell or editor in any tab wiped a feature's attention prefix, and no ordering
  // fixed it because both inputs change on their own schedule.
  //
  // ctx.titlePrefix is exercised here through a throwaway feature rather than
  // through tabs, so this asserts the KERNEL's contract and not the tabs feature's
  // use of it.

  /** Mount a terminal carrying one feature that captures ctx, so a test can drive
   *  ctx.titlePrefix directly. */
  async function withTitleFeature(): Promise<{
    setPrefix: (text: string) => void;
    emitTitle: (title: string) => void;
    destroy: () => void;
  }> {
    let ctxRef: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "title-probe",
      setup(ctx) {
        ctxRef = ctx;
        // FeatureInstance requires teardown; this probe owns no DOM, so it has
        // nothing to release. vi.fn keeps it a real function without an empty body.
        return { api: undefined, teardown: vi.fn() };
      },
    };
    const root = document.createElement("div");
    document.body.appendChild(root);
    const term = createTerminal(root, { features: () => [probe] });
    await tick();
    if (!ctxRef) {
      throw new Error("the probe feature never ran");
    }
    const captured = ctxRef;
    const cbs = connectionInit.mock.calls[0]![0]!;
    return {
      setPrefix: (text) => captured.titlePrefix(text),
      emitTitle: (title) => cbs.onMessage?.({ type: "title", title } as never),
      destroy: () => term.destroy(),
    };
  }

  it("puts the prefix first and keeps it across a later OSC 0/2 title", async () => {
    document.title = "Served page";
    const t = await withTitleFeature();

    t.setPrefix("(2) ");
    expect(document.title).toBe("(2) Served page");

    // The program's title replaces the BASE only. This is the assertion the whole
    // kernel-owns-the-title change exists for.
    t.emitTitle("vim README.md");
    expect(document.title).toBe("(2) vim README.md");

    // A blank OSC title is ignored, so a shell redrawing its prompt cannot flicker
    // the page title to the bare prefix.
    t.emitTitle("   ");
    expect(document.title).toBe("(2) vim README.md");

    // Clearing the prefix leaves the program's title in place.
    t.setPrefix("");
    expect(document.title).toBe("vim README.md");
    t.destroy();
  });

  it("clears a SET prefix on destroy, leaving the base alone", async () => {
    // The pre-existing destroy assertion in features/tabs runs with the prefix
    // already empty, so paintTitle is a no-op there and the cleanup could be
    // deleted with that suite green. This is the case that actually pins it.
    document.title = "Served page";
    const t = await withTitleFeature();

    t.setPrefix("(1) ");
    expect(document.title).toBe("(1) Served page");

    t.destroy();
    expect(document.title).toBe("Served page");
  });
});

// --- Helpers for the suites below -------------------------------------------

/** Give a root real geometry. An unstyled root measures 0, and 0 is inside BOTH
 *  narrow breakpoints, so an un-sized root is unconditionally narrow and the two
 *  halves of the test are indistinguishable. */
function sizeRoot(root: HTMLElement, width: number, height: number): void {
  Object.defineProperty(root, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(root, "clientHeight", { value: height, configurable: true });
}

/** A QUERY-AWARE matchMedia. The kernel asks two different questions that mean
 *  opposite things — `(any-pointer: fine)` (a hardware pointer exists, so focus
 *  eagerly) and `(pointer: coarse)` (the primary pointer is a finger, which
 *  ctx.layout() reports) — so a blanket `matches: false` stub answers the wrong
 *  one and a blanket `true` answers both wrongly at once. */
function stubMedia(answers: Record<string, boolean>): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: answers[query] ?? false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

describe("narrow layout: compact in EITHER dimension", () => {
  // The .wt-narrow class and ctx.layout().narrow are the same fact, published
  // once. Both breakpoints are load-bearing and they are NOT interchangeable: a
  // landscape phone (932x430) is far wider than the width breakpoint and still
  // wants the thumb-reach switcher, which is exactly the case a width-only test
  // cannot see.

  it("is not narrow on a desktop root", () => {
    const root = rootIn();
    sizeRoot(root, 1280, 800);
    createTerminal(root, { features: () => [] });
    expect(root.classList.contains("wt-narrow")).toBe(false);
  });

  it("is narrow on a portrait phone (skinny)", () => {
    const root = rootIn();
    sizeRoot(root, 390, 844);
    createTerminal(root, { features: () => [] });
    expect(root.classList.contains("wt-narrow")).toBe(true);
  });

  it("is narrow on a LANDSCAPE phone, which is wide but short", () => {
    // 932x430: an iPhone 14 Pro Max rotated. Wider than the width breakpoint by
    // 330px, so only the height half can catch it.
    const root = rootIn();
    sizeRoot(root, 932, 430);
    createTerminal(root, { features: () => [] });
    expect(root.classList.contains("wt-narrow")).toBe(true);
  });

  it("is not narrow on a landscape tablet, which is the case the height bound separates", () => {
    // The smallest iPad is 744 CSS px tall in landscape, so the 500px bound clears
    // it with margin — a tablet gets the desktop strip.
    const root = rootIn();
    sizeRoot(root, 1024, 744);
    createTerminal(root, { features: () => [] });
    expect(root.classList.contains("wt-narrow")).toBe(false);
  });

  it("counts the width breakpoint itself as narrow, and one pixel past it as not", () => {
    const atBound = rootIn();
    sizeRoot(atBound, 600, 800);
    createTerminal(atBound, { features: () => [] });
    expect(atBound.classList.contains("wt-narrow")).toBe(true);

    const pastBound = rootIn();
    sizeRoot(pastBound, 601, 800);
    createTerminal(pastBound, { features: () => [] });
    expect(pastBound.classList.contains("wt-narrow")).toBe(false);
  });

  it("counts the height breakpoint itself as narrow, and one pixel past it as not", () => {
    const atBound = rootIn();
    sizeRoot(atBound, 1280, 500);
    createTerminal(atBound, { features: () => [] });
    expect(atBound.classList.contains("wt-narrow")).toBe(true);

    const pastBound = rootIn();
    sizeRoot(pastBound, 1280, 501);
    createTerminal(pastBound, { features: () => [] });
    expect(pastBound.classList.contains("wt-narrow")).toBe(false);
  });

  it("reports the same fact through ctx.layout(), alongside pointer coarseness", async () => {
    // Two independent questions, deliberately: a narrow embedded panel on a
    // desktop is narrow with a fine pointer, and a landscape tablet is wide with
    // a coarse one. A feature that conflated them would get the mobile treatment
    // on a desktop panel.
    stubMedia({ "(pointer: coarse)": true });
    const root = rootIn();
    sizeRoot(root, 390, 844);
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "layout-probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: () => [probe] });
    await tick();

    expect(captured?.layout()).toEqual({ narrow: true, coarse: true });
  });

  it("reports coarse: false when the primary pointer is not a finger", async () => {
    stubMedia({ "(any-pointer: fine)": true });
    const root = rootIn();
    sizeRoot(root, 1280, 800);
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "layout-probe-fine",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: () => [probe] });
    await tick();

    expect(captured?.layout()).toEqual({ narrow: false, coarse: false });
  });

  it("drops the narrow class on destroy, so a re-mount starts clean", () => {
    const root = rootIn();
    sizeRoot(root, 390, 844);
    const term = createTerminal(root, { features: () => [] });
    expect(root.classList.contains("wt-narrow")).toBe(true);
    term.destroy();
    expect(root.classList.contains("wt-narrow")).toBe(false);
  });
});

describe("consumer theme overrides", () => {
  // The theme is a consumer-supplied record that lands on the root as CSS custom
  // properties, and the `--` filter is what keeps it to custom properties: the
  // whole point is to override the shipped tokens for THIS instance, not to hand
  // a consumer arbitrary inline style on the terminal root.

  it("sets each custom property on the root", () => {
    const root = rootIn();
    createTerminal(root, {
      features: () => [],
      theme: { "--wt-bg": "#101014", "--wt-fg": "#e6e6e6" },
    });
    expect(root.style.getPropertyValue("--wt-bg")).toBe("#101014");
    expect(root.style.getPropertyValue("--wt-fg")).toBe("#e6e6e6");
  });

  it("ignores a key that is not a custom property", () => {
    const root = rootIn();
    createTerminal(root, {
      features: () => [],
      // A consumer reaching for `position` is reaching past the token contract:
      // the layout-mode class owns how the root claims space.
      theme: { position: "static", "--wt-bg": "#101014" } as Record<string, string>,
    });
    expect(root.style.getPropertyValue("position")).toBe("");
    expect(root.style.getPropertyValue("--wt-bg")).toBe("#101014");
  });

  it("ignores a key that merely CONTAINS the custom-property prefix", () => {
    const root = rootIn();
    createTerminal(root, {
      features: () => [],
      theme: { "font-family--": "serif" } as Record<string, string>,
    });
    expect(root.style.getPropertyValue("font-family--")).toBe("");
  });

  it("writes no custom property of its own to the root with no theme", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    // Not "the style attribute is absent": viewport.init() publishes the visual
    // viewport's geometry on the root as --kb-inset/--vv-top, which it is supposed
    // to do and which a real browser (a real window.visualViewport) makes happen
    // on every mount. Those two have a different owner and their own tests. What
    // the theme seam owes with no theme given is that it contributes nothing, so
    // that is what is asserted: every inline property present belongs to the
    // viewport, and no --wt-* token was invented.
    const written = [...root.style].sort();
    expect(written).toEqual(["--kb-inset", "--vv-top"]);
  });
});

describe("toast (the kernel-owned shared primitive)", () => {
  const toastEl = (root: HTMLElement): HTMLElement | null =>
    root.querySelector<HTMLElement>(".wt-toast");

  async function withToast(): Promise<{ root: HTMLElement; ctx: TerminalContext }> {
    const root = rootIn();
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "toast-probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(root, { features: () => [probe] });
    await tick();
    if (captured === undefined) {
      throw new Error("the probe feature never ran");
    }
    return { root, ctx: captured };
  }

  it("announces itself to assistive tech as a status, not an alert", async () => {
    // role="status" is polite: a toast is confirmation of something the user just
    // did, so it must not interrupt what a screen reader is currently saying.
    const { root } = await withToast();
    expect(toastEl(root)?.getAttribute("role")).toBe("status");
  });

  it("shows the message, then hides and clears it when the window expires", async () => {
    const { root, ctx } = await withToast();
    vi.useFakeTimers();
    try {
      ctx.toast("Copied");
      expect(toastEl(root)?.textContent).toBe("Copied");
      expect(toastEl(root)?.classList.contains("visible")).toBe(true);

      vi.advanceTimersByTime(3000);

      expect(toastEl(root)?.classList.contains("visible")).toBe(false);
      // Cleared as well as hidden: the element stays in the DOM under role=status,
      // and leftover text is announced again by some screen readers on the next
      // mutation.
      expect(toastEl(root)?.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the window on a second toast instead of letting the first one hide it", async () => {
    // Without the clearTimeout the FIRST toast's timer still fires on its original
    // schedule and blanks the second message early — the more toasts, the shorter
    // each one lasts.
    const { root, ctx } = await withToast();
    vi.useFakeTimers();
    try {
      ctx.toast("First");
      vi.advanceTimersByTime(2500);
      ctx.toast("Second");

      vi.advanceTimersByTime(2500); // 5000ms since the first, 2500 since the second
      expect(toastEl(root)?.textContent).toBe("Second");
      expect(toastEl(root)?.classList.contains("visible")).toBe(true);

      vi.advanceTimersByTime(500);
      expect(toastEl(root)?.classList.contains("visible")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a caller's own duration", async () => {
    const { root, ctx } = await withToast();
    vi.useFakeTimers();
    try {
      ctx.toast("Brief", 500);
      vi.advanceTimersByTime(499);
      expect(toastEl(root)?.classList.contains("visible")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(toastEl(root)?.classList.contains("visible")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("feature error routing", () => {
  // A feature that throws must be attributed and contained. With no host handler
  // the kernel logs; with one, the host decides — and a host handler that itself
  // throws must not turn a feature bug into an unhandled rejection.

  it("logs a feature error, with the feature named, when no host handler is registered", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "noisy",
      setup(ctx) {
        captured = ctx;
        ctx.on("connection:state", () => {
          throw new Error("handler blew up");
        });
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();
    if (captured === undefined) {
      throw new Error("the probe feature never ran");
    }
    logged.mockClear();

    // The definitive 4001 close, because it publishes its state immediately: an
    // ordinary close is suppressed until the first frame has landed (the loading
    // overlay owns the screen), so it would deliver no event to throw from.
    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onProcessExit?.();

    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[0])).toContain("noisy");
    logged.mockRestore();
  });

  it("routes to a registered host handler instead of the console", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();
    const probe: TerminalFeature<void> = {
      name: "noisy",
      setup(ctx) {
        ctx.onError(onError);
        ctx.on("connection:state", () => {
          throw new Error("handler blew up");
        });
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();
    logged.mockClear();

    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onProcessExit?.();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("noisy");
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("survives a host error handler that throws, and still reaches the next one", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = vi.fn();
    const probe: TerminalFeature<void> = {
      name: "noisy",
      setup(ctx) {
        ctx.onError(() => {
          throw new Error("reporter blew up");
        });
        ctx.onError(second);
        ctx.on("connection:state", () => {
          throw new Error("handler blew up");
        });
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();
    const cbs = connectionInit.mock.calls[0]![0]!;

    expect(() => {
      cbs.onProcessExit?.();
    }).not.toThrow();

    expect(second).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("stops routing to a handler that unregistered itself", async () => {
    const onError = vi.fn();
    const probe: TerminalFeature<void> = {
      name: "noisy",
      setup(ctx) {
        const off = ctx.onError(onError);
        off();
        ctx.on("connection:state", () => {
          throw new Error("handler blew up");
        });
        return { teardown: () => undefined };
      },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onProcessExit?.();

    expect(onError).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("the input funnel's transform and observer chains", () => {
  // A transform can rewrite or drop bytes; an observer only watches. The split is
  // what lets predictive echo paint a character without being able to corrupt what
  // the server receives — and observers see ACCEPTED input only, so a phantom is
  // never painted for bytes the socket refused.

  it("tells every observer what was accepted", async () => {
    const seen: string[] = [];
    const dec2 = new TextDecoder();
    const probe: TerminalFeature<void> = {
      name: "observer",
      setup(ctx) {
        ctx.registerInputObserver((b) => {
          seen.push(dec2.decode(b));
        });
        ctx.registerInputObserver((b) => {
          seen.push(`second:${dec2.decode(b)}`);
        });
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(seen).toEqual(["q", "second:q"]);
  });

  it("tells observers the TRANSFORMED bytes, not the raw ones", async () => {
    const seen: string[] = [];
    const dec2 = new TextDecoder();
    const probe: TerminalFeature<void> = {
      name: "rewriter",
      setup(ctx) {
        ctx.registerInputTransform(() => new TextEncoder().encode("Z"));
        ctx.registerInputObserver((b) => {
          seen.push(dec2.decode(b));
        });
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(seen).toEqual(["Z"]);
  });

  it("tells observers nothing when the socket refused the bytes", async () => {
    const observed = vi.fn();
    const probe: TerminalFeature<void> = {
      name: "observer",
      setup(ctx) {
        ctx.registerInputObserver(observed);
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();
    sendBinary.mockReturnValue(false); // the outbox is full

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(observed).not.toHaveBeenCalled();
    sendBinary.mockReturnValue(true);
  });

  it("stops calling an unregistered transform, leaving the earlier one in place", async () => {
    // The unsubscribe has to remove the RIGHT entry: a splice at a stale index
    // silently drops somebody else's transform, which is the failure mode an
    // index-guard mutation produces and a single-transform test cannot see.
    const probe: TerminalFeature<void> = {
      name: "two-transforms",
      setup(ctx) {
        ctx.registerInputTransform((b) => new TextEncoder().encode(`<${dec.decode(b)}`));
        const off = ctx.registerInputTransform((b) =>
          new TextEncoder().encode(`${dec.decode(b)}>`),
        );
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(sentText()).toBe("<q");
  });

  it("stops calling an unregistered observer, leaving the earlier one in place", async () => {
    const seen: string[] = [];
    const dec2 = new TextDecoder();
    const probe: TerminalFeature<void> = {
      name: "two-observers",
      setup(ctx) {
        ctx.registerInputObserver((b) => {
          seen.push(`first:${dec2.decode(b)}`);
        });
        const off = ctx.registerInputObserver((b) => {
          seen.push(`second:${dec2.decode(b)}`);
        });
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(seen).toEqual(["first:q"]);
  });

  it("stops calling an unregistered keydown interceptor, leaving the earlier one in place", async () => {
    const seen: string[] = [];
    const probe: TerminalFeature<void> = {
      name: "two-keydowns",
      setup(ctx) {
        ctx.registerKeydown(() => {
          seen.push("first");
          return false;
        });
        const off = ctx.registerKeydown(() => {
          seen.push("second");
          return false;
        });
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));

    expect(seen).toEqual(["first"]);
  });

  it("unregistering the FIRST of two leaves the second working", async () => {
    // The index-zero case. A guard that admits only positive indices leaves entry
    // 0 in the list forever, so the removed transform keeps running.
    const probe: TerminalFeature<void> = {
      name: "drop-the-first",
      setup(ctx) {
        const off = ctx.registerInputTransform((b) =>
          new TextEncoder().encode(`<${dec.decode(b)}`),
        );
        ctx.registerInputTransform((b) => new TextEncoder().encode(`${dec.decode(b)}>`));
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(sentText()).toBe("q>");
  });

  it("unregistering the FIRST observer leaves the second hearing input", async () => {
    const seen: string[] = [];
    const dec2 = new TextDecoder();
    const probe: TerminalFeature<void> = {
      name: "drop-the-first-observer",
      setup(ctx) {
        const off = ctx.registerInputObserver((b) => {
          seen.push(`first:${dec2.decode(b)}`);
        });
        ctx.registerInputObserver((b) => {
          seen.push(`second:${dec2.decode(b)}`);
        });
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(seen).toEqual(["second:q"]);
  });

  it("unregistering the FIRST keydown interceptor leaves the second in the chain", async () => {
    const seen: string[] = [];
    const probe: TerminalFeature<void> = {
      name: "drop-the-first-keydown",
      setup(ctx) {
        const off = ctx.registerKeydown(() => {
          seen.push("first");
          return false;
        });
        ctx.registerKeydown(() => {
          seen.push("second");
          return false;
        });
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));

    expect(seen).toEqual(["second"]);
  });

  it("tolerates a double unregister of an observer without silencing the survivor", async () => {
    const seen: string[] = [];
    const dec2 = new TextDecoder();
    const probe: TerminalFeature<void> = {
      name: "double-off-observer",
      setup(ctx) {
        ctx.registerInputObserver((b) => {
          seen.push(`first:${dec2.decode(b)}`);
        });
        const off = ctx.registerInputObserver((b) => {
          seen.push(`second:${dec2.decode(b)}`);
        });
        off();
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(seen).toEqual(["first:q"]);
  });

  it("tolerates a double unregister of a keydown interceptor without dropping the survivor", async () => {
    const seen: string[] = [];
    const probe: TerminalFeature<void> = {
      name: "double-off-keydown",
      setup(ctx) {
        ctx.registerKeydown(() => {
          seen.push("first");
          return false;
        });
        const off = ctx.registerKeydown(() => {
          seen.push("second");
          return false;
        });
        off();
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));

    expect(seen).toEqual(["first"]);
  });

  it("tolerates a double unregister without disturbing the survivors", async () => {
    // The second call finds nothing, and `indexOf` reports -1 — which a splice
    // would read as "the last entry", removing an innocent transform.
    const probe: TerminalFeature<void> = {
      name: "double-off",
      setup(ctx) {
        const off = ctx.registerInputTransform((b) =>
          new TextEncoder().encode(`<${dec.decode(b)}`),
        );
        ctx.registerInputTransform((b) => new TextEncoder().encode(`${dec.decode(b)}>`));
        off();
        off();
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "q" }));

    expect(sentText()).toBe("q>");
  });
});

describe("the input event's value-recovery path (Android/IME, where ev.data is null)", () => {
  // The `input` event does not always carry what was typed: on Android's Gboard
  // and several IMEs `data` is null and the typed text is only visible as the
  // textarea's VALUE. The textarea is seeded with a placeholder so a backspace at
  // column 0 has something to delete, so recovery means telling "placeholder plus
  // new text" apart from "the field was replaced outright" — and sending the
  // placeholder to the pty would type garbage into the user's shell.
  const ta = (): HTMLTextAreaElement =>
    document.querySelector(".term-input") as HTMLTextAreaElement;
  const fireValueInput = (value: string): void => {
    const el = ta();
    el.value = value;
    el.dispatchEvent(new InputEvent("input", { inputType: "insertText" }));
  };

  it("sends only the text appended after the placeholder", () => {
    createTerminal(rootIn(), { features: () => [] });
    const placeholder = ta().value;
    expect(placeholder.length).toBeGreaterThan(0);

    fireValueInput(`${placeholder}hi`);

    expect(sentText()).toBe("hi");
  });

  it("sends nothing when the value is the untouched placeholder", () => {
    createTerminal(rootIn(), { features: () => [] });
    fireValueInput(ta().value);
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("sends nothing when the field was emptied", () => {
    // A cleared field is a delete, not a keystroke: the placeholder is restored
    // and nothing goes on the wire.
    createTerminal(rootIn(), { features: () => [] });
    fireValueInput("");
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("sends the whole value when it does not start with the placeholder", () => {
    // An IME that REPLACES the field rather than appending to it. The value is
    // entirely the user's text, so all of it goes.
    createTerminal(rootIn(), { features: () => [] });
    fireValueInput("replaced");
    expect(sentText()).toBe("replaced");
  });

  it("sends the whole value when the placeholder is a SUFFIX rather than a prefix", () => {
    // Position matters: text before the placeholder is the user's, and treating it
    // as a placeholder-prefixed value would slice the user's own characters off.
    createTerminal(rootIn(), { features: () => [] });
    const placeholder = ta().value;

    fireValueInput(`ab${placeholder}`);

    // The placeholder is an NBSP and every send path normalizes NBSP to a space
    // (the iOS quirk), so the recovered text arrives as "ab ".
    expect(sentText()).toBe("ab ");
  });

  it("normalizes an iOS NBSP recovered from the value", () => {
    createTerminal(rootIn(), { features: () => [] });
    const placeholder = ta().value;
    fireValueInput(`${placeholder}a\u00A0b`);
    expect(sentText()).toBe("a b");
  });

  it("restores the placeholder afterwards, so the next backspace still has a target", () => {
    createTerminal(rootIn(), { features: () => [] });
    const placeholder = ta().value;
    fireValueInput(`${placeholder}hi`);
    expect(ta().value).toBe(placeholder);
  });

  it("sends nothing for a deletion, whatever is left in the field", () => {
    // Backspace and its three siblings are the reason the placeholder exists: the
    // engine's key encoder already sent the control byte on keydown, so the
    // resulting `input` event must send nothing at all. The residual value is what
    // makes this observable — an EMPTY field takes the same path either way, so a
    // test that clears the field proves nothing about the guard. A field still
    // holding text is the case where dropping the guard sends it a second time.
    for (const inputType of [
      "deleteContentBackward",
      "deleteContentForward",
      "deleteWordBackward",
      "deleteWordForward",
    ]) {
      sendBinary.mockClear();
      document.body.replaceChildren();
      createTerminal(rootIn(), { features: () => [] });
      const el = ta();
      const placeholder = el.value;
      el.value = `${placeholder}ab`;

      el.dispatchEvent(new InputEvent("input", { inputType }));

      expect(sendBinary, `${inputType} must send nothing`).not.toHaveBeenCalled();
      expect(el.value, `${inputType} must restore the placeholder`).toBe(placeholder);
    }
  });

  it("prefers ev.data over the value when both are present", () => {
    // The value still holds the placeholder at this point; taking the data path is
    // what keeps the placeholder out of the wire on the common browsers.
    createTerminal(rootIn(), { features: () => [] });
    const el = ta();
    el.value = `${el.value}ignored`;

    el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "d" }));

    expect(sentText()).toBe("d");
  });

  it("falls back to the value when ev.data is an empty string", () => {
    // An empty `data` is not "nothing typed": Gboard reports it while putting the
    // text in the value, so an empty-string check that admitted it would send
    // nothing at all.
    createTerminal(rootIn(), { features: () => [] });
    const el = ta();
    const placeholder = el.value;
    el.value = `${placeholder}gb`;

    el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "" }));

    expect(sentText()).toBe("gb");
  });
});

describe("the keydown chain on the focused textarea", () => {
  const ta = (): HTMLTextAreaElement =>
    document.querySelector(".term-input") as HTMLTextAreaElement;
  const key = (init: KeyboardEventInit & { key: string }): KeyboardEvent => {
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    ta().dispatchEvent(ev);
    return ev;
  };

  it("stops at the first feature that claims the key", async () => {
    // Ordering is the contract: clipboard's Ctrl+Shift+C must beat the encoder,
    // which would otherwise send an interrupt.
    const seen: string[] = [];
    const probe: TerminalFeature<void> = {
      name: "claimer",
      setup(ctx) {
        ctx.registerKeydown((ev) => {
          seen.push(`first:${ev.key}`);
          return true;
        });
        ctx.registerKeydown((ev) => {
          seen.push(`second:${ev.key}`);
          return false;
        });
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    key({ key: "c", ctrlKey: true, shiftKey: true });

    expect(seen).toEqual(["first:c"]);
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("falls through to the encoder when no feature claims the key", async () => {
    const probe: TerminalFeature<void> = {
      name: "declines",
      setup(ctx) {
        ctx.registerKeydown(() => false);
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe] });
    await tick();

    key({ key: "c", ctrlKey: true });

    // Ctrl+C is SIGINT: the encoder maps it, so the chain must reach it.
    expect(sentText()).toBe("\x03");
  });

  it("scrolls a page up on Shift+PageUp instead of sending it to the pty", () => {
    // Scrollback paging is a CLIENT gesture: the pty has no scrollback to page,
    // so the bytes must not go on the wire and the browser's own PageUp must not
    // also fire.
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const term = root.querySelector<HTMLElement>(".term");
    if (!term) {
      throw new Error("no .term");
    }
    declareScrollGeometry(term, { clientHeight: 400, scrollHeight: 4000, scrollTop: 1000 });

    const ev = key({ key: "PageUp", shiftKey: true });

    expect(term.scrollTop).toBe(600);
    expect(ev.defaultPrevented).toBe(true);
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("clamps a page up at the top rather than scrolling past it", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const term = root.querySelector<HTMLElement>(".term");
    if (!term) {
      throw new Error("no .term");
    }
    declareScrollGeometry(term, { clientHeight: 400, scrollHeight: 4000, scrollTop: 120 });

    key({ key: "PageUp", shiftKey: true });

    expect(term.scrollTop).toBe(0);
  });

  it("scrolls a page down on Shift+PageDown", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const term = root.querySelector<HTMLElement>(".term");
    if (!term) {
      throw new Error("no .term");
    }
    declareScrollGeometry(term, { clientHeight: 400, scrollHeight: 4000, scrollTop: 1000 });

    const ev = key({ key: "PageDown", shiftKey: true });

    expect(term.scrollTop).toBe(1400);
    expect(ev.defaultPrevented).toBe(true);
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("cancels a key it sends, so the browser cannot also act on it", () => {
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const ev = key({ key: "c", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
  });

  it("leaves a printable key to the input event, uncancelled", () => {
    // The encoder defers a plain character on purpose: cancelling here would kill
    // IME and dead-key composition, which only produce text through `input`.
    createTerminal(rootIn(), { features: () => [] });
    const ev = key({ key: "a" });
    expect(ev.defaultPrevented).toBe(false);
    expect(sendBinary).not.toHaveBeenCalled();
  });
});

describe("tap-to-focus on touch (the gesture boundary with native selection)", () => {
  // A touch that opens the soft keyboard has to be a genuine tap. Everything else
  // belongs to the platform: a drag is a scroll or a selection-extend, a hold is a
  // long-press that native text selection and the context menu split between them.
  // The thresholds live in gesture.ts because the contextMenu feature classifies
  // the other side of the same boundary from them.
  function tapSequence(
    root: HTMLElement,
    opts: {
      from?: [number, number];
      to?: [number, number];
      heldMs?: number;
      pointerType?: string;
      target?: Element;
    } = {},
  ): void {
    const term = root.querySelector<HTMLElement>(".term");
    if (!term) {
      throw new Error("no .term");
    }
    const [x0, y0] = opts.from ?? [100, 100];
    const [x1, y1] = opts.to ?? [x0, y0];
    const pointerType = opts.pointerType ?? "touch";
    const down = new PointerEvent("pointerdown", {
      bubbles: true,
      pointerType,
      clientX: x0,
      clientY: y0,
    });
    Object.defineProperty(down, "timeStamp", { value: 1000, configurable: true });
    term.dispatchEvent(down);
    const up = new PointerEvent("pointerup", {
      bubbles: true,
      pointerType,
      clientX: x1,
      clientY: y1,
    });
    Object.defineProperty(up, "timeStamp", {
      value: 1000 + (opts.heldMs ?? 40),
      configurable: true,
    });
    Object.defineProperty(up, "target", { value: opts.target ?? term, configurable: true });
    (opts.target ?? term).dispatchEvent(up);
  }
  const focused = (root: HTMLElement): boolean =>
    document.activeElement === root.querySelector(".term-input");
  const blurTerminal = (root: HTMLElement): void => {
    (root.querySelector(".term-input") as HTMLTextAreaElement).blur();
  };

  it("focuses the input on a clean tap, which is what opens the soft keyboard", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root);

    expect(focused(root)).toBe(true);
  });

  it("bows out of a drag, which is a scroll or a selection-extend", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { from: [100, 100], to: [140, 100] });

    expect(focused(root)).toBe(false);
  });

  it("bows out of vertical movement too, not just horizontal", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { from: [100, 100], to: [100, 60] });

    expect(focused(root)).toBe(false);
  });

  it("counts the movement ceiling itself as still a tap", () => {
    // At the threshold, not past it: the contextMenu feature classifies the other
    // side of this same boundary, so an off-by-one here opens a gap or an overlap.
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { from: [100, 100], to: [110, 110] });

    expect(focused(root)).toBe(true);
  });

  it("bows out one pixel past the movement ceiling", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { from: [100, 100], to: [111, 100] });

    expect(focused(root)).toBe(false);
  });

  it("measures movement as a distance, so a leftward drag counts too", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { from: [100, 100], to: [40, 100] });

    expect(focused(root)).toBe(false);
  });

  it("bows out of a long-press, which belongs to native word-select", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { heldMs: 900 });

    expect(focused(root)).toBe(false);
  });

  it("counts the duration ceiling itself as still a tap", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { heldMs: 500 });

    expect(focused(root)).toBe(true);
  });

  it("bows out one millisecond past the duration ceiling", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { heldMs: 501 });

    expect(focused(root)).toBe(false);
  });

  it("leaves a tap on a link to the platform", () => {
    // Neither this handler nor the context menu claims a link press: the OS's own
    // affordances (preview on hold, activate on tap) win.
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const output = root.querySelector(".term-output");
    const link = document.createElement("a");
    link.className = "term-link";
    link.href = "https://example.com/";
    output?.appendChild(link);
    blurTerminal(root);

    tapSequence(root, { target: link });

    expect(focused(root)).toBe(false);
  });

  it("ignores a mouse pointerup entirely: this handler is touch-only", () => {
    // The click handler owns the mouse, and it applies the selection policy that
    // this one must not.
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    tapSequence(root, { pointerType: "mouse" });

    expect(focused(root)).toBe(false);
  });

  it("clears a selection on a clean tap WITHOUT popping the keyboard", () => {
    // The deselect tap. iOS otherwise leaves the selection stuck, because the
    // synthetic mousedown the kernel cancels to preserve the keyboard also
    // suppresses the platform's own tap-to-deselect. Focusing here as well would
    // pop the keyboard right after a copy.
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const output = root.querySelector(".term-output");
    const text = document.createTextNode("selected output");
    output?.appendChild(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    blurTerminal(root);

    tapSequence(root);

    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(focused(root)).toBe(false);
  });

  it("clears the selection AND focuses in one tap when a hardware keyboard is present", () => {
    // An iPad with a Magic Keyboard has no soft keyboard to protect, so the extra
    // tap the bare-touch rule costs is pure friction — a large part of the
    // reported "2-3 taps to focus".
    stubMedia({ "(any-pointer: fine)": true });
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const output = root.querySelector(".term-output");
    const text = document.createTextNode("selected output");
    output?.appendChild(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    blurTerminal(root);

    tapSequence(root);

    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(focused(root)).toBe(true);
  });
  it("cancels the synthetic mousedown after a bare-touch tap, which is what keeps the keyboard up", () => {
    // iOS synthesises a mousedown after a touch tap, and letting it through blurs
    // and refocuses the textarea — which closes and reopens the soft keyboard. The
    // xterm.js focus-preservation pattern, scoped to touch.
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const term = root.querySelector(".term");
    term?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));

    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    term?.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
  });

  it("lets that mousedown through when a hardware keyboard is present", () => {
    // There is no soft keyboard to protect on an iPad with a trackpad, and
    // suppressing the mousedown there was DEFEATING the native focus — which is why
    // the terminal needed several taps to focus.
    stubMedia({ "(any-pointer: fine)": true });
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const term = root.querySelector(".term");
    term?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));

    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    term?.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("clicking the terminal", () => {
  const clickOn = (el: Element): MouseEvent => {
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };
  const focused = (root: HTMLElement): boolean =>
    document.activeElement === root.querySelector(".term-input");
  const blurTerminal = (root: HTMLElement): void => {
    (root.querySelector(".term-input") as HTMLTextAreaElement).blur();
  };

  it("opens a linkified URL in a new tab, severed from this page", () => {
    // noopener is the security property: without it the opened page gets a live
    // `window.opener` handle to the terminal, and the terminal is a shell.
    stubMedia({});
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const link = document.createElement("a");
    link.className = "term-link";
    link.href = "https://example.com/path";
    root.querySelector(".term-output")?.appendChild(link);

    const ev = clickOn(link);

    expect(opened).toHaveBeenCalledWith(
      "https://example.com/path",
      "_blank",
      "noopener,noreferrer",
    );
    // Cancelled, so the browser does not ALSO navigate this page to the href.
    expect(ev.defaultPrevented).toBe(true);
    opened.mockRestore();
  });

  it("focuses the terminal on an ordinary click", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    blurTerminal(root);

    const output = root.querySelector(".term-output");
    if (!output) {
      throw new Error("no .term-output");
    }
    clickOn(output);

    expect(focused(root)).toBe(true);
  });

  it("declines while text is selected, so a click does not destroy the selection", () => {
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const output = root.querySelector(".term-output");
    if (!output) {
      throw new Error("no .term-output");
    }
    const text = document.createTextNode("selected output");
    output.appendChild(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    blurTerminal(root);

    clickOn(output);

    expect(focused(root)).toBe(false);
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });

  it("declines the synthetic click after a bare-touch tap, which pointerup already handled", () => {
    // On bare touch the pointerup handler owns the gesture; letting the synthetic
    // click focus as well would pop the keyboard on a deselect tap.
    stubMedia({});
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const output = root.querySelector(".term-output");
    if (!output) {
      throw new Error("no .term-output");
    }
    root
      .querySelector(".term")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    blurTerminal(root);

    clickOn(output);

    expect(focused(root)).toBe(false);
  });

  it("still focuses after a touch tap when a hardware keyboard is present", () => {
    stubMedia({ "(any-pointer: fine)": true });
    const root = rootIn();
    createTerminal(root, { features: () => [] });
    const output = root.querySelector(".term-output");
    if (!output) {
      throw new Error("no .term-output");
    }
    root
      .querySelector(".term")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    blurTerminal(root);

    clickOn(output);

    expect(focused(root)).toBe(true);
  });
});

describe("browse-cache TTL boundaries and the visible/hidden asymmetry", () => {
  const TTL_MS = 5 * 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A terminal with one background store, under FAKE timers.
   *
   *  The timers have to be installed before createTerminal, because the sweep is a
   *  window.setInterval registered during the build: install them afterwards and
   *  advanceTimersByTime never fires it, so every "does not drop" assertion in this
   *  suite would pass without the sweep running at all. */
  async function withBackgroundStore(): Promise<Engine.LineStore> {
    vi.useFakeTimers();
    let captured: TerminalContext | undefined;
    const grabber: TerminalFeature<void> = {
      name: "store-grabber",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [grabber] });
    await vi.advanceTimersByTimeAsync(0);
    const store = captured?.newLineStore("session-bg");
    if (store === undefined) {
      throw new Error("the feature never ran");
    }
    return store;
  }

  it("leaves an EMPTY bound cache alone, however long ago it was read", () => {
    // Nothing to evict. Calling into the store anyway is not free — the drop
    // schedules a reconcile — and it would run on every sweep for the life of the
    // page on a terminal that never paged any history in.
    vi.useFakeTimers();
    createTerminal(rootIn(), { features: () => [] });
    browseCacheSize.mockReturnValue(0);
    lastBrowseActivityMs.mockReturnValue(Date.now() - 60 * 60_000);

    vi.advanceTimersByTime(61_000);

    expect(dropBrowseCache).not.toHaveBeenCalled();
  });

  it("drops at exactly the TTL, not one tick later", () => {
    vi.useFakeTimers();
    createTerminal(rootIn(), { features: () => [] });
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now() + 60_000 - TTL_MS);

    // The sweep runs 60s from now, at which point the cache has been idle for
    // exactly TTL_MS.
    vi.advanceTimersByTime(60_000);

    expect(dropBrowseCache).toHaveBeenCalledTimes(1);
  });

  it("holds one millisecond short of the TTL", () => {
    vi.useFakeTimers();
    createTerminal(rootIn(), { features: () => [] });
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now() + 60_000 - TTL_MS + 1);

    vi.advanceTimersByTime(60_000);

    expect(dropBrowseCache).not.toHaveBeenCalled();
  });

  it("drops UNCONDITIONALLY on a hidden page, where there is no reader to protect", () => {
    // The visible-page drop is conditional inside the store, because a reader
    // parked on cached rows is idle while looking straight at them. A hidden page
    // has no reader, so the same call must not exempt anything.
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as Document["visibilityState"]);
    createTerminal(rootIn(), { features: () => [] });
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now() - TTL_MS - 1);

    vi.advanceTimersByTime(61_000);

    expect(dropBrowseCache).toHaveBeenCalledWith(false);
    visibility.mockRestore();
  });

  it("leaves an empty BACKGROUND cache alone", async () => {
    const background = await withBackgroundStore();
    const bgDrop = vi.spyOn(background, "dropBrowseCache");
    vi.spyOn(background, "browseCacheSize").mockReturnValue(0);
    vi.spyOn(background, "lastBrowseActivityMs").mockReturnValue(Date.now() - 60 * 60_000);
    browseCacheSize.mockReturnValue(0);

    vi.advanceTimersByTime(61_000);

    expect(bgDrop).not.toHaveBeenCalled();
  });

  it("leaves a recently-read BACKGROUND cache alone", async () => {
    // A background tab still has a reader who may come back to exactly these rows,
    // so inactivity is the test there too — not merely "is not the bound store".
    const background = await withBackgroundStore();
    const bgDrop = vi.spyOn(background, "dropBrowseCache");
    vi.spyOn(background, "browseCacheSize").mockReturnValue(900);
    vi.spyOn(background, "lastBrowseActivityMs").mockReturnValue(Date.now());
    browseCacheSize.mockReturnValue(0);

    vi.advanceTimersByTime(61_000);

    expect(bgDrop).not.toHaveBeenCalled();
  });

  it("drops a background cache at exactly the TTL", async () => {
    const background = await withBackgroundStore();
    const bgDrop = vi.spyOn(background, "dropBrowseCache");
    vi.spyOn(background, "browseCacheSize").mockReturnValue(900);
    vi.spyOn(background, "lastBrowseActivityMs").mockReturnValue(Date.now() + 60_000 - TTL_MS);
    browseCacheSize.mockReturnValue(0);

    vi.advanceTimersByTime(60_000);

    expect(bgDrop).toHaveBeenCalledWith(-1, false);
  });

  it("holds a background cache one millisecond short of the TTL", async () => {
    const background = await withBackgroundStore();
    const bgDrop = vi.spyOn(background, "dropBrowseCache");
    vi.spyOn(background, "browseCacheSize").mockReturnValue(900);
    vi.spyOn(background, "lastBrowseActivityMs").mockReturnValue(Date.now() + 60_000 - TTL_MS + 1);
    browseCacheSize.mockReturnValue(0);

    vi.advanceTimersByTime(60_000);

    expect(bgDrop).not.toHaveBeenCalled();
  });

  it("sweeps the BOUND store through the renderer, never directly", async () => {
    // The bound store is the one with a reader, so its drop is conditional and has
    // to go through the layer that knows where that reader is. Reaching it directly
    // from the store list would apply the no-reader rule to the visible tab and
    // delete the rows somebody is looking at.
    const background = await withBackgroundStore();
    const bgDrop = vi.spyOn(background, "dropBrowseCache");
    vi.spyOn(background, "browseCacheSize").mockReturnValue(900);
    vi.spyOn(background, "lastBrowseActivityMs").mockReturnValue(Date.now() - TTL_MS - 1);
    boundStore.mockReturnValue(background); // this store IS the visible tab's
    browseCacheSize.mockReturnValue(1200);
    lastBrowseActivityMs.mockReturnValue(Date.now() - TTL_MS - 1);

    vi.advanceTimersByTime(61_000);

    expect(dropBrowseCache).toHaveBeenCalledWith(true);
    expect(bgDrop).not.toHaveBeenCalled();
  });
});

describe("the loading overlay cannot be resurrected once it is down", () => {
  it("ignores a second dismissal, so no late failure re-fades a lowered overlay", async () => {
    // Two independent paths lower the overlay and they can both run: a session owner
    // that resolves nothing lowers it so its retry chrome is visible, and any later
    // close lowers it again on its way through markReady. Without the one-shot the
    // second one re-arms the fade and the removal timer on an element the consumer
    // may have taken back, which is a spinner reappearing over a working page.
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const owner: TerminalFeature = {
      name: "session-owner",
      sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
      setup() {
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [owner], loading });
    await tick();
    await tick();
    expect(loading.classList.contains("fade")).toBe(true);
    loading.dispatchEvent(new Event("transitionend"));
    expect(loading.isConnected).toBe(false);
    document.body.appendChild(loading); // the consumer re-attached its own element

    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onProcessExit?.(); // a second path that would lower the overlay
    loading.dispatchEvent(new Event("transitionend"));

    expect(loading.isConnected).toBe(true);
  });
});

describe("the recovery surface's accessibility wiring", () => {
  // The one implementation of "Terminal failed to start", shared by the
  // synchronous and asynchronous startup phases. It is a dialog, so it has to name
  // and describe itself, and focus has to land on the only action available.

  function fatalRoot(): HTMLElement {
    const root = rootIn();
    const thrower: TerminalFeature = {
      name: "thrower",
      setup() {
        throw new Error("setup blew up");
      },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createTerminal(root, { features: () => [thrower] });
    logged.mockRestore();
    return root;
  }

  it("labels and describes the dialog from its own title and message", async () => {
    const root = fatalRoot();
    await tick();
    const surface = root.querySelector<HTMLElement>(".wt-fatal");
    if (!surface) {
      throw new Error("no recovery surface");
    }
    const labelId = surface.getAttribute("aria-labelledby");
    const describedId = surface.getAttribute("aria-describedby");

    // Not merely present: the ids have to RESOLVE, or a screen reader announces an
    // unnamed dialog.
    expect(labelId).not.toBeNull();
    expect(describedId).not.toBeNull();
    expect(surface.querySelector(`#${String(labelId)}`)?.textContent).toBe(
      STARTUP_FAILURE_COPY.title,
    );
    expect(surface.querySelector(`#${String(describedId)}`)?.textContent).toBe(
      STARTUP_FAILURE_COPY.message,
    );
  });

  it("moves focus to the reload button, because the terminal input it left is gone", async () => {
    const root = fatalRoot();
    await tick();
    const button = root.querySelector<HTMLButtonElement>(".wt-fatal-reload");
    expect(button).not.toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe("the consumer's loading overlay is always removed, not merely faded", () => {
  // The fade is a transition, and `transitionend` is not guaranteed to fire — a
  // display:none ancestor, a reduced-motion setting, or a browser that drops the
  // event leaves the overlay sitting on top of a working terminal forever. The
  // timeout is the guarantee, and it is the one that actually runs under a test.

  it("removes the overlay from the document after the fade window", async () => {
    vi.useFakeTimers();
    try {
      const loading = document.createElement("div");
      document.body.appendChild(loading);
      createTerminal(rootIn(), { features: () => [], loading });
      await vi.advanceTimersByTimeAsync(0);
      const cbs = connectionInit.mock.calls[0]![0]!;
      cbs.onProcessExit?.(); // any path that lowers the overlay
      expect(loading.classList.contains("fade")).toBe(true);
      expect(loading.isConnected).toBe(true);

      await vi.advanceTimersByTimeAsync(1500);

      expect(loading.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes it on transitionend without waiting for the timeout", async () => {
    vi.useFakeTimers();
    try {
      const loading = document.createElement("div");
      document.body.appendChild(loading);
      createTerminal(rootIn(), { features: () => [], loading });
      await vi.advanceTimersByTimeAsync(0);
      const cbs = connectionInit.mock.calls[0]![0]!;
      cbs.onProcessExit?.();

      loading.dispatchEvent(new Event("transitionend"));

      expect(loading.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lowers the overlay only once, so a second close cannot restart the fade", async () => {
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    createTerminal(rootIn(), { features: () => [], loading });
    await tick();
    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onProcessExit?.();
    loading.dispatchEvent(new Event("transitionend"));
    expect(loading.isConnected).toBe(false);
    document.body.appendChild(loading); // a consumer re-attached it

    cbs.onWireIncompatible?.({
      source: "server-close",
      clientVersion: 4,
      minimumServerVersion: 3,
      reason: "upgrade required",
    });
    loading.dispatchEvent(new Event("transitionend"));

    // Still attached: the second dismissal was a no-op, so no listener and no
    // timer were armed to remove it again.
    expect(loading.isConnected).toBe(true);
  });
});

describe("ctx.loadingReason (progressive status on the consumer's overlay)", () => {
  it("writes the reason into the overlay's status element", async () => {
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "status-probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe], loading });
    await tick();

    captured?.loadingReason("Waiting for the session list");

    // The status lines are built by the kernel's own overlay attachment, so a
    // consumer supplies a bare overlay element and gets both the visible and the
    // announced line.
    expect(loading.querySelector(".wt-loading-text")?.textContent).toBe(
      "Waiting for the session list",
    );
    expect(loading.querySelector(".wt-loading-live")?.textContent).toBe(
      "Waiting for the session list",
    );
  });

  it("is inert once the overlay has been lowered, so a late retry cannot resurrect it", async () => {
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "status-probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    createTerminal(rootIn(), { features: () => [probe], loading });
    await tick();
    captured?.loadingReason("Waiting for the session list");
    const cbs = connectionInit.mock.calls[0]![0]!;
    cbs.onProcessExit?.(); // lowers the overlay, which stops the status

    captured?.loadingReason("too late");

    // stop() detaches both lines, so a late reason has nowhere to land and cannot
    // put text back over a terminal that is already usable.
    expect(loading.querySelector(".wt-loading-text")).toBeNull();
    expect(loading.querySelector(".wt-loading-live")).toBeNull();
  });
});

describe("the switch path (ctx.notifySwitch and the kernel's owned first connect)", () => {
  function withSwitchProbe(): {
    term: TerminalHandle;
    ctx: () => TerminalContext;
    detached: () => number;
    switched: () => { id: string }[];
    busSwitches: () => { id: string }[];
  } {
    let captured: TerminalContext | undefined;
    let detaches = 0;
    const switches: { id: string }[] = [];
    const busSwitches: { id: string }[] = [];
    const probe: TerminalFeature<void> = {
      name: "switch-probe",
      setup(ctx) {
        captured = ctx;
        ctx.on("session:switch", (s) => {
          busSwitches.push(s);
        });
        return {
          teardown: () => undefined,
          onDetach: () => {
            detaches += 1;
          },
          onSwitch: (s) => {
            switches.push(s);
          },
        };
      },
    };
    const term = createTerminal(rootIn(), { features: () => [probe] });
    return {
      term,
      ctx: () => {
        if (captured === undefined) {
          throw new Error("the probe feature never ran");
        }
        return captured;
      },
      detached: () => detaches,
      switched: () => switches,
      busSwitches: () => busSwitches,
    };
  }

  it("detaches, re-points the socket, attaches, and announces — in that order", async () => {
    const probe = withSwitchProbe();
    await tick();

    probe.ctx().notifySwitch({ id: "s2" });

    expect(probe.detached()).toBe(1);
    expect(setSession).toHaveBeenCalledWith("s2");
    expect(probe.switched()).toEqual([{ id: "s2" }]);
    // The bus event is for pure observers, on top of the instance callback.
    expect(probe.busSwitches()).toEqual([{ id: "s2" }]);
  });

  it("clears the textarea across a switch, so half-typed text reaches neither session", async () => {
    const probe = withSwitchProbe();
    await tick();
    const ta = document.querySelector(".term-input") as HTMLTextAreaElement;
    const placeholder = ta.value;
    ta.value = `${placeholder}half-typed`;

    probe.ctx().notifySwitch({ id: "s2" });

    expect(ta.value).toBe(placeholder);
    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("reports the new session as the active one", async () => {
    const probe = withSwitchProbe();
    await tick();
    expect(probe.ctx().session.id).toBeNull();

    probe.ctx().notifySwitch({ id: "s2" });

    expect(probe.ctx().session.id).toBe("s2");
  });

  it("ignores a switch requested after destroy, so a late async cannot reopen the socket", async () => {
    // A feature's un-cancelled create() or poll can resolve after destroy(); without
    // this guard it re-points a torn-down terminal's connection at a session.
    const probe = withSwitchProbe();
    await tick();
    const ctx = probe.ctx();
    probe.term.destroy();
    setSession.mockClear();

    ctx.notifySwitch({ id: "s3" });

    expect(setSession).not.toHaveBeenCalled();
  });
});
