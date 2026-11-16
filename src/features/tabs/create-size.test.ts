// A create tells the server the grid of the pane its tab opens in, so a program
// that reads its width once at start is laid out at that width rather than at
// the server's 80-column default. Driven through the real feature and kernel;
// the engine fake's renderer measures the grid, and fetch is the only network
// fake.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { shortenSettle } from "../../test-helpers/delays.js";
import { shippedBundle } from "../../test-helpers/stylesheet.js";
import {
  engineOn,
  menuItem,
  openTabMenu,
  rootIn,
  shown,
  stripSplit,
  tick,
  until,
} from "./test-helpers/split.js";
import {
  created,
  held,
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

  // Per session, the grid of the pane it was first shown in, read as the pane
  // switches to it.
  const firstShown = new Map<string, { cols: number; rows: number }>();

  beforeEach(() => {
    firstShown.clear();
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
      const setSession = vi.mocked(engine.connection.setSession);
      const switchTo = setSession.getMockImplementation();
      setSession.mockImplementation((id) => {
        if (!firstShown.has(id)) {
          firstShown.set(id, boxGrid(opts.termWrap));
        }
        switchTo?.(id);
      });
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

  it("a split create in the same task as a close slide carries the right pane's grid", async () => {
    server.list = [ok([A])];
    server.post = [
      created({ id: "s-new", title: "", createdAt: "9", status: "idle" }),
      created({ id: "s-two", title: "", createdAt: "10", status: "idle" }),
    ];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "s-new", 120);
    m.ctx().shell.root.classList.add("wt-animate");

    void m.api.close("s-new");
    expect(m.ctx().shell.root.classList.contains("wt-split-closing")).toBe(true);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "s-two", 120);

    expect(createBodies()[1]).toEqual(JSON.stringify(await announcing(root, "right")));
  });

  /** The grid of the pane `id` was first shown in. */
  function landed(id: string): { cols: number; rows: number } {
    const grid = firstShown.get(id);
    if (grid === undefined) {
      throw new Error(`${id} was never shown`);
    }
    return grid;
  }

  /** Run `act` once, as the first POST /api/sessions arrives. */
  function duringTheCreate(act: () => void): void {
    let done = false;
    server.onRequest = (method, path) => {
      if (!done && method === "POST" && path === "/api/sessions") {
        done = true;
        act();
      }
    };
  }

  it("a split pressed while a + create is out shows the new tab where it was measured", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    duringTheCreate(() => {
      stripSplit(root).click();
    });

    await m.api.create();
    await until(() => m.ctx().shell.split.isOpen(), 120);

    expect(createBodies()).toEqual([JSON.stringify(landed("s-new"))]);
    expect(m.ctx().shell.split.isOpen()).toBe(true);
  });

  it("a snap pressed while a + create is out shows the new tab where it was measured", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    duringTheCreate(() => {
      m.api.snap("A", "right");
    });

    await m.api.create();
    await until(() => shown(m.ctx(), "right") === "A", 120);

    expect(createBodies()).toEqual([JSON.stringify(landed("s-new"))]);
    expect(shown(m.ctx(), "right")).toBe("A");
  });

  it("closing the other pane's tab while a + create is out shows the new tab where it was measured", async () => {
    server.list = [ok([A, B])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "B", 120);
    duringTheCreate(() => {
      void m.api.close("A");
    });

    await m.api.create();
    await until(() => !m.api.list().some((t) => t.id === "A"), 120);

    expect(createBodies()).toEqual([JSON.stringify(landed("s-new"))]);
    expect(m.ctx().shell.split.isOpen()).toBe(false);
  });

  it("selecting the other pane while a + create is out keeps the new tab in the pane it measured", async () => {
    server.list = [ok([A, B])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "B", 120);
    expect(m.ctx().shell.split.setRatio(0.3, true)).toBe(true);
    duringTheCreate(() => {
      m.ctx().shell.select("right");
    });

    await m.api.create();

    expect(shown(m.ctx(), "right")).toBe("s-new");
    expect(createBodies()).toEqual([JSON.stringify(landed("s-new"))]);
  });

  it("closing the shown tabs from a chip's menu while a + create is out shows the new tab where it was measured", async () => {
    const C = row("C", "tab_C", "3");
    server.list = [ok([A, B, C])];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "B", 120);
    duringTheCreate(() => {
      menuItem(openTabMenu(root, "C"), "Close others").click();
    });

    await m.api.create();
    await until(() => m.api.list().length === 2, 120);

    expect(createBodies()).toEqual([JSON.stringify(landed("s-new"))]);
    expect(m.api.list().map((t) => t.id)).toEqual(["C", "s-new"]);
  });

  it("an address navigated to while a + create is out is shown once the new tab is", async () => {
    server.list = [ok([A, B])];
    const answer = held(created({ id: "s-new", title: "", createdAt: "9", status: "idle" }));
    server.post = [answer.answer];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") === "A", 120);
    duringTheCreate(() => {
      location.hash = "#tab_A,tab_B";
    });

    const creating = m.api.create();
    await until(() => server.count("POST", "/api/sessions") === 1, 120);
    await tick();
    await tick();
    answer.release();
    await creating;
    await until(() => shown(m.ctx(), "right") === "B", 120);

    expect(createBodies()).toEqual([JSON.stringify(landed("s-new"))]);
    expect(shown(m.ctx(), "left")).toBe("A");
  });

  it("a split closed while a + create measures carries the grid of the pane that remains", async () => {
    server.list = [ok([A, B])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    stripSplit(root).click();
    await until(() => shown(m.ctx(), "right") === "B", 120);

    const creating = m.api.create();
    stripSplit(root).click();
    await creating;

    expect(m.ctx().shell.split.isOpen()).toBe(false);
    expect(shown(m.ctx(), "left")).toBe("s-new");
    expect(createBodies()).toEqual([JSON.stringify(landed("s-new"))]);
  });

  it("a window resize while a + create is out resizes the new tab once it shows", async () => {
    server.list = [ok([A])];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    const before = boxGrid(engineOn(fake, root, "left").options.termWrap);
    duringTheCreate(() => {
      root.style.width = "700px";
      window.dispatchEvent(new Event("resize"));
    });

    await m.api.create();
    await until(() => shown(m.ctx(), "left") === "s-new", 120);

    const after = await announcing(root, "left");
    expect(createBodies()).toEqual([JSON.stringify(before)]);
    expect(after).toEqual(boxGrid(engineOn(fake, root, "left").options.termWrap));
    expect(after?.cols).toBeLessThan(before.cols);
  });

  it("a split create that fails leaves the shown pane's renderer at the single view's grid", async () => {
    server.list = [ok([A])];
    server.post = [{ status: 500, body: { error: "boom" } }];
    const root = rootIn(1000);
    const m = await mountScripted(root);
    await until(() => shown(m.ctx(), "left") !== null, 120);
    const left = engineOn(fake, root, "left");

    const fitted = (): unknown => vi.mocked(left.renderer.computeSize).mock.results.at(-1)?.value;
    const atBox = (): boolean =>
      JSON.stringify(fitted()) === JSON.stringify(boxGrid(left.options.termWrap));

    stripSplit(root).click();
    await until(() => server.count("POST", "/api/sessions") === 1, 120);
    await tick();
    // The box can still move after the probe; the pane re-fits when its
    // viewport settles, which a loaded runner reaches ticks later.
    await until(atBox, 120);

    expect(m.ctx().shell.split.isOpen()).toBe(false);
    expect(fitted()).toEqual(boxGrid(left.options.termWrap));
  });
});
