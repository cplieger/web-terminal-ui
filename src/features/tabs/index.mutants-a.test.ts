// tabs feature — the switcher's INTERACTIVE drag and the document-level
// dismissals (index.ts, the last section of the file). index.test.ts drives the
// recogniser's decisions (which axis a drag locks, whether a release resolves at
// all); what it never reaches is what the drag DOES while the finger is down and
// what the release then commits:
//
//   * the vertical drag's live height and its open/closed snap, including the
//     flick that beats the halfway rule and the four ways a flick is refused
//     (canceled, too slow, too leisurely, too short);
//   * the horizontal drag's live preview (the chip follows the finger, an open
//     list peeks in the swipe direction), the spring back when the release does
//     not commit, and the slide when it does;
//   * the document handlers: a tap that dismisses an open overlay rather than
//     opening the keyboard, a right-click that closes the tab menu, Escape's
//     claim on that menu, and the active row's own close button.
//
// Two things make that reachable here where the sibling file leaves it dark. The
// list's scrollHeight is supplied as what it is — an engine reading — so the
// vertical drag's whole arithmetic (which is bounded by it) comes alive against a
// number the test chose rather than whatever an unstyled list happened to measure.
// And matchMedia is stubbed per query, so a case says which of the three questions
// the feature asks it is answering.
//
// Pointer events carry an explicit timeStamp. The recogniser's flick test is
// three comparisons against the clock (duration, sample velocity, staleness), so
// a test that let the environment pick the timestamps would be asserting whatever
// the box happened to be doing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
import type { MobileToolbarApi } from "../mobile-toolbar.js";
import type { TerminalFeature } from "../../kernel/types.js";
// The gesture vocabulary, imported rather than restated: these tests pin the
// SHAPE of each rule (a flick beats distance, a stale sample is ignored, the
// peek is capped), not the numbers a retune may move.
import {
  AXIS_LOCK_PX,
  PREVIEW_DRAG_RATIO,
  PREVIEW_PEEK_MAX,
  SWIPE_DURATION,
  SWIPE_MIN_PX,
  SWIPE_VELOCITY,
  VELOCITY_STALE_MS,
} from "./switcher.js";

const setSession = vi.fn<(id: string) => void>();
const bind = vi.fn();
const sendBinary = vi.fn<(bytes: Uint8Array) => boolean>(() => true);

// The engine is replaced wholesale, as in index.test.ts: a switch re-points the
// renderer and reconnects the socket, and neither belongs in a DOM-only test.
// `modes` comes through from the real module so getMouseMode() answers 0 (no
// mouse-mode application) unless a test says otherwise.
// getMouseMode has to come through the mock factory rather than a vi.spyOn on the
// real namespace: an ESM module namespace object is not configurable, so
// `vi.spyOn(engine.modes, "getMouseMode")` throws "Module namespace is not
// configurable in ESM" in a real browser (the node transform used to rewrite it
// into something patchable). The default answers 0 — no mouse-mode application —
// which is what `...actual` used to give.
const getMouseMode = vi.fn<() => number>(() => 0);

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    modes: { ...actual.modes, getMouseMode },
    render: {
      init: vi.fn(),
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
      resetScrollback: vi.fn(),
      resetScreen: vi.fn(),
      dropBrowseCache: vi.fn(),
      bind,
      captureViewMemory: vi.fn(() => ({ abs: 7, screenTop: -3, following: false })),
      boundStore: vi.fn(() => ({ getWindow: () => ({ base: 0 }) })),
    },
    scroll: {
      // Reached through viewport.ts's settle handler, which a real browser fires on
      // its own: viewport.init() observes the term wrap with a ResizeObserver, and a
      // real one delivers its first observation asynchronously, so every mount opens a
      // transition that settles ~350ms later and pins to the bottom. Absent from the
      // double, that settle throws out of a timer as an unhandled error.
      stickToBottom: vi.fn(),
      init: vi.fn(),
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      restoreScrollTop: vi.fn(),
      restoreView: vi.fn(),
    },
    connection: {
      init: vi.fn(),
      connect: vi.fn(),
      sendBinary,
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect: vi.fn(),
      setSession,
      forgetSession: vi.fn(),
      serverEpochOf: vi.fn(() => 777),
      adoptPersistedEpoch: vi.fn(),
      currentSessionId: vi.fn(() => "unmanaged"),
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
let createStatus = 201;
// When set, the session list waits on this before resolving. That is how a test
// says "the user did something while the initial list was still in flight": the
// chrome mounts synchronously and the status stream fills it, so the race is
// real, and gating it here makes it deterministic instead of a microtask bet.
let listGate: Promise<unknown> | null = null;
const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "POST") {
    return Promise.resolve(
      createStatus === 201
        ? jsonResponse({ id: "s-new", title: "", createdAt: "9", status: "idle" }, 201)
        : jsonResponse({}, createStatus),
    );
  }
  if (method === "DELETE") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  return listGate === null
    ? Promise.resolve(jsonResponse(listBody, 200))
    : listGate.then(() => jsonResponse(listBody, 200));
});

beforeEach(async () => {
  vi.resetModules();
  setSession.mockClear();
  bind.mockClear();
  // mockReset strips the factory default; restore "no mouse-mode application".
  getMouseMode.mockReturnValue(0);
  sendBinary.mockClear();
  fetchMock.mockClear();
  createStatus = 201;
  listGate = null;
  listBody = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
    { id: "s3", title: "three", createdAt: "3", status: "idle" },
  ];
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
  localStorage.clear();
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function until(pred: () => boolean, tries = 30): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// A query-aware matchMedia. `motion: false` is the ordinary case (an animating
// browser); `motion: true` is the opt-out, asserted on its own. Stubbed rather
// than left to the environment because a headless browser's own answer to
// prefers-reduced-motion is not the test's to choose.
function stubMatchMedia(reduced: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reduced : true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    })),
  );
}

// A pointer event with a chosen clock reading and pointer id. MouseEvent stands
// in (as in index.test.ts) because `timeStamp` is read-only on a constructed
// event, and the recogniser compares it three ways; the two pointer fields it
// reads are defined onto it.
function pointerEvent(type: string, x: number, y: number, t: number, id = 1): MouseEvent {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(e, "timeStamp", { value: t });
  Object.defineProperty(e, "pointerId", { value: id });
  return e;
}

// A fake keyboardToggle (a MobileToolbarApi provider), so the tap-dismiss tests
// can have a key grid that is genuinely open. Mirrors index.test.ts's fake.
function fakeKeyboardToggle(open = false): {
  feature: TerminalFeature<MobileToolbarApi>;
  isOpen: () => boolean;
} {
  let isOpen = open;
  return {
    feature: {
      name: "mobileToolbar",
      setup() {
        return {
          api: {
            toggle() {
              isOpen = !isOpen;
            },
            isOpen: () => isOpen,
            isCtrlArmed: () => false,
            onCtrlArmedChange: () => () => undefined,
          },
          teardown: () => undefined,
        };
      },
    },
    isOpen: () => isOpen,
  };
}

interface Bar {
  root: HTMLElement;
  switcher: HTMLElement;
  list: HTMLElement;
  inner: HTMLElement;
  surface: HTMLElement;
  expanded: () => boolean;
  active: () => string;
  rows: () => HTMLElement[];
  live: () => string;
  /** Press the active row at (x, y) on the clock reading `t`. */
  down: (x: number, y: number, t: number, id?: number) => void;
  /** A move delivered on WINDOW, which is where the gesture's listener lives. */
  move: (x: number, y: number, t: number, id?: number) => void;
  up: (x: number, y: number, t: number, id?: number) => void;
  cancel: (x: number, y: number, t: number, id?: number) => void;
  lostCapture: (x: number, y: number, t: number, id?: number) => void;
  /** Open the list the ordinary way (a tap on the active row). */
  openList: () => void;
  /** Take over the timers. Only ever called AFTER the async mount: `until()`
   *  drives itself on setTimeout, so faking it earlier deadlocks the mount. */
  freezeTime: () => void;
  frame: () => void;
}

/** Mount the tabs chrome over `count` sessions and hand back the switcher's
 *  parts plus a gesture driver.
 *
 *  `listHeight` is the list's scrollHeight, which is the ONLY input bounding the
 *  vertical drag; an unstyled list has nothing overflowing it, and a zero bound
 *  makes the whole drag inert (its two guards return early), so it is supplied
 *  here.
 *  `surfaceWidth` is the terminal's own width, which sets the horizontal
 *  commit distance (a quarter of it) — deliberately different from the window's
 *  width, so a test can tell which one the rule reads. */
async function mountBar(
  count = 3,
  opts: {
    listHeight?: number;
    surfaceWidth?: number;
    keyboard?: TerminalFeature<MobileToolbarApi>;
  },
): Promise<Bar> {
  listBody = ["one", "two", "three", "four"].slice(0, count).map((title, i) => ({
    id: `s${String(i + 1)}`,
    title,
    createdAt: String(i + 1),
    status: "idle",
  }));
  const root = document.createElement("div");
  document.body.appendChild(root);
  const feature = tabs(opts.keyboard ? { keyboardToggle: opts.keyboard } : {});
  term = createTerminal(root, {
    features: () => (opts.keyboard ? [opts.keyboard, feature] : [feature]),
  });
  await until(() => root.querySelectorAll(".wt-tab").length === count);
  const switcher = root.querySelector<HTMLElement>(".wt-switcher");
  const current = root.querySelector<HTMLElement>(".wt-switcher-current");
  const list = root.querySelector<HTMLElement>(".wt-switcher-list");
  const inner = root.querySelector<HTMLElement>(".wt-switcher-current-inner");
  const surface = root.querySelector<HTMLElement>(".term");
  if (!switcher || !current || !list || !inner || !surface) {
    throw new Error("switcher chrome missing");
  }
  Object.defineProperty(list, "scrollHeight", {
    value: opts.listHeight ?? 0,
    configurable: true,
  });
  Object.defineProperty(surface, "clientWidth", {
    value: opts.surfaceWidth ?? 0,
    configurable: true,
  });
  const send = (
    type: string,
    x: number,
    y: number,
    t: number,
    id: number,
    to: EventTarget,
  ): void => {
    to.dispatchEvent(pointerEvent(type, x, y, t, id));
  };
  return {
    root,
    switcher,
    list,
    inner,
    surface,
    expanded: () => switcher.classList.contains("wt-switcher-expanded"),
    active: () => root.querySelector(".wt-switcher-label")?.textContent ?? "",
    rows: () => [...list.querySelectorAll<HTMLElement>(".wt-switcher-row")],
    live: () => root.querySelector('[aria-live="polite"]')?.textContent ?? "",
    down: (x, y, t, id = 1) => {
      send("pointerdown", x, y, t, id, current);
    },
    move: (x, y, t, id = 1) => {
      send("pointermove", x, y, t, id, window);
    },
    up: (x, y, t, id = 1) => {
      send("pointerup", x, y, t, id, current);
    },
    cancel: (x, y, t, id = 1) => {
      send("pointercancel", x, y, t, id, window);
    },
    lostCapture: (x, y, t, id = 1) => {
      send("lostpointercapture", x, y, t, id, current);
    },
    openList: () => {
      current.click();
    },
    // The status poll is a setInterval that must keep running on the real clock
    // (freezing it deadlocks teardown), so only the timers the animations use
    // are taken over.
    freezeTime: () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
      });
    },
    // requestAnimationFrame is faked with the timers above, so a frame is one tick
    // of the fake clock rather than a real paint.
    frame: () => {
      vi.advanceTimersByTime(20);
    },
  };
}

describe("tabs: the switcher's vertical drag", () => {
  // Dragging up grows the tab list under the bar and dragging down shrinks it,
  // 1:1 with the finger; the release snaps to whichever end is nearer, unless
  // the release was a flick, which goes the way it was thrown.
  const LIST_H = 200; // the fully-open height; half of it is the snap point

  it("grows the list with the finger, clamped to the fully-open height", async () => {
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 240, 1010); // 60px up: past the axis lock, so vertical is chosen
    expect(h.list.style.maxHeight).toBe("60px");

    // Further up keeps tracking...
    h.move(100, 160, 1020);
    expect(h.list.style.maxHeight).toBe("140px");
    // ...to the fully-open height and no further: there is nothing beyond it to
    // reveal, so the finger stops being followed rather than over-growing the list.
    h.move(100, 20, 1030);
    expect(h.list.style.maxHeight).toBe(`${String(LIST_H)}px`);
    // And a drag back below the start clamps at nothing, not at a negative height.
    h.move(100, 420, 1040);
    // A real CSSOM normalizes a LENGTH on read-back: production writes `0` and
    // `element.style` reports `0px`. Same value, the platform's spelling. A bare
    // number (opacity) is not a length and stays `0`.
    expect(h.list.style.maxHeight).toBe("0px");
  });

  it("snaps open when the release is past the halfway point", async () => {
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 150, 1200); // 150px up, slowly (0.75px/ms is under the flick bar)
    h.up(100, 150, 1210);

    expect(h.expanded()).toBe(true);
    // The live region clears and re-sets on a timer, so the message lands late.
    await new Promise((r) => setTimeout(r, 150));
    expect(h.live()).toBe("Terminal list expanded");
    // The height goes back to the class: the snap is CSS's to animate from
    // wherever the finger left it.
    expect(h.list.style.maxHeight).toBe("");
    expect(h.list.style.transition).toBe("");
    expect(h.active()).toBe("one"); // a vertical drag never switches tabs
  });

  it("snaps open from exactly the halfway point", async () => {
    // The boundary is inclusive: half the travel is enough. A drag released
    // dead-centre has to resolve one way, and "the list you dragged towards
    // wins" is the one that does not feel like the gesture was thrown away.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 200, 1400); // exactly LIST_H / 2, far too slow to be a flick
    h.up(100, 200, 1410);

    expect(h.expanded()).toBe(true);
  });

  it("snaps back closed when the release is short of halfway", async () => {
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 250, 1400); // 50px of 200: not enough, and slow enough not to flick
    h.up(100, 250, 1410);

    expect(h.expanded()).toBe(false);
    expect(h.list.style.maxHeight).toBe("");
    // Nothing is announced for a list that did not open. The region re-sets on a
    // timer, so this waits out the window an announcement would have landed in.
    await new Promise((r) => setTimeout(r, 150));
    expect(h.live()).toBe("");
  });

  it("opens on an upward flick that never reached halfway", async () => {
    // The flick is the whole reason the halfway rule is not the only rule: a
    // quick throw upward opens the list from a short travel.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 250, 1010); // 50px in 10ms = 5px/ms, ten times the flick bar
    h.up(100, 250, 1015);

    expect(h.expanded()).toBe(true);
  });

  it("closes on a downward flick that was still past halfway", async () => {
    // The mirror image, and the case that proves the flick's direction is read
    // from the throw rather than from where the list happened to be: released
    // past the halfway point, which the distance rule alone would snap OPEN.
    const h = await mountBar(3, { listHeight: LIST_H });
    h.openList();
    expect(h.expanded()).toBe(true);

    h.down(100, 300, 1000);
    h.move(100, 350, 1010); // 50px down in 10ms: a flick, and 150px of 200 remains
    h.up(100, 350, 1015);

    expect(h.expanded()).toBe(false);
  });

  it("refuses a flick the finger threw before pausing on the way up", async () => {
    // pointerup usually repeats the last move's position, so a finger that
    // stopped and then lifted reports the speed it had BEFORE stopping. The
    // gesture the user made was a slow drag, so distance decides it.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 250, 1010); // fast: 5px/ms
    h.up(100, 250, 1010 + VELOCITY_STALE_MS + 1); // then held still, and lifted

    expect(h.expanded()).toBe(false);
  });

  it("refuses a flick that took too long to arrive, however fast it ended", async () => {
    // A long, meandering drag that happens to end quickly is not a throw: the
    // whole gesture is timed, not just its last sample.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 300, 1000 + SWIPE_DURATION - 20); // a long dwell, no travel
    h.move(100, 250, 1000 + SWIPE_DURATION - 10); // then 50px in 10ms
    h.up(100, 250, 1000 + SWIPE_DURATION + 5);

    expect(h.expanded()).toBe(false);
  });

  it("refuses a flick slower than the flick velocity", async () => {
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    // Exactly the flick velocity, which is not OVER it: the bar is a threshold
    // to beat, so the boundary reading stays a drag and distance decides.
    h.move(100, 255, 1050);
    h.move(100, 250, 1050 + 5 / SWIPE_VELOCITY);
    h.up(100, 250, 1055 + 5 / SWIPE_VELOCITY);

    expect(h.expanded()).toBe(false);
  });

  it("refuses a flick whose whole gesture took exactly the duration cap", async () => {
    // The cap is a strict bound: a gesture that took the whole window is a drag,
    // so the distance rule decides it and this short one snaps back.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 300, 1000 + SWIPE_DURATION - 10); // a dwell, no travel
    h.move(100, 250, 1000 + SWIPE_DURATION - 5); // then 50px in 5ms
    h.up(100, 250, 1000 + SWIPE_DURATION);

    expect(h.expanded()).toBe(false);
  });

  it("still counts a velocity sampled exactly at the staleness bound", async () => {
    // The stale-velocity guard is a strict bound too: a sample that old is still
    // this gesture's, so the flick it describes stands and the list opens from a
    // travel the distance rule would have refused.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 250, 1010); // 5px/ms
    h.up(100, 250, 1010 + VELOCITY_STALE_MS);

    expect(h.expanded()).toBe(true);
  });

  it("refuses a flick shorter than the swipe minimum", async () => {
    // A fast twitch is not a throw. The travel bar is what separates them.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 300 - SWIPE_MIN_PX, 1010); // fast, but exactly the minimum, not past it
    h.up(100, 300 - SWIPE_MIN_PX, 1015);

    expect(h.expanded()).toBe(false);
  });

  it("never flicks on a cancel, and hands the height back to CSS", async () => {
    // A system interruption (a call, a notification shade) is not a gesture.
    // The throw is discarded and the nearer end wins — here, closed.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 250, 1010); // an upward flick, by speed and travel
    h.cancel(100, 250, 1015);

    expect(h.expanded()).toBe(false);
    // The inline height is what tracked the finger; leaving it behind would
    // pin the list at the interrupted size for the rest of the page's life.
    expect(h.list.style.maxHeight).toBe("");
  });

  it("treats a revoked pointer capture as a cancel, not as a release", async () => {
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 250, 1010); // the same upward flick
    h.lostCapture(100, 250, 1015);

    expect(h.expanded()).toBe(false);
    expect(h.list.style.maxHeight).toBe("");
  });

  it("reads the velocity as travel over time, not as either alone", async () => {
    // Two ways to get this wrong that a single-sample test cannot see: the
    // divide the other way round, or the two positions added. Both turn a
    // deliberate slow drag into a flick, so the assertion is that a slow drag
    // stays a drag.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 250, 1200); // 50px over 200ms: 0.25px/ms, half the flick bar
    h.up(100, 250, 1205);

    expect(h.expanded()).toBe(false);
  });

  it("does not read a coalesced sample sharing its timestamp as infinite speed", async () => {
    // High-refresh browsers coalesce moves, and two samples can carry the same
    // timeStamp. Dividing by that zero would report an infinite velocity and
    // flick every such drag open.
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 290, 1200); // slow: 0.05px/ms
    h.move(100, 250, 1200); // same clock reading, 40px on
    h.up(100, 250, 1205);

    expect(h.expanded()).toBe(false);
  });

  it("is inert on a collapsed single tab, with no list to reveal", async () => {
    const h = await mountBar(1, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 150, 1010);

    expect(h.list.style.maxHeight).toBe("");
    h.up(100, 150, 1015);
    expect(h.expanded()).toBe(false);
  });

  it("opens on a vertical drag with two tabs, which is one to list", async () => {
    // Two tabs is the smallest list worth revealing: the OTHER tab is what the
    // list shows, so one row is a list.
    const h = await mountBar(2, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 150, 1400); // 150px up, slowly: distance decides, and it is past half
    h.up(100, 150, 1410);

    expect(h.expanded()).toBe(true);
    // ...and the row is really there: the drag renders the list on its way open,
    // or the bar lifts to reveal nothing.
    expect(h.rows()).toHaveLength(1);
  });

  it("renders every other tab as a row on the way open", async () => {
    const h = await mountBar(3, { listHeight: LIST_H });

    h.down(100, 300, 1000);
    h.move(100, 150, 1400);
    h.up(100, 150, 1410);

    expect(h.rows()).toHaveLength(2);
    expect(h.rows().map((r) => r.querySelector(".wt-switcher-row-label")?.textContent)).toEqual([
      "two",
      "three",
    ]);
  });

  it("never grows the list past half the visible viewport", async () => {
    // The bound is the region above the soft keyboard, matching the switcher's
    // own bottom anchor: a list as tall as its content would grow behind the
    // keyboard, where the rows cannot be reached.
    const tall = 10_000; // far more content than the viewport can show
    const h = await mountBar(3, { listHeight: tall });
    const half = Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.5);
    expect(half).toBeLessThan(tall); // the viewport is the binding constraint here

    h.down(100, 1000, 1000);
    h.move(100, 0, 1010); // drag up by more than the whole viewport

    expect(h.list.style.maxHeight).toBe(`${String(half)}px`);
  });
});

describe("tabs: the switcher's horizontal drag", () => {
  // The active-tab chip follows the finger, and an open list peeks in the swipe
  // direction. The release either commits the switch (sliding the incoming chip
  // in from that side) or springs everything back.
  const WIDTH = 400; // the terminal's own width: a quarter of it commits
  const QUARTER = WIDTH / 4;

  it("drags the active chip with the finger, one pixel per pixel", async () => {
    stubMatchMedia(false);
    const h = await mountBar(3, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(240, 300, 1010);
    expect(h.inner.style.transform).toBe("translateX(-60px)");
    expect(h.inner.style.transition).toBe("none"); // tracking, not animating
    h.move(360, 300, 1020);
    expect(h.inner.style.transform).toBe("translateX(60px)");
  });

  it("peeks an open list in the swipe direction, capped short of a full shift", async () => {
    // The incoming row only appears on release, so the open list nudges rather
    // than shifting: a fraction of the travel, capped, in the swipe direction.
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });
    h.openList();
    expect(h.rows()).toHaveLength(1);

    h.down(300, 300, 1000);
    h.move(250, 300, 1010); // 50px left
    const peek = 50 * PREVIEW_DRAG_RATIO;
    expect(peek).toBeLessThan(PREVIEW_PEEK_MAX); // the un-capped case
    for (const row of h.rows()) {
      expect(row.style.transform).toBe(`translateY(-${String(peek)}px)`);
      expect(row.style.transition).toBe("none");
    }
    // The rows are translated inside the list, so the list has to clip them.
    expect(h.list.style.overflow).toBe("hidden");

    // A long drag stops at the cap rather than sliding the list a screen's worth.
    h.move(0, 300, 1020);
    for (const row of h.rows()) {
      expect(row.style.transform).toBe(`translateY(-${String(PREVIEW_PEEK_MAX)}px)`);
    }
  });

  it("peeks the other way for a drag towards the previous tab", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });
    h.openList();

    h.down(300, 300, 1000);
    h.move(350, 300, 1010); // 50px right

    for (const row of h.rows()) {
      expect(row.style.transform).toBe(`translateY(${String(50 * PREVIEW_DRAG_RATIO)}px)`);
    }
  });

  it("does not peek the list under reduced motion", async () => {
    stubMatchMedia(true);
    const h = await mountBar(2, { surfaceWidth: WIDTH });
    h.openList();

    h.down(300, 300, 1000);
    h.move(250, 300, 1010);

    for (const row of h.rows()) {
      expect(row.style.transform).toBe("");
    }
    expect(h.list.style.overflow).toBe(""); // nothing to clip, so nothing claimed
  });

  it("claims no list styling when there is no open list to preview", async () => {
    stubMatchMedia(false);
    const h = await mountBar(3, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(250, 300, 1010);

    // The chip still follows the finger; the collapsed list is not this
    // gesture's to clip or position.
    expect(h.inner.style.transform).toBe("translateX(-50px)");
    expect(h.list.style.overflow).toBe("");
    expect(h.list.style.position).toBe("");
  });

  it("springs the chip back when the release is short of a quarter width", async () => {
    stubMatchMedia(false);
    const h = await mountBar(3, { surfaceWidth: WIDTH });
    h.freezeTime();

    h.down(300, 300, 1000);
    h.move(300 - QUARTER + 10, 300, 1200); // 90px of the needed 100, slowly
    h.up(300 - QUARTER + 10, 300, 1210);

    expect(h.active()).toBe("one"); // no switch
    expect(setSession).not.toHaveBeenCalledWith("s2");
    // The transform is dropped and a transition put on, so the chip eases home
    // rather than jumping there.
    expect(h.inner.style.transform).toBe("");
    expect(h.inner.style.transition).toBe("transform 0.2s ease-out");
    // ...and the transition is handed back to CSS once the ease is over, so the
    // next drag tracks the finger instead of lagging behind it.
    vi.advanceTimersByTime(240);
    expect(h.inner.style.transition).toBe("");
  });

  it("springs the peeked rows back to rest on that same release", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });
    h.openList();
    h.freezeTime();

    h.down(300, 300, 1000);
    h.move(250, 300, 1200); // slow, and short of the commit distance
    h.up(250, 300, 1210);

    h.frame();
    for (const row of h.rows()) {
      expect(row.style.transform).toBe("translateY(0px)");
      expect(row.style.transition).toBe("transform 0.2s ease-out");
    }
  });

  it("commits the switch once the drag passes a quarter of the terminal's width", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300 - QUARTER - 20, 300, 1200); // past the quarter, slowly: distance alone
    h.up(300 - QUARTER - 20, 300, 1210);

    expect(h.active()).toBe("two");
    expect(setSession).toHaveBeenCalledWith("s2");
  });

  it("commits from exactly a quarter of the width", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300 - QUARTER, 300, 1200);
    h.up(300 - QUARTER, 300, 1210);

    expect(h.active()).toBe("two");
  });

  it("takes the previous tab for a rightward drag, wrapping to the last", async () => {
    // Direction is what makes the swipe feel like moving along a strip; the
    // list is circular, so dragging right from the first tab lands on the last.
    stubMatchMedia(false);
    const h = await mountBar(3, { surfaceWidth: WIDTH });

    h.down(100, 300, 1000);
    h.move(100 + QUARTER + 20, 300, 1200);
    h.up(100 + QUARTER + 20, 300, 1210);

    expect(h.active()).toBe("three");
  });

  it("commits a short drag when it was thrown, not dragged", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300 - SWIPE_MIN_PX - 10, 300, 1010); // 50px in 10ms, well short of a quarter
    h.up(300 - SWIPE_MIN_PX - 10, 300, 1015);

    expect(h.active()).toBe("two");
  });

  it("does not commit a fast twitch shorter than the swipe minimum", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300 - SWIPE_MIN_PX, 300, 1010); // fast, but only the minimum travel
    h.up(300 - SWIPE_MIN_PX, 300, 1015);

    expect(h.active()).toBe("one");
  });

  it("does not commit a fast drag the finger paused at the end of", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300 - SWIPE_MIN_PX - 10, 300, 1010); // fast enough to flick
    h.up(300 - SWIPE_MIN_PX - 10, 300, 1010 + VELOCITY_STALE_MS + 1); // ...then held

    expect(h.active()).toBe("one");
  });

  it("still counts a velocity sampled exactly at the staleness bound", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300 - SWIPE_MIN_PX - 10, 300, 1010);
    h.up(300 - SWIPE_MIN_PX - 10, 300, 1010 + VELOCITY_STALE_MS);

    expect(h.active()).toBe("two"); // the flick stands, well short of a quarter
  });

  it("does not commit a fast finish to a long, slow drag", async () => {
    // The flick is a property of the whole gesture, not of its last few
    // milliseconds: a leisurely drag that ends with a jerk is still a drag.
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300, 300, 1000 + SWIPE_DURATION + 100); // a long dwell, no travel
    h.move(250, 300, 1000 + SWIPE_DURATION + 110); // then 50px in 10ms
    h.up(250, 300, 1000 + SWIPE_DURATION + 115);

    expect(h.active()).toBe("one");
  });

  it("does not commit a gesture that took exactly the duration cap", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300, 300, 1000 + SWIPE_DURATION - 10);
    h.move(250, 300, 1000 + SWIPE_DURATION - 5);
    h.up(250, 300, 1000 + SWIPE_DURATION);

    expect(h.active()).toBe("one");
  });

  it("does not commit a release exactly at the flick velocity", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(255, 300, 1050);
    h.move(250, 300, 1050 + 5 / SWIPE_VELOCITY); // exactly the bar, not over it
    h.up(250, 300, 1055 + 5 / SWIPE_VELOCITY);

    expect(h.active()).toBe("one");
  });

  it("has nowhere to swipe to with a single tab, so it springs back", async () => {
    // A circular list of one has no other tab to reach, so however far the drag
    // goes the chip eases home instead of sliding a new one in.
    stubMatchMedia(false);
    const h = await mountBar(1, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300 - QUARTER - 50, 300, 1200);
    h.up(300 - QUARTER - 50, 300, 1210);

    expect(h.inner.style.transform).toBe("");
    expect(h.inner.style.transition).toBe("transform 0.2s ease-out");
  });

  it("does not commit a canceled drag, however far it travelled", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(0, 300, 1200); // three quarters of the width
    h.cancel(0, 300, 1210);

    expect(h.active()).toBe("one");
    expect(setSession).not.toHaveBeenCalledWith("s2");
  });

  it("slides the incoming chip in from the side the drag came from", async () => {
    stubMatchMedia(false);
    const h = await mountBar(2, { surfaceWidth: WIDTH });
    h.freezeTime();
    // The chip's OWN width is the slide distance (every part of it moves by the
    // same pixels, so the close stays locked to the label); the terminal's width
    // is only the fallback when the chip has not been laid out.
    h.inner.getBoundingClientRect = (): DOMRect =>
      ({
        width: 320,
        height: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    h.down(300, 300, 1000);
    h.move(300 - QUARTER - 20, 300, 1200);
    h.up(300 - QUARTER - 20, 300, 1210);

    // Parked off to the right (the side the finger came from), un-animated...
    expect(h.inner.style.transform).toBe("translateX(320px)");
    expect(h.inner.style.transition).toBe("none");
    // ...then animated home on the next frame...
    h.frame();
    expect(h.inner.style.transform).toBe("translateX(0px)");
    expect(h.inner.style.transition).toContain("cubic-bezier");
    // ...and left with no inline style of ours once it has arrived.
    vi.advanceTimersByTime(340);
    expect(h.inner.style.transform).toBe("");
    expect(h.inner.style.transition).toBe("");
  });

  it("switches without a slide under reduced motion", async () => {
    stubMatchMedia(true);
    const h = await mountBar(2, { surfaceWidth: WIDTH });

    h.down(300, 300, 1000);
    h.move(300 - QUARTER - 20, 300, 1200);
    h.up(300 - QUARTER - 20, 300, 1210);

    expect(h.active()).toBe("two"); // the switch still happens
    expect(h.inner.style.transform).toBe(""); // it just does not travel
    expect(h.inner.style.transition).toBe("");
  });
});

describe("tabs: the switcher's gesture bookkeeping", () => {
  it("ignores a pointerup no gesture owns", async () => {
    const h = await mountBar(3, { surfaceWidth: 400 });

    // No pointerdown came first, so there is no drag to resolve — and no origin
    // to measure against either: treating this as a release would compare the
    // release position against a zero origin and read it as a huge swipe.
    h.up(300, 300, 1000);

    expect(h.active()).toBe("one");
    expect(setSession).not.toHaveBeenCalledWith("s2");
  });

  it("ignores a second finger's release, and resolves on the owner's", async () => {
    const h = await mountBar(3, { surfaceWidth: 400 });

    h.down(300, 300, 1000, 1);
    h.up(0, 300, 1010, 2); // another finger lifts, far to the left
    expect(h.active()).toBe("one");

    h.up(300, 300, 1020, 1); // the owning finger lifts where it pressed
    expect(h.active()).toBe("one");
  });

  it("ignores a second finger's movement", async () => {
    stubMatchMedia(false);
    const h = await mountBar(3, { surfaceWidth: 400 });

    h.down(300, 300, 1000, 1);
    h.move(100, 300, 1010, 2); // a stray finger sweeps across

    expect(h.inner.style.transform).toBe(""); // nothing was previewed
  });

  it("ignores a second finger's press, keeping the first finger's origin", async () => {
    const h = await mountBar(3, { surfaceWidth: 400 });

    h.down(300, 300, 1000, 1);
    h.down(400, 300, 1005, 2); // a second finger arrives on the bar
    // Measured from the FIRST press, this is a leftward swipe (300 -> 250) and
    // the next tab; measured from the second it would be rightward, and the
    // previous one.
    h.up(250, 300, 1010, 1);

    expect(h.active()).toBe("two");
  });

  it("previews nothing while the travel is still a tremor", async () => {
    stubMatchMedia(false);
    const h = await mountBar(3, { surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.move(303, 301, 1010);
    h.move(304, 302, 1020);

    expect(h.inner.style.transform).toBe("");
    expect(h.list.style.maxHeight).toBe("");
  });

  it("locks an axis at exactly the lock distance", async () => {
    stubMatchMedia(false);
    const h = await mountBar(3, { surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.move(300 - AXIS_LOCK_PX, 300, 1010);

    expect(h.inner.style.transform).toBe(`translateX(-${String(AXIS_LOCK_PX)}px)`);
  });

  it("gives an evenly diagonal move to the vertical axis", async () => {
    // One of the two has to win a tie. The list is the gesture with a visible
    // resting state, so an ambiguous drag reveals it rather than half-switching
    // a tab the user cannot see yet.
    stubMatchMedia(false);
    const h = await mountBar(3, { listHeight: 200 });

    h.down(300, 300, 1000);
    h.move(250, 250, 1010); // 50 across, 50 up

    expect(h.list.style.maxHeight).toBe("50px");
    expect(h.inner.style.transform).toBe("");
  });

  it("keeps the axis it locked when the finger changes its mind", async () => {
    // Already covered for the horizontal lock in index.test.ts; the assertion
    // here is on the PREVIEW, which is what re-deciding would visibly break.
    stubMatchMedia(false);
    const h = await mountBar(3, { listHeight: 200, surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.move(240, 300, 1010); // locks horizontal
    h.move(240, 100, 1020); // then goes sharply up

    expect(h.list.style.maxHeight).toBe(""); // the list was never dragged
    expect(h.inner.style.transform).toBe("translateX(-60px)");
  });

  it("swallows the click that ends a drag, but only that one", async () => {
    // A pointerup on the bar is followed by a click; the drag already resolved
    // the gesture, so the click must not also toggle the list. The NEXT click is
    // an ordinary tap again.
    stubMatchMedia(false);
    const h = await mountBar(3, { listHeight: 200, surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.move(240, 300, 1010);
    h.up(240, 300, 1020);
    h.openList(); // the drag's own trailing click
    expect(h.expanded()).toBe(false);

    h.openList(); // a real tap
    expect(h.expanded()).toBe(true);
  });

  it("swallows the trailing click of a vertical drag too", async () => {
    // The vertical drag has already decided the list's state on release; letting
    // its click through would toggle straight back out of it.
    const h = await mountBar(3, { listHeight: 200 });

    h.down(300, 300, 1000);
    h.move(300, 200, 1400); // locks vertical, slowly: 100px of 200 is the snap point
    h.up(300, 200, 1410);
    expect(h.expanded()).toBe(true);

    h.openList();

    expect(h.expanded()).toBe(true);
  });

  it("toggles the list on a tap that never became a drag", async () => {
    const h = await mountBar(3, { listHeight: 200 });

    h.down(300, 300, 1000);
    h.up(300, 300, 1010);
    h.openList();

    expect(h.expanded()).toBe(true);
  });

  it("swallows the trailing click of a swipe that carried no move at all", async () => {
    // A flick with no intermediate pointermove (or a synthetic down/up) still
    // resolves as a switch, and still owns its trailing click.
    const h = await mountBar(3, { listHeight: 200, surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.up(300 - SWIPE_MIN_PX - 20, 300, 1010);
    expect(h.active()).toBe("two");

    h.openList();
    expect(h.expanded()).toBe(false);
  });

  it("swallows the trailing click of a bare vertical swipe", async () => {
    const h = await mountBar(3, { listHeight: 200 });

    h.down(300, 300, 1000);
    h.up(300, 300 - SWIPE_MIN_PX - 20, 1010);
    expect(h.expanded()).toBe(true);

    h.openList(); // would collapse the list it just opened
    expect(h.expanded()).toBe(true);
  });

  it("needs travel past the swipe minimum for a moveless swipe to resolve", async () => {
    const h = await mountBar(3, { surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.up(300 - SWIPE_MIN_PX, 300, 1010); // exactly the minimum: enough

    expect(h.active()).toBe("two");
  });

  it("needs one axis to dominate the other for a moveless swipe to resolve", async () => {
    // A drag exactly at the dominance ratio is still ambiguous: the horizontal
    // travel has to BEAT one-and-a-half times the vertical, not match it.
    const h = await mountBar(3, { surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.up(240, 260, 1010); // 60 across, 40 up: exactly 1.5x

    expect(h.active()).toBe("one");
    expect(h.expanded()).toBe(false);
  });

  it("needs the same dominance the other way round to open the list", async () => {
    const h = await mountBar(3, { listHeight: 200, surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.up(340, 240, 1010); // 40 across, 60 up: exactly 1.5x the other way

    expect(h.expanded()).toBe(false);
    expect(h.active()).toBe("one");
  });

  it("leaves the list alone for an upward nudge below the swipe minimum", async () => {
    // Straight up, so nothing competes with it — and still too short to mean
    // anything. A resting thumb moves a few pixels.
    const h = await mountBar(3, { listHeight: 200 });

    h.down(300, 300, 1000);
    h.up(300, 300 - SWIPE_MIN_PX + 20, 1010);

    expect(h.expanded()).toBe(false);
  });

  it("opens the list from a moveless swipe of exactly the minimum", async () => {
    const h = await mountBar(3, { listHeight: 200 });

    h.down(300, 300, 1000);
    h.up(300, 300 - SWIPE_MIN_PX, 1010);

    expect(h.expanded()).toBe(true);
  });

  it("leaves a moveless swipe alone while a program owns drags", async () => {
    getMouseMode.mockReturnValue(1000);
    const h = await mountBar(3, { surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.up(200, 300, 1010);

    expect(h.active()).toBe("one");
  });

  it("swallows the trailing click of a drag it abandoned to a program", async () => {
    // The bar stands down mid-drag when a mouse-mode application is capturing
    // drags — and having stood down, it must not let the release's click toggle
    // the list either: the gesture went to the program, not to the chrome.
    getMouseMode.mockReturnValue(1000);
    stubMatchMedia(false);
    const h = await mountBar(3, { listHeight: 200, surfaceWidth: 400 });

    h.down(300, 300, 1000);
    h.move(200, 300, 1010);
    h.up(200, 300, 1020);
    h.openList();

    expect(h.expanded()).toBe(false);
    expect(h.inner.style.transform).toBe(""); // nothing was previewed either
  });

  it("leaves the drag state clear after abandoning to a program", async () => {
    // Standing down has to end the gesture, not merely stop steering it: a drag
    // left marked active strands every later tap that checks for one — the tap
    // that dismisses an open overlay reads exactly that flag.
    getMouseMode.mockReturnValue(1000);
    const h = await mountBar(3, { listHeight: 200, surfaceWidth: 400 });
    h.openList();
    expect(h.expanded()).toBe(true);

    h.down(300, 300, 1000);
    h.move(200, 300, 1010); // abandoned here
    h.up(200, 300, 1020);
    h.surface.dispatchEvent(pointerEvent("pointerup", 10, 10, 2000));

    expect(h.expanded()).toBe(false);
  });
});

describe("tabs: dismissing an open overlay with a tap", () => {
  // A tap on the terminal closes whichever mobile overlay is open — the tab list
  // or the key grid — instead of opening the keyboard, so the first tap closes
  // and a second opens the keyboard.
  //
  // The tap is delivered capture-phase on the document, which is also what makes
  // it possible to prove: a listener on the surface itself stands in for the
  // kernel's own tap-to-focus, and whether it runs is the observable difference.
  function tapListener(h: Bar): { taps: () => number } {
    let taps = 0;
    h.surface.addEventListener("pointerup", () => {
      taps++;
    });
    return { taps: () => taps };
  }
  function tap(target: EventTarget): void {
    target.dispatchEvent(pointerEvent("pointerup", 10, 10, 5000));
  }

  it("collapses an open tab list, and does not pass the tap to the terminal", async () => {
    const h = await mountBar(3, { listHeight: 200 });
    const seen = tapListener(h);
    h.openList();
    expect(h.expanded()).toBe(true);

    tap(h.surface);

    expect(h.expanded()).toBe(false);
    expect(seen.taps()).toBe(0);
  });

  it("closes an open key grid, and does not pass the tap to the terminal", async () => {
    const kb = fakeKeyboardToggle(true);
    const h = await mountBar(3, { keyboard: kb.feature });
    const seen = tapListener(h);
    expect(kb.isOpen()).toBe(true);

    tap(h.surface);

    expect(kb.isOpen()).toBe(false);
    expect(seen.taps()).toBe(0);
  });

  it("leaves a tap alone when nothing is open", async () => {
    const h = await mountBar(3, { listHeight: 200 });
    const seen = tapListener(h);

    tap(h.surface);

    expect(seen.taps()).toBe(1); // the terminal's own tap-to-focus gets it
    expect(h.expanded()).toBe(false);
  });

  it("leaves a tap inside the switcher to the switcher's own controls", async () => {
    const h = await mountBar(3, { listHeight: 200 });
    h.openList();

    tap(h.switcher);

    expect(h.expanded()).toBe(true);
  });

  it("leaves a tap inside the tab strip to the strip's own controls", async () => {
    // The desktop strip counts as chrome too: without it, the strip's keyboard
    // button closed the grid on its own pointerup and its click re-opened it, so
    // the button could never close the grid.
    const kb = fakeKeyboardToggle(true);
    const h = await mountBar(3, { keyboard: kb.feature });
    const strip = h.root.querySelector<HTMLElement>(".wt-tab-bar");
    if (!strip) {
      throw new Error("no tab strip");
    }

    tap(strip);

    expect(kb.isOpen()).toBe(true);
  });

  it("leaves a tap inside the key toolbar to the toolbar's own controls", async () => {
    // The toolbar is a sibling feature's surface (mobile-toolbar renders
    // .key-toolbar into the kernel's bottom region); this stands in for it, as
    // the fake keyboardToggle above stands in for its API.
    const kb = fakeKeyboardToggle(true);
    const h = await mountBar(3, { keyboard: kb.feature });
    const toolbar = document.createElement("div");
    toolbar.className = "key-toolbar";
    h.root.appendChild(toolbar);

    tap(toolbar);

    expect(kb.isOpen()).toBe(true);
  });

  it("stands down while a bar gesture owns the pointer", async () => {
    // The gesture's own release logic resolves the outcome. Swallowing that
    // pointerup here would strand the drag state and brick every later swipe.
    const kb = fakeKeyboardToggle(true);
    const h = await mountBar(3, { keyboard: kb.feature });

    h.down(300, 300, 1000);
    tap(h.surface); // the finger lifts over the terminal, mid-gesture

    expect(kb.isOpen()).toBe(true);
  });
});

describe("tabs: dismissing the tab menu", () => {
  function openMenu(root: HTMLElement, index: number): HTMLElement | null {
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[index];
    chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    return root.querySelector<HTMLElement>(".wt-tab-menu");
  }
  function pressKey(root: HTMLElement, key: string): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    root.querySelector<HTMLTextAreaElement>(".term-input")?.dispatchEvent(ev);
    return ev;
  }

  it("closes on a right-click anywhere other than a tab", async () => {
    const h = await mountBar(3, { listHeight: 200 });
    const menu = openMenu(h.root, 0);
    expect(menu?.classList.contains("visible")).toBe(true);

    h.surface.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(menu?.classList.contains("visible")).toBe(false);
  });

  it("stays open for a right-click on another tab, which reopens it there", async () => {
    // A tab's own handler runs first and reopens the menu; the document handler
    // must not then close what that just opened.
    const h = await mountBar(3, { listHeight: 200 });
    openMenu(h.root, 0);
    const menu = openMenu(h.root, 1);

    expect(menu?.classList.contains("visible")).toBe(true);
  });

  it("closes on Escape, and does not also send Escape to the shell", async () => {
    const h = await mountBar(3, { listHeight: 200 });
    const menu = openMenu(h.root, 0);
    sendBinary.mockClear();

    const ev = pressKey(h.root, "Escape");

    expect(menu?.classList.contains("visible")).toBe(false);
    expect(sendBinary).not.toHaveBeenCalled();
    // The key is claimed, not merely swallowed: an unprevented Escape still
    // carries whatever default the platform attaches to it (leaving fullscreen,
    // cancelling an IME composition).
    expect(ev.defaultPrevented).toBe(true);
  });

  it("leaves Escape to the shell when no menu is open", async () => {
    const h = await mountBar(3, { listHeight: 200 });
    sendBinary.mockClear();

    pressKey(h.root, "Escape");

    // The one Escape byte, delivered by the kernel's own mapping because this
    // feature did not claim the key.
    expect(sendBinary).toHaveBeenCalledTimes(1);
    expect([...(sendBinary.mock.calls[0]?.[0] ?? [])]).toEqual([0x1b]);
  });

  it("leaves an ordinary key alone with the menu open", async () => {
    const h = await mountBar(3, { listHeight: 200 });
    const menu = openMenu(h.root, 0);

    pressKey(h.root, "ArrowUp");

    expect(menu?.classList.contains("visible")).toBe(true);
  });
});

describe("tabs: the switcher's active-row close", () => {
  it("closes the tab the bar is showing", async () => {
    const h = await mountBar(3, { listHeight: 200 });
    const close = h.root.querySelector<HTMLElement>(".wt-switcher-current-close");
    fetchMock.mockClear();

    close?.click();
    await until(() => h.root.querySelectorAll(".wt-tab").length === 2, 60);

    const deleted = fetchMock.mock.calls
      .filter((c) => (c[1]?.method ?? "GET") === "DELETE")
      .map((c) => String(c[0]).split("/").pop());
    expect(deleted).toEqual(["s1"]);
  });
});

describe("tabs: teardown hands the out-of-page surfaces back", () => {
  // The chrome goes with the kernel's regions, and the document title is the
  // kernel's own to compose and clear. The tab ICON is neither: it is this
  // feature's write onto a document-wide surface that outlives the terminal —
  // a browser remembers one icon per URL and renders it for the bookmark, the
  // history row and the new-tab tile.
  function statusMonitor(): {
    feature: TerminalFeature<ActivityMonitorApi>;
    emit: (s: SessionStatus) => void;
  } {
    const subs = new Set<(s: SessionStatus) => void>();
    return {
      feature: {
        name: "activityMonitor",
        setup() {
          return {
            api: {
              onStatus(cb) {
                subs.add(cb);
                return () => subs.delete(cb);
              },
              current: () => undefined,
            },
            teardown: () => undefined,
          };
        },
      },
      emit: (s) => {
        for (const cb of [...subs]) {
          cb(s);
        }
      },
    };
  }

  it("puts the page's own icon back when the terminal is destroyed", async () => {
    // Read back through the link this test inserted, not through the first
    // `link[rel~="icon"]` in the document: the tester page ships an icon link of
    // its own (`/__vitest__/favicon.svg`), so a document-wide query returns that
    // one and the assertion measures the harness. Production rewrites EVERY icon
    // link by design, so it rewrites both; this is the one under test.
    const ownIcon = document.createElement("link");
    ownIcon.rel = "icon";
    ownIcon.setAttribute("href", "/favicon.svg");
    document.head.appendChild(ownIcon);
    const iconHref = (): string | null => ownIcon.getAttribute("href");
    try {
      const monitor = statusMonitor();
      const root = document.createElement("div");
      document.body.appendChild(root);
      term = createTerminal(root, {
        features: () => [
          monitor.feature,
          tabs({ activityMonitor: monitor.feature, attentionIcons: true }),
        ],
      });
      await until(() => root.querySelectorAll(".wt-tab").length === 3);

      monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
      expect(iconHref()).toBe("/favicon-input.svg");

      term.destroy();
      term = undefined;

      expect(iconHref()).toBe("/favicon.svg");
    } finally {
      ownIcon.remove();
    }
  });
});

describe("tabs: what list() reports", () => {
  it("marks exactly the active tab active", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const feature = tabs();
    term = createTerminal(root, { features: () => [feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    expect(feature.api?.list()).toEqual([
      { id: "s1", title: "one", active: true },
      { id: "s2", title: "two", active: false },
      { id: "s3", title: "three", active: false },
    ]);

    root.querySelectorAll<HTMLElement>(".wt-tab")[2]?.click();

    expect(
      feature.api
        ?.list()
        .filter((t) => t.active)
        .map((t) => t.id),
    ).toEqual(["s3"]);
  });
});

describe("tabs: the bootstrap's choice of starting tab", () => {
  // A monitor that pushes the existing sessions the moment tabs subscribes,
  // which is what the real status stream does: the chrome is up, with chips, well
  // before the initial GET /api/sessions resolves.
  function snapshotMonitor(
    snapshot: readonly SessionStatus[],
  ): TerminalFeature<ActivityMonitorApi> {
    return {
      name: "activityMonitor",
      setup() {
        return {
          api: {
            onStatus(cb) {
              for (const s of snapshot) {
                cb(s);
              }
              return () => undefined;
            },
            current: () => undefined,
          },
          teardown: () => undefined,
        };
      },
    };
  }

  it("leaves a tab the user picked mid-boot alone", async () => {
    // The chrome mounts synchronously and the status stream fills it, so a chip
    // can be tapped before the list lands. An explicit gesture outranks the
    // ladder: activating anything else now would flash the wrong screen and burn
    // a socket attach on it.
    let release = (): void => undefined;
    listGate = new Promise<void>((r) => {
      release = r;
    });
    const monitor = snapshotMonitor([
      { id: "s1", status: "idle", title: "one", createdAt: "1" },
      { id: "s2", status: "idle", title: "two", createdAt: "2" },
    ]);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [monitor, tabs({ activityMonitor: monitor })] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click(); // ...while the list is in flight
    release();
    await until(() => setSession.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 0)); // let the list round-trip settle

    expect(root.querySelectorAll(".wt-tab")[1]?.classList.contains("wt-tab-active")).toBe(true);
    expect(setSession.mock.calls.map((c) => c[0])).toEqual(["s2"]);
  });

  it("leaves the keyboard on the terminal, not on the chrome it just mounted", async () => {
    // An end-state assertion: the kernel focuses the input on its own boot as
    // well, so this pins where the keyboard ends up rather than which layer put
    // it there. Worth stating because the chrome is a row of BUTTONS, and any of
    // them taking focus during the mount would open the page with the keyboard
    // parked on a tab chip.
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    expect(document.activeElement).toBe(root.querySelector(".term-input"));
  });
});

describe("tabs: booting onto a page whose sessions have all ended", () => {
  it("restores the saved ended tab rather than the oldest, when nothing is live", async () => {
    // Live sessions outrank ended ones, so the saved id is normally honoured
    // only while its session lives. When NOTHING is live the ladder has no live
    // tab to prefer, and the tab the user left on is the better landing than the
    // oldest corpse.
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "exited" },
      { id: "s2", title: "two", createdAt: "2", status: "exited" },
    ];
    createStatus = 500; // the fresh spawn fails too, so nothing becomes live
    localStorage.setItem("wt-active-session", "s2");
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    await until(() => root.querySelector(".wt-tab-active") !== null, 60);

    expect(root.querySelectorAll(".wt-tab")[1]?.classList.contains("wt-tab-active")).toBe(true);
    // And the toast says only what it knows: the server offered no explanation,
    // so none is invented (and no "undefined" is shown to the user).
    expect(root.querySelector(".wt-toast")?.textContent).toBe("Couldn't open a terminal");
  });
});
