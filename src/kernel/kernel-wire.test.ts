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
// The seam is the fake engine's `createTerminalEngine`: it captures the
// callbacks object the kernel passes, so a test can deliver a frame the way the
// socket would, and its renderer, scroll and connection members are spies. That
// is also the seam a FEATURE test needs to reach the kernel's wire:* events — the
// frame goes in here and comes out on the bus.
//
// The kernel's font-ready path is gated on `document.fonts`, which a real
// browser always provides, so this file installs the shape it wants rather than
// inheriting one. Every test starts from the SETTLED shape (a load that has
// already resolved), because that is the common case and the state most suites
// assume; the suites that care about the not-yet-loaded state install the
// controllable pending shape instead (stubFonts below). Stating it per test
// rather than once in this header is the point: a premise no filename and no
// environment can carry is a premise ~40 tests inherit without declaring it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import type {
  CreateTerminalOptions,
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
} from "./types.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const { resetScrollback, resetScreen, noteResumeBounds, dropBrowseCache, updateFontMetrics } =
  fake.renderer;
const { sendResize, reconnectNow } = fake.connection;

function mount(opts: CreateTerminalOptions): Promise<TerminalHandle> {
  return mountTerminal(rootIn(), opts);
}

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
  // The settled shape, stated rather than inherited: a load that has already
  // resolved, so the kernel's font gate opens on the first microtask after mount
  // instead of depending on what the host environment happens to provide. With a
  // settled `ready` beside it, because a real FontFaceSet has one and the gate's
  // timed-out arm reads it — including for a mount whose deadline outlives its own
  // test, which is every mount in this file.
  restoreFonts = shadowFonts({ load: () => Promise.resolve([]), ready: Promise.resolve() });
});

afterEach(() => {
  restoreFonts();
  restoreFonts = () => undefined;
  vi.useRealTimers();
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Waits out the viewport settle window that every mount opens.
 *
 *  viewport.init() observes the terminal wrap with a ResizeObserver, and a real
 *  one delivers its FIRST observation asynchronously after observe(), so mounting
 *  a terminal always starts a transition. `measurableSize()` declines while one
 *  is in flight, which is a SECOND reason for a null size on top of the fonts
 *  gate — so a fonts assertion that skips this can pass for the viewport's
 *  reason instead of its own. 400ms clears viewport.ts's 350ms settle. The
 *  viewport gate has its own test, on fake timers. */
const viewportSettled = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

/** Advances FAKE timers a settle window at a time until `done()` holds.
 *
 *  A single fixed advance is a race, and it is the kind that wins on a fast
 *  machine and loses on a CI runner: the ResizeObserver behind
 *  viewport.startTransition is REAL, it delivers whenever the browser schedules
 *  it, and every delivery re-arms the 350ms settle timer. An advance that lands
 *  before the last delivery leaves the viewport in transition, and the size then
 *  reads null for the viewport's reason rather than for the test's.
 *
 *  Waiting for the OBSERVABLE asserts the same contract ("it settles, and then
 *  this becomes true") without pinning when the observer happened to fire. The
 *  bound is what keeps a genuine never-settles regression a failure rather than a
 *  hang. Deliberately predicate-based rather than reading viewport.isInTransition:
 *  importing the viewport module here breaks this file's engine mock, which is
 *  hoisted above the imports. */
async function settleUntil(done: () => boolean, windows = 8): Promise<void> {
  for (let i = 0; i < windows; i++) {
    if (done()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(400);
  }
  if (!done()) {
    throw new Error(`condition not reached within ${windows} viewport settle windows`);
  }
}

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

/** Installs `value` as an own `document.fonts` and returns the restore.
 *
 *  `fonts` is an accessor on Document.prototype, so `delete document.fonts` does
 *  not remove it — it drops the own shadow and re-exposes the platform's real
 *  FontFaceSet. The restore therefore has to put back the descriptor that was
 *  actually there, which for the platform's own accessor means removing the
 *  shadow and nothing else. */
function shadowFonts(value: unknown): () => void {
  const saved = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { value, configurable: true, writable: true });
  return () => {
    if (saved) {
      Object.defineProperty(document, "fonts", saved);
    } else {
      Reflect.deleteProperty(document, "fonts");
    }
  };
}

/** Undoes whatever shape the current test installed. Set in beforeEach, before
 *  anything is installed, so it always returns to the platform's own state
 *  regardless of how many times a test re-shaped `document.fonts`. */
let restoreFonts: () => void = () => undefined;

/** Replace the settled default with a load promise this test controls. Returns
 *  the resolver; calling it settles the font load the way a webfont swap does. */
function stubFonts(): () => void {
  let settle = (): void => undefined;
  const pending = new Promise<FontFace[]>((resolve) => {
    settle = () => {
      resolve([]);
    };
  });
  Object.defineProperty(document, "fonts", {
    // `ready` settles WITH the load, as a real FontFaceSet's does: it is pending for
    // as long as the initial load is, and the gate's timed-out arm reads it.
    value: { load: () => pending, ready: pending.then(() => undefined) },
    configurable: true,
    writable: true,
  });
  return settle;
}

/** Replace the settled default with a load that REJECTS over a `ready` this test
 *  controls — the shape a host serving only SOME of the gate's families produces,
 *  since one load() over a comma-separated stack rejects as a unit. Returns the
 *  resolver for `ready`; calling it settles the font set the way the initial load
 *  finishing does, failed faces included, and NOT calling it is the never-settling
 *  `ready` a held-open response produces. */
function stubFontsRejecting(): () => void {
  let settleSet = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    settleSet = () => {
      resolve();
    };
  });
  Object.defineProperty(document, "fonts", {
    value: { load: () => Promise.reject(new Error("network")), ready },
    configurable: true,
    writable: true,
  });
  return settleSet;
}

/** Replace the settled default with a request that STALLS: neither the load nor
 *  `ready` ever settles, which is what a response held open produces when nothing
 *  else rejects. Nothing to return — the point of this shape is that no signal ever
 *  arrives, so only the deadline can open the gate. */
function stubFontsStalled(): void {
  Object.defineProperty(document, "fonts", {
    value: {
      load: () => new Promise<FontFace[]>(() => undefined),
      ready: new Promise<void>(() => undefined),
    },
    configurable: true,
    writable: true,
  });
}

/** Replace the settled default with a load that RESOLVES over a `ready` this test
 *  controls: the healthy path, which has already measured the real metrics by the
 *  time the font set finishes. Returns the resolver for `ready`. */
function stubFontsLoaded(): () => void {
  let settleSet = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    settleSet = () => {
      resolve();
    };
  });
  Object.defineProperty(document, "fonts", {
    value: { load: () => Promise.resolve([]), ready },
    configurable: true,
    writable: true,
  });
  return settleSet;
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

/** The callbacks the kernel handed the engine, as the engine would invoke them. */
function wire(): Engine.ConnectionCallbacks {
  return fake.callbacks();
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
  await mount({ features: () => [probe] });
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
  await mount({ features: () => [watcher] });
  await tick();
  wire().onMessage(screenFrame()); // first frame + settled fonts => loaded
  seen.length = 0;
  return seen;
}

describe("the wire fan-out: a server frame reaches the renderer AND the bus", () => {
  // The engine paints the frame before the kernel sees it; the kernel's half is
  // the bus, where features act on the same frame (tabs' unseen-activity cue, the
  // clipboard feature's OSC 52 handler).

  it("republishes a screen frame on the bus", async () => {
    const { seen } = await withBusProbe();
    const frame = screenFrame(12);

    wire().onMessage(frame);

    expect(seen).toEqual([{ event: "wire:screen", payload: frame }]);
  });

  it("publishes nothing for a scroll frame", async () => {
    // Committed history lines are the renderer's business alone: no feature
    // subscribes, so the kernel deliberately does not fan this one out.
    const { seen } = await withBusProbe();
    const frame = scrollFrame(40);

    wire().onMessage(frame);

    expect(seen).toEqual([]);
  });

  it("republishes a modes frame", async () => {
    const { seen } = await withBusProbe();
    const frame = modesFrame(true);

    wire().onMessage(frame);

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
    await mount({ features: () => [], loading });
    await tick();

    wire().onMessage(screenFrame());

    expect(loading.classList.contains("fade")).toBe(false);
  });

  it("lifts it on the first screen frame once the fonts HAVE settled", async () => {
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    await mount({ features: () => [], loading });
    await tick();
    expect(loading.classList.contains("fade")).toBe(false);

    wire().onMessage(screenFrame());

    expect(loading.classList.contains("fade")).toBe(true);
  });

  it("lifts it when the fonts settle AFTER the first frame has already rendered", async () => {
    const settle = stubFonts();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    await mount({ features: () => [], loading });
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
    await mount({ features: () => [], loading });
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
      // `ready` because the rejection arm falls through to it; a real FontFaceSet
      // always has one, and the shape a test installs has to have it too.
      value: { load: () => Promise.reject(new Error("network")), ready: Promise.resolve() },
      configurable: true,
      writable: true,
    });
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    await mount({ features: () => [], loading });
    await tick();

    wire().onMessage(screenFrame());

    expect(loading.classList.contains("fade")).toBe(true);
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("lifts it at the block period when the load rejects and `ready` NEVER settles", async () => {
    // document.fonts.ready has no deadline: a host whose overlay URL fails while
    // the required family's response is held open leaves it pending for as long as
    // that request lives. Unbounded, the gate never opens, so the overlay covers a
    // terminal that reports no size at all — while the engine, past its own
    // font-display block period, is already painting the fallback the gate is
    // holding out against.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The returned resolver is deliberately never called: THIS is the never-settling
    // `ready`, where the sibling case above settles it.
    stubFontsRejecting();
    vi.useFakeTimers();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    await mount({ features: () => [], loading });
    await vi.advanceTimersByTimeAsync(0);

    wire().onMessage(screenFrame());

    // The frame has landed and the fonts have not, so the overlay stays up for the
    // whole budget rather than lifting on the rejection.
    await vi.advanceTimersByTimeAsync(2999);
    expect(loading.classList.contains("fade")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(loading.classList.contains("fade")).toBe(true);
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("takes the block-period deadline down with a terminal destroyed inside the font wait", async () => {
    // The frame has landed and the fonts are still pending when the consumer
    // tears the terminal down. The deadline that would have opened the gate goes
    // with the pane, so nothing is armed to fade the consumer's overlay later.
    stubFontsStalled();
    vi.useFakeTimers();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const term = await mount({ features: () => [], loading });
    await vi.advanceTimersByTimeAsync(0);
    wire().onMessage(screenFrame());
    await vi.advanceTimersByTimeAsync(1000);

    term.destroy();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(loading.classList.contains("fade")).toBe(false);
  });

  it("ignores fonts that settle after destroy: no overlay fade, no measure, no resize", async () => {
    // The load promise cannot be cancelled, so its continuation is the one font
    // path that still runs on a dead pane; it must find the gate closed.
    const settle = stubFonts();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const term = await mount({ features: () => [], loading });
    await tick();
    wire().onMessage(screenFrame());
    term.destroy();
    sendResize.mockClear();
    updateFontMetrics.mockClear();

    settle();
    await tick();
    await nextFrame();

    expect(loading.classList.contains("fade")).toBe(false);
    expect(updateFontMetrics).not.toHaveBeenCalled();
    expect(sendResize).not.toHaveBeenCalled();
  });

  it("lifts it at the block period when the request STALLS and nothing rejects", async () => {
    // The other half of the same bound, and the half a deadline armed on the
    // rejection cannot reach: with one URL's response held open and no family
    // rejecting, `load` itself never settles, so nothing warns and nothing arrives.
    // Unbounded, the overlay covers a terminal that reports no size at all.
    stubFontsStalled();
    vi.useFakeTimers();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    await mount({ features: () => [], loading });
    await vi.advanceTimersByTimeAsync(0);

    wire().onMessage(screenFrame());

    await vi.advanceTimersByTimeAsync(2999);
    expect(loading.classList.contains("fade")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(loading.classList.contains("fade")).toBe(true);
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
    await mount({ features: () => [probe], loading });
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
    await mount({ features: () => [] });
    await viewportSettled();
    sendResize.mockClear();

    wire().onOpen();

    expect(sendResize).not.toHaveBeenCalled();
  });

  it("announces on open once the fonts have settled", async () => {
    await mount({ features: () => [] });
    await viewportSettled();
    sendResize.mockClear();

    wire().onOpen();

    expect(sendResize).toHaveBeenCalledTimes(1);
  });

  it("announces when the fonts settle after the socket is already open", async () => {
    const settle = stubFonts();
    await mount({ features: () => [] });
    await viewportSettled();
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
    // connection that has not negotiated yet. That font-settle attempt is this
    // test's subject, so it deliberately does NOT wait out the viewport settle:
    // the kernel's viewport-settle arm calls connection.sendResize() without
    // consulting wsOpen, relying on the engine's own `connState.status !==
    // "connected"` early return, which a mocked engine cannot show.
    await mount({ features: () => [] });
    await tick();
    await nextFrame();

    expect(sendResize).not.toHaveBeenCalled();
  });

  it("re-measures the font metrics before reporting a size, rather than trusting cached ones", async () => {
    // The cell metrics are what turn a pixel box into cols and rows. A size
    // computed from metrics measured before the webfont swapped is wrong in
    // exactly the way the fonts gate exists to avoid.
    await mount({ features: () => [] });
    await viewportSettled();
    updateFontMetrics.mockClear();

    const size = wire().initialSize?.();

    expect(updateFontMetrics).toHaveBeenCalled();
    expect(size).toEqual({ cols: 80, rows: 24 });
  });

  it("reports NO size to the resume while the fonts are still loading", async () => {
    stubFonts();
    await mount({ features: () => [] });
    await viewportSettled();

    expect(wire().initialSize?.()).toBeNull();
  });

  it("keeps reporting NO size after the load REJECTS, until the font set itself settles", async () => {
    // One document.fonts.load over a comma-separated stack rejects as a UNIT, so a
    // host missing ONE of the gate's families rejects the whole load — and settling
    // the gate in that handler announces cols computed from the fallback's cell
    // width for every family, including the ones that were served. The rejection
    // arm therefore waits for document.fonts.ready, which settles the initial load
    // including a failed face.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settleFontSet = stubFontsRejecting();
    await mount({ features: () => [] });
    await viewportSettled();

    // Null for the FONTS' reason, not the viewport's: the same call answers a size
    // below without a further wait.
    expect(wire().initialSize?.()).toBeNull();

    settleFontSet();
    await tick();

    expect(wire().initialSize?.()).toEqual({ cols: 80, rows: 24 });
    warned.mockRestore();
  });

  it("announces AGAIN when a font lands after the bound already opened the gate", async () => {
    // The bound trades "never sized" for "sized on fallback metrics", and the swap
    // period is infinite: a companion arriving after it changes the cell width with
    // fontsLoaded already true, and nothing else re-measures until the next viewport
    // transition — so the announced column count would stay wrong for the rest of
    // this geometry.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settleFontSet = stubFontsRejecting();
    vi.useFakeTimers();
    await mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);

    // A size at all means the DEADLINE opened the gate: the load has rejected and
    // the font set is still pending, so nothing else could have.
    await settleUntil(() => wire().initialSize?.() != null, 12);
    sendResize.mockClear();
    updateFontMetrics.mockClear();

    // Nothing between the bound and the bytes announces anything.
    await vi.advanceTimersByTimeAsync(1400);
    expect(sendResize).not.toHaveBeenCalled();

    settleFontSet();
    await vi.advanceTimersByTimeAsync(0);

    expect(sendResize).toHaveBeenCalledTimes(1);
    // Re-measured, not replayed: the cell metrics are the whole reason to announce.
    expect(updateFontMetrics).toHaveBeenCalled();
    warned.mockRestore();
  });

  it("does NOT announce again when the font set settles after a healthy gate", async () => {
    // The corrective announce above belongs to the timed-out arm alone. Here the gate
    // opened on the fonts themselves, so it has already measured the metrics `ready`
    // would report, and a second announce would cost the server a resize for nothing.
    const settleFontSet = stubFontsLoaded();
    await mount({ features: () => [] });
    await viewportSettled();
    expect(wire().initialSize?.()).toEqual({ cols: 80, rows: 24 });
    sendResize.mockClear();

    settleFontSet();
    await tick();

    expect(sendResize).not.toHaveBeenCalled();
  });

  it("reports no size while a viewport transition is in flight, and one once it settles", async () => {
    // An iOS keyboard slide or a rotation makes the intermediate geometry
    // provisional; a size measured mid-slide costs a second resize and a second
    // redraw the moment it stops moving.
    vi.useFakeTimers();
    await mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event("resize"));
    expect(wire().initialSize?.()).toBeNull();

    await settleUntil(() => wire().initialSize?.() != null);
    expect(wire().initialSize?.()).toEqual({ cols: 80, rows: 24 });
  });
});

describe("the decisions the transport cannot make for itself", () => {
  // The engine's transport is store-blind and viewport-blind by design, so each of
  // these forwards a judgement only the renderer can make. Asserting that the
  // callback EXISTS is what let the paging seam ship inert; these call it.

  it("forwards the resume's retained-history bounds to the renderer", async () => {
    await mount({ features: () => [] });
    await tick();

    wire().onResumeBounds?.(900, 400);

    expect(noteResumeBounds).toHaveBeenCalledTimes(1);
    expect(noteResumeBounds).toHaveBeenCalledWith(900, 400);
  });

  it("publishes the cursor move the renderer reports, so chrome can follow it", async () => {
    const { seen } = await withBusProbe();
    const opts = fake.options();

    opts.onCursorMove?.();

    expect(seen).toEqual([{ event: "render:cursor", payload: undefined }]);
  });

  it("publishes the scrolled-up fact the scroll controller reports", async () => {
    // The jump-to-bottom button is a feature, and this is the only thing that tells
    // it to appear.
    const { seen } = await withBusProbe();
    const opts = fake.options();

    opts.onUserScrollChange?.(true);
    opts.onUserScrollChange?.(false);

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
    await mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);
    sendResize.mockClear();

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    // Mid-burst the geometry is in flight, so nothing may go on the wire.
    await vi.advanceTimersByTimeAsync(100);
    expect(sendResize).not.toHaveBeenCalled();

    await settleUntil(() => sendResize.mock.calls.length > 0);

    expect(sendResize).toHaveBeenCalledTimes(1);
  });

  it("announces nothing at the settle when the fonts never loaded", async () => {
    stubFonts();
    vi.useFakeTimers();
    await mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);
    sendResize.mockClear();

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);

    expect(sendResize).not.toHaveBeenCalled();
  });

  it("stops settling after destroy, so a released terminal puts nothing on the wire", async () => {
    vi.useFakeTimers();
    const term = await mount({ features: () => [] });
    await vi.advanceTimersByTimeAsync(0);
    term.destroy();
    sendResize.mockClear();

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(500);

    expect(sendResize).not.toHaveBeenCalled();
  });
});

describe("wake-reconnect handlers", async () => {
  // Each of these opens a socket, so none may fire before the first connect has
  // happened: under a session owner the kernel connects only once
  // resolveInitialSession returns an id, and a bare /ws before then hits a
  // session-gated endpoint that a SessionManager 404s. pageshow fires on the
  // INITIAL load, which is how a slow session list turned into a 404 in Firefox.
  //
  // They live in this file rather than beside the DOM tests because they are
  // document- and window-scoped: they need every earlier terminal torn down, or a
  // leaked listener answers the same event and the count is somebody else's.
  async function ownedTerminal(resolved: Promise<{ id: string } | null>): Promise<void> {
    const owner: TerminalFeature = {
      name: "session-owner",
      sessionOwner: { resolveInitialSession: () => resolved },
      setup() {
        return { teardown: () => undefined };
      },
    };
    await mount({ features: () => [owner] });
  }

  it("reconnects when the page becomes visible again", async () => {
    await mount({ features: () => [] });
    reconnectNow.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("reconnects on pageshow", async () => {
    await mount({ features: () => [] });
    reconnectNow.mockClear();

    window.dispatchEvent(new Event("pageshow"));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("reconnects when the network comes back", async () => {
    await mount({ features: () => [] });
    reconnectNow.mockClear();

    window.dispatchEvent(new Event("online"));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("opens no socket on pageshow before an owned first connect has happened", async () => {
    // The Firefox race: pageshow fires on the initial load, and a session list that
    // has not resolved yet leaves no session id to put on the URL.
    await ownedTerminal(new Promise(() => undefined));
    reconnectNow.mockClear();

    window.dispatchEvent(new Event("pageshow"));

    expect(reconnectNow).not.toHaveBeenCalled();
  });

  it("opens no socket on visibilitychange or online before an owned first connect", async () => {
    await ownedTerminal(new Promise(() => undefined));
    reconnectNow.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));

    expect(reconnectNow).not.toHaveBeenCalled();
  });

  it("reconnects once the owner's session HAS been resolved", async () => {
    await ownedTerminal(Promise.resolve({ id: "s1" }));
    await tick();
    await tick();
    reconnectNow.mockClear();

    window.dispatchEvent(new Event("online"));

    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("stops reconnecting after destroy, so a released terminal cannot reopen a socket", async () => {
    // These listeners live on the document and the window, which outlive the root:
    // a leaked one calls into a disconnected engine every time the reader comes
    // back to the tab.
    const term = await mount({ features: () => [] });
    term.destroy();
    reconnectNow.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));

    expect(reconnectNow).not.toHaveBeenCalled();
  });
});

describe("last-chance cache release, and its teardown", () => {
  it("drops every browse cache on freeze, TTL or no TTL", async () => {
    // A frozen page runs no code at all, so the periodic sweep cannot cover it: its
    // caches would stay resident for the whole freeze and a discard would then throw
    // them away unread.
    await mount({ features: () => [] });
    dropBrowseCache.mockClear();

    document.dispatchEvent(new Event("freeze"));

    expect(dropBrowseCache).toHaveBeenCalledWith(false);
  });

  it("drops nothing on freeze after destroy", async () => {
    const term = await mount({ features: () => [] });
    term.destroy();
    dropBrowseCache.mockClear();

    document.dispatchEvent(new Event("freeze"));

    expect(dropBrowseCache).not.toHaveBeenCalled();
  });

  it("stops the periodic sweep after destroy", async () => {
    vi.useFakeTimers();
    const term = await mount({ features: () => [] });
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
    await mount({ features: () => [watcher] });
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
    await mount({ features: () => [reporter, broken] });
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
    const term = await mount({ features: () => [slow] });

    term.destroy();
    release();
    await tick();
    await tick();

    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
