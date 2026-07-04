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
import type * as KernelModule from "./../kernel/kernel.js";
import type * as TabsModule from "./tabs.js";
import type { TerminalFeature } from "./../kernel/types.js";
import type { ActivityMonitorApi } from "./activity-monitor.js";

// A fake activityMonitor feature: lets a test push status events into tabs
// without the real SSE. tabs reads it via ctx.use, so passing the same feature
// value in the features array (before tabs) and to tabs({ activityMonitor })
// wires them together.
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
    scroll: { init: vi.fn(), scrollToBottom: vi.fn(), isUserScrolledUp: vi.fn(() => false) },
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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
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
  ({ createTerminal } = await import("./../kernel/kernel.js"));
  ({ tabs } = await import("./tabs.js"));
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

  it("renders the + button as the last item inside the tab strip", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const bar = root.querySelector(".wt-tab-bar");
    const newBtn = root.querySelector(".wt-tab-new");
    expect(newBtn).toBeTruthy();
    // The close-all bar button is gone (it moved to the right-click menu); the +
    // is the last flex item in the strip, right after the tabs.
    expect(root.querySelector(".wt-tab-closeall")).toBeNull();
    expect(bar?.contains(newBtn ?? null)).toBe(true);
    expect(bar?.lastElementChild).toBe(newBtn);
    expect(newBtn?.previousElementSibling?.classList.contains("wt-tab")).toBe(true);
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

  it("opens a right-click context menu on a tab with the five close actions", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const menu = root.querySelector(".wt-tab-menu");
    expect(menu?.classList.contains("visible")).toBe(false);

    const items = openTabMenu(root, 0);
    expect(menu?.classList.contains("visible")).toBe(true);
    expect(items.map((b) => b.textContent)).toEqual([
      "Close",
      "Close others",
      "Close to the right",
      "Close to the left",
      "Close all",
    ]);
    // On the first of two tabs, "Close to the left" is disabled; the rest enabled.
    expect(menuItem(items, "Close to the left")?.disabled).toBe(true);
    expect(menuItem(items, "Close to the right")?.disabled).toBe(false);
    expect(menuItem(items, "Close others")?.disabled).toBe(false);
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

  it("surfaces a background needs-input on the active bar surface", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // The needs-input cue now rides the active surface (the separate overview
    // button is gone); tapping/swiping it opens the overview to resolve it.
    const current = root.querySelector<HTMLElement>(".wt-switcher-current");
    expect(current?.dataset["attention"]).toBeUndefined();

    // s2 is a background tab (s1 is active) and needs input.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(current?.dataset["attention"]).toBe("input");

    // It clears once that tab reports a non-input status.
    monitor.emit({ id: "s2", status: "idle", title: "two", createdAt: "2" });
    expect(current?.dataset["attention"]).toBeUndefined();
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
});
