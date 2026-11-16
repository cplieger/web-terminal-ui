// A create tells the server the grid of the pane its tab opens in, so a program
// that reads its width once at start is laid out at that width rather than at
// the server's 80-column default. Driven through the real feature and kernel;
// the engine fake's renderer measures the grid, and fetch is the only network
// fake.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { shortenSettle } from "../../test-helpers/delays.js";
import { shippedBundle } from "../../test-helpers/stylesheet.js";
import { engineOn, rootIn, shown, stripSplit, tick, until } from "./test-helpers/split.js";
import {
  created,
  mountScripted,
  ok,
  refuse,
  row,
  scriptedServer,
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
const GRID = { cols: 47, rows: 31 };

let server: ScriptedServer;

beforeEach(async () => {
  await shortenSettle();
  fake.reset();
  fake.renderer.computeSize.mockReturnValue(GRID);
  server = scriptedServer();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
  history.replaceState(null, "", location.pathname);
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

/** The size the pane on `side` sends when its socket opens, once it can measure. */
async function announcing(
  root: HTMLElement,
  side: "left" | "right",
): Promise<{ cols: number; rows: number } | null> {
  const initialSize = engineOn(fake, root, side).callbacks.initialSize;
  await until(() => (initialSize?.() ?? null) !== null, 120);
  return initialSize?.() ?? null;
}

describe("a create carries the size of the pane it opens in", () => {
  it("the boot create carries the landing pane's grid", async () => {
    server.list = [ok([])];
    const m = await mountScripted(rootIn(1000));

    await until(() => shown(m.ctx(), "left") !== null, 120);
    expect(createBodies()).toEqual([JSON.stringify(GRID)]);
  });

  it("a boot create retried after a 503 measures the pane again", async () => {
    const later = { cols: 52, rows: 33 };
    server.list = [ok([])];
    server.post = [refuse(), created({ id: "s-new", title: "", createdAt: "9", status: "idle" })];
    server.onRequest = (method) => {
      if (method === "POST") {
        fake.renderer.computeSize.mockReturnValue(later);
      }
    };
    const m = await mountScripted(rootIn(1000));

    await until(() => shown(m.ctx(), "left") !== null, 120);
    expect(createBodies()).toEqual([JSON.stringify(GRID), JSON.stringify(later)]);
  });

  it("a + create in the single view carries the selected pane's grid", async () => {
    server.list = [ok([A])];
    const m = await mountScripted(rootIn(1000));
    await until(() => shown(m.ctx(), "left") !== null, 120);

    await m.api.create();

    expect(createBodies()).toEqual([JSON.stringify(GRID)]);
  });

  it("with both panes showing a tab, a + create carries the grid of the pane it lands in", async () => {
    server.list = [ok([A, B])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") !== null, 120);
    const left = { cols: 41, rows: 29 };
    const right = { cols: 43, rows: 27 };
    engineOn(fake, root, "left").renderer.computeSize.mockReturnValue(left);
    engineOn(fake, root, "right").renderer.computeSize.mockReturnValue(right);

    await m.api.create();
    await until(() => shown(m.ctx(), "right") === "s-new", 120);

    expect(createBodies()).toEqual([JSON.stringify(await announcing(root, "right"))]);
  });

  it("a create during a viewport transition carries the grid the pane settles at", async () => {
    server.list = [ok([A])];
    const m = await mountScripted(rootIn(1000));
    await until(() => shown(m.ctx(), "left") !== null, 120);
    const settled = { cols: 52, rows: 33 };
    window.dispatchEvent(new Event("resize"));

    const creating = m.api.create();
    await tick();
    fake.renderer.computeSize.mockReturnValue(settled);
    await creating;

    expect(createBodies()).toEqual([JSON.stringify(settled)]);
  });
});

describe("a create that opens the split carries the size of the pane it opens", () => {
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

  beforeEach(() => {
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

  it("the split button's create carries the right pane's grid, not the single view's", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    const single = boxGrid(engineOn(fake, root, "left").options.termWrap);

    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "s-new", 120);

    const landed = await announcing(root, "right");
    expect(landed?.cols).toBeLessThan(single.cols);
    expect(createBodies()).toEqual([JSON.stringify(landed)]);
  });

  it("a snap with no partner carries the grid of the pane its new tab lands in", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    const single = boxGrid(engineOn(fake, root, "left").options.termWrap);

    expect(m.api.snap("A", "right")).toBe(true);
    await until(() => shown(m.ctx(), "left") === "s-new", 120);

    const landed = await announcing(root, "left");
    expect(landed?.cols).toBeLessThan(single.cols);
    expect(createBodies()).toEqual([JSON.stringify(landed)]);
  });
});
