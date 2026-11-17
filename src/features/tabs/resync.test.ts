// A server restarting under an open page: every tab the page knew is gone from
// its list, and the restored set arrives under new ids with the old aliases. The
// page drops the dead tabs without placing anything, settles the new set, and
// places it by the address and the record, never by arrival order. Driven
// through the real feature and kernel with a fake status stream; fetch answers
// with real Responses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import { fakeMonitor, rootIn, shown, tick, until, type FakeMonitor } from "./test-helpers/split.js";
import {
  created,
  held,
  mountScripted,
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

const basePath = location.pathname + location.search;
const X = row("X", "a", "1");
const Y = row("Y", "b", "2");
const X2 = row("X2", "a", "11");
const Y2 = row("Y2", "b", "12");
const Z = row("Z", "z", "13");
const W = row("W", "w", "14");
const closed = (id: string) => ({
  left: id,
  right: null,
  selected: "left",
  handle: 0.5,
  open: false,
});
const status = (r: ReturnType<typeof row>): SessionStatus => r as unknown as SessionStatus;

let server: ScriptedServer;
let monitor: FakeMonitor;
let pushes: number;

beforeEach(() => {
  fake.reset();
  server = scriptedServer();
  monitor = fakeMonitor();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
  history.replaceState(null, "", basePath);
  pushes = 0;
  vi.spyOn(history, "pushState").mockImplementation(function (this: History, ...args) {
    pushes++;
    return History.prototype.pushState.apply(this, args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", basePath);
});

const toastText = (root: HTMLElement): string => root.querySelector(".wt-toast")?.textContent ?? "";
const panes = (m: ScriptedMount): (string | null)[] => [
  shown(m.ctx(), "left"),
  shown(m.ctx(), "right"),
];
const lists = (): number => server.count("GET", "/api/sessions");

/** Boot at `hash` and let the first stream open's reconcile finish, so the next
 *  open is a reopen. */
async function page(hash: string): Promise<ScriptedMount & { root: HTMLElement }> {
  History.prototype.replaceState.call(history, null, "", hash);
  const root = rootIn(1000);
  const m = await mountScripted(root, {
    before: [monitor.feature],
    tabsOpts: { activityMonitor: monitor.feature },
  });
  await until(
    () =>
      m
        .ctx()
        .shell.panes()
        .some((p) => p.state() === "shown"),
    120,
  );
  const before = lists();
  monitor.open();
  await until(() => lists() > before);
  for (let i = 0; i < 5; i++) {
    await tick();
  }
  pushes = 0;
  return { root, ...m };
}

/** A split page `#a,b` over X and Y. */
async function splitPage(): Promise<ScriptedMount & { root: HTMLElement }> {
  server.layout = [ok(splitRecord("X", "Y"))];
  server.list = [ok([X, Y])];
  const m = await page("#a,b");
  expect(panes(m)).toEqual(["X", "Y"]);
  return m;
}

describe("resync after a server restart", () => {
  it("restores the split the address names onto the new sessions, creating nothing and pushing no history", async () => {
    const m = await splitPage();
    server.list = [ok([]), ok([X2, Y2])];
    server.layout = [refuse(), ok(splitRecord("X2", "Y2"))];

    monitor.open();
    await until(() => panes(m).join() === "X2,Y2", 200);

    expect(panes(m)).toEqual(["X2", "Y2"]);
    expect(m.term.split?.isOpen()).toBe(true);
    expect(server.count("POST", "/api/sessions")).toBe(0);
    expect(pushes).toBe(0);
    await tick();
    expect(location.hash).toBe("#a,b");
  });

  it("does not place restored tabs the stream delivers before the list answers", async () => {
    const m = await splitPage();
    const list = held(ok([X2, Y2]));
    server.list = [list.answer];
    server.layout = [ok(splitRecord("X2", "Y2"))];
    const before = lists();

    monitor.open();
    await until(() => lists() > before);
    monitor.emit(status(X2));
    monitor.emit(status(Y2));
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    expect(panes(m)).not.toContain("X2");
    expect(panes(m)).not.toContain("Y2");

    list.release();
    await until(() => panes(m).join() === "X2,Y2", 200);
    expect(panes(m)).toEqual(["X2", "Y2"]);
    await tick();
    expect(location.hash).toBe("#a,b");
  });

  it("keeps the tabs of a server that did not restart and places a new one after the reconcile", async () => {
    const m = await splitPage();
    const list = held(ok([X, Y, Z]));
    server.list = [list.answer];
    const before = lists();

    monitor.open();
    await until(() => lists() > before);
    monitor.emit(status(Z));
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    expect(panes(m)).not.toContain("Z");

    list.release();
    await until(() => panes(m).includes("Z"), 200);
    expect(m.api.list().map((t) => t.id)).toEqual(["X", "Y", "Z"]);
    expect(panes(m)).toContain("Z");
  });

  it("settles onto a replacement another device made when the last tab is removed mid-reconcile", async () => {
    server.layout = [ok(closed("X"))];
    server.list = [ok([X])];
    const m = await page("#a");
    const list = held(ok([row("Y", "y", "5")]));
    server.list = [list.answer];
    const before = lists();

    monitor.open();
    await until(() => lists() > before);
    monitor.emit({ ...status(X), status: "exited", removed: true });
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    expect(lists()).toBe(before + 1);

    list.release();
    await until(() => shown(m.ctx(), "left") === "Y", 200);
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    expect(lists()).toBe(before + 2);
    expect(server.count("POST", "/api/sessions")).toBe(0);
  });

  it("holds placement across two reopens inside one settle", async () => {
    const m = await splitPage();
    const layout = held(ok(splitRecord("X2", "Y2")));
    const reopenList = held(ok([X2, Y2, Z]));
    server.layout = [refuse(), layout.answer];
    server.list = [ok([]), ok([X2, Y2]), reopenList.answer];
    const layoutsBefore = server.count("GET", "/api/sessions/layout");

    monitor.open();
    await until(() => server.count("GET", "/api/sessions/layout") === layoutsBefore + 2, 200);
    monitor.emit(status(X2));
    monitor.emit(status(Y2));
    monitor.open();
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    expect(panes(m)).toEqual([null, null]);

    const listsBefore = lists();
    layout.release();
    await until(() => lists() === listsBefore + 2, 200);
    monitor.emit(status(Z));
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    // The second reopen's reconcile is still out: nothing has been placed by arrival.
    expect(panes(m)).toEqual(["X2", "Y2"]);

    reopenList.release();
    // Z arrived after the settle's list: it joins the strip, and the split the
    // address restored keeps both its panes.
    for (let i = 0; i < 10; i++) {
      await tick();
    }
    expect(m.api.list().map((t) => t.id)).toEqual(["X2", "Y2", "Z"]);
    expect(panes(m)).toEqual(["X2", "Y2"]);
    expect(location.hash).toBe("#a,b");
  });

  it("lands on the record's tab without a notice when the restored set lacks the shown tab", async () => {
    server.layout = [ok(closed("X"))];
    server.list = [ok([X])];
    const m = await page("#a");
    server.list = [ok([W])];
    server.layout = [ok(closed("W"))];

    monitor.open();
    await until(() => shown(m.ctx(), "left") === "W", 200);
    await tick();
    await tick();
    expect(toastText(m.root)).toBe("");
    expect(location.hash).toBe("#w");
  });

  it("does not let a page that booted onto nothing switch to a held arrival before the settle ends", async () => {
    server.list = [{ status: 500, body: { error: "down" } }];
    server.post = [{ status: 500, body: { error: "down" } }];
    const root = rootIn(1000);
    const m = await mountScripted(root, {
      before: [monitor.feature],
      tabsOpts: { activityMonitor: monitor.feature },
    });
    await until(() => toastText(root).startsWith("Could not open a terminal"), 120);
    server.list = [ok([])];
    monitor.open();
    await until(() => lists() >= 2);
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    const Q = row("Q", "q", "7");
    const list = held(ok([Q]));
    server.list = [list.answer];
    const before = lists();

    monitor.open();
    await until(() => lists() > before);
    monitor.emit(status(Q));
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    expect(panes(m)).toEqual([null, null]);

    list.release();
    await until(() => shown(m.ctx(), "left") === "Q", 200);
    expect(shown(m.ctx(), "left")).toBe("Q");
  });
});

describe("explicit requests during a wait", () => {
  it("still creates the tab the user asked for with + once the server stops refusing", async () => {
    server.layout = [ok(closed("X"))];
    server.list = [ok([X])];
    const m = await page("#a");
    server.post = [refuse("service starting"), created(row("N", "n", "9"))];

    await m.api.create();

    expect(server.count("POST", "/api/sessions")).toBe(2);
    expect(m.api.list().map((t) => t.id)).toEqual(["X", "N"]);
  });

  it("still replaces the last tab the user closes", async () => {
    server.layout = [ok(closed("X"))];
    server.list = [ok([X])];
    const m = await page("#a");
    server.post = [created(row("N", "n", "9"))];

    await m.api.close("X");

    expect(server.count("POST", "/api/sessions")).toBe(1);
    expect(m.api.list().map((t) => t.id)).toEqual(["N"]);
  });
});
