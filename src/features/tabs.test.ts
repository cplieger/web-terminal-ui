// @vitest-environment happy-dom
//
// tabs feature tests (design sections 5, 6, 22.10): the session list builds a
// tab per session with the first active, a switch re-points the renderer at the
// next tab's cached store and reconnects the WS to it, and creating a tab spawns
// a session and switches to it. Runs tabs alone (no activityMonitor) so no SSE
// mock is needed; fetch is stubbed for the REST API.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "./../kernel/kernel.js";
import type * as TabsModule from "./tabs.js";

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
    createTerminal(root, { features: [tabs()] });
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
    createTerminal(root, { features: [tabs()] });
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
    createTerminal(root, { features: [tabs()] });
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
    createTerminal(root, { features: [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    // POST was used to create the initial session.
    const posted = fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "POST");
    expect(posted).toBe(true);
  });
});
