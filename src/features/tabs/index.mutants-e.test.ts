// Additional tabs-feature tests for the FIRST ~1000 lines of
// src/features/tabs/index.ts: the chrome the feature builds at setup (the two
// ResizeObservers that publish the strip's measurements as CSS variables, the
// roles that make the strip, the catch-up banner and the context menu
// navigable, the bar buttons that must not take the keyboard off the terminal),
// the acknowledgement store's eviction and write discipline, the page-lifecycle
// listeners (visibilitychange / pagehide / pageshow), and the physical-keyboard
// heuristic.
//
// A separate file from index.test.ts purely so concurrent workers do not edit
// one file; the setup idioms (real kernel, stubbed fetch, dynamic import per
// test, a fake activityMonitor for the status stream, a query-aware matchMedia)
// are the ones that file established.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";
import type { TerminalFeature } from "../../kernel/types.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
import type { MobileToolbarApi } from "../mobile-toolbar.js";
// Plain constants, so reading them through a separate module instance than the
// (dynamically re-imported) feature under test is safe.
import { PRESSED_CLASS } from "../dom.js";
import { CUE_SEEN_KEY, MAX_PERSISTED_CUE_SEEN } from "./model.js";

// A fake activityMonitor: lets a test push status events into tabs without the
// real SSE. tabs reads it via ctx.use, so the same feature value goes into the
// features array (before tabs) and into tabs({ activityMonitor }). Its presence
// also switches the poll timer off, so the only list round-trips in a test are
// the ones the test caused.
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
          onStreamOpen() {
            return () => undefined;
          },
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

/** A fake keyboardToggle (MobileToolbarApi provider) whose sticky-Ctrl state a
 *  test drives: `armed` is what tabs reads at setup, and `arm()` pushes a change
 *  through the subscription tabs registers. The real toolbar's Ctrl key does
 *  exactly these two things. */
function fakeKeyboardToggle(armedAtSetup = false): {
  feature: TerminalFeature<MobileToolbarApi>;
  arm: (armed: boolean) => void;
  subscribers: () => number;
} {
  const subs = new Set<(armed: boolean) => void>();
  let armed = armedAtSetup;
  const feature: TerminalFeature<MobileToolbarApi> = {
    name: "mobileToolbar",
    setup() {
      return {
        api: {
          toggle: () => undefined,
          isOpen: () => false,
          isCtrlArmed: () => armed,
          onCtrlArmedChange(fn) {
            subs.add(fn);
            return () => subs.delete(fn);
          },
        },
        teardown: () => undefined,
      };
    },
  };
  return {
    feature,
    arm: (next) => {
      armed = next;
      for (const fn of [...subs]) {
        fn(next);
      }
    },
    subscribers: () => subs.size,
  };
}

/** One observed element per constructed ResizeObserver, plus the callback, so a
 *  test can fire a resize on demand. A real ResizeObserver only fires when a box
 *  actually changes, and these callbacks are about WHAT they do with an
 *  observation rather than when the engine delivers one. */
interface FakeObserver {
  callback: ResizeObserverCallback;
  targets: Element[];
}
let observers: FakeObserver[];

function stubResizeObserver(): void {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      private readonly record: FakeObserver;
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.targets.push(target);
      }
      unobserve(): void {
        // nothing to undo: the test drives the callback directly
      }
      disconnect(): void {
        this.record.targets.length = 0;
      }
    },
  );
}

/** Fire every observer watching `target`, and report how many there were, so a
 *  test can tell "the callback did nothing" from "nothing was ever observing". */
function resize(target: Element): number {
  const watching = observers.filter((o) => o.targets.includes(target));
  for (const o of watching) {
    o.callback([], {} as ResizeObserver);
  }
  return watching.length;
}

// A query-aware matchMedia: the feature asks three different questions of it
// ("(any-pointer: fine)" for a physical keyboard, "(pointer: coarse)" for the
// mobile layout, "(prefers-reduced-motion: reduce)" for the animation gate) and
// they mean opposite things, so a blanket answer proves something other than
// what the test claims.
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

// Page visibility is a FIXTURE, not ambient state: the active-tab
// acknowledgement defers while hidden, so a test that inherited whatever the
// previous one left would pass or fail by ordering.
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

let createTerminal: (typeof KernelModule)["createTerminal"];
let tabs: (typeof TabsModule)["tabs"];
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let list: unknown[];

const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "POST") {
    return Promise.resolve(
      jsonResponse({ id: "s-new", title: "fresh", createdAt: "9", status: "idle" }, 201),
    );
  }
  if (method === "DELETE" || method === "PUT") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  void url;
  return Promise.resolve(jsonResponse(list, 200));
});

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockClear();
  list = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
  ];
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
  document.title = "Host page";
  localStorage.clear();
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
  // Reset for every test, so a case that throws mid-way cannot leak "hidden".
  setVisibility("visible");
});

async function until(pred: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Mount the terminal with tabs and wait for one chip per listed session. */
async function mount(opts: Parameters<typeof tabs>[0] = {}): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  term = createTerminal(root, { features: () => [tabs(opts)] });
  await until(() => root.querySelectorAll(".wt-tab").length === list.length);
  return root;
}

/** Mount with a status stream wired, the way every cue test needs it. */
async function mountWithMonitor(
  opts: Parameters<typeof tabs>[0] = {},
): Promise<{ root: HTMLElement; monitor: ReturnType<typeof fakeMonitor> }> {
  const monitor = fakeMonitor();
  const root = document.createElement("div");
  document.body.appendChild(root);
  term = createTerminal(root, {
    features: () => [monitor.feature, tabs({ ...opts, activityMonitor: monitor.feature })],
  });
  await until(() => root.querySelectorAll(".wt-tab").length === list.length);
  return { root, monitor };
}

/** The element the feature publishes its measurements on: the surface's parent,
 *  because the scroll-to-bottom button lives in a sibling region and inherits
 *  the variables from there rather than from .term. */
function varRoot(root: HTMLElement): HTMLElement {
  const surface = root.querySelector<HTMLElement>(".term");
  const parent = surface?.parentElement;
  if (!parent) {
    throw new Error("no surface parent");
  }
  return parent;
}

// --- The measurements the strip publishes as CSS variables ---

describe("tabs: the strip's measured height and reserved row", () => {
  beforeEach(() => {
    stubResizeObserver();
  });

  it("publishes the strip's own height so the chrome above it can clear the bar", async () => {
    // The offset is measured rather than guessed because the bar's height depends
    // on the font and the safe area. It is published on the surface's PARENT: the
    // scroll-to-bottom button sits in a sibling region, so a property set on
    // .term would not inherit to it and it would fall back to the 44px guess and
    // overlap the strip.
    const root = await mount();
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    if (!bar) {
      throw new Error("no tab bar");
    }

    // Nothing is published until a resize is observed, which is what makes the
    // observation itself load-bearing rather than decorative.
    expect(varRoot(root).style.getPropertyValue("--wt-tabbar-h")).toBe("");
    expect(resize(bar)).toBe(1);
    expect(varRoot(root).style.getPropertyValue("--wt-tabbar-h")).toBe(
      `${String(bar.offsetHeight)}px`,
    );
  });

  it("reserves the collapsed switcher row plus the safe area beneath it", async () => {
    // viewport.ts adds --wt-reserve-bottom to the surface's bottom inset, so
    // terminal content stops above the mobile bar. innerHeight - top captures the
    // row AND the safe area under it; the keyboard lift is viewport.ts's own
    // separate term.
    const root = await mount();
    const swBar = root.querySelector<HTMLElement>(".wt-switcher-bar");
    if (!swBar) {
      throw new Error("no switcher bar");
    }
    window.innerHeight = 800;
    vi.spyOn(swBar, "getBoundingClientRect").mockReturnValue({
      height: 56,
      top: 730,
      bottom: 786,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: 730,
      toJSON: () => ({}),
    });

    expect(resize(swBar)).toBe(1);
    // 800 - 730 = the 56px row plus the 14px inset under it.
    expect(varRoot(root).style.getPropertyValue("--wt-reserve-bottom")).toBe("70px");
  });

  it("reserves nothing while the switcher row is not laid out at all", async () => {
    // A zero-height box is the desktop case (the mobile bar is display:none) and
    // the pre-layout case. Both must reserve 0 rather than the whole viewport
    // height that innerHeight - 0 would produce.
    const root = await mount();
    const swBar = root.querySelector<HTMLElement>(".wt-switcher-bar");
    if (!swBar) {
      throw new Error("no switcher bar");
    }
    window.innerHeight = 800;
    vi.spyOn(swBar, "getBoundingClientRect").mockReturnValue({
      height: 0,
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    expect(resize(swBar)).toBe(1);
    expect(varRoot(root).style.getPropertyValue("--wt-reserve-bottom")).toBe("0px");
  });

  it("never reserves a negative row when the bar sits below the viewport", async () => {
    // A bar pushed past innerHeight (a keyboard mid-animation on iOS) must floor
    // at 0: a negative inset would pull terminal content DOWN off the screen.
    const root = await mount();
    const swBar = root.querySelector<HTMLElement>(".wt-switcher-bar");
    if (!swBar) {
      throw new Error("no switcher bar");
    }
    window.innerHeight = 800;
    vi.spyOn(swBar, "getBoundingClientRect").mockReturnValue({
      height: 56,
      top: 900,
      bottom: 956,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: 900,
      toJSON: () => ({}),
    });

    expect(resize(swBar)).toBe(1);
    expect(varRoot(root).style.getPropertyValue("--wt-reserve-bottom")).toBe("0px");
  });
});

// --- The roles that make the chrome navigable ---

describe("tabs: the chrome's accessible structure", () => {
  it("wraps the chips in a tablist, which is what makes their tab role valid", async () => {
    // The chips carry role="tab" and aria-selected. A tab outside a tablist is
    // not a defined relationship, so a screen reader stops reporting "tab 2 of 3"
    // and arrow-key navigation loses its container.
    const root = await mount();
    const scroller = root.querySelector<HTMLElement>(".wt-tab-scroll");
    expect(scroller?.getAttribute("role")).toBe("tablist");
    expect(scroller?.querySelectorAll('[role="tab"]').length).toBe(2);
  });

  it("announces the catching-up cue as a status region", async () => {
    // The cue says the screen on display is stale. It appears without any user
    // action, so it has to be announced politely rather than only painted — a
    // plain div tells a screen-reader user nothing at all.
    const root = await mount();
    expect(root.querySelector(".wt-catchup")?.getAttribute("role")).toBe("status");
  });

  it("declares the tab context menu a menu", async () => {
    // The items are role="menuitem" buttons; without the container role they are
    // orphaned and the menu is not reported as one.
    const root = await mount();
    expect(root.querySelector(".wt-tab-menu")?.getAttribute("role")).toBe("menu");
  });
});

// --- The bar buttons that must not take the keyboard off the terminal ---

describe("tabs: the switcher bar's buttons hold focus on press", () => {
  /** Press and release, reporting what the press did: whether it cancelled the
   *  default (which is what keeps the keyboard on the terminal input and stops
   *  iOS eating the first tap), whether the button painted its own press state,
   *  and whether the release cleaned it up. */
  function press(btn: HTMLElement): {
    cancelled: boolean;
    litWhileHeld: boolean;
    litAfterRelease: boolean;
  } {
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    const litWhileHeld = btn.classList.contains(PRESSED_CLASS);
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    return {
      cancelled: down.defaultPrevented,
      litWhileHeld,
      litAfterRelease: btn.classList.contains(PRESSED_CLASS),
    };
  }

  it("keeps the keyboard on the terminal when the keyboard button is pressed", async () => {
    // Cancelling the pointerdown default is what stops the press parking the
    // keyboard on the button, where the strip's own keydown handling eats arrows
    // as "switch tab" and Delete as "close tab". It also suppresses Firefox's
    // :active, so the button's own press class is its only feedback there.
    const kbt = fakeKeyboardToggle();
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [
        kbt.feature,
        monitor.feature,
        tabs({ keyboardToggle: kbt.feature, activityMonitor: monitor.feature }),
      ],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const kb = root.querySelector<HTMLElement>(".wt-switcher-kb");
    if (!kb) {
      throw new Error("no switcher keyboard button");
    }
    expect(press(kb)).toEqual({ cancelled: true, litWhileHeld: true, litAfterRelease: false });
  });

  it("keeps the keyboard on the terminal when the switch button is pressed", async () => {
    // Same contract for the button that opens the tab list: it is the one control
    // a phone user taps most, and a press that moved focus made iOS spend the
    // first tap blurring the input instead of opening the list.
    const root = await mount();
    const sw = root.querySelector<HTMLElement>(".wt-switcher-switch");
    if (!sw) {
      throw new Error("no switch button");
    }
    expect(press(sw)).toEqual({ cancelled: true, litWhileHeld: true, litAfterRelease: false });
  });
});

// --- Sticky-Ctrl mirrored onto the keyboard buttons ---

describe("tabs: the keyboard buttons mirror a pending Ctrl", () => {
  async function mountArmed(armedAtSetup: boolean): Promise<{
    root: HTMLElement;
    kbt: ReturnType<typeof fakeKeyboardToggle>;
    armedButtons: () => string[];
  }> {
    const kbt = fakeKeyboardToggle(armedAtSetup);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [kbt.feature, tabs({ keyboardToggle: kbt.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    return {
      root,
      kbt,
      armedButtons: () =>
        [...root.querySelectorAll<HTMLElement>(".wt-armed")].map((b) => b.className),
    };
  }

  it("inverts every keyboard button while a Ctrl press is pending", async () => {
    // With the grid closed the button is the only place a pending modifier can
    // show, and there are two of them (the switcher's and the desktop strip's) —
    // whichever layout is on screen has to say Ctrl is armed, or the next
    // keystroke silently carries a modifier the user cannot see.
    const h = await mountArmed(false);
    expect(h.armedButtons()).toEqual([]);

    h.kbt.arm(true);
    expect(h.armedButtons()).toHaveLength(2);
    expect(h.armedButtons().every((cls) => cls.includes("wt-btn"))).toBe(true);

    // ...and the auto-disarm after the Ctrl byte takes it back off both.
    h.kbt.arm(false);
    expect(h.armedButtons()).toEqual([]);
  });

  it("shows a Ctrl already armed before the strip existed", async () => {
    // The toolbar sets up BEFORE tabs, so Ctrl can already be armed by the time
    // these buttons are built: reading the current state at setup is what stops
    // the buttons starting out disagreeing with the toolbar's own Ctrl key.
    const h = await mountArmed(true);
    expect(h.armedButtons()).toHaveLength(2);
  });
});

// --- The acknowledgement store's write discipline ---

describe("tabs: the acknowledgement store stays bounded and quiet", () => {
  function storedCueSeen(): Record<string, string> {
    return JSON.parse(localStorage.getItem(CUE_SEEN_KEY) ?? "{}") as Record<string, string>;
  }

  it("evicts the oldest acknowledgement rather than growing past the cap", async () => {
    // Sessions that vanished while the page was CLOSED leave entries nothing
    // collects (dropTab only prunes what closes while the page is open).
    // Unbounded, they would push the map past the cap the parser enforces, and
    // the parser discards whatever it read LAST — dropping fresh
    // acknowledgements to keep dead ones. So the live map evicts at the cap, and
    // it evicts from the front.
    const stale = Object.fromEntries(
      Array.from({ length: MAX_PERSISTED_CUE_SEEN }, (_, i) => [`gone-${String(i)}`, "done"]),
    );
    localStorage.setItem(CUE_SEEN_KEY, JSON.stringify(stale));
    const { monitor } = await mountWithMonitor();

    // One more acknowledgement than the map can hold: the active tab latching a
    // cue while the user is looking at it.
    monitor.emit({ id: "s1", status: "input", title: "one", createdAt: "1" });

    const seen = storedCueSeen();
    expect(Object.keys(seen)).toHaveLength(MAX_PERSISTED_CUE_SEEN);
    expect(seen["gone-0"]).toBeUndefined();
    expect(seen["gone-1"]).toBe("done");
    expect(seen["s1"]).toBe("input");
  });

  it("does not rewrite the store when the same latch is re-delivered", async () => {
    // input/done are LATCHED server-side and the stream re-pushes the snapshot on
    // every open, with the poll fallback re-listing on top of that. Every one of
    // those re-deliveries reaches the active tab's acknowledgement, so without
    // the "already seen" test each becomes a synchronous localStorage write.
    const writes: string[] = [];
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push(k);
        store.set(k, v);
      },
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    });
    const { monitor } = await mountWithMonitor();

    const cue: SessionStatus = { id: "s1", status: "input", title: "one", createdAt: "1" };
    monitor.emit(cue);
    const afterFirst = writes.filter((k) => k === CUE_SEEN_KEY).length;
    monitor.emit(cue);
    monitor.emit(cue);

    expect(afterFirst).toBe(1);
    expect(writes.filter((k) => k === CUE_SEEN_KEY)).toHaveLength(1);
    expect(JSON.parse(store.get(CUE_SEEN_KEY) ?? "{}")).toEqual({ s1: "input" });
  });
});

// --- Coming back to the page ---

describe("tabs: returning to the page acknowledges what the user can now see", () => {
  it("acknowledges the ACTIVE tab's cue, not the first tab's", async () => {
    // The deferred half of the active-tab acknowledgement: a cue that latched
    // while the page was hidden was deliberately left unacknowledged so it could
    // raise the out-of-page surfaces, and this is the same acknowledgement at the
    // moment it becomes true. Keyed on the ACTIVE tab, so with the SECOND tab
    // active the first tab's state must not stand in for it.
    const { root, monitor } = await mountWithMonitor();
    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();
    await until(() => root.querySelectorAll(".wt-tab-active").length === 1);
    expect(root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.className).toContain("wt-tab-active");

    setVisibility("hidden");
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
    expect(document.title).toBe("(1) Host page");

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("Host page");
  });

  it("acknowledges nothing while the page is still hidden", async () => {
    // visibilitychange fires for the transition INTO hidden as well, and a phone
    // re-fires it as the OS parks the page. Acknowledging there would blank the
    // cue the out-of-page surfaces exist to raise, while the user is looking at
    // something else entirely.
    const { monitor } = await mountWithMonitor();
    setVisibility("hidden");
    monitor.emit({ id: "s1", status: "input", title: "one", createdAt: "1" });
    expect(document.title).toBe("(1) Host page");

    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("(1) Host page");
    expect(localStorage.getItem(CUE_SEEN_KEY)).toBeNull();
  });
});

// --- The page going away and coming back ---

describe("tabs: the page's own icon and title on the way out", () => {
  it("repaints the cue only for a page that actually came back", async () => {
    // pagehide hands the icon and title back because a browser remembers ONE icon
    // per URL. The matching pageshow only has something to restore when the page
    // was BFCACHED: a plain load fires pageshow too, and repainting there would
    // write a cue onto a page whose fold has not run yet.
    const { monitor } = await mountWithMonitor();
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(document.title).toBe("(1) Host page");

    window.dispatchEvent(new Event("pagehide"));
    expect(document.title).toBe("Host page");

    const fresh = new Event("pageshow");
    Object.defineProperty(fresh, "persisted", { value: false });
    window.dispatchEvent(fresh);
    expect(document.title).toBe("Host page");

    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    expect(document.title).toBe("(1) Host page");
  });
});

// --- The switch button's aggregate dot ---

describe("tabs: the switch button's dot", () => {
  it("drops its tooltip along with its colour when the cue is acknowledged", async () => {
    // The dot's title is the same wording the per-tab dots use, so the aggregate
    // cue names the state it shows. Once the cue is gone the dot is hidden, and a
    // tooltip left behind on a hidden element still answers a hover on the button
    // — claiming a terminal wants attention when none does.
    list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const { root, monitor } = await mountWithMonitor();
    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");

    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");
    expect(dot?.getAttribute("title")).toBe("waiting for you");

    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    expect(dot?.dataset["status"]).toBeUndefined();
    expect(dot?.hasAttribute("title")).toBe(false);
  });
});

// --- The opt-in icon variants ---

describe("tabs: the attention icons are opt-in", () => {
  it("leaves the page's own icon alone unless the app shipped the variants", async () => {
    // The icon sink swaps in a generated per-status variant (favicon-input.svg and
    // friends, see .kiro/scripts/gen-attention-icons.py). An app that never
    // generated them would get 404s in place of its icon, so the capability is
    // off until the consumer says the assets exist.
    // Read back through the link this test inserted, not through the first
    // `link[rel~="icon"]` in the document: the tester page ships an icon link of
    // its own (`/__vitest__/favicon.svg`), so a document-wide query returns that
    // one and the assertion measures the harness instead of the subject.
    const ownIcon = document.createElement("link");
    ownIcon.rel = "icon";
    ownIcon.setAttribute("href", "/favicon.svg");
    document.head.appendChild(ownIcon);
    const iconHref = (): string | null => ownIcon.getAttribute("href");
    try {
      const { monitor } = await mountWithMonitor();
      monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
      // The title count still rises: only the icon needs the generated assets.
      expect(document.title).toBe("(1) Host page");
      expect(iconHref()).toBe("/favicon.svg");
    } finally {
      ownIcon.remove();
    }
  });
});

// --- Row motion in the open list ---

describe("tabs: the open list's add/close motion", () => {
  /** Open the tray on a three-tab strip, close the LAST listed tab through its
   *  row, and hand back the row element the close removed. Reading the inline
   *  style off the (by then detached) element is race-free: animateRowOut writes
   *  it synchronously and only the removal is deferred. */
  async function closeARowWhileOpen(root: HTMLElement): Promise<HTMLElement> {
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    expect(root.querySelector(".wt-switcher")?.className).toContain("wt-switcher-expanded");
    const rows = [...root.querySelectorAll<HTMLElement>(".wt-switcher-row")];
    const row = rows[rows.length - 1];
    if (!row) {
      throw new Error("no listed rows");
    }
    row.querySelector<HTMLElement>(".wt-switcher-row-close")?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    return row;
  }

  beforeEach(() => {
    list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
  });

  it("collapses a closed row out of an already-open list", async () => {
    // The tray's height follows its rows, so removing one outright makes the
    // sheet snap shorter under the user's finger. The leaving row is taken out of
    // hit-testing as it goes, since a row mid-collapse must not answer a tap.
    const root = await mount();
    const row = await closeARowWhileOpen(root);

    expect(row.style.pointerEvents).toBe("none");
    expect(row.style.maxHeight).not.toBe("");
  });

  it("removes a closed row outright when the viewer asked for no motion", async () => {
    // Reduced motion is read LIVE at every mutation, and the gate has to be in the
    // JS as well as the CSS because these transitions are written inline where no
    // stylesheet rule can reach them.
    stubMedia({ "(prefers-reduced-motion: reduce)": true });
    const root = await mount();
    const row = await closeARowWhileOpen(root);

    expect(row.style.pointerEvents).toBe("");
    expect(row.style.maxHeight).toBe("");
  });
});

// --- The physical-keyboard heuristic ---

describe("tabs: physical-keyboard evidence is the whole key name", () => {
  // These run with NO fine pointer, so the keydown latch is the only thing that
  // can turn focus-on-switch on, and the switch is driven by a bare click so the
  // "put the keyboard back where the press took it from" rule cannot supply the
  // focus instead.
  async function mountCoarse(): Promise<{
    input: HTMLElement;
    press: (init: KeyboardEventInit) => void;
    switchAndReportFocus: (index: number) => boolean;
    chip: (index: number) => HTMLElement;
  }> {
    stubMedia({});
    const root = await mount();
    const input = root.querySelector<HTMLElement>(".term-input");
    if (!input) {
      throw new Error("no .term-input");
    }
    const chip = (index: number): HTMLElement => {
      const el = root.querySelectorAll<HTMLElement>(".wt-tab")[index];
      if (!el) {
        throw new Error("no chip");
      }
      return el;
    };
    return {
      input,
      chip,
      press: (init) => {
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
      },
      switchAndReportFocus: (index) => {
        // `document.body.focus()` does not move focus in a real browser: the body
        // has no tabindex, so focus() on it is ignored and the textarea keeps it.
        // Blurring the input is what actually parks focus off it (Chromium then
        // reports document.activeElement as <body>, never null).
        input.blur();
        chip(index).click();
        return document.activeElement === input;
      },
    };
  }

  it("does not read a longer name that merely contains an F-number as a function key", async () => {
    // The pattern is anchored at both ends, so the evidence is the key name
    // itself and not a substring of it. An embedding page can dispatch any
    // keydown it likes into this chrome (wt-container mode), and a vendor key
    // value is not proof a keyboard is attached — reading one as proof turns the
    // soft keyboard back on for every switch on a bare phone.
    const h = await mountCoarse();
    h.press({ key: "XF1" });
    expect(h.switchAndReportFocus(1)).toBe(false);
    h.press({ key: "F1x" });
    expect(h.switchAndReportFocus(0)).toBe(false);
    // F12 itself still counts, so the rejection above is about the anchors and
    // not about the pattern having stopped working.
    h.press({ key: "F12" });
    expect(h.switchAndReportFocus(1)).toBe(true);
  });

  it("does not hand the keyboard over for a switch no press drove", async () => {
    // Focus parked on the strip is not enough on its own: the OTHER reason to
    // focus the input is that the press being handled took the keyboard OFF it,
    // and handing it back is then a restore rather than new focus. A switch with
    // no press behind it (focus arriving on a chip on its own, a remote adopt)
    // must summon nothing — this runs with no fine pointer and no hardware key
    // seen, so the press half is the only half that could say yes.
    const h = await mountCoarse();
    h.chip(0).focus();
    expect(document.activeElement).toBe(h.chip(0));

    // Activated with the keyboard still on the chip, and no pointerdown at all.
    h.chip(1).click();
    await until(() => h.chip(1).className.includes("wt-tab-active"));

    expect(h.chip(1).className).toContain("wt-tab-active");
    expect(document.activeElement).not.toBe(h.input);
  });

  it("still hands displaced focus back in an environment with no matchMedia", async () => {
    // The pointer probe is guarded because matchMedia is the one capability here a
    // host environment can simply not have (an old embedded webview, a non-browser
    // DOM). Unguarded it throws, and the throw lands mid-way through the focus
    // rule: the press has already parked the keyboard on the chip and nothing
    // hands it back, so every press on the strip strands the keyboard there and
    // the strip's own keydown handling then eats the user's arrows.
    vi.stubGlobal("matchMedia", undefined);
    const root = await mount();
    const input = root.querySelector<HTMLElement>(".term-input");
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];
    if (!input || !chip) {
      throw new Error("no input or chip");
    }
    input.focus();
    // A press on the already-active chip: the pointerdown records that the
    // keyboard was on the input, and the browser's own default action then moves
    // focus to the chip (chips are not wired with holdFocusOnPress).
    chip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    chip.focus();
    chip.click();

    expect(document.activeElement).toBe(input);
  });
});

// --- How the terminal input is focused ---

describe("tabs: handing the keyboard to the terminal", () => {
  it("asks for focus without scrolling the page to the hidden input", async () => {
    // The input is a 1-line off-screen textarea inside a scroller. A plain focus()
    // asks the browser to scroll it into view, which on iOS drags the whole page
    // (and the terminal surface with it) as the keyboard comes up — so every
    // switch on an iPad would jump the view. preventScroll is the one option that
    // suppresses it, and nothing else about the call is observable, so this pins
    // the option itself.
    stubMedia({ "(any-pointer: fine)": true }); // a keyboard is likely: focus on switch
    const root = await mount();
    const input = root.querySelector<HTMLElement>(".term-input");
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[1];
    if (!input || !chip) {
      throw new Error("no input or chip");
    }
    const focus = vi.spyOn(input, "focus");
    chip.click();
    await until(() => focus.mock.calls.length > 0);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
