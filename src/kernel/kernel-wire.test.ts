// @vitest-environment happy-dom
//
// The kernel's ENGINE SEAM: every callback the kernel hands the engine's
// connection/render/scroll modules, driven from the outside.
//
// kernel.test.ts owns the DOM-facing contract (what the built terminal looks
// like, what a keystroke does). This file owns the other direction: a frame or a
// socket event arrives from the engine, and the kernel routes it — to the
// renderer, to the loading lifecycle, to the connection-state machine, and onto
// the feature bus. None of that has a DOM affordance to assert on, and all of it
// is a fan-out where a dropped arm is invisible until a feature goes dark in
// production (which is how the paging seam shipped inert).
//
// The seam is the mocked `connection.init`: it captures the callbacks object the
// kernel passes, so a test can deliver a frame the way the socket would. Same for
// render.init and scroll.init. That is also the seam a FEATURE test needs to reach
// the kernel's wire:* events — the frame goes in here and comes out on the bus.
//
// happy-dom has no `document.fonts`, so the kernel's font-ready path takes its
// synchronous catch and `fontsLoaded` is already true by the time any test runs.
// The suites that care about the not-yet-loaded state install a real-shaped
// `document.fonts` first (stubFonts below); everything else gets the settled
// state, which is the common case anyway.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "./kernel.js";
import type { TerminalContext, TerminalFeature, TerminalHandle } from "./types.js";

const connectionInit = vi.fn<(callbacks: Parameters<typeof Engine.connection.init>[0]) => void>();
const renderInit = vi.fn<(opts: Parameters<typeof Engine.render.init>[0]) => void>();
const scrollInit = vi.fn<(opts: Parameters<typeof Engine.scroll.init>[0]) => void>();
const handleScreen = vi.fn();
const handleScroll = vi.fn();
const updateReverseVideo = vi.fn();
const resetScrollback = vi.fn();
const resetScreen = vi.fn();
const noteResumeBounds = vi.fn();
const maybeFetchHistory = vi.fn();
const sendResize = vi.fn();
const reconnectNow = vi.fn();
const dropBrowseCache = vi.fn();
const currentSessionId = vi.fn<() => string>(() => "session-under-test");
const updateFontMetrics = vi.fn();

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    render: {
      init: renderInit,
      updateFontMetrics,
      setPredictedCursor: vi.fn(),
      computeSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getCursorPx: vi.fn(() => ({ left: 0, top: 0, cellH: 16 })),
      getHighestIndex: vi.fn(() => -1),
      pendingRowCount: vi.fn(() => 0),
      noteResumeBounds,
      handleScreen,
      handleScroll,
      updateReverseVideo,
      resetScrollback,
      resetScreen,
      browseCacheSize: vi.fn(() => 0),
      lastBrowseActivityMs: vi.fn(() => 0),
      dropBrowseCache,
      maybeFetchHistory,
      handleScrollPosition: vi.fn(),
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
      stickToBottom: vi.fn(),
    },
    connection: {
      init: connectionInit,
      connect: vi.fn(),
      sendBinary: vi.fn(() => true),
      sendResize,
      reconnectNow,
      disconnect: vi.fn(),
      setSession: vi.fn(),
      forgetSession: vi.fn(),
      currentSessionId,
    },
  };
});

let createTerminal: (typeof KernelModule)["createTerminal"];
/** Every terminal a test mounted. Destroyed in afterEach, because the kernel's
 *  page-lifecycle and viewport listeners live on `document`/`window` and outlive
 *  the root: a terminal left alive keeps answering `resize` and
 *  `visibilitychange` for the rest of the FILE, and its callbacks reach the same
 *  hoisted engine mocks this file counts calls on. Measured before this existed:
 *  one dispatched `resize` produced 26 `sendResize` calls, one per surviving
 *  terminal. */
const mounted: TerminalHandle[] = [];

function mount(opts: Parameters<typeof KernelModule.createTerminal>[1]): TerminalHandle {
  const term = createTerminal(rootIn(), opts);
  mounted.push(term);
  return term;
}

beforeEach(async () => {
  vi.resetModules();
  connectionInit.mockClear();
  renderInit.mockClear();
  scrollInit.mockClear();
  handleScreen.mockClear();
  handleScroll.mockClear();
  updateReverseVideo.mockClear();
  resetScrollback.mockClear();
  resetScreen.mockClear();
  noteResumeBounds.mockClear();
  maybeFetchHistory.mockClear();
  sendResize.mockClear();
  reconnectNow.mockClear();
  dropBrowseCache.mockClear();
  updateFontMetrics.mockClear();
  currentSessionId.mockReturnValue("session-under-test");
  document.body.replaceChildren();
  ({ createTerminal } = await import("./kernel.js"));
});

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.destroy();
  }
  Reflect.deleteProperty(document, "fonts");
  vi.useRealTimers();
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const nextFrame = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => {
      r();
    });
  });

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

/** Install a `document.fonts` happy-dom does not provide, whose load promise this
 *  test controls. Returns the resolver; calling it settles the font load the way a
 *  webfont swap does. */
function stubFonts(): () => void {
  let settle = (): void => undefined;
  const pending = new Promise<FontFace[]>((resolve) => {
    settle = () => {
      resolve([]);
    };
  });
  Object.defineProperty(document, "fonts", {
    value: { load: () => pending },
    configurable: true,
    writable: true,
  });
  return settle;
}

/** A minimal but VALID screen frame. */
function screenFrame(base = 0): Engine.ScreenMessage {
  return { type: "screen", rows: [[]], base, cursor: [0, 0], changed: [0] };
}

function scrollFrame(firstIndex = 0): Engine.ScrollMessage {
  return { type: "scroll", firstIndex, lines: [[]] };
}

function modesFrame(reverseVideo: boolean): Engine.ModesMessage {
  return {
    type: "modes",
    bracketedPaste: true,
    applicationCursor: false,
    applicationKeypad: false,
    mouseSGR: false,
    focusReporting: false,
    reverseVideo,
    mousePixels: false,
    mouseMode: 0,
    keyboardFlags: 0,
  };
}

/** The callbacks the kernel handed the engine's connection layer. */
function wire(): Parameters<typeof Engine.connection.init>[0] {
  const first = connectionInit.mock.calls[0]?.[0];
  if (first === undefined) {
    throw new Error("the kernel never called connection.init");
  }
  return first;
}

interface BusRecord {
  readonly event: string;
  readonly payload: unknown;
}

/** Build a terminal whose feature subscribes to every kernel event this file
 *  cares about, so a fan-out arm can be observed from where a real feature sits. */
async function withBusProbe(): Promise<{ seen: BusRecord[]; ctx: TerminalContext }> {
  const seen: BusRecord[] = [];
  let captured: TerminalContext | undefined;
  const probe: TerminalFeature<void> = {
    name: "bus-probe",
    setup(ctx) {
      captured = ctx;
      ctx.on("wire:screen", (payload) => {
        seen.push({ event: "wire:screen", payload });
      });
      ctx.on("wire:modes", (payload) => {
        seen.push({ event: "wire:modes", payload });
      });
      ctx.on("wire:clipboard", (payload) => {
        seen.push({ event: "wire:clipboard", payload });
      });
      ctx.on("wire:title", (payload) => {
        seen.push({ event: "wire:title", payload });
      });
      ctx.on("render:cursor", (payload) => {
        seen.push({ event: "render:cursor", payload });
      });
      ctx.on("scroll:state", (payload) => {
        seen.push({ event: "scroll:state", payload });
      });
      return { teardown: () => undefined };
    },
  };
  mount({ features: () => [probe] });
  await tick();
  if (captured === undefined) {
    throw new Error("the probe feature never ran");
  }
  return { seen, ctx: captured };
}

/** A terminal whose feature records every connection state the kernel published,
 *  already past the loading gate.
 *
 *  The gate is load-bearing here: until the first frame lands the machine reports
 *  "open" for every transient state, because the loading overlay owns the screen
 *  and a banner behind it would only flicker. So a lifecycle test that skips the
 *  frame is testing the gate, not the callback. */
async function loadedStateWatcher(): Promise<string[]> {
  const seen: string[] = [];
  const watcher: TerminalFeature<void> = {
    name: "conn-state-watcher",
    setup(ctx) {
      ctx.on("connection:state", (s) => {
        seen.push(s);
      });
      return { teardown: () => undefined };
    },
  };
  mount({ features: () => [watcher] });
  await tick();
  wire().onMessage(screenFrame()); // first frame + settled fonts => loaded
  seen.length = 0;
  return seen;
}

describe("the wire fan-out: a server frame reaches the renderer AND the bus", () => {
  // Every arm here is a two-consumer split, which is why it needs asserting in
  // both directions: the renderer paints the frame, and features act on the same
  // frame through the bus (tabs' unseen-activity cue, the clipboard feature's
  // OSC 52 handler). Dropping either half leaves the other working, so nothing
  // else notices.

  it("gives a screen frame to the renderer and republishes it on the bus", async () => {
    const { seen } = await withBusProbe();
    const frame = screenFrame(12);

    wire().onMessage(frame);

    expect(handleScreen).toHaveBeenCalledTimes(1);
    expect(handleScreen).toHaveBeenCalledWith(frame);
    expect(seen).toEqual([{ event: "wire:screen", payload: frame }]);
  });

  it("gives a scroll frame to the renderer, and publishes nothing", async () => {
    // Committed history lines are the renderer's business alone: no feature
    // subscribes, so the kernel deliberately does not fan this one out.
    const { seen } = await withBusProbe();
    const frame = scrollFrame(40);

    wire().onMessage(frame);

    expect(handleScroll).toHaveBeenCalledTimes(1);
    expect(handleScroll).toHaveBeenCalledWith(frame);
    expect(seen).toEqual([]);
  });

  it("repaints reverse video and republishes a modes frame", async () => {
    const { seen } = await withBusProbe();
    const frame = modesFrame(true);

    wire().onMessage(frame);

    expect(updateReverseVideo).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ event: "wire:modes", payload: frame }]);
  });

  it("republishes an inbound OSC 52 clipboard frame as its text", async () => {
    // The clipboard feature is what writes the system clipboard; with none loaded
    // this is a no-op, so the bus payload is the only observable.
    const { seen } = await withBusProbe();

    wire().onMessage({ type: "clipboard", text: "copied from the pty" });

    expect(seen).toEqual([{ event: "wire:clipboard", payload: "copied from the pty" }]);
  });

  it("publishes a title frame against the ACTIVE session, so a tab knows whose title it is", async () => {
    // The payload's session is what lets a tabs feature label the right tab. With
    // no session owner there is no active session, and the field is empty rather
    // than absent — which is the shape the subscriber destructures.
    const { seen } = await withBusProbe();

    wire().onMessage({ type: "title", title: "vim README.md" });

    expect(seen).toEqual([
      { event: "wire:title", payload: { session: "", title: "vim README.md" } },
    ]);
  });

  it("publishes a BLANK title too, even though the browser title holds its last good value", async () => {
    // The two halves disagree on purpose: document.title must not flicker to the
    // bare attention prefix when a shell clears its window title, but a subscriber
    // still needs to see the clear and apply its own policy. A guard that wrapped
    // the emit as well would silently take that decision away.
    document.title = "Served page";
    const { seen } = await withBusProbe();

    wire().onMessage({ type: "title", title: "   " });

    expect(document.title).toBe("Served page");
    expect(seen).toEqual([
      { event: "wire:title", payload: { session: "   ".trim(), title: "   " } },
    ]);
  });

  it("ignores a frame type it does not handle", async () => {
    const { seen } = await withBusProbe();

    wire().onMessage({ type: "resumeAck", received: 0 });

    expect(handleScreen).not.toHaveBeenCalled();
    expect(handleScroll).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe("first frame + fonts: the overlay lifts only when BOTH have landed", () => {
  // The loading overlay covers a terminal that would otherwise paint at the wrong
  // cell size. Either input can arrive first, so each one re-checks the other, and
  // a version that lifted on whichever came first is exactly the "text reflows
  // under the reader" bug the two flags exist to prevent.

  it("holds the overlay on the first screen frame while the fonts are still loading", async () => {
    stubFonts(); // never settles in this test
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    mount({ features: () => [], loading });
    await tick();

    wire().onMessage(screenFrame());

    expect(loading.classList.contains("fade")).toBe(false);
  });

  it("lifts it on the first screen frame once the fonts HAVE settled", async () => {
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    mount({ features: () => [], loading });
    await tick();
    expect(loading.classList.contains("fade")).toBe(false);

    wire().onMessage(screenFrame());

    expect(loading.classList.contains("fade")).toBe(true);
  });

  it("lifts it when the fonts settle AFTER the first frame has already rendered", async () => {
    const settle = stubFonts();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    mount({ features: () => [], loading });
    await tick();
    wire().onMessage(screenFrame());
    expect(loading.classList.contains("fade")).toBe(false);

    settle();
    await tick();

    expect(loading.classList.contains("fade")).toBe(true);
  });

  it("keeps the overlay up when the fonts settle with no frame rendered yet", async () => {
    // Settled fonts alone are not readiness: there is nothing painted to look at,
    // and lifting here shows the consumer's empty page instead of its spinner.
    const settle = stubFonts();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    mount({ features: () => [], loading });
    await tick();

    settle();
    await tick();

    expect(loading.classList.contains("fade")).toBe(false);
  });

  it("survives a font load that REJECTS, rather than waiting on it forever", async () => {
    // A missing or blocked webfont is a normal deployment state, and the terminal
    // still has to become usable — at the fallback font's metrics.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Object.defineProperty(document, "fonts", {
      value: { load: () => Promise.reject(new Error("network")) },
      configurable: true,
      writable: true,
    });
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    mount({ features: () => [], loading });
    await tick();

    wire().onMessage(screenFrame());

    expect(loading.classList.contains("fade")).toBe(true);
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("marks the page loaded exactly once, so a repaint cannot re-run the lifecycle", async () => {
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    let lowered = 0;
    const probe: TerminalFeature<void> = {
      name: "loading-probe",
      setup(ctx) {
        ctx.on("connection:state", () => undefined);
        return { teardown: () => undefined };
      },
    };
    mount({ features: () => [probe], loading });
    await tick();
    const observer = new MutationObserver(() => {
      lowered += 1;
    });
    observer.observe(loading, { attributes: true, attributeFilter: ["class"] });

    wire().onMessage(screenFrame(0));
    wire().onMessage(screenFrame(1));
    await tick();
    observer.disconnect();

    // One class mutation, not two: markReady is one-shot, so the second frame
    // cannot re-enter the lifecycle and re-arm the fade.
    expect(lowered).toBe(1);
  });
});

describe("socket lifecycle callbacks the state machine depends on", () => {
  // Every one of these is a one-line handler whose only observable is the state it
  // publishes, so a dropped call is invisible until a user stares at a banner that
  // never changes.

  it("reports a full outbox as a disconnection, because that is what it is to a typist", async () => {
    // The socket may still be open, but input is no longer reaching the server, and
    // a terminal that silently swallows keystrokes is worse than one that says it
    // is disconnected.
    const seen = await loadedStateWatcher();
    vi.useFakeTimers();

    wire().onOutboxFull?.();
    await vi.advanceTimersByTimeAsync(700); // past the machine's grace delay

    expect(seen).toContain("reconnecting");
  });

  it("blanks the screen on a server restart, and says so immediately", async () => {
    // The old process's content belongs to a pty that no longer exists; leaving it
    // up would also put a haveThrough on the next resume that claims lines the
    // replacement server never committed. No grace delay: this one is a fact, not
    // a suspicion.
    const seen = await loadedStateWatcher();
    resetScrollback.mockClear();
    resetScreen.mockClear();

    wire().onServerRestart?.();

    expect(resetScrollback).toHaveBeenCalledTimes(1);
    expect(resetScreen).toHaveBeenCalledTimes(1);
    expect(seen).toContain("restarted");
  });

  it("surfaces a reconnect attempt", async () => {
    const seen = await loadedStateWatcher();
    vi.useFakeTimers();

    wire().onConnecting?.();
    await vi.advanceTimersByTimeAsync(700);

    expect(seen).toContain("reconnecting");
  });

  it("clears the reconnecting banner when the socket comes back open", async () => {
    const seen = await loadedStateWatcher();
    vi.useFakeTimers();
    wire().onConnecting?.();
    await vi.advanceTimersByTimeAsync(700);
    expect(seen).toContain("reconnecting");
    seen.length = 0;

    wire().onOpen();

    expect(seen).toEqual(["open"]);
  });
});

describe("the resize announce, and the two things it waits for", () => {
  // The client's geometry has to reach the server BEFORE the resume replay, or the
  // replay comes back at the wrong width and every SIGWINCH-repainting program
  // redraws twice. But announcing an UNTRUSTWORTHY size is worse than waiting:
  // unloaded webfonts mean the cell metrics are wrong, so cols and rows are.

  it("does not announce a size while the fonts are still loading", async () => {
    stubFonts();
    mount({ features: () => [] });
    await tick();
    sendResize.mockClear();

    wire().onOpen();

    expect(sendResize).not.toHaveBeenCalled();
  });

  it("announces on open once the fonts have settled", async () => {
    mount({ features: () => [] });
    await tick();
    sendResize.mockClear();

    wire().onOpen();

    expect(sendResize).toHaveBeenCalledTimes(1);
  });

  it("announces when the fonts settle after the socket is already open", async () => {
    const settle = stubFonts();
    mount({ features: () => [] });
    await tick();
    wire().onOpen();
    sendResize.mockClear();

    settle();
    await tick();
    await nextFrame();

    expect(sendResize).toHaveBeenCalledTimes(1);
  });

  it("does not announce a size before the socket is open, however measurable it is", async () => {
    // The fonts settle during startup and schedule their own attempt; with no
    // socket open it has to decline, or the engine buffers a resize for a
    // connection that has not negotiated yet.
    mount({ features: () => [] });
    await tick();
    await nextFrame();

    expect(sendResize).not.toHaveBeenCalled();
  });

  it("re-measures the font metrics before reporting a size, rather than trusting cached ones", async () => {
    // The cell metrics are what turn a pixel box into cols and rows. A size
    // computed from metrics measured before the webfont swapped is wrong in
    // exactly the way the fonts gate exists to avoid.
    mount({ features: () => [] });
    await tick();
    updateFontMetrics.mockClear();

    const size = wire().initialSize?.();

    expect(updateFontMetrics).toHaveBeenCalled();
    expect(size).toEqual({ cols: 80, rows: 24 });
  });

  it("reports NO size to the resume while the fonts are still loading", async () => {
    stubFonts();
    mount({ features: () => [] });
    await tick();

    expect(wire().initialSize?.()).toBeNull();
  });

  it("reports no size while a viewport transition is in flight, and one once it settles", async () => {
    // An iOS keyboard slide or a rotation makes the intermediate geometry
    // provisional; a size measured mid-slide costs a second resize and a second
    // redraw the moment it stops moving.
    vi.useFakeTimers();
    mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event("resize"));
    expect(wire().initialSize?.()).toBeNull();

    await vi.advanceTimersByTimeAsync(400);
    expect(wire().initialSize?.()).toEqual({ cols: 80, rows: 24 });
  });
});

describe("the decisions the transport cannot make for itself", () => {
  // The engine's transport is store-blind and viewport-blind by design, so each of
  // these forwards a judgement only the renderer can make. Asserting that the
  // callback EXISTS is what let the paging seam ship inert; these call it.

  it("re-runs the full paging trigger when a history request was denied", async () => {
    // Deliberately not a replay of the denied range: by the time the token bucket
    // refills, the gap may have healed or the session may have entered alt.
    mount({ features: () => [] });
    await tick();

    wire().onHistoryRetry?.();

    expect(maybeFetchHistory).toHaveBeenCalledTimes(1);
  });

  it("forwards the resume's retained-history bounds to the renderer", async () => {
    mount({ features: () => [] });
    await tick();

    wire().onResumeBounds?.(900, 400);

    expect(noteResumeBounds).toHaveBeenCalledTimes(1);
    expect(noteResumeBounds).toHaveBeenCalledWith(900, 400);
  });

  it("publishes the cursor move the renderer reports, so chrome can follow it", async () => {
    const { seen } = await withBusProbe();
    const opts = renderInit.mock.calls[0]?.[0];

    opts?.onCursorMove?.();

    expect(seen).toEqual([{ event: "render:cursor", payload: undefined }]);
  });

  it("publishes the scrolled-up fact the scroll controller reports", async () => {
    // The jump-to-bottom button is a feature, and this is the only thing that tells
    // it to appear.
    const { seen } = await withBusProbe();
    const opts = scrollInit.mock.calls[0]?.[0];

    opts?.onUserScrollChange?.(true);
    opts?.onUserScrollChange?.(false);

    expect(seen).toEqual([
      { event: "scroll:state", payload: { scrolledUp: true } },
      { event: "scroll:state", payload: { scrolledUp: false } },
    ]);
  });
});

describe("the settle after a viewport transition", () => {
  // A keyboard slide or a rotation emits a burst of geometry events whose
  // intermediate values are provisional. The settle is the one authoritative
  // moment, and therefore the one resize the whole burst should cost.

  it("announces the settled size once, at the end of the burst", async () => {
    vi.useFakeTimers();
    mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);
    sendResize.mockClear();

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    // Mid-burst the geometry is in flight, so nothing may go on the wire.
    await vi.advanceTimersByTimeAsync(100);
    expect(sendResize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(sendResize).toHaveBeenCalledTimes(1);
  });

  it("announces nothing at the settle when the fonts never loaded", async () => {
    stubFonts();
    vi.useFakeTimers();
    mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);
    sendResize.mockClear();

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);

    expect(sendResize).not.toHaveBeenCalled();
  });

  it("stops settling after destroy, so a released terminal puts nothing on the wire", async () => {
    vi.useFakeTimers();
    const term = mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);
    term.destroy();
    sendResize.mockClear();

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);

    expect(sendResize).not.toHaveBeenCalled();
  });
});

describe("wake-reconnect handlers", () => {
  // Each of these opens a socket, so none may fire before the first connect has
  // happened: under a session owner the kernel connects only once
  // resolveInitialSession returns an id, and a bare /ws before then hits a
  // session-gated endpoint that a SessionManager 404s. pageshow fires on the
  // INITIAL load, which is how a slow session list turned into a 404 in Firefox.
  //
  // They live in this file rather than beside the DOM tests because they are
  // document- and window-scoped: they need every earlier terminal torn down, or a
  // leaked listener answers the same event and the count is somebody else's.
  function ownedTerminal(resolved: Promise<{ id: string } | null>): void {
    const owner: TerminalFeature = {
      name: "session-owner",
      sessionOwner: { resolveInitialSession: () => resolved },
      setup() {
        return { teardown: () => undefined };
      },
    };
    mount({ features: () => [owner] });
  }

  it("reconnects when the page becomes visible again", () => {
    mount({ features: () => [] });
    reconnectNow.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("reconnects on pageshow", () => {
    mount({ features: () => [] });
    reconnectNow.mockClear();

    window.dispatchEvent(new Event("pageshow"));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("reconnects when the network comes back", () => {
    mount({ features: () => [] });
    reconnectNow.mockClear();

    window.dispatchEvent(new Event("online"));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("opens no socket on pageshow before an owned first connect has happened", () => {
    // The Firefox race: pageshow fires on the initial load, and a session list that
    // has not resolved yet leaves no session id to put on the URL.
    ownedTerminal(new Promise(() => undefined));
    reconnectNow.mockClear();

    window.dispatchEvent(new Event("pageshow"));

    expect(reconnectNow).not.toHaveBeenCalled();
  });

  it("opens no socket on visibilitychange or online before an owned first connect", () => {
    ownedTerminal(new Promise(() => undefined));
    reconnectNow.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));

    expect(reconnectNow).not.toHaveBeenCalled();
  });

  it("reconnects once the owner's session HAS been resolved", async () => {
    ownedTerminal(Promise.resolve({ id: "s1" }));
    await tick();
    await tick();
    reconnectNow.mockClear();

    window.dispatchEvent(new Event("online"));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("stops reconnecting after destroy, so a released terminal cannot reopen a socket", () => {
    // These listeners live on the document and the window, which outlive the root:
    // a leaked one calls into a disconnected engine every time the reader comes
    // back to the tab.
    const term = mount({ features: () => [] });
    term.destroy();
    reconnectNow.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));

    expect(reconnectNow).not.toHaveBeenCalled();
  });
});

describe("last-chance cache release, and its teardown", () => {
  it("drops every browse cache on freeze, TTL or no TTL", () => {
    // A frozen page runs no code at all, so the periodic sweep cannot cover it: its
    // caches would stay resident for the whole freeze and a discard would then throw
    // them away unread.
    mount({ features: () => [] });
    dropBrowseCache.mockClear();

    document.dispatchEvent(new Event("freeze"));

    expect(dropBrowseCache).toHaveBeenCalledWith(false);
  });

  it("drops nothing on freeze after destroy", () => {
    const term = mount({ features: () => [] });
    term.destroy();
    dropBrowseCache.mockClear();

    document.dispatchEvent(new Event("freeze"));

    expect(dropBrowseCache).not.toHaveBeenCalled();
  });

  it("stops the periodic sweep after destroy", () => {
    vi.useFakeTimers();
    const term = mount({ features: () => [] });
    term.destroy();
    dropBrowseCache.mockClear();

    vi.advanceTimersByTime(300_000);

    expect(dropBrowseCache).not.toHaveBeenCalled();
  });
});

describe("an ordinary close is a reconnect, not an end", () => {
  it("surfaces a plain socket close as reconnecting", async () => {
    // The engine retries an ordinary close, so the banner has to say so — and it has
    // to WAIT, because a reconnect that lands promptly should show nothing at all.
    // The definitive 4001 close is the one that says "ended"; this one must not.
    const seen: string[] = [];
    const watcher: TerminalFeature<void> = {
      name: "close-watcher",
      setup(ctx) {
        ctx.on("connection:state", (s) => {
          seen.push(s);
        });
        return { teardown: () => undefined };
      },
    };
    mount({ features: () => [watcher] });
    await tick();
    wire().onMessage(screenFrame()); // past the loading gate
    seen.length = 0;
    vi.useFakeTimers();

    wire().onClose();
    expect(seen).not.toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(700);

    expect(seen).toContain("reconnecting");
    expect(seen).not.toContain("ended");
  });
});

describe("a feature whose setup fails, and one whose terminal is destroyed mid-setup", () => {
  it("reports the failure to a host error handler, not only to the console", async () => {
    // The host's onError is how an embedder learns a feature is dead. Logging alone
    // leaves an application with no way to react — and the console is not a channel
    // a product can subscribe to.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();
    const reporter: TerminalFeature<void> = {
      name: "reporter",
      setup(ctx) {
        ctx.onError(onError);
        return { teardown: () => undefined };
      },
    };
    const broken: TerminalFeature = {
      name: "broken",
      setup() {
        throw new Error("setup blew up");
      },
    };
    mount({ features: () => [reporter, broken] });
    await tick();
    await tick();

    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toBe("broken");
    // And the console still carries it, for a consumer with no handler at all.
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("tears down an instance whose setup resolved after destroy, instead of leaking it", async () => {
    // destroy() may land while a feature's setup is still awaiting. cleanupRuntime
    // has already swept the instance list and destroy is one-shot, so pushing the
    // late instance would leave its listeners, timers and observers alive for the
    // life of the page with nothing able to reach them.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const teardown = vi.fn();
    const slow: TerminalFeature<void> = {
      name: "slow-setup",
      async setup() {
        await gate;
        return { teardown };
      },
    };
    const term = mount({ features: () => [slow] });

    term.destroy();
    release();
    await tick();
    await tick();

    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
