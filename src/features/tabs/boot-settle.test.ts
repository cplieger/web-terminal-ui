// The boot settles the session set before it shows anything: a host restoring
// its sessions answers 503 on the layout read and on create, and the page waits
// that out, re-reading and re-listing, before it reads the address. Driven
// through the real feature and kernel; fetch is the only fake, answering with
// real Responses so Retry-After and the error envelope go through the
// production parser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { fakeMonitor, rootIn, shown, tick, until, type FakeMonitor } from "./test-helpers/split.js";
import {
  created,
  held,
  mountScripted,
  notFound,
  ok,
  refuse,
  row,
  scriptedServer,
  splitRecord,
  type ScriptedMount,
  type ScriptedServer,
} from "./test-helpers/scripted.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const STALE = "That tab is no longer open";
const basePath = location.pathname + location.search;
const A = row("A", "sess_A", "1");
const B = row("B", "sess_B", "2");

let server: ScriptedServer;
let monitor: FakeMonitor;
let historyWrites: number;

beforeEach(() => {
  fake.reset();
  server = scriptedServer();
  monitor = fakeMonitor();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
  history.replaceState(null, "", basePath);
  historyWrites = 0;
  const count = (): void => {
    historyWrites++;
  };
  vi.spyOn(history, "pushState").mockImplementation(function (this: History, ...args) {
    count();
    return History.prototype.pushState.apply(this, args);
  });
  vi.spyOn(history, "replaceState").mockImplementation(function (this: History, ...args) {
    count();
    return History.prototype.replaceState.apply(this, args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", basePath);
});

const toastText = (root: HTMLElement): string => root.querySelector(".wt-toast")?.textContent ?? "";

async function boot(hash = "", loading?: HTMLElement) {
  if (hash !== "") {
    History.prototype.replaceState.call(history, null, "", hash);
  }
  const root = rootIn(1000);
  const m = await mountScripted(root, {
    before: [monitor.feature],
    tabsOpts: { activityMonitor: monitor.feature },
    ...(loading === undefined ? {} : { opts: { loading } }),
  });
  return { root, ...m };
}

const anyPaneShows = (m: ScriptedMount): boolean =>
  m
    .ctx()
    .shell.panes()
    .some((p) => p.state() === "shown");

describe("boot settles before it reads the address", () => {
  it("waits out 503s on the layout read, then shows the tab the address names, writing nothing first", async () => {
    let writesWhenListed = -1;
    server.layout = [
      refuse(),
      refuse(),
      ok({ left: "A", right: null, selected: "left", handle: 0.5, open: false }),
    ];
    server.list = [ok([A, B])];
    server.onRequest = (method, path) => {
      if (method === "GET" && path === "/api/sessions" && writesWhenListed < 0) {
        writesWhenListed = historyWrites;
      }
    };
    const m = await boot("#sess_B");

    await until(() => shown(m.ctx(), "left") !== null, 120);
    expect(shown(m.ctx(), "left")).toBe("B");
    expect(writesWhenListed).toBe(0);
    expect(server.count("GET", "/api/sessions/layout")).toBe(3);
    expect(server.count("POST", "/api/sessions")).toBe(0);
    expect(location.hash).toBe("#sess_B");
  });

  it("restores the persisted split from a layout read that first answered 503", async () => {
    server.layout = [refuse(), ok(splitRecord("A", "B", "right", 0.3))];
    server.list = [ok([A, B])];
    const m = await boot();

    await until(() => shown(m.ctx(), "right") !== null, 120);
    expect(m.term.split?.isOpen()).toBe(true);
    expect(shown(m.ctx(), "left")).toBe("A");
    expect(shown(m.ctx(), "right")).toBe("B");
    expect(m.ctx().shell.selected()).toBe("right");
    expect(m.term.split?.state().committedRatio).toBe(0.3);
  });

  it("re-lists after a refused create and adopts the restored tab instead of creating a second", async () => {
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    let overlaySaid = "";
    server.layout = [notFound];
    server.list = [ok([]), ok([A])];
    server.post = [
      // The restored session reaches the stream once the refused create is answered.
      {
        ...refuse("restoring tabs"),
        then: () => {
          monitor.emit({ ...A } as never);
        },
      },
      created(B),
    ];
    server.onRequest = (method, path) => {
      if (method === "GET" && path === "/api/sessions" && server.count("GET", path) === 2) {
        overlaySaid = loading.textContent ?? "";
      }
    };
    const m = await boot("", loading);

    await until(() => anyPaneShows(m), 120);
    await tick();
    expect(server.count("POST", "/api/sessions")).toBe(1);
    expect(shown(m.ctx(), "left")).toBe("A");
    expect(m.api.list().map((t) => t.id)).toEqual(["A"]);
    expect(overlaySaid).toContain("restoring tabs");
  });

  it("falls back to the record's tab for an address no restored tab holds, telling a deep link", async () => {
    server.layout = [ok({ left: "B", right: null, selected: "left", handle: 0.5, open: false })];
    server.list = [ok([A, B])];
    const m = await boot("#sess_Z");

    await until(() => anyPaneShows(m), 120);
    await tick();
    expect(shown(m.ctx(), "left")).toBe("B");
    expect(toastText(m.root)).toBe(STALE);
    expect(location.hash).toBe("#sess_B");
  });

  it("falls back silently on a reload", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { type: "reload" } as unknown as PerformanceEntry,
    ]);
    server.layout = [ok({ left: "B", right: null, selected: "left", handle: 0.5, open: false })];
    server.list = [ok([A, B])];
    const m = await boot("#sess_Z");

    await until(() => anyPaneShows(m), 120);
    await tick();
    expect(shown(m.ctx(), "left")).toBe("B");
    expect(toastText(m.root)).toBe("");
    expect(location.hash).toBe("#sess_B");
  });

  it("waits out a 503 on the list and reads the layout again before listing again", async () => {
    // No status stream and pollMs at one hour, so every counted request is the boot's.
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    let overlaySaid = "";
    const record = ok({ left: "A", right: null, selected: "left", handle: 0.5, open: false });
    server.layout = [record];
    server.list = [refuse("service starting"), ok([A])];
    server.onRequest = (method, path) => {
      if (method === "GET" && path === "/api/sessions/layout" && server.count(method, path) === 2) {
        overlaySaid = loading.textContent ?? "";
      }
    };
    const root = rootIn(1000);
    const m = await mountScripted(root, { tabsOpts: { pollMs: 3_600_000 }, opts: { loading } });

    await until(() => anyPaneShows(m), 120);
    await tick();
    // PUTs are the page's own record writes; a POST would be a create beside A.
    const reads = server.log.filter((r) => r.method !== "PUT").map((r) => `${r.method} ${r.path}`);
    expect(reads).toEqual([
      "GET /api/sessions/layout",
      "GET /api/sessions",
      "GET /api/sessions/layout",
      "GET /api/sessions",
    ]);
    expect(shown(m.ctx(), "left")).toBe("A");
    expect(overlaySaid).toContain("service starting");
  });

  it("issues no list until a layout read has answered, and exactly one after it", async () => {
    // No status stream is mounted, so every GET /api/sessions counted here is the
    // boot's: the stream-open reconcile would list too. pollMs keeps the poll out.
    const first = held(refuse());
    server.layout = [
      first.answer,
      ok({ left: null, right: null, selected: "left", handle: 0.5, open: false }),
    ];
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root, { tabsOpts: { pollMs: 3_600_000 } });

    await until(() => server.count("GET", "/api/sessions/layout") === 1);
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    expect(server.count("GET", "/api/sessions")).toBe(0);

    first.release();
    await until(() => anyPaneShows(m), 120);
    expect(server.count("GET", "/api/sessions/layout")).toBe(2);
    expect(server.count("GET", "/api/sessions")).toBe(1);
  });
});
