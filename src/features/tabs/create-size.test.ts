// The server starts a created session's program at its first client's first
// resize, so a create sends no size. What the client owes that rule: the new
// tab ends in the pane the layout change gives it, that pane's opening size is
// its own grid (not unmeasurable, no rows held), and every session the server
// created ends shown, listed or closed. Driven through the real feature and
// kernel; each engine fake measures its pane's box, and fetch is the only
// network fake.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { PaneSide } from "../../kernel/types.js";
import { shortenSettle } from "../../test-helpers/delays.js";
import { shippedBundle } from "../../test-helpers/stylesheet.js";
import {
  engineOn,
  fakeMonitor,
  rootIn,
  shown,
  stripSplit,
  tick,
  until,
  type FakeMonitor,
} from "./test-helpers/split.js";
import {
  created,
  held,
  mountScripted,
  ok,
  refuse,
  row,
  scriptedServer,
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

const A = row("A", "tab_A", "1");
const B = row("B", "tab_B", "2");
const NEW = { id: "s-new", title: "", createdAt: "9", status: "idle" };
const CELL = { width: 8, height: 17 };

/** The renderer's own fit: whole cells of the pane's padded box. */
function boxGrid(termWrap: HTMLElement): { cols: number; rows: number } {
  const cs = getComputedStyle(termWrap);
  const width = termWrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const height = termWrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return {
    cols: Math.max(20, Math.floor(width / CELL.width)),
    rows: Math.max(5, Math.floor(height / CELL.height)),
  };
}

let server: ScriptedServer;

beforeEach(async () => {
  await shortenSettle();
  fake.reset();
  server = scriptedServer();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
  history.replaceState(null, "", location.pathname);
  const styles = document.createElement("style");
  styles.textContent = shippedBundle("MANIFEST.tabbed");
  document.head.appendChild(styles);
  const build = fake.createTerminalEngine.getMockImplementation();
  if (build === undefined) {
    throw new Error("the engine fake has no build");
  }
  fake.createTerminalEngine.mockImplementation((opts) => {
    const engine = build(opts);
    vi.mocked(engine.renderer.computeSize).mockImplementation(() => boxGrid(opts.termWrap));
    return engine;
  });
  onTestFinished(() => {
    fake.createTerminalEngine.mockImplementation(build);
    styles.remove();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The body of every POST /api/sessions, in arrival order. */
function createBodies(): (BodyInit | null | undefined)[] {
  return server.fetch.mock.calls
    .filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/sessions"))
    .map(([, init]) => init?.body);
}

function sideShowing(m: ScriptedMount, id: string): PaneSide | null {
  return (["left", "right"] as const).find((side) => shown(m.ctx(), side) === id) ?? null;
}

/** The size `id`'s pane opens its socket with (its `initialSize`), beside the
 *  grid of that pane's box. Both read the same box, so they differ only when
 *  the pane cannot measure or holds its rows. */
async function startAndPane(
  m: ScriptedMount,
  root: HTMLElement,
  id: string,
): Promise<{ start: { cols: number; rows: number } | null; pane: { cols: number; rows: number } }> {
  const side = sideShowing(m, id);
  if (side === null) {
    throw new Error(`${id} is not shown`);
  }
  const engine = engineOn(fake, root, side);
  const initialSize = engine.callbacks.initialSize;
  await until(() => (initialSize?.() ?? null) !== null, 120);
  return { start: initialSize?.() ?? null, pane: boxGrid(engine.options.termWrap) };
}

/** Every session the server created that no tab holds and no DELETE closed. */
function orphans(m: ScriptedMount, createdIds: readonly string[]): string[] {
  const listed = new Set(m.api.list().map((t) => t.id));
  return createdIds.filter(
    (id) => !listed.has(id) && server.count("DELETE", `/api/sessions/${id}`) === 0,
  );
}

/** A + create with `act` run while its POST is out, as a click lands then. */
async function createWhile(m: ScriptedMount, act: () => void): Promise<void> {
  const answer = held(created(NEW));
  server.post = [answer.answer];
  const creating = m.api.create();
  await until(() => server.count("POST", "/api/sessions") === 1, 120);
  act();
  await tick();
  answer.release();
  await creating;
}

describe("a create sends no size", () => {
  it("the boot create posts no body, and its tab starts at the pane's grid", async () => {
    server.list = [ok([])];
    const root = rootIn(1000);
    const m = await mountScripted(root);

    await until(() => shown(m.ctx(), "left") === "s-new", 120);

    expect(createBodies()).toEqual([undefined]);
    const { start, pane } = await startAndPane(m, root, "s-new");
    expect(start).toEqual(pane);
  });

  it("a + create posts no body, and its tab starts at the pane's grid", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);

    await m.api.create();

    expect(createBodies()).toEqual([undefined]);
    const { start, pane } = await startAndPane(m, root, "s-new");
    expect(start).toEqual(pane);
  });
});

describe("a layout change during a create: the new tab starts at the pane it ends in", () => {
  it("a split pressed while a + create is out", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);
    const single = boxGrid(engineOn(fake, root, "left").options.termWrap);
    await createWhile(m, () => {
      stripSplit(root).click();
    });
    await until(() => m.ctx().shell.split.isOpen(), 120);

    expect(createBodies()).toEqual([undefined]);
    expect(shown(m.ctx(), "left")).not.toBeNull();
    expect(shown(m.ctx(), "right")).not.toBeNull();
    const { start, pane } = await startAndPane(m, root, "s-new");
    expect(start).toEqual(pane);
    expect(start?.cols).toBeLessThan(single.cols);
    expect(orphans(m, ["s-new"])).toEqual([]);
  });

  it("a split with a partner pressed while a + create is out opens at once", async () => {
    server.list = [ok([A, B])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);
    let openDuringTheCreate = false;

    await createWhile(m, () => {
      stripSplit(root).click();
      openDuringTheCreate = m.ctx().shell.split.isOpen();
    });

    expect(openDuringTheCreate).toBe(true);
    const { start, pane } = await startAndPane(m, root, "s-new");
    expect(start).toEqual(pane);
  });

  it("a split with a partner pressed during a 503 wait opens at once", async () => {
    server.list = [ok([A, B])];
    server.post = [{ ...refuse(), retryAfter: "2" }, created(NEW)];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);

    const creating = m.api.create();
    await until(() => server.count("POST", "/api/sessions") === 1, 120);
    await tick();
    stripSplit(root).click();
    await tick();
    const openDuringTheWait = m.ctx().shell.split.isOpen();
    await creating;

    expect(openDuringTheWait).toBe(true);
    expect(server.count("POST", "/api/sessions")).toBe(2);
    const { start, pane } = await startAndPane(m, root, "s-new");
    expect(start).toEqual(pane);
  }, 15_000);

  it("a snap pressed while a + create is out", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);
    const single = boxGrid(engineOn(fake, root, "left").options.termWrap);
    await createWhile(m, () => {
      m.api.snap("A", "right");
    });
    await until(() => shown(m.ctx(), "right") === "A" && sideShowing(m, "s-new") !== null, 120);

    expect(createBodies()).toEqual([undefined]);
    const { start, pane } = await startAndPane(m, root, "s-new");
    expect(start).toEqual(pane);
    expect(start?.cols).toBeLessThan(single.cols);
    expect(orphans(m, ["s-new"])).toEqual([]);
  });

  it("closing the other pane's tab while a + create is out", async () => {
    server.list = [ok([A, B])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "B", 120);
    await createWhile(m, () => {
      void m.api.close("A");
    });
    await until(() => !m.api.list().some((t) => t.id === "A"), 120);

    expect(server.count("DELETE", "/api/sessions/A")).toBe(1);
    const { start, pane } = await startAndPane(m, root, "s-new");
    expect(start).toEqual(pane);
    expect(orphans(m, ["s-new"])).toEqual([]);
  });

  it("closing a shown tab while a + create is out, then a teardown before it answers", async () => {
    server.list = [ok([A, B])];
    const answer = held(created(NEW));
    server.post = [answer.answer];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "B", 120);

    const creating = m.api.create();
    await until(() => server.count("POST", "/api/sessions") === 1, 120);
    const closing = m.api.close("A");
    await tick();
    m.term.destroy();
    answer.release();
    await creating;
    await closing;
    await until(() => server.count("DELETE", "/api/sessions/s-new") === 1, 120);

    expect(server.count("DELETE", "/api/sessions/A")).toBe(1);
    expect(server.count("DELETE", "/api/sessions/s-new")).toBe(1);
  });

  it("a window resize while a + create is out", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);
    const before = boxGrid(engineOn(fake, root, "left").options.termWrap);
    await createWhile(m, () => {
      root.style.width = "700px";
      window.dispatchEvent(new Event("resize"));
    });
    await until(() => shown(m.ctx(), "left") === "s-new", 120);

    const { start, pane } = await startAndPane(m, root, "s-new");
    expect(start).toEqual(pane);
    expect(start?.cols).toBeLessThan(before.cols);
  });
});

describe("a resync and a + create at once", () => {
  let monitor: FakeMonitor;
  beforeEach(() => {
    monitor = fakeMonitor();
  });

  it("a split pressed during the resync's create shows the resynced session beside its new tab", async () => {
    const X = row("X", "tab_X", "1");
    server.layout = [ok({ left: "X", right: null, selected: "left", handle: 0.5, open: false })];
    server.list = [ok([X])];
    const root = rootIn(1000);
    const m = await mountScripted(root, {
      before: [monitor.feature],
      tabsOpts: { activityMonitor: monitor.feature },
    });
    await until(() => shown(m.ctx(), "left") === "X", 120);
    const lists = (): number => server.count("GET", "/api/sessions");
    const before = lists();
    monitor.open();
    await until(() => lists() > before, 120);
    for (let i = 0; i < 5; i++) {
      await tick();
    }

    const resynced = held(created({ id: "R", title: "", createdAt: "20", status: "idle" }));
    server.post = [
      resynced.answer,
      created({ id: "N", title: "", createdAt: "21", status: "idle" }),
    ];
    server.list = [ok([])];
    monitor.open();
    await until(() => server.count("POST", "/api/sessions") === 1, 200);
    stripSplit(root).click();
    await tick();
    resynced.release();
    await until(() => sideShowing(m, "R") !== null && sideShowing(m, "N") !== null, 200);

    expect(createBodies()).toEqual([undefined, undefined]);
    expect(m.ctx().shell.split.isOpen()).toBe(true);
    expect(sideShowing(m, "R")).not.toBeNull();
    expect(sideShowing(m, "N")).not.toBeNull();
    for (const id of ["R", "N"]) {
      const { start, pane } = await startAndPane(m, root, id);
      expect(start).toEqual(pane);
    }
    expect(orphans(m, ["R", "N"])).toEqual([]);
  });

  it("a resync that starts while a + create is out attaches its session to a pane", async () => {
    const X = row("X", "tab_X", "1");
    server.layout = [ok({ left: "X", right: null, selected: "left", handle: 0.5, open: false })];
    server.list = [ok([X])];
    const root = rootIn(1000);
    const m = await mountScripted(root, {
      before: [monitor.feature],
      tabsOpts: { activityMonitor: monitor.feature },
    });
    await until(() => shown(m.ctx(), "left") === "X", 120);
    const lists = (): number => server.count("GET", "/api/sessions");
    const before = lists();
    monitor.open();
    await until(() => lists() > before, 120);
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    const attached = (): string[] =>
      fake.engines.flatMap((e) => e.connection.setSession.mock.calls.map(([id]) => id));

    const neu = held(created(NEW));
    const resynced = held(created({ id: "R", title: "", createdAt: "20", status: "idle" }));
    server.post = [neu.answer, resynced.answer];
    const creating = m.api.create();
    await until(() => server.count("POST", "/api/sessions") === 1, 120);
    server.list = [ok([])];
    monitor.open();
    await until(() => server.count("POST", "/api/sessions") === 2, 200);
    neu.release();
    await tick();
    await tick();
    resynced.release();
    await creating;
    await until(() => m.api.list().some((t) => t.id === "R"), 200);

    expect(attached()).toContain("R");
    expect(sideShowing(m, "s-new")).not.toBeNull();
    expect(orphans(m, ["R", "s-new"])).toEqual([]);
  });

  it("a teardown while a + create waits on a resync closes both new sessions", async () => {
    const X = row("X", "tab_X", "1");
    server.list = [ok([X])];
    const root = rootIn(1000);
    const m = await mountScripted(root, {
      before: [monitor.feature],
      tabsOpts: { activityMonitor: monitor.feature },
    });
    await until(() => shown(m.ctx(), "left") === "X", 120);
    const lists = (): number => server.count("GET", "/api/sessions");
    const before = lists();
    monitor.open();
    await until(() => lists() > before, 120);
    for (let i = 0; i < 5; i++) {
      await tick();
    }

    const neu = held(created(NEW));
    const resynced = held(created({ id: "R", title: "", createdAt: "20", status: "idle" }));
    server.post = [neu.answer, resynced.answer];
    const creating = m.api.create();
    await until(() => server.count("POST", "/api/sessions") === 1, 120);
    server.list = [ok([])];
    monitor.open();
    await until(() => server.count("POST", "/api/sessions") === 2, 200);
    neu.release();
    await tick();
    await tick();
    m.term.destroy();
    resynced.release();
    await creating;

    await until(() => server.count("DELETE", "/api/sessions/R") === 1, 200);

    expect(server.count("DELETE", "/api/sessions/s-new")).toBe(1);
    expect(server.count("DELETE", "/api/sessions/R")).toBe(1);
  });
});
