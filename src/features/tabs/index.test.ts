// @vitest-environment happy-dom
//
// tabs feature tests (design sections 5, 6, 22.10): the session list builds a
// tab per session with the first active, a switch re-points the renderer at the
// next tab's cached store and reconnects the WS to it, and creating a tab spawns
// a session and switches to it. Runs tabs alone (no activityMonitor) so no SSE
// mock is needed; fetch is stubbed for the REST API.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";
import type { TerminalFeature } from "../../kernel/types.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
import type { MobileToolbarApi } from "../mobile-toolbar.js";

// A fake activityMonitor feature: lets a test push status events into tabs
// without the real SSE. tabs reads it via ctx.use, so passing the same feature
// value in the features array (before tabs) and to tabs({ activityMonitor })
// wires them together.
function fakeMonitor(): {
  feature: TerminalFeature<ActivityMonitorApi>;
  emit: (s: SessionStatus) => void;
  open: () => void;
} {
  const subs = new Set<(s: SessionStatus) => void>();
  const openSubs = new Set<() => void>();
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
          onStreamOpen(cb) {
            openSubs.add(cb);
            return () => openSubs.delete(cb);
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
    open: () => {
      for (const cb of [...openSubs]) {
        cb();
      }
    },
  };
}

// A fake activityMonitor that delivers a status snapshot synchronously when
// tabs subscribes (onStatus), mimicking the server pushing the existing
// sessions on SSE open before the initial GET /api/sessions resolves. This is
// the ordering that used to duplicate every session (the list loop re-added the
// already-adopted tabs).
function snapshotMonitor(snapshot: readonly SessionStatus[]): TerminalFeature<ActivityMonitorApi> {
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

// A fake keyboardToggle feature (a MobileToolbarApi provider) so a test can
// verify tabs renders + wires its keyboard buttons without the real toolbar.
// Passed both in the features array (before tabs) and to tabs({ keyboardToggle })
// so ctx.use wires them, mirroring the activityMonitor fakes above.
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
      resetScrollback: vi.fn(),
      resetScreen: vi.fn(),
      bind,
      boundStore: vi.fn(() => ({ getWindow: () => ({ base: 0 }) })),
    },
    scroll: {
      init: vi.fn(),
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      restoreScrollTop: vi.fn(),
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
    },
  };
});

let createTerminal: (typeof KernelModule)["createTerminal"];
let tabs: (typeof TabsModule)["tabs"];
// Track the created terminal so afterEach can destroy it: tabs without an
// activityMonitor starts a polling setInterval, which must be cleared between
// tests (destroy() runs the feature teardown that clears it).
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    // A real Response always has headers, and the session API reads Retry-After
    // off a failed one. Without this the fake would throw a TypeError that the
    // call sites' catch blocks swallow, so a retry test would pass for the wrong
    // reason.
    headers: {
      get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let listBody: unknown[];
const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "POST") {
    return Promise.resolve(
      jsonResponse({ id: "s-new", title: "", createdAt: "3", status: "idle" }, 201),
    );
  }
  if (method === "DELETE") {
    return Promise.resolve(jsonResponse(null, 204));
  }
  return Promise.resolve(jsonResponse(listBody, 200));
});

beforeEach(async () => {
  vi.resetModules();
  setSession.mockClear();
  forgetSession.mockClear();
  bind.mockClear();
  fetchMock.mockClear();
  listBody = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
  ];
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
  localStorage.clear(); // isolate the persisted active-tab id between tests
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
});

async function until(pred: () => boolean, tries = 20): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// A minimal DataTransfer stand-in recording what the strip's drag handlers put
// on it, plus a synthetic DragEvent (happy-dom has no drag event constructors).
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
function dragEvent(type: string, dt: FakeDataTransfer): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dt });
  Object.defineProperty(e, "clientX", { value: 0 });
  Object.defineProperty(e, "clientY", { value: 0 });
  return e;
}

describe("tabs feature", () => {
  it("builds a tab per listed session with the first active and connects to it", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEls = root.querySelectorAll(".wt-tab");
    expect(tabEls.length).toBe(2);
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(true);
    expect(tabEls[1]?.classList.contains("wt-tab-active")).toBe(false);
    // The first (oldest) session is activated: renderer bound + WS connected.
    expect(bind).toHaveBeenCalled();
    expect(setSession).toHaveBeenCalledWith("s1");
  });

  it("restores the previously-active tab on reload from localStorage", async () => {
    // A prior session left s2 active; a reload must reopen s2, not the oldest s1.
    localStorage.setItem("wt-active-session", "s2");
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEls = root.querySelectorAll(".wt-tab");
    expect(tabEls[1]?.classList.contains("wt-tab-active")).toBe(true);
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(false);
    expect(setSession).toHaveBeenCalledWith("s2");
  });

  it("falls back to the oldest tab when the saved active id no longer exists", async () => {
    // The saved tab was closed before the reload; activate the oldest instead.
    localStorage.setItem("wt-active-session", "s-gone");
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEls = root.querySelectorAll(".wt-tab");
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(true);
    expect(setSession).toHaveBeenCalledWith("s1");
  });

  it("spawns and activates a fresh session when every listed session is exited", async () => {
    // The agent died in every listed session (e.g. a sign-in dead end). The
    // bootstrap must not wedge on a corpse: it spawns a fresh live session,
    // activates it, and keeps the exited one around as a viewable tab.
    listBody = [{ id: "s1", title: "", createdAt: "1", status: "exited" }];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(setSession).toHaveBeenCalledWith("s-new");
    expect(setSession).not.toHaveBeenCalledWith("s1");
    // The exited session still has a tab (switch to it to read its last screen).
    expect(root.querySelectorAll(".wt-tab").length).toBe(2);
  });

  it("activates the oldest LIVE session, not an older exited one", async () => {
    listBody = [
      { id: "s1", title: "dead", createdAt: "1", status: "exited" },
      { id: "s2", title: "alive", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(setSession).toHaveBeenCalledWith("s2");
    // No fresh session was spawned: a live one existed.
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });

  it("ignores a saved active id whose session has exited (no reload-onto-a-corpse)", async () => {
    localStorage.setItem("wt-active-session", "s1");
    listBody = [
      { id: "s1", title: "dead", createdAt: "1", status: "exited" },
      { id: "s2", title: "alive", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(setSession).toHaveBeenCalledWith("s2");
    expect(setSession).not.toHaveBeenCalledWith("s1");
  });

  it("falls back to the exited tab when nothing is live and the fresh spawn fails", async () => {
    // Server lists only a corpse and refuses to create (e.g. rate limited).
    // A frozen final screen + "Session ended" still beats a blank page, so the
    // exited tab is activated as the last resort.
    listBody = [{ id: "s1", title: "dead", createdAt: "1", status: "exited" }];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") {
          return Promise.resolve(jsonResponse({ error: "rate_limited" }, 429));
        }
        return Promise.resolve(jsonResponse(listBody, 200));
      }),
    );
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => setSession.mock.calls.length > 0);

    expect(setSession).toHaveBeenCalledWith("s1");
  });

  it("switches to another tab: re-points the renderer and reconnects the WS", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    setSession.mockClear();
    bind.mockClear();

    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();

    expect(setSession).toHaveBeenCalledWith("s2");
    expect(bind).toHaveBeenCalledTimes(1);
    const tabEls = root.querySelectorAll(".wt-tab");
    expect(tabEls[1]?.classList.contains("wt-tab-active")).toBe(true);
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(false);
  });

  it("creates a new tab via + and switches to it", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    root.querySelector<HTMLElement>(".wt-tab-new")?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    expect(root.querySelectorAll(".wt-tab").length).toBe(3);
    expect(setSession).toHaveBeenCalledWith("s-new");
  });

  it("renders the + button as a fixed bar item outside the scrolling tab list", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const scroller = root.querySelector(".wt-tab-scroll");
    const newBtn = root.querySelector(".wt-tab-new");
    expect(newBtn).toBeTruthy();
    // The close-all bar button is gone (it moved to the right-click menu). The
    // + sits OUTSIDE the scroller, directly after it in the bar, so an
    // overflowing tab list scrolls under it and can never push it away; the
    // scroller holds only the tabs, its last child being the last tab.
    expect(root.querySelector(".wt-tab-closeall")).toBeNull();
    expect(scroller?.contains(newBtn ?? null)).toBe(false);
    expect(newBtn?.previousElementSibling).toBe(scroller);
    expect(scroller?.lastElementChild?.classList.contains("wt-tab")).toBe(true);
  });

  it("keeps a tab's dot hidden until its session reports activity (default)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // The listed sessions carry no reportsActivity flag: evidence-driven
    // reveal keeps every dot unrevealed (a plain shell's tabs stay label-only).
    const dot = root.querySelector<HTMLElement>(".wt-tab .wt-tab-dot");
    expect(dot).toBeTruthy();
    expect(dot?.classList.contains("wt-reports")).toBe(false);
  });

  it("shows the idle dot from tab creation with presumeReports (agent shell)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs({ presumeReports: true })] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // An agent shell presumes every session reports (presetAgentTabbed): the
    // dot is revealed as idle immediately, without waiting for the agent's
    // first OSC 9;4 signal.
    for (const dot of root.querySelectorAll<HTMLElement>(".wt-tab .wt-tab-dot")) {
      expect(dot.classList.contains("wt-reports")).toBe(true);
      expect(dot.dataset["status"]).toBe("idle");
    }
  });

  it("closes a tab on middle-click", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    fetchMock.mockClear();
    // Middle-click (button 1) the second tab.
    root
      .querySelectorAll<HTMLElement>(".wt-tab")[1]
      ?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    const deleted = fetchMock.mock.calls.some(
      (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith("/s2"),
    );
    expect(deleted).toBe(true);
  });

  it("does not duplicate tabs when the status snapshot arrives before the initial list", async () => {
    // The SSE snapshot adopts s1+s2 as tabs.setup subscribes, before the awaited
    // GET /api/sessions (which also lists s1+s2) resolves. The list loop must
    // dedup against the adopted tabs: a straight push doubled every session
    // (4 tabs from 2) and painted two active (both copies of the active id).
    const monitor = snapshotMonitor([
      { id: "s1", status: "idle", title: "one", createdAt: "1" },
      { id: "s2", status: "idle", title: "two", createdAt: "2" },
    ]);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [monitor, tabs({ activityMonitor: monitor })] });
    await until(() => root.querySelectorAll(".wt-tab").length >= 2);
    // Give the initial list loop a turn to (wrongly) add duplicates.
    await new Promise((r) => setTimeout(r, 0));

    expect(root.querySelectorAll(".wt-tab").length).toBe(2);
    expect(root.querySelectorAll(".wt-tab.wt-tab-active").length).toBe(1);
  });

  it("replaces the sole tab on close (spawns first, then drops) without emptying the strip", async () => {
    listBody = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    fetchMock.mockClear();
    // Close the only tab (middle-click). A fresh session is POSTed and the old
    // one DELETEd; the strip keeps exactly one tab (the replacement) throughout.
    root
      .querySelector<HTMLElement>(".wt-tab")
      ?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await until(() => fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "POST"));
    await until(() =>
      fetchMock.mock.calls.some(
        (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith("/s1"),
      ),
    );

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    expect(root.querySelector(".wt-tab.wt-tab-active")).toBeTruthy();
    // The replacement is the fresh session, not the closed one.
    expect(root.querySelector(".wt-tab-label")?.textContent).toBe("New tab");
  });

  // --- Right-click tab context menu (round-4) ---
  // openTabMenu right-clicks a tab and returns the menu's buttons (the "button"
  // tag overload types these as HTMLButtonElement, so .disabled/.click() work).
  function openTabMenu(root: HTMLElement, index: number): HTMLButtonElement[] {
    const tab = root.querySelectorAll<HTMLElement>(".wt-tab")[index];
    tab?.dispatchEvent(new MouseEvent("contextmenu", { clientX: 10, clientY: 10, bubbles: true }));
    const menu = root.querySelector(".wt-tab-menu");
    return menu ? [...menu.querySelectorAll("button")] : [];
  }
  function menuItem(items: HTMLButtonElement[], label: string): HTMLButtonElement | undefined {
    return items.find((b) => b.textContent === label);
  }
  function wasDeleted(id: string): boolean {
    return fetchMock.mock.calls.some(
      (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith(`/${id}`),
    );
  }

  it("opens a right-click context menu on a tab with the move and close actions", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const menu = root.querySelector(".wt-tab-menu");
    expect(menu?.classList.contains("visible")).toBe(false);

    const items = openTabMenu(root, 0);
    expect(menu?.classList.contains("visible")).toBe(true);
    expect(items.map((b) => b.textContent)).toEqual([
      "Rename\u2026",
      "Use automatic name",
      "Move left",
      "Move right",
      "Close",
      "Close others",
      "Close to the right",
      "Close to the left",
      "Close all",
    ]);
    // The naming pair sits above a separator, away from the close items.
    expect(menu?.querySelectorAll(".wt-tab-menu-sep").length).toBe(1);
    // With no pinned name there is nothing to revert to, so the item is present
    // but inert — the menu's item positions never shift.
    expect(menuItem(items, "Use automatic name")?.disabled).toBe(true);
    expect(menuItem(items, "Rename\u2026")?.disabled).toBe(false);
    // On the first of two tabs, the leftward actions are disabled; the rest enabled.
    expect(menuItem(items, "Move left")?.disabled).toBe(true);
    expect(menuItem(items, "Move right")?.disabled).toBe(false);
    expect(menuItem(items, "Close to the left")?.disabled).toBe(true);
    expect(menuItem(items, "Close to the right")?.disabled).toBe(false);
    expect(menuItem(items, "Close others")?.disabled).toBe(false);
  });

  // --- Keyboard interaction on the desktop strip (WCAG 2.1.1; APG Tabs) ---
  function pressKey(el: HTMLElement | undefined, key: string): void {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  it("manages a roving tabindex: exactly the selected tab is in the Tab order", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEls = [...root.querySelectorAll<HTMLElement>(".wt-tab")];
    expect(tabEls.map((t) => t.tabIndex)).toEqual([0, -1]);
    tabEls[1]?.click();
    expect(tabEls.map((t) => t.tabIndex)).toEqual([-1, 0]);
  });

  it("ArrowRight/ArrowLeft move the selection and focus, wrapping at the ends", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    const tabEls = [...root.querySelectorAll<HTMLElement>(".wt-tab")];
    setSession.mockClear();
    // Arrow from the focused (active) tab selects and focuses its neighbor.
    pressKey(tabEls[0], "ArrowRight");
    expect(setSession).toHaveBeenCalledWith("s2");
    expect(tabEls[1]?.classList.contains("wt-tab-active")).toBe(true);
    expect(document.activeElement).toBe(tabEls[1]);
    // ArrowRight from the last tab wraps to the first.
    pressKey(tabEls[2], "ArrowRight");
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(true);
    // ArrowLeft from the first tab wraps to the last.
    pressKey(tabEls[0], "ArrowLeft");
    expect(tabEls[2]?.classList.contains("wt-tab-active")).toBe(true);
    expect(document.activeElement).toBe(tabEls[2]);
  });

  it("Home and End select the boundary tabs", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    const tabEls = [...root.querySelectorAll<HTMLElement>(".wt-tab")];
    pressKey(tabEls[0], "End");
    expect(tabEls[2]?.classList.contains("wt-tab-active")).toBe(true);
    pressKey(tabEls[2], "Home");
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(true);
  });

  it("Delete closes the focused tab", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    fetchMock.mockClear();
    pressKey(root.querySelectorAll<HTMLElement>(".wt-tab")[1], "Delete");
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(wasDeleted("s2")).toBe(true);
  });

  // --- Move left / Move right (WCAG 2.5.7 single-pointer reorder) ---
  it("moves a tab one slot per command, keeping DOM and list order aligned", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const feature = tabs();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    // "Move right" on the first tab moves it exactly one slot.
    menuItem(openTabMenu(root, 0), "Move right")?.click();
    let labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels).toEqual(["two", "one", "three"]);
    // The internal order follows the DOM (positions, switcher, close-to-side).
    expect(feature.api?.list().map((t) => t.id)).toEqual(["s2", "s1", "s3"]);
    // The scroller still holds only tabs after the re-insertion (the "+" is a
    // fixed bar item outside it), so the last child is the last TAB.
    const scroller = root.querySelector(".wt-tab-scroll");
    expect(scroller?.querySelectorAll(":scope > :not(.wt-tab)").length).toBe(0);
    expect(scroller?.lastElementChild?.querySelector(".wt-tab-label")?.textContent).toBe("three");

    // "Move left" on it (now second) restores the original order: one slot back.
    menuItem(openTabMenu(root, 1), "Move left")?.click();
    labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels).toEqual(["one", "two", "three"]);
    expect(feature.api?.list().map((t) => t.id)).toEqual(["s1", "s2", "s3"]);
    // No session was closed or created by a reorder.
    expect(fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") !== "GET")).toBe(false);
  });

  it("swallows a tab drop rather than letting the browser act on the payload", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEl = root.querySelector<HTMLElement>(".wt-tab");
    const surface = root.querySelector(".term");
    const dt = fakeDataTransfer();
    tabEl?.dispatchEvent(dragEvent("dragstart", dt));

    // The id rides a PRIVATE type. WebKit loads dropped text/plain as a URL, so a
    // bare session id there navigated iPadOS to /<session-id> mid-reorder.
    expect(dt.data["text/plain"]).toBeUndefined();
    expect(dt.data["application/x-web-terminal-tab"]).toBe("s1");
    // And an EXPLICIT drag image: WebKit renders none of its own for an element
    // under the strip's backdrop-filter (webkit.org/b/22787).
    expect(dt.image?.classList.contains("wt-tab-ghost")).toBe(true);

    // The drop is cancelled on the strip AND anywhere else it may land.
    const onStrip = dragEvent("drop", dt);
    tabEl?.dispatchEvent(onStrip);
    expect(onStrip.defaultPrevented).toBe(true);
    const offStrip = dragEvent("drop", dt);
    surface?.dispatchEvent(offStrip);
    expect(offStrip.defaultPrevented).toBe(true);
    // Order still follows the DOM, and nothing was closed or created.
    expect(fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") !== "GET")).toBe(false);

    // The document guard lasts only as long as the tab drag: an unrelated drop
    // (a file onto the page) is left entirely to the browser.
    tabEl?.dispatchEvent(dragEvent("dragend", dt));
    const unrelated = dragEvent("drop", dt);
    surface?.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
  });

  it("announces a tab move on the polite live region", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    menuItem(openTabMenu(root, 0), "Move right")?.click();
    // The announcer re-sets the cleared region after a ~100ms timer.
    await new Promise((r) => setTimeout(r, 130));
    const live = root.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Moved one to position 2");
  });

  it("disables 'Close to the right' on the last tab", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    const items = openTabMenu(root, 2);
    expect(menuItem(items, "Close to the right")?.disabled).toBe(true);
    expect(menuItem(items, "Close to the left")?.disabled).toBe(false);
  });

  it("closes all other tabs from the context menu (Close others)", async () => {
    vi.stubGlobal("confirm", () => true);
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    fetchMock.mockClear();
    // Right-click the middle tab (s2) and choose "Close others".
    menuItem(openTabMenu(root, 1), "Close others")?.click();
    // The closes are async (sequential DELETEs); wait for both to land.
    await until(
      () => fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "DELETE").length === 2,
    );

    expect(wasDeleted("s1")).toBe(true);
    expect(wasDeleted("s3")).toBe(true);
    expect(wasDeleted("s2")).toBe(false);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    // s2 is the survivor and becomes active.
    expect(root.querySelector(".wt-tab-label")?.textContent).toBe("two");
  });

  // Title RESOLUTION now lives entirely in the engine: the input-derived name and
  // its eligibility filter and session-scoped latch are Go code
  // (terminal/inputtitle.go), and the precedence between pinned / derived / OSC /
  // client-pushed / process-inferred is resolved server-side into one `title`
  // field. Seven tests here used to cover the browser's own version of that; the
  // server is the source of truth for a session's name, because a browser can only
  // ever derive from ITS OWN keyboard and so disagreed with every other client.
  //
  // What the UI still owes is rendering what the server resolved — including a
  // name that arrives MID-SESSION, which is exactly what a server-side deriver
  // produces and what no earlier test covered.
  it("renders the title the server resolved, including one that arrives later", async () => {
    const monitor = fakeMonitor();
    listBody = [{ id: "s1", title: "", createdAt: "1", status: "idle" }];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    const labels = (): (string | null)[] =>
      [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels()).toEqual(["New tab"]);

    // The engine latched a name from the input stream and pushed it.
    monitor.emit({
      id: "s1",
      status: "idle",
      title: "refactor the auth module",
      createdAt: "1",
      reportsActivity: false,
    });
    await until(() => labels()[0] === "refactor the auth module");

    // A blank title never overwrites a good one (a program clearing its own OSC
    // title reports ""), so the name holds.
    monitor.emit({
      id: "s1",
      status: "working",
      title: "",
      createdAt: "1",
      reportsActivity: false,
    });
    await until(() => false, 5);
    expect(labels()).toEqual(["refactor the auth module"]);
  });

  it("closes tabs to the right from the context menu", async () => {
    vi.stubGlobal("confirm", () => true);
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    fetchMock.mockClear();
    // Right-click the first tab and choose "Close to the right" (closes s2, s3).
    menuItem(openTabMenu(root, 0), "Close to the right")?.click();
    // The closes are async (sequential DELETEs); wait for both to land.
    await until(
      () => fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "DELETE").length === 2,
    );

    expect(wasDeleted("s2")).toBe(true);
    expect(wasDeleted("s3")).toBe(true);
    expect(wasDeleted("s1")).toBe(false);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
  });

  it("closes every tab and opens a fresh one via 'Close all' (confirmed)", async () => {
    vi.stubGlobal("confirm", () => true);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    fetchMock.mockClear();
    menuItem(openTabMenu(root, 0), "Close all")?.click();
    // Both existing sessions are DELETEd and one fresh session is POSTed.
    await until(
      () =>
        fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "DELETE").length === 2 &&
        fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "POST"),
    );
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
  });

  it("does not close tabs when 'Close all' is cancelled", async () => {
    vi.stubGlobal("confirm", () => false);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    fetchMock.mockClear();
    menuItem(openTabMenu(root, 0), "Close all")?.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(root.querySelectorAll(".wt-tab").length).toBe(2);
    expect(fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "DELETE")).toBe(false);
  });

  it("labels tabs from the server title and shows 'New tab' for untitled ones", async () => {
    listBody = [
      { id: "s1", title: "kiro: fix bug", createdAt: "1", status: "idle" },
      { id: "s2", title: "", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels[0]).toBe("kiro: fix bug");
    // An untitled session reads "New tab" (no "Tab N" number).
    expect(labels[1]).toBe("New tab");
  });

  it("shows 'New tab' for every untitled tab, with no numeric suffix", async () => {
    listBody = [
      { id: "s1", title: "", createdAt: "1", status: "idle" },
      { id: "s2", title: "", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    // Fallback labels are not de-duplicated, so both stay plain "New tab".
    expect(labels).toEqual(["New tab", "New tab"]);
  });

  it("de-duplicates identical tab titles with a numeric suffix", async () => {
    listBody = [
      { id: "s1", title: "kiro: workspace", createdAt: "1", status: "idle" },
      { id: "s2", title: "kiro: workspace", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels[0]).toBe("kiro: workspace");
    expect(labels[1]).toBe("kiro: workspace (2)");
  });

  it("creates one session when the list is empty", async () => {
    listBody = [];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    // POST was used to create the initial session.
    const posted = fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "POST");
    expect(posted).toBe(true);
  });

  it("renders the mobile bar reflecting the active tab, with a close button and no position counter", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(root.querySelector(".wt-switcher-label")?.textContent).toBe("one");
    // The n/m counter is gone (the list rotates, so an absolute position number
    // is meaningless); the active row instead carries the standard close (x)
    // that every other row has.
    expect(root.querySelector(".wt-switcher-pos")).toBeNull();
    expect(root.querySelector(".wt-switcher-current-close")).toBeTruthy();
    // The mobile "+" is present; the keyboard button stays hidden without a
    // keyboardToggle wired (the separate overview button + count are gone).
    expect(root.querySelector(".wt-switcher-new")).toBeTruthy();
    expect(root.querySelector<HTMLElement>(".wt-switcher-kb")?.hidden).toBe(true);
  });

  it("expands the bar to list the other tabs; a row selects it and collapses", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const switcher = root.querySelector(".wt-switcher");
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(false);

    // Tapping the active surface expands the bar to list the OTHER tabs (s2);
    // the active tab (s1) stays in the bar row, so only one row is listed.
    root.querySelector<HTMLElement>(".wt-switcher-current")?.click();
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(true);
    expect(root.querySelectorAll(".wt-switcher-row").length).toBe(1);

    setSession.mockClear();
    root.querySelector<HTMLElement>(".wt-switcher-row .wt-switcher-row-select")?.click();
    expect(setSession).toHaveBeenCalledWith("s2");
    // Selecting a tab collapses the list.
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(false);
  });

  it("orders the expanded list circularly starting after the active tab", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
      { id: "s4", title: "four", createdAt: "4", status: "idle" },
    ];
    const feature = tabs();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 4);

    // Make s2 active, then open the list: it should read as the circular queue
    // that follows s2 -> three, four, one (s1 wraps to the end).
    feature.api?.switchTo("s2");
    root.querySelector<HTMLElement>(".wt-switcher-current")?.click();
    const labels = [...root.querySelectorAll(".wt-switcher-row-label")].map((e) => e.textContent);
    expect(labels).toEqual(["three", "four", "one"]);
  });

  it("keeps the last good title when a later status update reports a blank one", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // The process sets a window title.
    monitor.emit({ id: "s1", status: "working", title: "kiro: building", createdAt: "1" });
    expect(root.querySelectorAll(".wt-tab-label")[0]?.textContent).toBe("kiro: building");

    // A later sweep reports a BLANK title (the process cleared its OSC 0/2
    // title, or an idle-session record has none). It must NOT revert the label
    // to "New tab": the last good title is held until a real one replaces it.
    monitor.emit({ id: "s1", status: "idle", title: "", createdAt: "1" });
    expect(root.querySelectorAll(".wt-tab-label")[0]?.textContent).toBe("kiro: building");

    // A genuine new non-blank title still replaces it.
    monitor.emit({ id: "s1", status: "idle", title: "kiro: tests", createdAt: "1" });
    expect(root.querySelectorAll(".wt-tab-label")[0]?.textContent).toBe("kiro: tests");
  });

  it("closes a tab from an expanded list row (DELETE)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    root.querySelector<HTMLElement>(".wt-switcher-current")?.click(); // expand
    fetchMock.mockClear();
    root.querySelector<HTMLElement>(".wt-switcher-row .wt-switcher-row-close")?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    const deleted = fetchMock.mock.calls.some(
      (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith("/s2"),
    );
    expect(deleted).toBe(true);
  });

  it("collapses the expanded list on a second tap", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const switcher = root.querySelector(".wt-switcher");
    const current = root.querySelector<HTMLElement>(".wt-switcher-current");
    current?.click(); // expand
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(true);
    current?.click(); // a second tap toggles it closed
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(false);
  });

  it("switches tabs on a horizontal swipe of the switcher bar", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const cur = root.querySelector<HTMLElement>(".wt-switcher-current");
    setSession.mockClear();
    // A leftward drag (dx < 0) advances to the next tab.
    cur?.dispatchEvent(new MouseEvent("pointerdown", { clientX: 220, clientY: 10, bubbles: true }));
    cur?.dispatchEvent(new MouseEvent("pointerup", { clientX: 90, clientY: 14, bubbles: true }));
    expect(setSession).toHaveBeenCalledWith("s2");
  });

  it("shows the switch-button dot for a background needs-input, greens on done (latest-wins)", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // No pending notification on the dedicated switch button initially.
    expect(dot?.dataset["status"]).toBeUndefined();

    // s2 is a background tab (s1 is active) that needs input -> amber cue.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");

    // The same background tab then finishes a turn -> green cue (latest wins:
    // the newer "done" overwrites the earlier "input").
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("done");
  });

  it("clears the switch-button dot when the list opens (click the switch button)", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // A background tab raises the cue.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");

    // Opening the switcher acknowledges it: the dot clears (reset happens only
    // on open, not on close).
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    expect(root.querySelector(".wt-switcher")?.classList.contains("wt-switcher-expanded")).toBe(
      true,
    );
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("clears the switch-button dot when a swipe arrives on the tab that raised it", async () => {
    // Swiping through the tabs must acknowledge the cue on arrival at its
    // subject, not only opening the list (the reported bug: the dot survived a
    // swipe onto the concerned tab).
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // Background s2 needs input -> the cue lights.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");

    // A leftward swipe on the active row advances to s2 (the raising tab): the
    // cue is resolved by arriving there.
    const cur = root.querySelector<HTMLElement>(".wt-switcher-current");
    cur?.dispatchEvent(new MouseEvent("pointerdown", { clientX: 220, clientY: 10, bubbles: true }));
    cur?.dispatchEvent(new MouseEvent("pointerup", { clientX: 90, clientY: 14, bubbles: true }));
    expect(setSession).toHaveBeenCalledWith("s2");
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("keeps the switch-button dot when switching to a tab other than the raiser", async () => {
    const monitor = fakeMonitor();
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    const feature = tabs({ activityMonitor: monitor.feature });
    term = createTerminal(root, { features: [monitor.feature, feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // Background s3 raised the cue; visiting s2 does NOT resolve it.
    monitor.emit({ id: "s3", status: "done", title: "three", createdAt: "3" });
    expect(dot?.dataset["status"]).toBe("done");
    feature.api?.switchTo("s2");
    expect(dot?.dataset["status"]).toBe("done");
    // Arriving on s3 does.
    feature.api?.switchTo("s3");
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("clears the switch-button dot when the tab that raised it is closed", async () => {
    // A cue whose subject is gone can never be resolved by visiting it; a close
    // must clear it rather than leave a permanently lit dot.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");

    // Middle-click closes s2 (a background close from the desktop strip).
    root
      .querySelectorAll<HTMLElement>(".wt-tab")[1]
      ?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("toggles the switcher list closed when the switch button is clicked while open", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const switcher = root.querySelector(".wt-switcher");
    const btn = root.querySelector<HTMLElement>(".wt-switcher-switch");
    // The switch button sits between the keyboard and "+" buttons in the bar.
    const bar = root.querySelector(".wt-switcher-bar");
    expect(bar?.contains(btn ?? null)).toBe(true);
    expect(btn?.previousElementSibling?.classList.contains("wt-switcher-kb")).toBe(true);
    expect(btn?.nextElementSibling?.classList.contains("wt-switcher-new")).toBe(true);

    // First click opens the list.
    btn?.click();
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(true);
    // A second click (while open) closes it (toggle).
    btn?.click();
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(false);
  });

  it("arms the catching-up cue after a switch (until a screen frame lands)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const cue = root.querySelector(".wt-catchup");
    // Not shown on initial load (no switch), nor immediately on switch.
    expect(cue?.classList.contains("visible")).toBe(false);
    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();
    expect(cue?.classList.contains("visible")).toBe(false);
    // Shown once the short grace elapses without the resume delta arriving (the
    // mocked connection emits no screen frame, so it stays up).
    await new Promise((r) => setTimeout(r, 180));
    expect(cue?.classList.contains("visible")).toBe(true);
  });

  it("polls the session list to update dots and drop reaped tabs without activityMonitor", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs({ pollMs: 10 })] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const s2dot = (): HTMLElement | undefined =>
      root.querySelectorAll<HTMLElement>(".wt-tab .wt-tab-dot")[1];

    // A poll picks up s2 going to working.
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "working" },
    ];
    await until(() => s2dot()?.dataset["status"] === "working", 60);
    expect(s2dot()?.dataset["status"]).toBe("working");

    // A later poll no longer lists s2 (reaped): its tab drops without a DELETE.
    listBody = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    await until(() => root.querySelectorAll(".wt-tab").length === 1, 60);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    const deleted = fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "DELETE");
    expect(deleted).toBe(false); // a reaped session is dropped locally, not DELETEd
  });

  it("carries a desktop-strip keyboard button, hidden without a keyboardToggle", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // The desktop strip carries its own keyboard button (like the switcher's):
    // the bar's LAST flex item, OUTSIDE the scrolling tab list, so it is pinned
    // at the bar's right edge (the scroll-to-bottom button's column) and an
    // overflowing tab list can never push or scroll it away. It stays hidden
    // until a keyboardToggle feature is wired, and never counts as a tab.
    const deskKb = root.querySelector<HTMLElement>(".wt-tab-kb");
    const bar = root.querySelector(".wt-tab-bar");
    expect(deskKb).toBeTruthy();
    expect(deskKb?.hidden).toBe(true);
    expect(bar?.contains(deskKb ?? null)).toBe(true);
    expect(bar?.lastElementChild).toBe(deskKb);
    expect(root.querySelector(".wt-tab-scroll")?.contains(deskKb)).toBe(false);
    // Bar order [scroller | + | kb]: the kb button anchors to the right of the
    // fixed "+" (both outside the scroller).
    expect(deskKb?.previousElementSibling?.classList.contains("wt-tab-new")).toBe(true);
  });

  it("maps a vertical wheel over the bar to horizontal tab-list scrolling", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const scroller = root.querySelector<HTMLElement>(".wt-tab-scroll");
    if (!bar || !scroller) {
      throw new Error("missing tab bar chrome");
    }

    // Not overflowing (happy-dom reports scrollWidth = clientWidth = 0): the
    // wheel falls through untouched so the page keeps it.
    const inert = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    bar.dispatchEvent(inert);
    expect(inert.defaultPrevented).toBe(false);
    expect(scroller.scrollLeft).toBe(0);

    // Overflowing: a vertical wheel translates to scrollLeft and claims the
    // event; a horizontal-dominant delta (trackpad pan) keeps native handling.
    Object.defineProperty(scroller, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 200, configurable: true });
    const vertical = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    bar.dispatchEvent(vertical);
    expect(vertical.defaultPrevented).toBe(true);
    expect(scroller.scrollLeft).toBe(120);

    const lines = new WheelEvent("wheel", {
      deltaY: 3,
      deltaMode: 1, // DOM_DELTA_LINE (Firefox wheel): fixed per-line step
      bubbles: true,
      cancelable: true,
    });
    bar.dispatchEvent(lines);
    expect(scroller.scrollLeft).toBe(120 + 3 * 32);

    const pan = new WheelEvent("wheel", {
      deltaX: 80,
      deltaY: 10,
      bubbles: true,
      cancelable: true,
    });
    bar.dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(false);
    expect(scroller.scrollLeft).toBe(120 + 3 * 32);
  });

  it("closes the key grid on a second tap of the desktop keyboard button", async () => {
    const kbt = fakeKeyboardToggle();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [kbt.feature, tabs({ keyboardToggle: kbt.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const deskKb = root.querySelector<HTMLElement>(".wt-tab-kb");
    deskKb?.click();
    expect(kbt.isOpen()).toBe(true);

    // A real tap delivers pointerup (bubbling to the document's capture-phase
    // tap-dismiss handler) BEFORE the click. The handler used to treat the tab
    // strip as "outside" chrome: it closed the grid on the pointerup and the
    // button's click then re-opened it — so a second tap never closed the grid
    // (the landscape-phone / iPad bug). The strip now counts as chrome.
    deskKb?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    deskKb?.click();
    expect(kbt.isOpen()).toBe(false);
  });

  it("wires the desktop + mobile keyboard buttons to the one shared grid toggle", async () => {
    const kbt = fakeKeyboardToggle();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [kbt.feature, tabs({ keyboardToggle: kbt.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const deskKb = root.querySelector<HTMLElement>(".wt-tab-kb");
    const mobKb = root.querySelector<HTMLElement>(".wt-switcher-kb");
    // Both keyboard buttons come from the one factory and are un-hidden once a
    // keyboardToggle is wired (CSS then gates the desktop one to a wide
    // touchscreen and the mobile one to the switcher).
    expect(deskKb?.hidden).toBe(false);
    expect(mobKb?.hidden).toBe(false);

    // Clicking the desktop keyboard button toggles the SAME grid and reflects
    // the open state on BOTH buttons (one wiring, placed per layout).
    deskKb?.click();
    expect(kbt.isOpen()).toBe(true);
    expect(deskKb?.getAttribute("aria-expanded")).toBe("true");
    expect(mobKb?.getAttribute("aria-expanded")).toBe("true");
    expect(deskKb?.classList.contains("wt-active")).toBe(true);
    expect(mobKb?.classList.contains("wt-active")).toBe(true);
  });

  // --- Persisted tab arrangement ---
  //
  // A reorder is a user decision about their own workspace, so it has to outlive
  // a reload. It cannot come from the server: GET /api/sessions is sorted by
  // creation time, which is exactly the order the user rearranged away from.
  // These pin the client-side arrangement end to end — written on a reorder,
  // honoured on the next load, and not corrupted by the things that legitimately
  // change the tab set.

  // The strip's labels in DOM order. Scoped to the scroller, which holds ONLY
  // tabs: a drag's ghost is a chip clone parked under .wt-root until the next
  // frame, so a root-wide query would count the dragged tab twice.
  function idsOf(root: HTMLElement): string[] {
    return [
      ...(root.querySelector(".wt-tab-scroll")?.querySelectorAll<HTMLElement>(".wt-tab-label") ??
        []),
    ].map((e) => e.textContent ?? "");
  }
  function storedOrder(): unknown {
    const raw = localStorage.getItem("wt-tab-order");
    return raw === null ? null : JSON.parse(raw);
  }

  it("persists a reorder so it survives a reload", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    menuItem(openTabMenu(root, 2), "Move left")?.click();
    expect(idsOf(root)).toEqual(["one", "three", "two"]);
    expect(storedOrder()).toEqual(["s1", "s3", "s2"]);

    // Reload: same server listing (creation order), a fresh feature instance.
    term.destroy();
    root.remove();
    const root2 = document.createElement("div");
    document.body.appendChild(root2);
    term = createTerminal(root2, { features: [tabs()] });
    await until(() => root2.querySelectorAll(".wt-tab").length === 3);
    expect(idsOf(root2)).toEqual(["one", "three", "two"]);
  });

  it("restores the arrangement no matter which source delivers the sessions first", async () => {
    // The status stream pushes a snapshot on open and the bootstrap's list lands
    // separately, so arrival order is a race — and it is the SERVER's order, not
    // the user's. Placement must not depend on it.
    localStorage.setItem("wt-tab-order", JSON.stringify(["s3", "s1", "s2"]));
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const snapshot = listBody as unknown as SessionStatus[];
    const root = document.createElement("div");
    document.body.appendChild(root);
    const monitor = snapshotMonitor(snapshot);
    term = createTerminal(root, { features: [monitor, tabs({ activityMonitor: monitor })] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    expect(idsOf(root)).toEqual(["three", "one", "two"]);
    // The list order and the DOM order agree, so positions, the switcher rows
    // and close-to-the-side all read the same strip.
    expect(
      root.querySelector(".wt-tab-scroll")?.querySelectorAll(":scope > :not(.wt-tab)").length,
    ).toBe(0);
  });

  it("puts a session the arrangement does not know at the end, and prunes closed ones", async () => {
    localStorage.setItem("wt-tab-order", JSON.stringify(["s2", "s1", "gone-long-ago"]));
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    expect(idsOf(root)).toEqual(["two", "one"]);

    // A new session lands last (it predates no arrangement), and the stored
    // arrangement is rewritten from the live strip — so the id of a session that
    // no longer exists does not accumulate forever.
    root.querySelector<HTMLElement>(".wt-tab-new")?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 3);
    expect(storedOrder()).toEqual(["s2", "s1", "s-new"]);
  });

  it("keeps the stored arrangement when the strip transiently empties", async () => {
    // 'Close all' drops every tab before its replacement lands. An empty strip
    // carries no arrangement, so persisting it would erase the user's order.
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    menuItem(openTabMenu(root, 1), "Move left")?.click();
    expect(storedOrder()).toEqual(["s2", "s1"]);

    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    menuItem(openTabMenu(root, 0), "Close all")?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(storedOrder()).not.toEqual([]);
  });

  it("persists a DRAG reorder too, not only the menu's move commands", async () => {
    // The strip's drag-and-drop is the primary reorder gesture; Move left/right
    // is the pointer/keyboard alternative. Both commit through syncOrderFromDom,
    // which is why persistence hangs off syncChrome rather than off either call
    // site — this pins that the drag really reaches storage.
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const first = root.querySelector<HTMLElement>(".wt-tab");
    const bar = root.querySelector(".wt-tab-bar");
    const dt = fakeDataTransfer();
    first?.dispatchEvent(dragEvent("dragstart", dt));
    // Every rect is zero-sized under happy-dom, so dragTargetBefore finds no
    // midpoint past clientX=0 and the dragged chip goes to the end.
    bar?.dispatchEvent(dragEvent("dragover", dt));
    first?.dispatchEvent(dragEvent("drop", dt));

    expect(idsOf(root)).toEqual(["two", "one"]);
    expect(storedOrder()).toEqual(["s2", "s1"]);
  });

  it("never persists a partial arrangement while the strip is still filling", async () => {
    // The initial population grows the strip one tab at a time, so each
    // intermediate state is a PARTIAL arrangement. Persisting those meant a
    // reload landing mid-population stored a one-tab order — and, worse, the
    // partial write became the arrangement the rest of the population was placed
    // by, so the restore destroyed the very order it was reading. Pruning the one
    // COMPLETE strip at the end of the bootstrap is fine and wanted.
    localStorage.setItem("wt-tab-order", JSON.stringify(["s3", "s1", "s2", "closed-elsewhere"]));
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const writes: string[][] = [];
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (k === "wt-tab-order") {
        writes.push(JSON.parse(v) as string[]);
      }
      realSet.call(this, k, v);
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const monitor = snapshotMonitor(listBody as unknown as SessionStatus[]);
    term = createTerminal(root, { features: [monitor, tabs({ activityMonitor: monitor })] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    expect(idsOf(root)).toEqual(["three", "one", "two"]);
    // Whatever was written must describe the WHOLE strip, never a prefix of it.
    for (const w of writes) {
      expect(w, JSON.stringify(writes)).toEqual(["s3", "s1", "s2"]);
    }
  });

  it("survives storage that throws (Safari private mode) without losing the reorder", async () => {
    const boom = (): never => {
      throw new Error("storage disabled");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    menuItem(openTabMenu(root, 1), "Move left")?.click();
    // The reorder still applies for this page; only its persistence is lost.
    expect(idsOf(root)).toEqual(["two", "one"]);
  });
});

describe("tabs feature: a host that temporarily refuses session creation (503)", () => {
  // web-terminal-kiro holds session creation with 503 + Retry-After while its
  // tool engine installs the manifest's tools on first boot, a window its own
  // HEALTHCHECK budgets 20 minutes for. That used to surface as the same fixed
  // "Couldn't open a terminal" toast as a 500, with no retry: an empty tab bar
  // and a page that read as broken while the server was deliberately waiting
  // (and /api/health reported healthy at the same time).
  it("retries on the server's own hint and opens the terminal once it is ready", async () => {
    listBody = []; // nothing live, so the bootstrap must create
    let posts = 0;
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        posts++;
        // Refuse twice with a 0s hint (keeps the test fast; the parse itself is
        // covered in model.test.ts), then succeed.
        if (posts <= 2) {
          return Promise.resolve(
            jsonResponse({ error: "tools installing" }, 503, { "Retry-After": "0" }),
          );
        }
        return Promise.resolve(
          jsonResponse({ id: "s-new", title: "", createdAt: "3", status: "idle" }, 201),
        );
      }
      return Promise.resolve(jsonResponse(listBody, 200));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });

    await until(() => root.querySelectorAll(".wt-tab").length === 1, 200);
    expect(posts).toBe(3);
    expect(setSession).toHaveBeenCalledWith("s-new");
  });

  it("repeats the server's explanation rather than inventing library wording", async () => {
    listBody = [];
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          jsonResponse({ error: "tools installing" }, 503, { "Retry-After": "0" }),
        );
      }
      return Promise.resolve(jsonResponse(listBody, 200));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });

    // The host's own words reach the page; the library never hardcodes "tools",
    // which is a web-terminal-kiro concept it knows nothing about.
    await until(() => root.textContent?.includes("tools installing") === true, 200);
    expect(root.textContent).toContain("tools installing");
  });

  it("does NOT retry a 500: that is not 'come back shortly'", async () => {
    listBody = [];
    let posts = 0;
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        posts++;
        return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      }
      return Promise.resolve(jsonResponse(listBody, 200));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });

    await until(() => posts > 0, 200);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toBe(1);
  });
});

describe("tabs feature: stream-open reconcile (manager-restart zombie tabs)", () => {
  it("drops tabs the server no longer lists when the status stream (re)opens", async () => {
    // A manager restart kills every session; the replacement server's SSE
    // snapshot carries no tombstones for sessions it never knew, so the only
    // signal is the stream REOPEN. tabs must reconcile against
    // GET /api/sessions there and drop the zombies (no DELETE — they are
    // already gone) instead of leaving them spinning "Reconnecting…".
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // Restart: s1 died with the old manager; the new one lists only s2
    // (recreated elsewhere). The reopen triggers the one-shot reconcile.
    listBody = [{ id: "s2", title: "two", createdAt: "2", status: "idle" }];
    fetchMock.mockClear();
    monitor.open();

    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    // The zombie was dropped locally, never DELETEd (it is already gone).
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(false);
    // The reconcile listed sessions exactly once for this open.
    const gets = fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "GET");
    expect(gets.length).toBe(1);
  });
});

describe("tabs feature: boot race (stream-open reconcile vs bootstrap create)", () => {
  it("spares a tab adopted while the reconcile's list was in flight (no double create)", async () => {
    // The real boot interleaving (the double-create bug): the SSE stream opens
    // while the bootstrap's create POST is in flight, so the stream-open
    // reconcile's GET /api/sessions is answered from a snapshot taken BEFORE
    // the create committed (an empty list). That stale listing is not
    // authoritative for the tab the bootstrap adopts meanwhile: dropping it
    // cascaded into dropTab's last-tab intercept spawning a replacement — a
    // second POST, an orphaned server session, and an aborted first WS.
    const monitor = fakeMonitor();
    const stale: { resolve: (() => void) | null } = { resolve: null };
    let posts = 0;
    let gets = 0;
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        posts++;
        if (posts === 1) {
          // The stream opens exactly while the create is in flight: the
          // reconcile snapshots its epoch NOW (no tabs adopted yet) and its
          // GET hangs until after the bootstrap adopted the created session.
          monitor.open();
        }
        return Promise.resolve(
          jsonResponse({ id: `s-new-${posts}`, title: "", createdAt: "3", status: "idle" }, 201),
        );
      }
      if (method === "DELETE") {
        return Promise.resolve(jsonResponse(null, 204));
      }
      gets++;
      if (gets === 1) {
        // The bootstrap's own list: empty server, so it proceeds to create.
        return Promise.resolve(jsonResponse([], 200));
      }
      // The reconcile's list: deferred, resolved by the test AFTER the
      // bootstrap adopted its tab, with the stale pre-create body.
      return new Promise<Response>((res) => {
        stale.resolve = () => {
          res(jsonResponse([], 200));
        };
      });
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });

    // Bootstrap created + adopted its session while the reconcile's GET hangs.
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    await until(() => stale.resolve !== null);
    expect(stale.resolve).not.toBeNull();
    stale.resolve?.();
    // Let the reconcile finish; the adopted tab must survive its stale listing.
    await until(() => posts > 1, 5); // settles (no second create expected)

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    expect(posts).toBe(1); // no duplicate replacement session
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(false);
  });
});
