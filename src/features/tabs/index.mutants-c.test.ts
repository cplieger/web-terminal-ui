// tabs feature, chrome-sync half: the surfaces syncChrome refreshes and the
// per-chip wiring that feeds them — paintActive's "reveal the newly active chip"
// rule, the dedicated switch button's ≥2-tabs gate, the expanded switcher list
// (row reconcile, add/remove motion, the reel rotation, the deferred row clear),
// applyServerOrder's read half of tab-order sync, and switchTo's slide-direction
// derivation.
//
// A separate file from index.test.ts rather than an extension of it, so this
// module's coverage can grow from three directions at once. The harness (engine
// mock, fetch stub, fakeMonitor, until) is deliberately duplicated: each file has
// to stand on its own, and vitest gives each one its own module graph anyway.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";
import type { TerminalFeature } from "../../kernel/types.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
import type { MobileToolbarApi } from "../mobile-toolbar.js";

// A fake activityMonitor: lets a test push status events (a new title, a new
// server `order`, a status change) into tabs without the real SSE.
function fakeMonitor(): {
  feature: TerminalFeature<ActivityMonitorApi>;
  emit: (s: SessionStatus) => void;
} {
  const subs = new Set<(s: SessionStatus) => void>();
  const feature: TerminalFeature<ActivityMonitorApi> = {
    name: "activityMonitor",
    setup() {
      return {
        api: {
          onStatus(cb) {
            subs.add(cb);
            return () => subs.delete(cb);
          },
          current: () => undefined,
          onStreamOpen: () => () => undefined,
        },
        teardown: () => undefined,
      };
    },
  };
  return {
    feature,
    emit: (s) => {
      for (const cb of [...subs]) {
        cb(s);
      }
    },
  };
}

// A fake keyboardToggle (MobileToolbarApi provider), so the key-grid teardown the
// expanding list performs has a real grid to close.
function fakeKeyboardToggle(): {
  feature: TerminalFeature<MobileToolbarApi>;
  isOpen: () => boolean;
} {
  let open = false;
  const feature: TerminalFeature<MobileToolbarApi> = {
    name: "mobileToolbar",
    setup() {
      return {
        api: {
          toggle() {
            open = !open;
          },
          isOpen: () => open,
          isCtrlArmed: () => false,
          onCtrlArmedChange: () => () => undefined,
        },
        teardown: () => undefined,
      };
    },
  };
  return { feature, isOpen: () => open };
}

const setSession = vi.fn<(id: string) => void>();
const forgetSession = vi.fn<(id: string) => void>();
const bind = vi.fn();
// A DISTINCT view per call, never one constant: the round trip under test is "the
// position THIS tab saved comes back to THIS tab", and a double that answers the
// same object for every tab passes just as well when the wrong tab's position is
// handed back.
let viewSeq = 0;
const captureViewMemory = vi.fn(() => ({ abs: 100 + ++viewSeq, screenTop: -3, following: false }));
const pendingRowCount = vi.fn(() => 0);
const getHighestIndex = vi.fn(() => -1);

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
      updateReverseVideo: vi.fn(),
      resetScrollback: vi.fn(),
      resetScreen: vi.fn(),
      dropBrowseCache: vi.fn(),
      bind,
      captureViewMemory,
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
      sendBinary: vi.fn(() => true),
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect: vi.fn(),
      setSession,
      forgetSession,
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
let spawnSeq = 0;
const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "POST") {
    spawnSeq++;
    // createdAt is a year here (Date.parse of "1"/"2"/...), so a spawned session
    // has to be dated AFTER the listed ones or it sorts to the head of the strip.
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
  if (method === "DELETE") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  if (method === "PUT") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  return Promise.resolve(jsonResponse(listBody, 200));
});

beforeEach(async () => {
  vi.resetModules();
  setSession.mockClear();
  forgetSession.mockClear();
  bind.mockClear();
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

// A query-aware matchMedia, same reasoning as index.test.ts's: the feature asks
// three different questions of it and a blanket answer answers the wrong one.
// Installing it explicitly is what makes a case say which question it is
// answering, rather than inheriting whatever the host browser reports.
function stubMedia(answers: Record<string, boolean>): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: answers[query] ?? false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

const REDUCE = "(prefers-reduced-motion: reduce)";

interface Mounted {
  root: HTMLElement;
  chips: () => NodeListOf<HTMLElement>;
  labels: () => string[];
  rows: () => NodeListOf<HTMLElement>;
  rowLabels: () => string[];
  switcher: HTMLElement;
  swSwitch: HTMLElement;
  current: HTMLElement;
  list: HTMLElement;
}

function pick(root: HTMLElement, sel: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) {
    throw new Error(`no ${sel}`);
  }
  return el;
}

// Mount tabs over the current listBody and wait for every listed session to have
// a chip. Returns the surfaces every case below reads.
async function mount(feature?: TerminalFeature<unknown>[]): Promise<Mounted> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const wanted = listBody.length;
  term = createTerminal(root, { features: () => feature ?? [tabs()] });
  await until(() => root.querySelectorAll(".wt-tab").length === wanted);
  return {
    root,
    chips: () => root.querySelectorAll<HTMLElement>(".wt-tab"),
    labels: () =>
      [...(pick(root, ".wt-tab-scroll").querySelectorAll<HTMLElement>(".wt-tab-label") ?? [])].map(
        (e) => e.textContent ?? "",
      ),
    rows: () => root.querySelectorAll<HTMLElement>(".wt-switcher-row"),
    rowLabels: () =>
      [...root.querySelectorAll<HTMLElement>(".wt-switcher-row-label")].map(
        (e) => e.textContent ?? "",
      ),
    switcher: pick(root, ".wt-switcher"),
    swSwitch: pick(root, ".wt-switcher-switch"),
    current: pick(root, ".wt-switcher-current"),
    list: pick(root, ".wt-switcher-list"),
  };
}

function four(): void {
  listBody = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
    { id: "s3", title: "three", createdAt: "3", status: "idle" },
    { id: "s4", title: "four", createdAt: "4", status: "idle" },
  ];
}

describe("tabs: the switch button's ≥2-tabs gate", () => {
  it("keeps the dedicated switch button out of the a11y tree and the tab order while one tab is open", async () => {
    listBody = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const m = await mount();

    // One tab has nothing to switch to, so the button is collapsed: no multi
    // class driving its motion, hidden from assistive tech, out of Tab order.
    expect(m.switcher.classList.contains("wt-switcher-multi")).toBe(false);
    expect(m.swSwitch.getAttribute("aria-hidden")).toBe("true");
    expect(m.swSwitch.tabIndex).toBe(-1);

    // A second session earns it its place, on all three surfaces at once.
    pick(m.root, ".wt-tab-new").click();
    await until(() => m.chips().length === 2);

    expect(m.switcher.classList.contains("wt-switcher-multi")).toBe(true);
    expect(m.swSwitch.getAttribute("aria-hidden")).toBe("false");
    expect(m.swSwitch.tabIndex).toBe(0);
  });

  it("collapses the switch button again when the tab count falls back to one", async () => {
    const m = await mount();
    expect(m.switcher.classList.contains("wt-switcher-multi")).toBe(true);

    // Closing down to a single tab has to undo all three, or a lone tab keeps a
    // focusable button that opens a list with nothing in it.
    pick(m.chips()[1] ?? m.root, ".wt-tab-close").click();
    await until(() => m.chips().length === 1);

    expect(m.switcher.classList.contains("wt-switcher-multi")).toBe(false);
    expect(m.swSwitch.getAttribute("aria-hidden")).toBe("true");
    expect(m.swSwitch.tabIndex).toBe(-1);
  });

  it("refuses to expand the list when there is only one tab to list", async () => {
    listBody = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const m = await mount();

    m.current.click();

    expect(m.switcher.classList.contains("wt-switcher-expanded")).toBe(false);
    expect(m.rows().length).toBe(0);
  });
});

describe("tabs: the expanded list follows state changes", () => {
  it("builds no rows at all while the list is collapsed", async () => {
    const monitor = fakeMonitor();
    const m = await mount([monitor.feature, tabs({ activityMonitor: monitor.feature })]);

    monitor.emit({ id: "s2", status: "working", title: "two", createdAt: "2" });

    expect(m.switcher.classList.contains("wt-switcher-expanded")).toBe(false);
    expect(m.rows().length).toBe(0);
  });

  it("refreshes an open row's label and dot from a later status event", async () => {
    const monitor = fakeMonitor();
    const m = await mount([monitor.feature, tabs({ activityMonitor: monitor.feature })]);
    m.current.click();
    expect(m.rowLabels()).toEqual(["two"]);

    monitor.emit({
      id: "s2",
      status: "input",
      title: "two: waiting",
      createdAt: "2",
      reportsActivity: true,
    });

    expect(m.rowLabels()).toEqual(["two: waiting"]);
    expect(pick(m.root, ".wt-switcher-row-dot").dataset["status"]).toBe("input");
  });

  it("lists a tab opened while the list is already expanded", async () => {
    const m = await mount();
    m.current.click();
    expect(m.rows().length).toBe(1);

    pick(m.root, ".wt-switcher-new").click();
    await until(() => m.chips().length === 3);

    // The new tab becomes active, so the two it displaced are the listed ones.
    expect(m.rows().length).toBe(2);
    expect(m.rowLabels().sort()).toEqual(["one", "two"]);
  });
});

describe("tabs: revealing the newly active chip", () => {
  // The strip is an overflowed scroller on the desktop, so activating a chip that
  // is scrolled out of sight has to bring it back. The rule is deliberately
  // narrow: on an active-tab CHANGE, never on an unrelated repaint, or a user
  // reading a scrolled strip is yanked back by someone else's status event.
  function watchReveal(): { targets: () => HTMLElement[]; args: () => unknown[] } {
    const targets: HTMLElement[] = [];
    const args: unknown[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
      this: HTMLElement,
      opts?: unknown,
    ) {
      targets.push(this);
      args.push(opts);
    });
    return { targets: () => targets, args: () => args };
  }

  it("reveals the chip a switch moved to, in its own scroller and not the page", async () => {
    four();
    const seen = watchReveal();
    const m = await mount();
    // The bootstrap activation is itself a change, so the opening tab is revealed.
    expect(seen.targets()).toEqual([m.chips()[0]]);
    // block/inline "nearest" is the whole point: a bare scrollIntoView() scrolls
    // the page to the strip as well as the strip to the chip.
    expect(seen.args()[0]).toEqual({ block: "nearest", inline: "nearest" });

    m.chips()[2]?.click();

    expect(seen.targets()).toEqual([m.chips()[0], m.chips()[2]]);
  });

  it("does not re-reveal on a repaint that left the active tab alone", async () => {
    four();
    const monitor = fakeMonitor();
    const seen = watchReveal();
    const m = await mount([monitor.feature, tabs({ activityMonitor: monitor.feature })]);
    expect(seen.targets().length).toBe(1);

    // Three unrelated repaints: a background tab's status, the active tab's own
    // status, and a rename. None of them changed WHICH tab is active.
    monitor.emit({ id: "s3", status: "working", title: "three", createdAt: "3" });
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1" });
    monitor.emit({ id: "s1", status: "idle", title: "one renamed", createdAt: "1" });

    expect(seen.targets().length).toBe(1);
    expect(m.labels()[0]).toBe("one renamed");
  });
});

describe("tabs: applyServerOrder (the read half of tab-order sync)", () => {
  it("re-sorts the strip when a status event carries a new server order", async () => {
    four();
    const monitor = fakeMonitor();
    const m = await mount([monitor.feature, tabs({ activityMonitor: monitor.feature })]);
    expect(m.labels()).toEqual(["one", "two", "three", "four"]);

    // A drag on another device: the server placed s4 first and s1 after it.
    monitor.emit({ id: "s4", status: "idle", title: "four", createdAt: "4", order: 0 });
    monitor.emit({ id: "s1", status: "idle", title: "one", createdAt: "1", order: 1 });

    // Both the list order and the DOM order move, or the next keyboard arrow
    // steps to a neighbour that is somewhere else on screen.
    expect(m.labels()).toEqual(["four", "one", "two", "three"]);
  });

  it("keeps the strip in server order across a repaint that changes nothing else", async () => {
    four();
    const monitor = fakeMonitor();
    const m = await mount([monitor.feature, tabs({ activityMonitor: monitor.feature })]);
    monitor.emit({ id: "s3", status: "idle", title: "three", createdAt: "3", order: 0 });
    expect(m.labels()).toEqual(["three", "one", "two", "four"]);

    // The echo of a locally-committed reorder, and any later status tick, must
    // land as a no-op rather than a second visible move.
    monitor.emit({ id: "s3", status: "working", title: "three", createdAt: "3", order: 0 });
    monitor.emit({ id: "s2", status: "working", title: "two", createdAt: "2" });

    expect(m.labels()).toEqual(["three", "one", "two", "four"]);
  });

  it("leaves the strip alone while a drag owns it, and applies the order once the drag ends", async () => {
    four();
    const monitor = fakeMonitor();
    const m = await mount([monitor.feature, tabs({ activityMonitor: monitor.feature })]);
    const chip = m.chips()[0];
    if (!chip) {
      throw new Error("no chip");
    }

    const dragstart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, "dataTransfer", { value: null });
    chip.dispatchEvent(dragstart);

    // A remote reorder arriving mid-gesture must not re-sort under the finger.
    monitor.emit({ id: "s4", status: "idle", title: "four", createdAt: "4", order: 0 });
    expect(m.labels()).toEqual(["one", "two", "three", "four"]);

    // Once the pointer lets go, the pending server order is applied.
    chip.dispatchEvent(new Event("dragend", { bubbles: true }));
    monitor.emit({ id: "s2", status: "working", title: "two", createdAt: "2" });
    expect(m.labels()).toEqual(["four", "one", "two", "three"]);
  });
});

describe("tabs: per-chip event wiring", () => {
  it("suppresses the middle-click default on mousedown, and only for the middle button", async () => {
    // Without this the browser's autoscroll/paste affordance fires on the very
    // press that is closing the tab.
    const m = await mount();
    const chip = m.chips()[0];
    if (!chip) {
      throw new Error("no chip");
    }

    const middle = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    chip.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);

    // A left press must keep its default: it is what focuses the chip.
    const left = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    chip.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
  });

  it("closes on a middle auxclick and ignores a right one", async () => {
    const m = await mount();
    const chip = m.chips()[1];
    if (!chip) {
      throw new Error("no chip");
    }

    const right = new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true });
    chip.dispatchEvent(right);
    await until(() => m.chips().length === 1);
    expect(m.chips().length).toBe(2);

    const middle = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    chip.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    await until(() => m.chips().length === 1);
    expect(m.chips().length).toBe(1);
  });

  it("consumes the keys it acts on, so the strip does not scroll under them too", async () => {
    four();
    const m = await mount();
    const chip = m.chips()[1];
    if (!chip) {
      throw new Error("no chip");
    }

    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "F2"]) {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      chip.dispatchEvent(e);
      expect(e.defaultPrevented, key).toBe(true);
    }
    // A key the strip does not claim keeps its default.
    const plain = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    chip.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });

  it("consumes the Delete that closes the focused tab", async () => {
    const m = await mount();
    const chip = m.chips()[1];
    if (!chip) {
      throw new Error("no chip");
    }

    const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    chip.dispatchEvent(del);

    expect(del.defaultPrevented).toBe(true);
    await until(() => m.chips().length === 1);
    expect(m.chips().length).toBe(1);
  });

  it("suppresses the browser's text selection on the double-click that renames", async () => {
    const m = await mount();
    const chip = m.chips()[0];
    if (!chip) {
      throw new Error("no chip");
    }

    const dbl = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
    chip.dispatchEvent(dbl);

    expect(dbl.defaultPrevented).toBe(true);
    expect(chip.querySelector(".wt-tab-rename")).not.toBeNull();
  });

  it("suppresses the browser's own menu on the right-click that opens the tab menu", async () => {
    const m = await mount();
    const chip = m.chips()[0];
    if (!chip) {
      throw new Error("no chip");
    }

    const menu = new MouseEvent("contextmenu", {
      clientX: 10,
      clientY: 10,
      bubbles: true,
      cancelable: true,
    });
    chip.dispatchEvent(menu);

    expect(menu.defaultPrevented).toBe(true);
    expect(m.root.querySelector(".wt-tab-menu")).not.toBeNull();
  });

  it("marks every chip draggable, which is what arms the reorder gesture", async () => {
    const m = await mount();
    for (const chip of m.chips()) {
      expect(chip.draggable).toBe(true);
    }
  });

  it("keeps a click on the close button from also switching to the tab", async () => {
    const m = await mount();
    setSession.mockClear();
    bind.mockClear();

    pick(m.chips()[1] ?? m.root, ".wt-tab-close").click();
    await until(() => m.chips().length === 1);

    // s2 went away; the switch that would have preceded it never happened.
    expect(setSession).not.toHaveBeenCalledWith("s2");
    expect(bind).not.toHaveBeenCalled();
  });
});

describe("tabs: switchTo", () => {
  const SWITCH_CLASSES = ["wt-switching", "wt-switching-next", "wt-switching-prev"];
  function switchClass(surface: Element): string | undefined {
    return SWITCH_CLASSES.find((c) => surface.classList.contains(c));
  }
  // The class lands inside a rAF, so a case that reads it has to pump one.
  function frames(): { pump: () => void } {
    let next = 1;
    const queue = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      const h = next++;
      queue.set(h, cb);
      return h;
    });
    vi.stubGlobal("cancelAnimationFrame", (h: number): void => {
      queue.delete(h);
    });
    return {
      pump: () => {
        const due = [...queue.values()];
        queue.clear();
        for (const cb of due) {
          cb(0);
        }
      },
    };
  }

  it("does nothing but answer the focus rule when the press lands on the active tab", async () => {
    const m = await mount();
    setSession.mockClear();
    bind.mockClear();
    captureViewMemory.mockClear();

    m.chips()[0]?.click();

    // No re-bind, no reconnect, no view capture: it is already the open tab.
    expect(bind).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(captureViewMemory).not.toHaveBeenCalled();
  });

  it("slides forward for a later tab and backward for an earlier one", async () => {
    four();
    const m = await mount();
    const surface = pick(m.root, ".term");
    const f = frames();

    m.chips()[2]?.click(); // s1 -> s3, a later tab
    f.pump();
    expect(switchClass(surface)).toBe("wt-switching-next");

    m.chips()[1]?.click(); // s3 -> s2, an earlier one
    f.pump();
    expect(switchClass(surface)).toBe("wt-switching-prev");
  });

  it("honours the direction a swipe hands it, even when the indices disagree", async () => {
    // A swipe past the last tab wraps to the first, so the gesture's direction
    // ("next") is the opposite of the index delta. The gesture owns the feel: the
    // content must follow the finger, not the array.
    four();
    const m = await mount();
    const surface = pick(m.root, ".term");
    const f = frames();
    m.chips()[3]?.click(); // park on the last tab
    f.pump();

    m.current.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 240, clientY: 10, bubbles: true }),
    );
    m.current.dispatchEvent(
      new MouseEvent("pointerup", { clientX: 60, clientY: 12, bubbles: true }),
    );
    f.pump();

    expect(setSession).toHaveBeenCalledWith("s1");
    expect(switchClass(surface)).toBe("wt-switching-next");
  });

  it("hands each tab back the reading position it saved, not the other tab's", async () => {
    const m = await mount();
    bind.mockClear();
    captureViewMemory.mockClear();

    m.chips()[1]?.click(); // leaves s1: its position is captured here
    const s1View = captureViewMemory.mock.results[0]?.value;
    expect(captureViewMemory).toHaveBeenCalledTimes(1);
    m.chips()[0]?.click(); // leaves s2, and reopens s1

    // s1 gets the position s1 saved. The renderer owns the pixel<->line mapping,
    // so this round trip through it is what survives the rebuild.
    expect(bind).toHaveBeenLastCalledWith(expect.anything(), { view: s1View });
    expect(captureViewMemory).toHaveBeenCalledTimes(2);
  });
});

describe("tabs: the key grid yields to the expanded list", () => {
  it("closes an open key grid and resets both keyboard buttons when the list expands", async () => {
    const kbt = fakeKeyboardToggle();
    const m = await mount([kbt.feature, tabs({ keyboardToggle: kbt.feature })]);
    const deskKb = pick(m.root, ".wt-tab-kb");
    const mobKb = pick(m.root, ".wt-switcher-kb");
    deskKb.click();
    expect(kbt.isOpen()).toBe(true);

    m.current.click(); // expand the tab list

    // The grid would otherwise open behind the list, with both buttons still
    // claiming it is open.
    expect(kbt.isOpen()).toBe(false);
    expect(deskKb.getAttribute("aria-expanded")).toBe("false");
    expect(mobKb.getAttribute("aria-expanded")).toBe("false");
    expect(deskKb.classList.contains("wt-active")).toBe(false);
    expect(mobKb.classList.contains("wt-active")).toBe(false);
  });
});

describe("tabs: the expanded/collapsed resting state", () => {
  it("reports the expanded state on the bar row and announces the change", async () => {
    const m = await mount();
    expect(m.current.getAttribute("aria-expanded")).toBe("false");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    m.current.click();
    expect(m.current.getAttribute("aria-expanded")).toBe("true");
    // The announcer re-sets the cleared region after a ~100ms timer.
    vi.advanceTimersByTime(130);
    expect(pick(m.root, '[aria-live="polite"]').textContent).toBe("Terminal list expanded");

    m.current.click();
    expect(m.current.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles cleanly on a third tap, so the state cannot latch open", async () => {
    const m = await mount();
    m.current.click();
    m.current.click();
    m.current.click();
    expect(m.switcher.classList.contains("wt-switcher-expanded")).toBe(true);
    expect(m.rows().length).toBe(1);
  });

  it("keeps the rows out of the a11y tree only after the collapse has run", async () => {
    const m = await mount();
    m.current.click();
    expect(m.rows().length).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    m.current.click(); // collapse
    // Still listed while the collapse animates, or the tray empties visibly.
    expect(m.rows().length).toBe(1);
    vi.advanceTimersByTime(300);
    expect(m.rows().length).toBe(0);
  });

  it("does not clear the rows of a list that was reopened before the collapse landed", async () => {
    const m = await mount();
    m.current.click();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    m.current.click(); // collapse
    vi.advanceTimersByTime(100);
    m.current.click(); // reopened while the collapse was still pending
    vi.advanceTimersByTime(400);

    expect(m.switcher.classList.contains("wt-switcher-expanded")).toBe(true);
    expect(m.rows().length).toBe(1);
  });
});

// The expanded list's motion is measured in pixels, and an unstyled row has no
// height to move by — which is not a neutral default here: animateRowIn bails on a
// zero-height row and the reel's pitch collapses to 0, so a case built on whatever
// the bare markup laid out as proves nothing about either. This gives the ROWS and
// their LIST (only) a chosen box: 40px rows stacked in DOM order inside a list
// whose own box starts at `listTop`. Everything else keeps the environment's own
// answer, so the strip's own scroll maths is untouched.
//
// Rows lifted OUT of the flow (the reel's absolute ghost) occupy no slot, which is
// what a browser does and what the reel depends on: the survivors close up over
// the row that left.
//
// `onListMeasured` fires whenever the list's own box is read. The reel reads it
// once to locate the list and once more as the forced reflow that COMMITS the
// from-state, so a case that wants to see the from-state — which the to-state
// overwrites inside the same function — watches from there.
const ROW_H = 40;
function stubRowLayout(
  opts: { listTop?: number; gap?: number; onListMeasured?: () => void } = {},
): void {
  const listTop = opts.listTop ?? 0;
  const pitch = ROW_H + (opts.gap ?? 0);
  const real = HTMLElement.prototype.getBoundingClientRect;
  const box = (top: number, height: number): DOMRect =>
    ({
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: 200,
      width: 200,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("wt-switcher-list")) {
      opts.onListMeasured?.();
      return box(listTop, this.children.length * pitch);
    }
    if (!this.classList.contains("wt-switcher-row")) {
      return real.call(this);
    }
    const flow = [...(this.parentElement?.children ?? [])].filter(
      (c) => !(c instanceof HTMLElement) || c.style.position !== "absolute",
    );
    return box(listTop + Math.max(0, flow.indexOf(this)) * pitch, ROW_H);
  });
}

// A frame pump: the row animations and the reel commit their to-state inside a
// rAF, so a case that reads the settled state has to run the frame itself rather
// than hope one arrives.
function framePump(): () => void {
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    const h = next++;
    queue.set(h, cb);
    return h;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number): void => {
    queue.delete(h);
  });
  return () => {
    const due = [...queue.values()];
    queue.clear();
    for (const cb of due) {
      cb(0);
    }
  };
}

// A leftward flick of the bar: no pointermove, so the gesture resolves from the
// net delta (the discrete-switch fallback), which is the swipe every reel case
// below drives.
function flickNext(current: HTMLElement): void {
  current.dispatchEvent(
    new MouseEvent("pointerdown", { clientX: 240, clientY: 10, bubbles: true }),
  );
  current.dispatchEvent(new MouseEvent("pointerup", { clientX: 60, clientY: 12, bubbles: true }));
}

// A downward flick collapses the list. Used instead of a tap where a swipe came
// first: the trailing click of a gesture is deliberately swallowed, so a tap
// straight after a flick toggles nothing.
function flickDown(current: HTMLElement): void {
  current.dispatchEvent(
    new MouseEvent("pointerdown", { clientX: 100, clientY: 10, bubbles: true }),
  );
  current.dispatchEvent(new MouseEvent("pointerup", { clientX: 100, clientY: 110, bubbles: true }));
}

// A rightward flick goes to the PREVIOUS tab, wrapping past the first one.
function flickPrev(current: HTMLElement): void {
  current.dispatchEvent(new MouseEvent("pointerdown", { clientX: 60, clientY: 10, bubbles: true }));
  current.dispatchEvent(new MouseEvent("pointerup", { clientX: 240, clientY: 12, bubbles: true }));
}

// A row is addressed by the label it shows, never by its position: the list
// rotates, so position names nothing stable.
function rowByLabel(m: Mounted, label: string): HTMLElement | undefined {
  return [...m.rows()].find(
    (r) => r.querySelector(".wt-switcher-row-label")?.textContent === label,
  );
}

describe("tabs: the expanded list's row reconcile", () => {
  it("publishes the measured content height, capped at half the viewport", async () => {
    // The tray animates its max-height between 0 and the REAL content height; a
    // fixed 50dvh made the open finish early and the close start late. The cap is
    // what keeps a long list scrollable instead of taller than the screen.
    const m = await mount();
    Object.defineProperty(m.list, "scrollHeight", { value: 1000, configurable: true });

    m.current.click();

    // Half of the REAL viewport, read here rather than written as a constant: the
    // number is a property of the environment (the browser project pins 1280x720,
    // so 360px), and the claim under test is the cap RULE, not the height of any
    // one browser window. The content is 1000px, so the cap demonstrably applied.
    const half = window.innerHeight / 2;
    expect(half).toBeLessThan(1000);
    expect(m.switcher.style.getPropertyValue("--wt-list-h")).toBe(`${String(half)}px`);
  });

  it("publishes the content height itself when the content is shorter than the cap", async () => {
    const m = await mount();
    Object.defineProperty(m.list, "scrollHeight", { value: 120, configurable: true });

    m.current.click();

    expect(m.switcher.style.getPropertyValue("--wt-list-h")).toBe("120px");
  });

  it("reveals the rows of the initial expand without animating each one in", async () => {
    // The expand itself is the animation (the tray's max-height); a per-row grow
    // on top of it double-animates the open.
    four();
    stubRowLayout();
    const m = await mount();

    m.current.click();

    expect(m.rows().length).toBe(3);
    for (const row of m.rows()) {
      expect(row.style.maxHeight).toBe("");
      expect(row.style.opacity).toBe("");
    }
  });

  it("grows a row in when its tab joins a list that is already open, leaving the others alone", async () => {
    four();
    stubRowLayout();
    const pump = framePump();
    const m = await mount();
    m.current.click();
    const settled = [...m.rows()];

    // Switching to a listed tab takes its row out of the list and puts the
    // outgoing tab's row in: one departure and one arrival, no reel (s1 -> s3 is
    // two slots apart, and the reel only plays for a one-step move).
    m.chips()[2]?.click();

    const arriving = [...m.rows()].find((r) => !settled.includes(r));
    if (!arriving) {
      throw new Error("no new row");
    }
    // Starts collapsed and transparent...
    // A real CSSOM normalizes a LENGTH on read-back: production writes `0` and
    // `element.style` reports `0px`. Same value, the platform's spelling. A bare
    // number (opacity) is not a length and stays `0`.
    expect(arriving.style.maxHeight).toBe("0px");
    expect(arriving.style.opacity).toBe("0");
    expect(arriving.style.overflow).toBe("hidden");
    // ...then transitions to its measured height on the next frame.
    pump();
    expect(arriving.style.maxHeight).toBe(`${String(ROW_H)}px`);
    expect(arriving.style.opacity).toBe("1");
    expect(arriving.style.transition).toContain("max-height");
    // A row that was already listed is not re-animated by someone else's arrival.
    const bystander = rowByLabel(m, "four");
    expect(bystander?.style.maxHeight).toBe("");
  });

  it("collapses a departing row out of the list rather than snapping it away", async () => {
    four();
    stubRowLayout();
    const pump = framePump();
    const m = await mount();
    m.current.click();
    const leaving = rowByLabel(m, "three");
    if (!leaving) {
      throw new Error("no leaving row");
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    m.chips()[2]?.click(); // s3 becomes active, so its row leaves the list

    // Still in the tray, held at its measured height and no longer clickable.
    expect(leaving.isConnected).toBe(true);
    expect(leaving.style.maxHeight).toBe(`${String(ROW_H)}px`);
    expect(leaving.style.pointerEvents).toBe("none");
    pump();
    expect(leaving.style.maxHeight).toBe("0px");
    // And gone once the collapse has run.
    vi.advanceTimersByTime(400);
    expect(leaving.isConnected).toBe(false);
  });

  it("snaps a departing row away instead of collapsing it under reduced motion", async () => {
    four();
    stubMedia({ [REDUCE]: true });
    stubRowLayout();
    const m = await mount();
    m.current.click();
    const leaving = rowByLabel(m, "three");
    if (!leaving) {
      throw new Error("no leaving row");
    }

    m.chips()[2]?.click();

    // No animation to wait for: the row is out of the tree at once, and nothing
    // inline was written on it.
    expect(leaving.isConnected).toBe(false);
    expect(leaving.style.maxHeight).toBe("");
    expect(m.rows().length).toBe(3);
  });

  it("gives a tab whose row left and came back a clean row, not the retired one", async () => {
    // The retired row carries the leave animation's residue (collapsed to 0,
    // transparent, pointer-events off). Reusing it lists a tab you cannot see or
    // click.
    four();
    stubRowLayout();
    const pump = framePump();
    const m = await mount();
    m.current.click();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    m.chips()[2]?.click(); // s3 active: its row retires
    pump();
    vi.advanceTimersByTime(400); // ...and finishes leaving
    m.chips()[0]?.click(); // back to s1: s3 needs a row again
    pump();

    const back = rowByLabel(m, "three");
    expect(back?.style.pointerEvents).toBe("");
    expect(back?.style.opacity).toBe("1");
    expect(back?.style.maxHeight).toBe(`${String(ROW_H)}px`);
  });
});

describe("tabs: the reel (a swipe rotates the open list)", () => {
  // 3 tabs so every swipe is a one-step move, which is the only shape the reel
  // plays for.
  function three(): void {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
  }
  function ghostOf(m: Mounted): HTMLElement | undefined {
    return [...m.rows()].find((r) => r.style.position === "absolute");
  }

  it("lifts the row of the tab being switched to out of the flow and slides it off the leading edge", async () => {
    three();
    stubRowLayout();
    const m = await mount();
    m.current.click();
    const wasListed = rowByLabel(m, "two");

    flickNext(m.current); // s1 -> s2, the first listed tab

    expect(setSession).toHaveBeenCalledWith("s2");
    const ghost = ghostOf(m);
    expect(ghost).toBe(wasListed);
    // Anchored where it sat, masked out of the pointer, and leaving upward: a
    // forward rotation carries the row that became active off the top.
    expect(ghost?.style.pointerEvents).toBe("none");
    expect(ghost?.style.opacity).toBe("0");
    const exit = parseFloat((ghost?.style.transform ?? "").replace(/[^-\d.]/g, ""));
    expect(Number.isFinite(exit)).toBe(true);
    expect(exit).toBeLessThan(0);
    // The list clips while the reel runs, so the rows are masked at the edges.
    expect(m.list.style.overflow).toBe("hidden");
  });

  it("carries the surviving row into its new slot rather than re-rendering it there", async () => {
    three();
    stubRowLayout();
    const m = await mount();
    m.current.click();
    const survivor = rowByLabel(m, "three");

    flickNext(m.current);

    // Same element, released to its new slot with a transition on it: this is
    // what makes the change read as a rotation instead of a reload.
    const after = rowByLabel(m, "three");
    expect(after).toBe(survivor);
    expect(after?.style.transform).toBe("translateY(0px)");
    expect(after?.style.opacity).toBe("1");
    expect(after?.style.transition).toContain("transform");
  });

  it("sends the leaving row the other way for a backward swipe", async () => {
    three();
    stubRowLayout();
    const m = await mount();
    m.current.click();

    // A rightward flick goes to the previous tab, which wraps to the last one.
    flickPrev(m.current);

    expect(setSession).toHaveBeenCalledWith("s3");
    const exit = parseFloat((ghostOf(m)?.style.transform ?? "").replace(/[^-\d.]/g, ""));
    expect(exit).toBeGreaterThan(0);
  });

  it("settles the reel back into the stylesheet when it is over", async () => {
    three();
    stubRowLayout();
    const m = await mount();
    m.current.click();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    flickNext(m.current);
    expect(ghostOf(m)).toBeDefined();
    vi.advanceTimersByTime(400);

    // The ghost is gone, the list holds one row per OTHER tab, and every inline
    // style the reel wrote is handed back to the stylesheet.
    expect(ghostOf(m)).toBeUndefined();
    expect(m.rows().length).toBe(2);
    expect(m.list.style.overflow).toBe("");
    expect(m.list.style.position).toBe("");
    for (const row of m.rows()) {
      expect(row.style.transform).toBe("");
      expect(row.style.transition).toBe("");
      expect(row.style.opacity).toBe("");
    }
  });

  it("keeps one ghost when a second swipe arrives mid-reel, and does not let the first reel's deadline end it", async () => {
    three();
    stubRowLayout();
    const m = await mount();
    m.current.click();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    flickNext(m.current); // reel A
    vi.advanceTimersByTime(200);
    flickNext(m.current); // reel B, while A is still running
    expect(m.rows().length).toBe(3); // two rows + exactly one ghost

    // A's 300ms deadline passes here. It must not settle B's reel early.
    vi.advanceTimersByTime(150);
    expect(ghostOf(m)).toBeDefined();
    vi.advanceTimersByTime(200);
    expect(ghostOf(m)).toBeUndefined();
  });

  it("does not reel when the swipe is a two-step move", async () => {
    // The reel is a one-slot rotation; anything else has no rotation to show and
    // must reconcile plainly.
    four();
    stubRowLayout();
    const m = await mount();
    m.current.click();

    m.chips()[2]?.click(); // s1 -> s3

    expect(setSession).toHaveBeenCalledWith("s3");
    expect([...m.rows()].some((r) => r.style.position === "absolute")).toBe(false);
  });

  it("does not reel under reduced motion", async () => {
    three();
    stubMedia({ [REDUCE]: true });
    stubRowLayout();
    const m = await mount();
    m.current.click();

    flickNext(m.current);

    expect(setSession).toHaveBeenCalledWith("s2");
    expect([...m.rows()].some((r) => r.style.position === "absolute")).toBe(false);
    expect(m.list.style.overflow).toBe("");
  });

  it("drops a reel in flight when the list is cleared after a collapse", async () => {
    three();
    stubRowLayout();
    const m = await mount();
    m.current.click();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    flickNext(m.current);
    expect(ghostOf(m)).toBeDefined();
    flickDown(m.current); // collapse while the reel is still running

    // The deferred clear runs before the reel's own deadline would have: it has to
    // settle the reel itself, or the emptied tray keeps the reel's inline clip and
    // the ghost's frame.
    vi.advanceTimersByTime(280);
    expect(m.rows().length).toBe(0);
    expect(m.list.style.overflow).toBe("");
    expect(m.list.style.position).toBe("");

    // And the reel's own deadline, arriving after all that, finds nothing to undo.
    vi.advanceTimersByTime(200);
    expect(m.rows().length).toBe(0);
    expect(m.list.style.overflow).toBe("");
  });
});

describe("tabs: chrome that only a runtime change moves", () => {
  it("animates a runtime-added chip in, and drops the class again, leaving the boot chips alone", async () => {
    // The boot chips are the page arriving, not tabs appearing, so they must not
    // animate. The class comes off on a timer rather than animationend, because on
    // the hidden mobile strip the animation never fires at all.
    const m = await mount();
    for (const chip of m.chips()) {
      expect(chip.classList.contains("wt-tab-enter")).toBe(false);
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    pick(m.root, ".wt-tab-new").click();
    await vi.advanceTimersByTimeAsync(0);
    const fresh = m.chips()[2];
    if (!fresh) {
      throw new Error("no third chip");
    }
    expect(fresh.classList.contains("wt-tab-enter")).toBe(true);

    await vi.advanceTimersByTimeAsync(400);
    expect(fresh.classList.contains("wt-tab-enter")).toBe(false);
  });

  it("does not restart the deferred row clear when a collapse gesture lands on a collapsed list", async () => {
    const m = await mount();
    m.current.click(); // expand
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    m.current.click(); // collapse: the rows leave the a11y tree ~260ms later

    // A second collapse gesture arrives while that clear is still pending. Taking
    // it would push the deadline out and leave the rows reachable for longer than
    // the collapse animation they belong to.
    vi.advanceTimersByTime(100);
    flickDown(m.current);
    vi.advanceTimersByTime(200);

    expect(m.rows().length).toBe(0);
  });

  it("drops a closed tab's unseen cue from the out-of-page count", async () => {
    // The count is derived from the tab list, so a tab leaving has to re-derive it
    // — including when the tab that left was not the one the switch dot named.
    document.title = "Host page";
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const m = await mount([monitor.feature, tabs({ activityMonitor: monitor.feature })]);

    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    monitor.emit({ id: "s3", status: "done", title: "three", createdAt: "3" });
    expect(document.title).toBe("(2) Host page");

    // s2 is not the dot's subject (latest wins, so that is s3), so nothing else on
    // the close path repaints the count.
    pick(m.chips()[1] ?? m.root, ".wt-tab-close").click();
    await until(() => m.chips().length === 2);

    expect(document.title).toBe("(1) Host page");
    document.title = "";
  });
});

describe("tabs: what a chip carries from the moment it is built", () => {
  it("shows a listed session's percentage from the first paint, before any status event", async () => {
    // A session adopted from the REST list can already be running with a
    // percentage; nothing repaints the chip until its first status event, so the
    // creation paint is the only thing standing between the user and a blank bar.
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "working", progressValue: 45 },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const m = await mount();

    const bar = m.chips()[0]?.querySelector<HTMLElement>(".wt-progress-bar");
    expect(bar?.hidden).toBe(false);
    expect(bar?.style.width).toBe("45%");
    // The idle sibling has no percentage, so it shows no bar at all.
    expect(m.chips()[1]?.querySelector<HTMLElement>(".wt-progress-bar")?.hidden).toBe(true);
  });

  it("names the session and its state on the chip from the first paint", async () => {
    listBody = [{ id: "s1", title: "one", createdAt: "1", status: "working", progressValue: 45 }];
    const m = await mount();

    // The accessible name is the only place a screen reader learns the state the
    // dot is showing, so it has to be there before the first status event too.
    expect(m.chips()[0]?.getAttribute("aria-label")).toBe("one — working, 45%");
  });
});

describe("tabs: guards on the chip's own handlers", () => {
  it("does not open the rename field from a double-click on the close button", async () => {
    const m = await mount();
    const close = pick(m.chips()[0] ?? m.root, ".wt-tab-close");

    const dbl = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
    close.dispatchEvent(dbl);

    // The close button owns that gesture; renaming a tab you just asked to close
    // is nobody's intent.
    expect(m.root.querySelector(".wt-tab-rename")).toBeNull();
    expect(dbl.defaultPrevented).toBe(false);
  });

  it("hands every key to the rename field while it owns the chip", async () => {
    const m = await mount();
    const chip = m.chips()[0];
    if (!chip) {
      throw new Error("no chip");
    }
    chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(chip.querySelector(".wt-tab-rename")).not.toBeNull();

    // Delete means "delete a character" here, not "close the tab", and F2 has
    // nothing left to open.
    const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    chip.dispatchEvent(del);
    const f2 = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
    chip.dispatchEvent(f2);

    expect(del.defaultPrevented).toBe(false);
    expect(f2.defaultPrevented).toBe(false);
    await until(() => m.chips().length === 1);
    expect(m.chips().length).toBe(2);
  });

  it("marks the dragged chip and closes any open tab menu when a drag starts", async () => {
    const m = await mount();
    const chip = m.chips()[0];
    if (!chip) {
      throw new Error("no chip");
    }
    chip.dispatchEvent(new MouseEvent("contextmenu", { clientX: 5, clientY: 5, bubbles: true }));
    const menu = pick(m.root, ".wt-tab-menu");
    expect(menu.classList.contains("visible")).toBe(true);

    const dragstart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, "dataTransfer", { value: null });
    chip.dispatchEvent(dragstart);

    // The chip reads as the one in flight, and the menu cannot hang over the
    // strip it is being dragged across.
    expect(chip.classList.contains("wt-tab-dragging")).toBe(true);
    expect(menu.classList.contains("visible")).toBe(false);
    expect(menu.children.length).toBe(0);

    chip.dispatchEvent(new Event("dragend", { bubbles: true }));
    expect(chip.classList.contains("wt-tab-dragging")).toBe(false);
  });
});

describe("tabs: the reel only plays for a genuine one-step move", () => {
  function five(): void {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
      { id: "s4", title: "four", createdAt: "4", status: "idle" },
      { id: "s5", title: "five", createdAt: "5", status: "idle" },
    ];
  }
  function ghosted(m: Mounted): boolean {
    return [...m.rows()].some((r) => r.style.position === "absolute");
  }

  it("reels a step forward from the second tab of a long list", async () => {
    five();
    stubRowLayout();
    const m = await mount();
    m.chips()[1]?.click(); // park on s2, one slot in
    m.current.click(); // expand

    flickNext(m.current); // s2 -> s3: adjacent, so the list rotates by one

    expect(setSession).toHaveBeenCalledWith("s3");
    expect(ghosted(m)).toBe(true);
  });

  it("reels a step forward from the third tab too", async () => {
    // The pair of cases pins BOTH ends of the step measurement: an index the
    // gesture starts from and an index it lands on. With one case, a step
    // measured from a fixed end still looks adjacent.
    five();
    stubRowLayout();
    const m = await mount();
    m.chips()[2]?.click(); // park on s3
    m.current.click();

    flickNext(m.current); // s3 -> s4

    expect(setSession).toHaveBeenCalledWith("s4");
    expect(ghosted(m)).toBe(true);
  });

  it("does not reel a three-step move in a five-tab list", async () => {
    five();
    stubRowLayout();
    const m = await mount();
    m.chips()[1]?.click(); // s2
    m.current.click();

    m.chips()[4]?.click(); // s2 -> s5, three slots away

    expect(setSession).toHaveBeenCalledWith("s5");
    expect(ghosted(m)).toBe(false);
  });
});

describe("tabs: the expanded row's live bits", () => {
  it("mirrors a listed session's percentage on its row", async () => {
    const monitor = fakeMonitor();
    const m = await mount([monitor.feature, tabs({ activityMonitor: monitor.feature })]);
    m.current.click();

    monitor.emit({
      id: "s2",
      status: "working",
      title: "two",
      createdAt: "2",
      progressValue: 60,
    });

    const bar = pick(m.root, ".wt-switcher-row .wt-progress-bar");
    expect(bar.hidden).toBe(false);
    expect(bar.style.width).toBe("60%");

    // And it goes away with the percentage, rather than sitting at its last value.
    monitor.emit({ id: "s2", status: "idle", title: "two", createdAt: "2", progressValue: -1 });
    expect(bar.hidden).toBe(true);
  });
});

describe("tabs: the reel's from-state", () => {
  // A FLIP is only a FLIP if the from-state reaches style before the to-state does.
  // This one commits it with a forced reflow, and the reason is recorded in the
  // source: an earlier version let the browser collapse from->to into a single
  // recalc, and the rows' fade never ran at all. The reflow read IS the commit, so
  // that read is the one moment the from-state can be observed — the to-state
  // overwrites it a few statements later, inside the same function.
  const GAP = 8;
  const PITCH = ROW_H + GAP;
  const LIST_TOP = 100;
  const SCROLLED = 30;

  interface Snap {
    label: string;
    transform: string;
    opacity: string;
    ghost: boolean;
    top: string;
  }
  function snapshot(): Snap[] {
    return [...document.querySelectorAll<HTMLElement>(".wt-switcher-row")].map((r) => ({
      label: r.querySelector(".wt-switcher-row-label")?.textContent ?? "",
      transform: r.style.transform,
      opacity: r.style.opacity,
      ghost: r.style.position === "absolute",
      top: r.style.top,
    }));
  }

  // Four tabs: a forward flick is a one-step move (s1 -> s2) and a backward one
  // wraps first-to-last, which the list treats as the same single rotation.
  async function reel(dir: "next" | "prev"): Promise<{ m: Mounted; committed: Snap[] }> {
    four();
    const snaps: Snap[][] = [];
    stubRowLayout({ listTop: LIST_TOP, gap: GAP, onListMeasured: () => snaps.push(snapshot()) });
    const m = await mount();
    m.current.click();
    // The row gap is part of one slot's travel, so the list carries the one the
    // stylesheet gives it; and a scrolled list is where an anchor computed in the
    // wrong space shows up.
    m.list.style.rowGap = `${String(GAP)}px`;
    // A plain `m.list.scrollTop = SCROLLED` is clamped to 0 by a real browser: the
    // list has no overflowing content in a bare test document, so there is nothing
    // to scroll. The scroll offset is an INPUT to the anchor arithmetic under test,
    // so it is declared as an own property the same way the row layout above is.
    Object.defineProperty(m.list, "scrollTop", { value: SCROLLED, configurable: true });

    if (dir === "next") {
      flickNext(m.current);
    } else {
      flickPrev(m.current);
    }
    return { m, committed: snaps.at(-1) ?? [] };
  }

  it("inverts every surviving row to the slot it came from, one whole slot away", async () => {
    const { committed } = await reel("next");

    const survivors = committed.filter((s) => !s.ghost && s.opacity !== "0");
    expect(survivors.map((s) => s.label)).toEqual(["three", "four"]);
    for (const s of survivors) {
      // One slot = a row plus the gap between rows. Positive because the rows the
      // reel keeps are rotating up into the slot above.
      expect(s.transform, s.label).toBe(`translateY(${String(PITCH)}px)`);
      // A survivor is already on screen; only the newcomer fades.
      expect(s.opacity, s.label).toBe("");
    }
  });

  it("starts the entering row one slot off the trailing edge, transparent", async () => {
    const { committed } = await reel("next");

    const entering = committed.find((s) => s.label === "one");
    expect(entering?.ghost).toBe(false);
    expect(entering?.transform).toBe(`translateY(${String(PITCH)}px)`);
    expect(entering?.opacity).toBe("0");
  });

  it("starts the entering row on the other edge for a backward rotation", async () => {
    const { committed } = await reel("prev");

    // Wrapping first-to-last rotates the other way, so the newcomer comes in from
    // above rather than below.
    const entering = committed.find((s) => s.label === "one");
    expect(entering?.transform).toBe(`translateY(-${String(PITCH)}px)`);
    expect(entering?.opacity).toBe("0");
    const survivors = committed.filter((s) => !s.ghost && s.label !== "one");
    for (const s of survivors) {
      expect(s.transform, s.label).toBe(`translateY(-${String(PITCH)}px)`);
    }
  });

  it("starts the leaving row at rest, at the spot it was anchored in the list's own scroll space", async () => {
    const { committed } = await reel("next");

    const ghost = committed.find((s) => s.ghost);
    expect(ghost?.label).toBe("two");
    // Anchored where the row sat: the list's top edge, offset by how far the list
    // is scrolled — an anchor computed in the viewport's space instead lands the
    // ghost a listful away from the row it replaces.
    expect(ghost?.top).toBe(`${String(SCROLLED)}px`);
    // Fully opaque and unmoved, so its fade and its exit both animate from here.
    expect(ghost?.transform).toBe("translateY(0px)");
    expect(ghost?.opacity).toBe("1");
  });
});

describe("tabs: more guards on the chip's own handlers", () => {
  it("does not switch tabs on a click aimed at the chip whose rename field is open", async () => {
    // F2 renames without switching, so the chip hosting the field can be a
    // BACKGROUND tab — and then the click the user makes to place the caret would
    // otherwise switch the terminal out from under the edit.
    const m = await mount();
    const chip = m.chips()[1];
    if (!chip) {
      throw new Error("no chip");
    }
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    expect(chip.querySelector(".wt-tab-rename")).not.toBeNull();
    setSession.mockClear();
    bind.mockClear();

    chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(setSession).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(chip.querySelector(".wt-tab-rename")).not.toBeNull();
  });

  it("ignores keys on a chip the strip no longer owns", async () => {
    // The element outlives the tab for as long as something holds a reference to
    // it (a pending animation, a focus restore). Acting on its keys would move the
    // selection using an index that no longer means anything.
    const m = await mount();
    const chip = m.chips()[1];
    if (!chip) {
      throw new Error("no chip");
    }
    pick(chip, ".wt-tab-close").click();
    await until(() => m.chips().length === 1);
    setSession.mockClear();

    for (const key of ["ArrowRight", "Home", "Delete", "F2"]) {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      chip.dispatchEvent(e);
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(setSession).not.toHaveBeenCalled();
  });

  it("clears the drag preview clone on dragend even if no frame ran to do it", async () => {
    // The clone exists only to be handed to setDragImage, and a frame normally
    // takes it away. A page that never gets that frame (a background tab, a
    // blocked main thread) must not be left with a second copy of the chip.
    const m = await mount();
    const pump = framePump();
    const chip = m.chips()[0];
    if (!chip) {
      throw new Error("no chip");
    }

    const dragstart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, "dataTransfer", { value: fakeDataTransfer() });
    chip.dispatchEvent(dragstart);
    expect(m.root.querySelectorAll(".wt-tab-ghost").length).toBe(1);

    chip.dispatchEvent(new Event("dragend", { bubbles: true }));

    expect(m.root.querySelectorAll(".wt-tab-ghost").length).toBe(0);
    pump(); // the frame arrives late and finds nothing left to do
    expect(m.root.querySelectorAll(".wt-tab-ghost").length).toBe(0);
  });
});

// A minimal DataTransfer stand-in: a constructed DragEvent carries a real, EMPTY
// DataTransfer that a test cannot write to, and the drag preview reads
// setDragImage off this.
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
