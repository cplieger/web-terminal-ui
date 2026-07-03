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
  return Promise.resolve(jsonResponse(listBody));
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

  it("renders the mobile switcher reflecting the active tab, position, and count", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(root.querySelector(".wt-switcher-label")?.textContent).toBe("one");
    expect(root.querySelector(".wt-switcher-pos")?.textContent).toBe("1 / 2");
    expect(root.querySelector(".wt-switcher-count")?.textContent).toBe("2");
  });

  it("opens the overview sheet, and a row selects the tab then closes the sheet", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const sheet = root.querySelector<HTMLElement>(".wt-sheet");
    expect(sheet?.hidden).toBe(true);

    root.querySelector<HTMLElement>(".wt-switcher-overview")?.click();
    expect(sheet?.hidden).toBe(false);
    expect(root.querySelectorAll(".wt-sheet-row").length).toBe(2);

    setSession.mockClear();
    // Select the second row.
    root.querySelectorAll<HTMLElement>(".wt-sheet-row .wt-sheet-select")[1]?.click();
    expect(setSession).toHaveBeenCalledWith("s2");
    expect(sheet?.hidden).toBe(true); // selection closed the sheet
  });

  it("closes a tab from a sheet row (DELETE)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    root.querySelector<HTMLElement>(".wt-switcher-overview")?.click();
    fetchMock.mockClear();
    root.querySelectorAll<HTMLElement>(".wt-sheet-row .wt-sheet-close")[1]?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    const deleted = fetchMock.mock.calls.some(
      (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith("/s2"),
    );
    expect(deleted).toBe(true);
  });

  it("closes the sheet on Escape", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const sheet = root.querySelector<HTMLElement>(".wt-sheet");
    root.querySelector<HTMLElement>(".wt-switcher-overview")?.click();
    expect(sheet?.hidden).toBe(false);

    sheet?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sheet?.hidden).toBe(true);
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

  it("surfaces a background needs-input on the overview badge", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const overview = root.querySelector<HTMLElement>(".wt-switcher-overview");
    expect(overview?.dataset["attention"]).toBeUndefined();

    // s2 is a background tab (s1 is active) and needs input.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(overview?.dataset["attention"]).toBe("input");

    // It clears once that tab reports a non-input status.
    monitor.emit({ id: "s2", status: "idle", title: "two", createdAt: "2" });
    expect(overview?.dataset["attention"]).toBeUndefined();
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
