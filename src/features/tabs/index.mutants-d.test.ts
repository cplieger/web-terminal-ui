// tabs feature, the wire-driven and reorder-mechanics half: the two kernel
// events the strip subscribes to (`wire:screen` arming the catching-up cue,
// `wire:title` relabelling the active tab from a live OSC 0/2 title), the cue's
// own timer/poll bookkeeping across a re-arm and a teardown, the reorder
// preview's coordinate conversion (scroll offset, scroller rect, offsetParent
// base), and the FLIP's inline-style bookkeeping — which chip is held still,
// which from-state is committed, and who hands the inline styles back.
//
// A separate file from index.test.ts rather than an extension of it, for the
// reason index.mutants-c.test.ts gives: this module's coverage grows from several
// directions at once, and vitest gives each file its own module graph anyway. The
// harness (engine mock, fetch stub, drag helpers) is deliberately duplicated so
// each file stands on its own.
//
// The seam that makes the wire events reachable is `connection.init`: the kernel
// hands the engine a callbacks object, the mock captures it, and `wire()` lets a
// test deliver a frame the way the socket would — the same seam
// kernel-wire.test.ts uses, and the only way into a feature's `ctx.on("wire:*")`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";
// The reorder timings, imported rather than restated, for the reason
// index.test.ts gives: these tests pin the SHAPE of the interaction, not the
// numbers, so a deliberate retune moves one definition and not a dozen magic
// numbers in a test file.
import {
  REORDER_MOVE_EPS_PX,
  REORDER_REST_MS,
  REORDER_SETTLE_MS,
  REORDER_SLOT_FADE_MS,
  REORDER_STILL_MS,
} from "./strip.js";

// The queued-row depth past which a frame arms the catching-up cue, and the
// anti-flicker delay before it appears. Restated rather than imported because
// they are module-private to index.ts; index.test.ts's cue suite restates them
// the same way.
const CATCHUP_MIN_BACKLOG = 400;
const CATCHUP_ARM_DELAY_MS = 150;

const setSession = vi.fn<(id: string) => void>();
const forgetSession = vi.fn<(id: string) => void>();
const bind = vi.fn();
// A DISTINCT view per call, never one constant: a double answering the same
// object for every tab passes just as well when the wrong tab's position comes
// back (index.mutants-c.test.ts's note).
let viewSeq = 0;
const captureViewMemory = vi.fn(() => ({ abs: 100 + ++viewSeq, screenTop: -3, following: false }));
const pendingRowCount = vi.fn(() => 0);
const getHighestIndex = vi.fn(() => -1);
// The callbacks object the kernel hands the engine's connection layer: the seam
// a server frame comes in through.
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
      getHighestIndex,
      pendingRowCount,
      noteResumeBounds: vi.fn(),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      handleScrollPosition: vi.fn(),
      updateReverseVideo: vi.fn(),
      resetScrollback: vi.fn(),
      resetScreen: vi.fn(),
      browseCacheSize: vi.fn(() => 0),
      lastBrowseActivityMs: vi.fn(() => 0),
      dropBrowseCache: vi.fn(),
      maybeFetchHistory: vi.fn(),
      replayMaxForResume: vi.fn(() => 1500),
      handleHistoryReply: vi.fn(),
      applyResumeTransition: vi.fn(),
      noteSolicited: vi.fn(),
      clearSolicited: vi.fn(),
      bind,
      captureViewMemory,
      boundStore: vi.fn(() => ({ getWindow: () => ({ base: 0 }) })),
    },
    scroll: {
      init: vi.fn(),
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
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect: vi.fn(),
      setSession,
      forgetSession,
      serverEpochOf: vi.fn(() => 777),
      adoptPersistedEpoch: vi.fn(),
      currentSessionId: vi.fn(() => "unmanaged"),
      historyBudget: vi.fn(() => 0),
      requestHistory: vi.fn(),
    },
  };
});

let createTerminal: (typeof KernelModule)["createTerminal"];
let tabs: (typeof TabsModule)["tabs"];
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let listBody: unknown[];
let spawnSeq = 0;
const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "POST") {
    spawnSeq++;
    return Promise.resolve(
      jsonResponse(
        {
          id: `s-new${String(spawnSeq)}`,
          title: "",
          createdAt: String(20 + spawnSeq),
          status: "idle",
        },
        201,
      ),
    );
  }
  if (method === "DELETE" || method === "PUT") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  return Promise.resolve(jsonResponse(listBody, 200));
});

beforeEach(async () => {
  vi.resetModules();
  setSession.mockClear();
  forgetSession.mockClear();
  bind.mockClear();
  connectionInit.mockClear();
  pendingRowCount.mockReturnValue(0);
  getHighestIndex.mockReturnValue(-1);
  fetchMock.mockClear();
  spawnSeq = 0;
  viewSeq = 0;
  captureViewMemory.mockClear();
  listBody = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
  ];
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
  localStorage.clear();
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

afterEach(() => {
  vi.useRealTimers();
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
});

async function until(pred: () => boolean, tries = 30): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** The callbacks the kernel handed the engine's connection layer. */
function wire(): Parameters<typeof Engine.connection.init>[0] {
  const first = connectionInit.mock.calls[0]?.[0];
  if (first === undefined) {
    throw new Error("the kernel never called connection.init");
  }
  return first;
}

function screenFrame(base = 0): Engine.ScreenMessage {
  return { type: "screen", rows: [[]], base, cursor: [0, 0], changed: [0] };
}

function titleFrame(title: string): Engine.TitleMessage {
  return { type: "title", title };
}

function pick(root: HTMLElement, sel: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) {
    throw new Error(`no ${sel}`);
  }
  return el;
}

function threeSessions(): void {
  listBody = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
    { id: "s3", title: "three", createdAt: "3", status: "idle" },
  ];
}

// --- wire:screen: any frame can reveal a backlog worth a cue -----------------
//
// Arming off the backlog ITSELF is what makes the cue fire on a wake or a large
// burst rather than only on an explicit tab switch. The threshold is what keeps
// ordinary streaming out of it — and the source states the consequence as a
// contract: "the completion poll only exists while there is something to
// complete", so a frame under the threshold must leave no rAF loop behind.

interface FrameHarness {
  root: HTMLElement;
  catchupEl: HTMLElement;
  visible: () => boolean;
  pendingFrames: () => number;
  tick: (ms: number) => void;
}

/** Two tabs, a manual rAF pump and a frozen clock, mounted with nothing owed so
 *  the BOOTSTRAP switch does not arm the cue: a cached highest index means the
 *  tab has content and an empty queue means nothing is pending, which is the one
 *  combination switchTo's own arm condition rejects. One priming frame goes in
 *  before the rAF stub so the kernel's first-frame work (which schedules its own
 *  frame) cannot be mistaken for the cue's completion poll. Every frame the tests
 *  below count is therefore one the cue asked for. */
async function mountFrames(): Promise<FrameHarness> {
  getHighestIndex.mockReturnValue(0);
  pendingRowCount.mockReturnValue(0);
  const root = document.createElement("div");
  document.body.appendChild(root);
  term = createTerminal(root, { features: () => [tabs()] });
  await until(() => root.querySelectorAll(".wt-tab").length === listBody.length);
  wire().onMessage(screenFrame()); // priming: nothing queued, so nothing arms
  let nextHandle = 1;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    const h = nextHandle++;
    frames.set(h, cb);
    return h;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number): void => {
    frames.delete(h);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return {
    root,
    catchupEl: pick(root, ".wt-catchup"),
    visible: () => root.querySelector(".wt-catchup")?.classList.contains("visible") === true,
    pendingFrames: () => frames.size,
    tick: (ms) => {
      vi.advanceTimersByTime(ms);
    },
  };
}

describe("tabs: a frame that reveals a backlog", () => {
  it("arms the catching-up cue on a frame whose queue is past the threshold", async () => {
    // The cue used to be armed only by an explicit tab switch, so the deepest
    // backlog the app ever builds — a resume replay after a wake — was exactly
    // the case it was blind to.
    const h = await mountFrames();
    pendingRowCount.mockReturnValue(CATCHUP_MIN_BACKLOG + 1);

    wire().onMessage(screenFrame());

    expect(h.visible()).toBe(false); // the delay is anti-flicker, so not yet
    h.tick(CATCHUP_ARM_DELAY_MS);
    expect(h.visible()).toBe(true);
  });

  it("stays silent at the threshold itself, and starts no completion poll there", async () => {
    // Exactly at the threshold is NOT past it: the renderer builds a few hundred
    // rows a frame, so a queue this size costs the user nothing to wait for.
    const h = await mountFrames();
    pendingRowCount.mockReturnValue(CATCHUP_MIN_BACKLOG);

    wire().onMessage(screenFrame());

    h.tick(CATCHUP_ARM_DELAY_MS);
    expect(h.visible()).toBe(false);
    expect(h.pendingFrames()).toBe(0);
  });

  it("leaves no completion poll behind for a frame with nothing queued", async () => {
    // Ordinary streaming delivers frames continuously, and the poll is an rAF
    // loop that re-arms itself, so a cue armed by every frame would leave a
    // permanent per-frame loop running for a queue never deep enough to mention.
    const h = await mountFrames();
    pendingRowCount.mockReturnValue(0);

    wire().onMessage(screenFrame());

    expect(h.pendingFrames()).toBe(0);
    h.tick(CATCHUP_ARM_DELAY_MS);
    expect(h.visible()).toBe(false);
  });

  it("keeps one completion poll however many frames arm the cue", async () => {
    // pollCatchup re-arms itself, so a second loop started by a second arm never
    // stops being a second loop: the per-frame cost doubles and clearCatchup can
    // only cancel the one handle it knows about.
    const h = await mountFrames();
    pendingRowCount.mockReturnValue(CATCHUP_MIN_BACKLOG + 1);
    wire().onMessage(screenFrame());
    expect(h.pendingFrames()).toBe(1);

    h.tick(10);
    wire().onMessage(screenFrame());

    expect(h.pendingFrames()).toBe(1);
  });

  it("does not stack a second anti-flicker timer while one is already pending", async () => {
    // A stacked timer is invisible while it agrees with the one that replaced it,
    // and shows up at teardown: clearCatchup can only clear the handle
    // `catchupTimer` currently holds, so the earlier one outlives the feature and
    // paints a cue onto chrome already torn off the page.
    const h = await mountFrames();
    pendingRowCount.mockReturnValue(CATCHUP_MIN_BACKLOG + 1);
    wire().onMessage(screenFrame()); // arms; its timer is pending
    h.tick(100);

    wire().onMessage(screenFrame()); // must re-use the pending timer, not add one

    const cue = h.catchupEl;
    term?.destroy();
    term = undefined;
    h.tick(CATCHUP_ARM_DELAY_MS);

    expect(cue.classList.contains("visible")).toBe(false);
  });

  it("stops the pending cue timer and the completion poll when the terminal is destroyed", async () => {
    // Both are live mechanisms the feature owns: a timer that fires after
    // teardown writes to chrome nobody is looking at, and an rAF loop that
    // survives teardown re-arms itself for the life of the page.
    const h = await mountFrames();
    pendingRowCount.mockReturnValue(CATCHUP_MIN_BACKLOG + 1);
    wire().onMessage(screenFrame());
    expect(h.pendingFrames()).toBe(1);
    const cue = h.catchupEl;

    term?.destroy();
    term = undefined;

    expect(h.pendingFrames()).toBe(0);
    h.tick(CATCHUP_ARM_DELAY_MS);
    expect(cue.classList.contains("visible")).toBe(false);
  });
});

// --- wire:title: the live OSC 0/2 title of the ACTIVE session ---------------

interface TitleHarness {
  labels: () => string[];
}

/** Three tabs with the SECOND one active. Deliberately not the first: the kernel
 *  republishes a title frame under the ACTIVE session's id, so a lookup that
 *  ignored the id entirely would still land on the right tab if the right tab
 *  were tabList[0]. */
async function mountTitles(): Promise<TitleHarness> {
  threeSessions();
  const root = document.createElement("div");
  document.body.appendChild(root);
  term = createTerminal(root, { features: () => [tabs()] });
  await until(() => root.querySelectorAll(".wt-tab").length === 3);
  root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();
  await until(() => setSession.mock.calls.some((c) => c[0] === "s2"));
  return {
    labels: () =>
      [...pick(root, ".wt-tab-scroll").querySelectorAll<HTMLElement>(".wt-tab-label")].map(
        (e) => e.textContent ?? "",
      ),
  };
}

describe("tabs: live window-title updates", () => {
  it("relabels the active tab, and only it, from a live OSC title", async () => {
    // The engine sends a TITLE frame on the live socket when the process changes
    // its title, so the label follows at once instead of waiting for the next
    // status sweep. Background tabs have no live socket and keep their labels.
    const h = await mountTitles();

    wire().onMessage(titleFrame("vim README.md"));

    expect(h.labels()).toEqual(["one", "vim README.md", "three"]);
  });

  it("keeps the last good label when the process clears its title", async () => {
    // A shell emits an empty OSC 0/2 when it redraws its prompt after idling.
    // Reverting to "New tab" on that would make an idle tab lose its name.
    const h = await mountTitles();

    wire().onMessage(titleFrame(""));

    expect(h.labels()).toEqual(["one", "two", "three"]);
  });

  it("treats a whitespace-only title as a clear, not as a new label", async () => {
    // The same clear, padded. A label of spaces is worse than a stale one: it
    // reads as an unnamed tab while carrying no name left to recover.
    const h = await mountTitles();

    wire().onMessage(titleFrame("   "));

    expect(h.labels()).toEqual(["one", "two", "three"]);
  });
});

// --- what a switch says out loud --------------------------------------------

describe("tabs: a switch announces where it landed", () => {
  it("names the tab a switch moved to", async () => {
    // The strip is a visual affordance; without this a switch is silent to anyone
    // who cannot see which chip went active.
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();
    vi.advanceTimersByTime(150);

    expect(root.querySelector('[aria-live="polite"]')?.textContent).toBe("Switched to two");
  });
});

// --- the swipe with nowhere to go -------------------------------------------

describe("tabs: the mobile swipe on a lone tab", () => {
  it("leaves the keyboard where it is when there is no other tab to reach", async () => {
    // One tab has nothing to switch to, so the gesture is not a switch at all and
    // must not run the focus rule a real switch owes. Moving the keyboard onto the
    // terminal here steals it from whatever chrome control the user was on.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        // A fine pointer means a physical keyboard is likely, which is the
        // condition under which a switch focuses the terminal input. Stubbed so
        // the focus rule is ARMED: a test where it could never fire proves
        // nothing about the gate that keeps it from firing.
        matches: query === "(any-pointer: fine)",
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    listBody = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    const plus = pick(root, ".wt-tab-new");
    plus.focus();
    expect(document.activeElement).toBe(plus);

    const cur = pick(root, ".wt-switcher-current");
    cur.dispatchEvent(new MouseEvent("pointerdown", { clientX: 220, clientY: 10, bubbles: true }));
    cur.dispatchEvent(new MouseEvent("pointerup", { clientX: 90, clientY: 12, bubbles: true }));

    expect(document.activeElement).toBe(plus);
  });
});

// --- the reorder preview ----------------------------------------------------
//
// No stylesheet is loaded, so the geometry a test reasons about is declared
// explicitly — and WHICH geometry matters: the hit test reads LAYOUT offsets
// (offsetLeft/offsetWidth, plus the scroller's own offsetLeft as the base) while
// the FLIP reads visual RECTS. The two helpers below declare them separately for
// that reason. A test that declares neither is aiming at whatever the default font
// laid the chips out as, which is nobody's chosen target.

interface FakeDataTransfer {
  effectAllowed: string;
  dropEffect: string;
  data: Record<string, string>;
  image: Element | null;
  setData(type: string, value: string): void;
  setDragImage(node: Element, x: number, y: number): void;
}
function fakeDataTransfer(): FakeDataTransfer {
  return {
    effectAllowed: "",
    dropEffect: "",
    data: {},
    image: null,
    setData(type, value) {
      this.data[type] = value;
    },
    setDragImage(node) {
      this.image = node;
    },
  };
}
function dragAt(type: string, dt: FakeDataTransfer, clientX: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dt });
  Object.defineProperty(e, "clientX", { value: clientX });
  Object.defineProperty(e, "clientY", { value: 0 });
  return e;
}
function dragEvent(type: string, dt: FakeDataTransfer): Event {
  return dragAt(type, dt, 0);
}

/** The strip's labels in DOM order. Scoped to the scroller, which holds ONLY
 *  tabs: a drag ghost is a chip clone parked under .wt-root until the next frame,
 *  so a root-wide query counts the dragged tab twice. */
function idsOf(root: HTMLElement): string[] {
  return [
    ...(root.querySelector(".wt-tab-scroll")?.querySelectorAll<HTMLElement>(".wt-tab-label") ?? []),
  ].map((e) => e.textContent ?? "");
}

// A real browser returns "" for a `translate` that was never set and for one that
// was cleared, so "no displacement" is one value. The `?? ""` and the cast are kept
// because lib.dom types this as a plain string while the property is newer than
// some engines the library supports.
function translateOf(el: HTMLElement): string {
  return (el.style.translate as string | undefined) ?? "";
}

function flatRect(left = 0, width = 0): DOMRect {
  return {
    left,
    right: left + width,
    width,
    x: left,
    y: 0,
    top: 0,
    bottom: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubReducedMotion(on: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: on && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

interface DragHarness {
  root: HTMLElement;
  bar: HTMLElement;
  scroller: HTMLElement;
  dt: FakeDataTransfer;
  chips: () => HTMLElement[];
  chip: (label: string) => HTMLElement;
  live: () => string;
  ids: () => string[];
  sweepTo: (x: number) => void;
  stubLayout: (opts?: { base?: number; rectLeft?: number; scrollLeft?: number }) => void;
  stubRects: () => void;
}

async function mountDrag(
  count: number,
  opts: { reducedMotion?: boolean } = {},
): Promise<DragHarness> {
  if (opts.reducedMotion === true) {
    // prefersReduce() is read live on every use, so one stub covers the drag.
    stubReducedMotion(true);
  }
  listBody = ["one", "two", "three", "four"]
    .slice(0, count)
    .map((title, i) => ({ id: `s${String(i + 1)}`, title, createdAt: String(i + 1) }));
  const root = document.createElement("div");
  document.body.appendChild(root);
  const feature = tabs();
  term = createTerminal(root, { features: () => [feature] });
  await until(() => root.querySelectorAll(".wt-tab").length === count);
  const bar = pick(root, ".wt-tab-bar");
  const scroller = pick(root, ".wt-tab-scroll");
  // Scoped to the scroller for the same reason idsOf is: the drag ghost is a
  // `.wt-tab` clone living outside it, and it is still there for the whole
  // synchronous body of a test (the rAF that clears it never runs).
  const chips = (): HTMLElement[] => [...scroller.querySelectorAll<HTMLElement>(".wt-tab")];
  const dt = fakeDataTransfer();
  // Only the timers, and only AFTER the async mount: until() drives itself on
  // setTimeout, and the status poll is a setInterval that must keep running on
  // the real clock. Date is faked with them because rest detection compares
  // Date.now() against the last movement, so the clock the assertions advance
  // has to be the clock the feature reads.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return {
    root,
    bar,
    scroller,
    dt,
    chips,
    chip: (label) => {
      const found = chips().find((c) => c.querySelector(".wt-tab-label")?.textContent === label);
      if (!found) {
        throw new Error(`no chip labelled ${label}`);
      }
      return found;
    },
    live: () => root.querySelector('[aria-live="polite"]')?.textContent ?? "",
    // The feature's OWN order, which is what a drop commits. Deliberately not
    // localStorage: where an arrangement is persisted is a separate concern.
    ids: () => feature.api?.list().map((t) => t.id) ?? [],
    // One dragover at a given x. A NEW x says "still moving"; repeating the last
    // one says "stopped", which is the distinction the whole preview turns on.
    sweepTo: (x: number) => {
      bar.dispatchEvent(dragAt("dragover", dt, x));
    },
    // Real LAYOUT geometry (what dropTargetBefore reads) so a test can aim at a
    // specific slot, plus the coordinate frame the conversion has to undo: the
    // scroller's offsetLeft (the base every chip offset carries), its client rect
    // (what clientX is relative to) and its scrollLeft (what offsets ignore).
    // With all three at zero every spelling of that conversion agrees, which is
    // why the tests below set them.
    stubLayout: (o = {}) => {
      const base = o.base ?? 0;
      Object.defineProperty(scroller, "offsetLeft", { value: base, configurable: true });
      // Declared, not assigned: the scroller has nothing overflowing it in a bare
      // test document, so a real browser clamps `scroller.scrollLeft = 100` back to
      // 0 and the conversion under test reads the wrong term. It is an INPUT here.
      Object.defineProperty(scroller, "scrollLeft", {
        value: o.scrollLeft ?? 0,
        configurable: true,
      });
      const rectLeft = o.rectLeft ?? 0;
      scroller.getBoundingClientRect = (): DOMRect => flatRect(rectLeft);
      chips().forEach((chipEl, i) => {
        Object.defineProperty(chipEl, "offsetLeft", { value: base + i * 100, configurable: true });
        Object.defineProperty(chipEl, "offsetWidth", { value: 100, configurable: true });
      });
    },
    // Real VISUAL geometry, derived from the LIVE DOM index so a reorder changes
    // what a chip reports. Without this the FLIP finds every delta zero and
    // returns before writing a style, which silently makes any assertion about
    // the slide vacuous.
    stubRects: () => {
      for (const chipEl of chips()) {
        chipEl.getBoundingClientRect = (): DOMRect => flatRect(chips().indexOf(chipEl) * 100, 100);
      }
    },
  };
}

/** Sweep to x, wait out the stillness confirmation, and deliver the stationary
 *  dragover that opens the slot: the positive-evidence path, which is the one
 *  that normally decides. Costs REORDER_STILL_MS of the fake clock. */
function restAt(h: DragHarness, x: number): void {
  h.sweepTo(x);
  vi.advanceTimersByTime(REORDER_STILL_MS);
  h.sweepTo(x);
}

describe("tabs reorder: the hit test's coordinate space", () => {
  // Chips share the scroller's offsetParent and layout offsets ignore scrolling,
  // so a clientX has to be converted into the space the offsets live in: minus
  // the scroller's client rect, plus its scrollLeft, and each chip's offset minus
  // the scroller's own. Each case below moves ONE of those three terms, because
  // with all of them at zero every spelling of the conversion gives the same
  // answer.

  it("hit-tests a scrolled strip against the chips' unscrolled layout offsets", async () => {
    const h = await mountDrag(4);
    h.stubLayout({ scrollLeft: 100 });
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));

    // clientX 120 on a strip scrolled 100px right is layout x 220: past "two"'s
    // midpoint (150) and short of "three"'s (250).
    restAt(h, 120);

    expect(idsOf(h.root)).toEqual(["one", "two", "four", "three"]);
  });

  it("hit-tests against a scroller that does not start at the viewport edge", async () => {
    const h = await mountDrag(4);
    h.stubLayout({ rectLeft: 100 });
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));

    // The strip starts 100px in, so clientX 120 is only 20px into it: left of
    // every midpoint, so the tab lands at the head.
    restAt(h, 120);

    expect(idsOf(h.root)).toEqual(["four", "one", "two", "three"]);
  });

  it("measures each chip's midpoint inside the scroller, not inside the offsetParent", async () => {
    const h = await mountDrag(4);
    // The scroller is itself offset inside the shared offsetParent, so every
    // chip's offsetLeft carries that base and it has to come back off.
    h.stubLayout({ base: 100 });
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));

    restAt(h, 200);

    expect(idsOf(h.root)).toEqual(["one", "two", "four", "three"]);
  });
});

describe("tabs reorder: rest detection", () => {
  it("treats a move of exactly the movement epsilon as stillness", async () => {
    // The epsilon is a tremor filter, and its boundary is what a hand resting on
    // a mouse actually produces: at the epsilon itself the pointer has NOT moved,
    // so the stop still counts and the slot opens.
    const h = await mountDrag(3);
    // stubLayout as well as stubRects: the hit test reads LAYOUT offsets
    // (offsetLeft/offsetWidth), which a real browser answers for real. Left
    // unstubbed, three chips of text width put every midpoint somewhere the test
    // never chose, and the sweep below lands in whichever slot that happens to be.
    // With the layout declared, x past the last midpoint (250 for chips of 100 at
    // 0/100/200) is what sends the dragged chip to the end.
    h.stubLayout();
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(260);
    vi.advanceTimersByTime(REORDER_STILL_MS);

    h.sweepTo(260 + REORDER_MOVE_EPS_PX);

    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);
  });
});

describe("tabs reorder: the slide", () => {
  it("holds the dragged chip still while its neighbours slide", async () => {
    // The dragged chip IS the slot, and the pointer already carries a solid copy
    // of it. A hole travelling across the strip alongside that copy is two things
    // moving at once.
    const h = await mountDrag(3);
    // stubLayout as well as stubRects: the hit test reads LAYOUT offsets
    // (offsetLeft/offsetWidth), which a real browser answers for real. Left
    // unstubbed, three chips of text width put every midpoint somewhere the test
    // never chose, and the sweep below lands in whichever slot that happens to be.
    // With the layout declared, x past the last midpoint (250 for chips of 100 at
    // 0/100/200) is what sends the dragged chip to the end.
    h.stubLayout();
    h.stubRects();
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(260);
    vi.advanceTimersByTime(REORDER_REST_MS);
    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);

    // The slide is really running, and the held chip is not part of it.
    const sliding = h.chips().filter((c) => c.style.transition !== "");
    expect(sliding.length).toBeGreaterThan(0);
    expect(sliding).not.toContain(dragged);
    expect(translateOf(h.chip("one"))).toBe("");
    expect(h.chip("one").style.transition).toBe("");
  });

  it("commits the from-state with a layout read before writing the to-state", async () => {
    // The from-state is what the transition runs FROM, and without a read between
    // the two writes the browser is free to collapse them into one recalc and
    // animate nothing at all. So the observable is the read itself: the scroller's
    // rect is measured with the displacements in place.
    const h = await mountDrag(3);
    // stubLayout as well as stubRects: the hit test reads LAYOUT offsets
    // (offsetLeft/offsetWidth), which a real browser answers for real. Left
    // unstubbed, three chips of text width put every midpoint somewhere the test
    // never chose, and the sweep below lands in whichever slot that happens to be.
    // With the layout declared, x past the last midpoint (250 for chips of 100 at
    // 0/100/200) is what sends the dragged chip to the end.
    h.stubLayout(); // before the rect override below, which stubLayout also sets
    h.stubRects();
    const seen: string[][] = [];
    h.scroller.getBoundingClientRect = (): DOMRect => {
      seen.push(h.chips().map(translateOf));
      return flatRect();
    };
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));

    h.sweepTo(260);
    vi.advanceTimersByTime(REORDER_REST_MS);

    // "one" goes to the end, so "two" and "three" each slide 100px left and are
    // inverted 100px right to start from where they were. "one" is held.
    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);
    expect(seen).toContainEqual(["100px", "100px", ""]);
  });

  it("displaces only the chips that actually moved", async () => {
    // A chip whose position did not change has nothing to animate, and an inline
    // transition on it is a promise something then has to hand back.
    const h = await mountDrag(4);
    h.stubLayout();
    h.stubRects();
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));

    restAt(h, 210); // into the slot before "three"

    expect(idsOf(h.root)).toEqual(["one", "two", "four", "three"]);
    expect(h.chip("three").style.transition).toContain("translate");
    for (const label of ["one", "two"]) {
      expect(h.chip(label).style.transition).toBe("");
      expect(translateOf(h.chip(label))).toBe("");
    }
  });

  it("hands back the chips the previous slide displaced before measuring a new one", async () => {
    // Both stages of a slide write the same two inline properties, so a chip the
    // NEXT slide does not touch keeps whatever the last one left on it unless the
    // new one clears the board first.
    const h = await mountDrag(4);
    h.stubLayout();
    h.stubRects();
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));
    restAt(h, 210); // slide 1 displaces "three"
    expect(h.chip("three").style.transition).toContain("translate");

    h.stubLayout(); // re-measure: the DOM order changed
    restAt(h, 110); // slide 2 displaces "two" only

    expect(idsOf(h.root)).toEqual(["one", "four", "two", "three"]);
    expect(h.chip("two").style.transition).toContain("translate");
    expect(translateOf(h.chip("three"))).toBe("");
    expect(h.chip("three").style.transition).toBe("");
  });

  it("drops the previous slide's settle timer when a new slide starts", async () => {
    // The settle timer hands every displaced chip back to the stylesheet. Left
    // armed, the OLD one fires in the middle of the NEW slide and cuts it short.
    const h = await mountDrag(4);
    h.stubLayout();
    h.stubRects();
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));
    restAt(h, 210); // slide 1

    h.stubLayout();
    restAt(h, 110); // slide 2, REORDER_STILL_MS after slide 1
    vi.advanceTimersByTime(REORDER_SETTLE_MS - REORDER_STILL_MS + 10);

    // Slide 1's settle moment has passed; slide 2 is still running.
    expect(h.chip("two").style.transition).toContain("translate");
    vi.advanceTimersByTime(REORDER_SETTLE_MS);
    expect(h.chip("two").style.transition).toBe("");
    expect(translateOf(h.chip("two"))).toBe("");
  });

  it("rearranges under reduced motion and animates none of it", async () => {
    // The lean and the slide are INLINE transitions, so no stylesheet gate can
    // reach them. Motion is what the user opted out of, not the feature — with
    // real geometry in place the reorder must still happen and still write
    // nothing.
    const h = await mountDrag(3, { reducedMotion: true });
    // stubLayout as well as stubRects: the hit test reads LAYOUT offsets
    // (offsetLeft/offsetWidth), which a real browser answers for real. Left
    // unstubbed, three chips of text width put every midpoint somewhere the test
    // never chose, and the sweep below lands in whichever slot that happens to be.
    // With the layout declared, x past the last midpoint (250 for chips of 100 at
    // 0/100/200) is what sends the dragged chip to the end.
    h.stubLayout();
    h.stubRects();
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));

    h.sweepTo(260);
    vi.advanceTimersByTime(REORDER_REST_MS);

    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);
    for (const chipEl of h.chips()) {
      expect(translateOf(chipEl)).toBe("");
      expect(chipEl.style.transition).toBe("");
    }
  });

  it("hands displaced chips back when reduced motion is turned on mid-drag", async () => {
    // The preference is read live, so it can change between two commits of one
    // gesture. The commit that stops animating still owes the chips the previous
    // one displaced their styles back, or they keep an inline transition nothing
    // will ever end.
    const h = await mountDrag(4);
    h.stubLayout();
    h.stubRects();
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));
    restAt(h, 210);
    expect(h.chip("three").style.transition).toContain("translate");

    stubReducedMotion(true);
    h.stubLayout();
    restAt(h, 110);

    expect(idsOf(h.root)).toEqual(["one", "four", "two", "three"]);
    for (const chipEl of h.chips()) {
      expect(translateOf(chipEl)).toBe("");
      expect(chipEl.style.transition).toBe("");
    }
  });
});

describe("tabs reorder: what a commit refuses to do", () => {
  it("abandons a pending slot whose reference chip left the strip", async () => {
    // The slot was chosen a rest window ago, and a session closed in another
    // window removes chips while this gesture is still open. insertBefore throws
    // NotFoundError on a reference that is no longer a child, which would abandon
    // the move half-done and leave DOM order and the tab list disagreeing.
    const h = await mountDrag(4);
    h.stubLayout();
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(210); // arms the fallback against "three"

    h.chip("three").remove();

    expect(() => {
      vi.advanceTimersByTime(REORDER_REST_MS);
    }).not.toThrow();
    expect(idsOf(h.root)).toEqual(["one", "two", "four"]);
  });

  it("opens no slot when a release lands on the position the tab already holds", async () => {
    // A drop commits the slot under the POINTER rather than whatever a timer had
    // pending, so it reaches commitSlot on every release — including the one
    // asking for the position the tab is already in. That is not a move, so there
    // is nothing to slide and no slot to fade in at a new home.
    const h = await mountDrag(3);
    // Layout declared, and the release aimed PAST the last midpoint (250, for
    // chips of 100 at 0/100/200) so it really is the position "three" already
    // holds. `dragEvent` releases at clientX 0, which with real chip widths is the
    // HEAD of the strip — a move, and the opposite of this test's premise.
    h.stubLayout();
    const dragged = h.chip("three"); // the last chip, released past the end
    dragged.dispatchEvent(dragEvent("dragstart", h.dt));

    dragged.dispatchEvent(dragAt("drop", h.dt, 260));

    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    expect(dragged.classList.contains("wt-tab-slotted")).toBe(false);
  });
});

describe("tabs reorder: the cancel", () => {
  it("says nothing when an abandoned drag never opened a slot", async () => {
    // Escape on a drag that moved nothing has nothing to put back, and announcing
    // "Move cancelled" for it tells a screen-reader user something was undone
    // when nothing ever happened.
    const h = await mountDrag(3);
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));

    dragged?.dispatchEvent(dragEvent("dragend", h.dt));

    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("");
  });

  it("reverts a preview that rearranged only the tail of the strip", async () => {
    // The strip counts as touched when ANY chip is out of place, not when the
    // first one is: a commit that moved the last two tabs leaves the head exactly
    // where the tab list says it should be.
    const h = await mountDrag(4);
    h.stubLayout();
    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));
    restAt(h, 210);
    expect(idsOf(h.root)).toEqual(["one", "two", "four", "three"]);

    h.chip("four").dispatchEvent(dragEvent("dragend", h.dt));

    expect(idsOf(h.root)).toEqual(["one", "two", "three", "four"]);
    expect(h.ids()).toEqual(["s1", "s2", "s3", "s4"]);
    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("Move cancelled");
  });

  it("re-projects the tab list when a chip has gone missing from the strip", async () => {
    // The tab list IS the snapshot, so a cancel re-projects it rather than
    // replaying moves — which also means a strip holding the wrong NUMBER of
    // chips is out of date whatever order the ones it still has are in.
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.chip("three").remove();

    h.chips()[0]?.dispatchEvent(dragEvent("dragend", h.dt));

    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("Move cancelled");
  });
});

describe("tabs reorder: the slot's fade", () => {
  it("restarts the fade at the new home instead of letting the old timer end it", async () => {
    // The fade says "the slot is HERE now". A second commit inside the first
    // fade's window has to take the timer over, or the first one's expiry clears
    // the class a moment after the second commit added it.
    const h = await mountDrag(4);
    h.stubLayout();
    const dragged = h.chip("four");
    dragged.dispatchEvent(dragEvent("dragstart", h.dt));
    restAt(h, 210); // commit 1: the fade starts here
    expect(dragged.classList.contains("wt-tab-slotted")).toBe(true);

    h.stubLayout();
    h.sweepTo(40);
    vi.advanceTimersByTime(REORDER_SLOT_FADE_MS - 2 * REORDER_STILL_MS);
    h.sweepTo(40); // commit 2, shortly before commit 1's fade would expire

    expect(idsOf(h.root)).toEqual(["four", "one", "two", "three"]);
    vi.advanceTimersByTime(2 * REORDER_STILL_MS + 10); // past commit 1's expiry
    expect(dragged.classList.contains("wt-tab-slotted")).toBe(true);
    vi.advanceTimersByTime(REORDER_SLOT_FADE_MS);
    expect(dragged.classList.contains("wt-tab-slotted")).toBe(false);
  });

  it("ends the slot's fade with the gesture rather than leaving it to its own timer", async () => {
    // The fade is gesture state: once the drag is over the slot is not a slot any
    // more, and a class that outlives it renders a finished tab as a pending drop
    // target for another third of a second.
    const h = await mountDrag(3);
    // Declared layout, and a sweep past the last midpoint: a slot only opens for a
    // position the chip is not already in, and with real chip widths x=10 is a
    // position "one" already holds.
    h.stubLayout();
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(260);
    vi.advanceTimersByTime(REORDER_REST_MS);
    expect(dragged?.classList.contains("wt-tab-slotted")).toBe(true);

    dragged?.dispatchEvent(dragEvent("drop", h.dt));
    dragged?.dispatchEvent(dragEvent("dragend", h.dt));

    // No timers advanced: the gesture's teardown is what removed it.
    expect(dragged?.classList.contains("wt-tab-slotted")).toBe(false);
  });

  it("drops a pending rest window with the gesture, so a fresh drag cannot inherit it", async () => {
    // A net armed by the previous gesture carries the previous gesture's target.
    // Surviving into a new drag it commits a slot the new pointer never asked
    // for — and moves whichever chip is being dragged now.
    const h = await mountDrag(4);
    h.stubLayout();
    const first = h.chip("one");
    first.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(210); // arms the fallback against "three"
    first.dispatchEvent(dragEvent("dragend", h.dt));

    h.chip("four").dispatchEvent(dragEvent("dragstart", h.dt));
    vi.advanceTimersByTime(REORDER_REST_MS * 2);

    expect(idsOf(h.root)).toEqual(["one", "two", "three", "four"]);
    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("");
  });
});

// --- the reel owns row motion, and only while it is running -----------------
//
// A swipe to an adjacent tab while the switcher list is OPEN animates the list as
// a rotation: every surviving row slides one slot, the row of the tab that went
// active exits, and the row of the tab that went inactive rotates in. So for that
// one reconcile the list's own add/remove animation has to stand down, and for
// every reconcile after it the list has to get it back.

interface ReelHarness {
  root: HTMLElement;
  rows: () => HTMLElement[];
  row: (label: string) => HTMLElement;
  label: () => string;
  swipeForward: () => void;
}

/** Three tabs with the list expanded, and rows with a real HEIGHT. The height is
 *  load-bearing rather than cosmetic: animateRowIn bails out when the box measures
 *  zero, which is what an unstyled row measures, so without it the enter animation
 *  this test is about cannot run either way and the assertion would be vacuous. */
async function mountReel(): Promise<ReelHarness> {
  threeSessions();
  const realRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ): DOMRect {
    if (this.classList.contains("wt-switcher-row")) {
      return {
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        top: 0,
        bottom: 24,
        height: 24,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return realRect.call(this) as DOMRect;
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  term = createTerminal(root, { features: () => [tabs()] });
  await until(() => root.querySelectorAll(".wt-tab").length === 3);
  pick(root, ".wt-switcher-current").click(); // expand
  const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".wt-switcher-row")];
  return {
    root,
    rows,
    row: (label) => {
      const found = rows().find(
        (r) => r.querySelector(".wt-switcher-row-label")?.textContent === label,
      );
      if (!found) {
        throw new Error(`no row labelled ${label}`);
      }
      return found;
    },
    label: () => root.querySelector(".wt-switcher-label")?.textContent ?? "",
    swipeForward: () => {
      const cur = pick(root, ".wt-switcher-current");
      cur.dispatchEvent(
        new MouseEvent("pointerdown", { clientX: 220, clientY: 10, bubbles: true }),
      );
      cur.dispatchEvent(new MouseEvent("pointerup", { clientX: 90, clientY: 12, bubbles: true }));
    },
  };
}

describe("tabs: the switcher reel and the list's own row motion", () => {
  it("suppresses the list's enter animation for the reconcile the reel drives", async () => {
    // Two animations for one movement read as two competing features: the rotation
    // carries the arriving row into its slot, so the row must not also grow itself
    // in from zero height at the same time.
    const h = await mountReel();
    expect(h.rows().length).toBe(2);

    h.swipeForward();

    // The reel really is running: the row of the tab that went active is anchored
    // as the exiting ghost rather than reconciled away.
    expect(h.label()).toBe("two");
    expect(h.rows().filter((r) => r.style.position === "absolute").length).toBe(1);
    // ...and the row that arrived carries none of the list's own enter animation.
    // Its opacity is not the tell — the reel writes that itself as the row rotates
    // into its slot. The clipped max-height is animateRowIn's alone.
    const arrived = h.row("one");
    expect(arrived.style.maxHeight).toBe("");
    expect(arrived.style.overflow).toBe("");
  });

  it("hands row motion back to the list as soon as the reel's reconcile is done", async () => {
    // The suppression is scoped to the ONE reconcile the reel drives. A close
    // arriving afterwards is an ordinary add/remove and animates itself out; left
    // suppressed, every later row change in the open list would snap instead.
    const h = await mountReel();
    h.swipeForward();
    expect(h.label()).toBe("two");

    const leaving = h.row("three");
    pick(leaving, ".wt-switcher-row-close").click();

    // Still on screen, collapsing: animateRowOut owns it until its own timer
    // removes it.
    expect(leaving.isConnected).toBe(true);
    expect(leaving.style.pointerEvents).toBe("none");
    expect(leaving.style.overflow).toBe("hidden");
  });
});
