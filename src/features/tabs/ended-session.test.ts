// A session that ended before its process started stays in the server's list
// as `ended`, with its reason, until a client closes it. The page keeps its tab
// like any other, the pane shows the ended screen and the reason the socket's
// 4001 close carries, and nothing it does creates a session in its place.
// Driven through the real feature and kernel with a fake status stream; fetch
// answers with real Responses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import { connectionBanner } from "../connection-banner.js";
import type { PaneSide } from "../../kernel/types.js";
import {
  announced,
  chipOf,
  engineOn,
  fakeMonitor,
  paneRoot,
  rootIn,
  settle as frames,
  shown,
  textareaOf,
  tick,
  until,
  type FakeMonitor,
} from "./test-helpers/split.js";
import {
  created,
  held,
  mountScripted,
  ok,
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
const startReason = "the process failed to start";
const X = row("X", "a", "1");
const Y = row("Y", "b", "2");
const X2 = row("X2", "a", "11");
const N = row("N", "n", "20");
const Z = row("Z", "z", "13");
const Z2 = row("Z2", "z2", "14");
const W = row("W", "w", "3");
const ended = (r: ReturnType<typeof row>) => ({ ...r, status: "ended", endReason: startReason });
const closed = (id: string) => ({
  left: id,
  right: null,
  selected: "left",
  handle: 0.5,
  open: false,
});
const status = (r: object): SessionStatus => r as unknown as SessionStatus;

let server: ScriptedServer;
let monitor: FakeMonitor;

beforeEach(() => {
  fake.reset();
  server = scriptedServer();
  monitor = fakeMonitor();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
  history.replaceState(null, "", basePath);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", basePath);
});

type Page = ScriptedMount & { root: HTMLElement };

const lists = (): number => server.count("GET", "/api/sessions");
const posts = (): number => server.count("POST", "/api/sessions");
const panes = (m: Page): (string | null)[] => [shown(m.ctx(), "left"), shown(m.ctx(), "right")];
const strip = (m: Page): string[] => m.api.list().map((t) => t.id);
const bannerOn = (m: Page, side: PaneSide): string =>
  m.ctx().shell.pane(side)?.root.querySelector(".wt-conn-banner")?.textContent ?? "";
const toastOn = (m: Page, side: PaneSide): string =>
  m.ctx().shell.pane(side)?.root.querySelector(".wt-toast")?.textContent ?? "";
const startToast = `Could not start the terminal: ${startReason}`;

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await tick();
  }
}

/** Boot at `hash` with the status stream open and its first reconcile done, so
 *  the next open is a reopen. */
async function page(hash: string): Promise<Page> {
  History.prototype.replaceState.call(history, null, "", hash);
  const root = rootIn(1000);
  const m = await mountScripted(root, {
    before: [monitor.feature],
    paneFeatures: () => [connectionBanner()],
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
  await ticks(5);
  return { root, ...m };
}

async function singlePage(): Promise<Page> {
  server.layout = [ok(closed("X"))];
  server.list = [ok([X])];
  const m = await page("#a");
  expect(panes(m)).toEqual(["X", null]);
  return m;
}

/** A split page `#a,b` over X and Y. */
async function splitPage(): Promise<Page> {
  server.layout = [ok(splitRecord("X", "Y"))];
  server.list = [ok([X, Y])];
  const m = await page("#a,b");
  await until(() => panes(m).join() === "X,Y", 200);
  expect(panes(m)).toEqual(["X", "Y"]);
  return m;
}

/** The server's side of a failed start for the session `side` shows: its
 *  socket closes 4001 with the reason. */
function closeWithReason(m: Page, side: PaneSide): void {
  engineOn(fake, m.root, side).callbacks.onProcessExit?.({ code: 4001, reason: startReason });
}

/** Both of the server's messages about a failed start: the stream's `ended`
 *  status and the socket's close, in `order`; the list names it ended from then. */
async function failOn(
  m: Page,
  side: PaneSide,
  r: ReturnType<typeof row>,
  order: "status first" | "close first" = "status first",
): Promise<void> {
  if (order === "close first") {
    closeWithReason(m, side);
    monitor.emit(status(ended(r)));
  } else {
    monitor.emit(status(ended(r)));
    closeWithReason(m, side);
  }
  await ticks(10);
}

/** The status stream opens and sends its snapshot, one event per row, before
 *  the open's list, which names the same rows, answers. */
async function openWithSnapshot(rows: readonly object[]): Promise<void> {
  server.list = [ok(rows)];
  const before = lists();
  monitor.open();
  for (const r of rows) {
    monitor.emit(status(r));
  }
  await until(() => lists() > before);
  await ticks(10);
  await frames();
}

/** One stream event, and the frame that paints it. */
async function arrive(r: object): Promise<void> {
  monitor.emit(status(r));
  await ticks(2);
  await frames();
}

const removed = (r: ReturnType<typeof row>) => ({ ...r, removed: true });
const cue = (r: ReturnType<typeof row>, s: string) => ({ ...r, status: s, statusSeq: 1 });
const swDot = (m: Page): string =>
  m.root.querySelector<HTMLElement>(".wt-switcher-switch-dot")?.dataset["status"] ?? "";
const selectedSide = (m: Page): PaneSide => m.ctx().shell.selected();
const paneSaid = (m: Page, side: PaneSide): string =>
  paneRoot(m.root, side).querySelector('[aria-live="polite"]')?.textContent ?? "";

async function reopen(): Promise<void> {
  const before = lists();
  monitor.open();
  await until(() => lists() > before);
  await ticks(10);
}

// Without the status stream's event: the page polls, or the stream dropped and
// its reopen lists the sessions instead.
interface Lister {
  mount: () => Promise<Page>;
  listAgain: () => Promise<void>;
}
const listers: [string, Lister][] = [
  [
    "the poll",
    {
      mount: async () => {
        History.prototype.replaceState.call(history, null, "", "#a");
        const root = rootIn(1000);
        const m = await mountScripted(root, {
          paneFeatures: () => [connectionBanner()],
          tabsOpts: { pollMs: 40 },
        });
        await until(() => shown(m.ctx(), "left") === "X", 200);
        return { root, ...m };
      },
      listAgain: async () => {
        const before = lists();
        await until(() => lists() >= before + 3, 400);
        expect(lists()).toBeGreaterThanOrEqual(before + 3);
      },
    },
  ],
  [
    "a reopened status stream",
    {
      mount: () => page("#a"),
      listAgain: async () => {
        await reopen();
        await reopen();
      },
    },
  ],
];

/** A split page `#a,b` over X and Y whose status stream has not opened yet. */
async function unopenedSplitPage(): Promise<Page> {
  History.prototype.replaceState.call(history, null, "", "#a,b");
  server.layout = [ok(splitRecord("X", "Y"))];
  server.list = [ok([X, Y])];
  const root = rootIn(1000);
  const m = await mountScripted(root, {
    before: [monitor.feature],
    paneFeatures: () => [connectionBanner()],
    tabsOpts: { activityMonitor: monitor.feature },
  });
  await until(() => panes({ root, ...m }).join() === "X,Y", 200);
  return { root, ...m };
}

// A split page over X and Y whose next list arrives together with no stream
// event before it: by the poll, or by the status stream's first open after boot.
const splitListers: [string, Lister][] = [
  [
    "the poll",
    {
      mount: async () => {
        History.prototype.replaceState.call(history, null, "", "#a,b");
        server.layout = [ok(splitRecord("X", "Y"))];
        server.list = [ok([X, Y])];
        const root = rootIn(1000);
        const m = await mountScripted(root, {
          paneFeatures: () => [connectionBanner()],
          tabsOpts: { pollMs: 40 },
        });
        await until(() => panes({ root, ...m }).join() === "X,Y", 200);
        return { root, ...m };
      },
      listAgain: async () => {
        const before = lists();
        await until(() => lists() >= before + 3, 400);
        expect(lists()).toBeGreaterThanOrEqual(before + 3);
        await ticks(10);
      },
    },
  ],
  [
    "the status stream's first open",
    {
      mount: unopenedSplitPage,
      listAgain: async () => {
        const before = lists();
        monitor.open();
        await until(() => lists() > before);
        await ticks(10);
      },
    },
  ],
];

describe("a list that names a session made elsewhere and an ended one", () => {
  const oneEnded: [string, () => object[]][] = [
    ["listed before the ended one", () => [X, Z, ended(Y)]],
    ["listed first", () => [Z, X, ended(Y)]],
    ["listed after the ended one", () => [X, ended(Y), Z]],
  ];
  describe.each(splitListers)("from %s", (_lister, { mount, listAgain }) => {
    it.each(oneEnded)("places the arrival on the live pane when it is %s", async (_o, list) => {
      const m = await mount();
      m.ctx().shell.select("left");
      closeWithReason(m, "right");
      server.list = [ok(list())];

      await listAgain();

      expect(posts()).toBe(0);
      expect(strip(m)).toEqual(["X", "Y", "Z"]);
      expect(panes(m)).toEqual(["Z", "Y"]);
      expect(bannerOn(m, "right")).toBe("Session ended");
    });

    it("gives the arrival only its chip when both panes are ended", async () => {
      const m = await mount();
      closeWithReason(m, "left");
      closeWithReason(m, "right");
      server.list = [ok([Z, ended(X), ended(Y)])];

      await listAgain();

      expect(posts()).toBe(0);
      expect(strip(m)).toEqual(["X", "Y", "Z"]);
      expect(panes(m)).toEqual(["X", "Y"]);
      expect(bannerOn(m, "left")).toBe("Session ended");
      expect(bannerOn(m, "right")).toBe("Session ended");
    });
  });
});

describe("a session that ended before its process started", () => {
  it.each(["status first", "close first"] as const)(
    "keeps its tab on its pane with the reason and creates nothing (%s)",
    async (order) => {
      const m = await singlePage();
      const failures: string[] = [];
      m.ctx().on("session:startFailed", ({ reason }) => failures.push(reason));
      server.list = [ok([ended(X)])];

      await failOn(m, "left", X, order);

      expect(posts()).toBe(0);
      expect(strip(m)).toEqual(["X"]);
      expect(panes(m)).toEqual(["X", null]);
      expect(toastOn(m, "left")).toBe(startToast);
      expect(failures).toEqual([startReason]);
      expect(bannerOn(m, "left")).toBe("Session ended");
    },
  );

  it("names the tab's state from the list", async () => {
    const m = await singlePage();
    server.list = [ok([ended(X)])];

    await failOn(m, "left", X);

    expect(chipOf(m.root, "X").querySelector(".wt-tab-dot")?.getAttribute("title")).toBe(
      "could not start",
    );
  });

  it("keeps the ended screen through a wake and opens no socket", async () => {
    const m = await singlePage();
    server.list = [ok([ended(X)])];
    await failOn(m, "left", X);
    const conn = engineOn(fake, m.root, "left").engine.connection;
    vi.mocked(conn.connect).mockClear();
    vi.mocked(conn.setSession).mockClear();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    window.dispatchEvent(new Event("online"));
    await ticks(5);

    expect(conn.connect).not.toHaveBeenCalled();
    expect(conn.setSession).not.toHaveBeenCalled();
    expect(bannerOn(m, "left")).toBe("Session ended");
  });

  it.each(listers)(
    "keeps the ended tab on its pane across lists that name it ended (%s)",
    async (_lister, { mount, listAgain }) => {
      server.layout = [ok(closed("X"))];
      server.list = [ok([X])];
      const m = await mount();
      server.list = [ok([ended(X)])];
      server.post = [created(N)];

      closeWithReason(m, "left");
      await listAgain();
      await ticks(10);

      expect(posts()).toBe(0);
      expect(strip(m)).toEqual(["X"]);
      expect(panes(m)).toEqual(["X", null]);
      expect(bannerOn(m, "left")).toBe("Session ended");
    },
  );

  it.each(listers)(
    "keeps the tab when a list names it ended before its socket closes (%s)",
    async (_lister, { mount, listAgain }) => {
      server.layout = [ok(closed("X"))];
      server.list = [ok([X])];
      const m = await mount();
      server.list = [ok([ended(X)])];
      server.post = [created(N)];

      await listAgain();
      await ticks(10);
      expect(posts()).toBe(0);
      expect(panes(m)).toEqual(["X", null]);

      closeWithReason(m, "left");
      await ticks(5);
      expect(posts()).toBe(0);
      expect(toastOn(m, "left")).toBe(startToast);
      expect(bannerOn(m, "left")).toBe("Session ended");
    },
  );

  it("drops only the tab a list no longer names when it still names the ended one", async () => {
    const m = await splitPage();
    server.list = [ok([X, ended(Y)])];
    await failOn(m, "right", Y);
    server.list = [ok([ended(Y)])];
    server.post = [created(N)];

    await reopen();

    expect(posts()).toBe(0);
    expect(strip(m)).toEqual(["Y"]);
    expect(panes(m).filter((id) => id !== null)).toEqual(["Y"]);
    const side = shown(m.ctx(), "left") === "Y" ? "left" : "right";
    expect(bannerOn(m, side)).toBe("Session ended");
  });

  it("keeps a split with one ended pane as it is", async () => {
    const m = await splitPage();
    server.list = [ok([X, ended(Y)])];

    await failOn(m, "right", Y);
    await reopen();

    expect(posts()).toBe(0);
    expect(m.term.split?.isOpen()).toBe(true);
    expect(panes(m)).toEqual(["X", "Y"]);
    expect(strip(m)).toEqual(["X", "Y"]);
    expect(bannerOn(m, "right")).toBe("Session ended");
  });

  it("keeps a split with two ended panes as it is", async () => {
    const m = await splitPage();
    server.list = [ok([ended(X), ended(Y)])];

    await failOn(m, "left", X);
    await failOn(m, "right", Y, "close first");
    await reopen();

    expect(posts()).toBe(0);
    expect(m.term.split?.isOpen()).toBe(true);
    expect(panes(m)).toEqual(["X", "Y"]);
    expect(strip(m)).toEqual(["X", "Y"]);
    expect(bannerOn(m, "left")).toBe("Session ended");
    expect(bannerOn(m, "right")).toBe("Session ended");
  });

  it("snaps an ended tab across an open split, where it shows its end again", async () => {
    const m = await splitPage();
    server.list = [ok([X, ended(Y)])];
    await failOn(m, "right", Y);

    expect(m.api.snap("Y", "left")).toBe(true);
    await ticks(5);
    expect(panes(m)).toEqual(["Y", "X"]);
    closeWithReason(m, "left");
    await ticks(5);

    expect(posts()).toBe(0);
    expect(strip(m)).toEqual(["X", "Y"]);
    expect(bannerOn(m, "left")).toBe("Session ended");
    expect(toastOn(m, "left")).toBe(startToast);
  });

  it("snaps an ended tab out of the single view beside its partner, creating nothing", async () => {
    server.layout = [ok(closed("X"))];
    server.list = [ok([X, Y])];
    const m = await page("#a");
    server.list = [ok([ended(X), Y])];
    await failOn(m, "left", X);

    expect(m.api.snap("X", "right")).toBe(true);
    await ticks(10);

    expect(posts()).toBe(0);
    expect(m.term.split?.isOpen()).toBe(true);
    expect(panes(m)).toEqual(["Y", "X"]);
  });

  it("moves an ended tab with the address, where it shows its end again", async () => {
    const m = await splitPage();
    server.list = [ok([X, ended(Y)])];
    await failOn(m, "right", Y);

    location.hash = "#b,a";
    await until(() => panes(m).join() === "Y,X", 200);
    closeWithReason(m, "left");
    await ticks(5);

    expect(posts()).toBe(0);
    expect(panes(m)).toEqual(["Y", "X"]);
    expect(strip(m)).toEqual(["X", "Y"]);
    expect(bannerOn(m, "left")).toBe("Session ended");
  });

  it("gives a session made elsewhere only its chip beside two ended panes", async () => {
    const m = await splitPage();
    server.list = [ok([ended(X), ended(Y)])];
    await failOn(m, "left", X);
    await failOn(m, "right", Y);

    monitor.emit(status(Z));
    await ticks(10);

    expect(posts()).toBe(0);
    expect(strip(m)).toEqual(["X", "Y", "Z"]);
    expect(panes(m)).toEqual(["X", "Y"]);
    expect(bannerOn(m, "left")).toBe("Session ended");
    expect(bannerOn(m, "right")).toBe("Session ended");
    expect(chipOf(m.root, "Y").querySelector(".wt-tab-dot")?.getAttribute("title")).toBe(
      "could not start",
    );
  });

  it("places a session made elsewhere on the live pane beside an ended one", async () => {
    const m = await splitPage();
    server.list = [ok([X, ended(Y)])];
    await failOn(m, "right", Y);
    m.ctx().shell.select("left");

    monitor.emit(status(Z));
    await ticks(10);

    expect(posts()).toBe(0);
    expect(strip(m)).toEqual(["X", "Y", "Z"]);
    expect(panes(m)).toEqual(["Z", "Y"]);
    expect(bannerOn(m, "right")).toBe("Session ended");
  });

  it("still shows the user's own new terminal in the unselected pane, as create documents", async () => {
    const m = await splitPage();
    server.list = [ok([X, ended(Y)])];
    await failOn(m, "right", Y);
    m.ctx().shell.select("left");
    server.post = [created(N)];

    await m.api.create();
    await ticks(5);

    expect(posts()).toBe(1);
    expect(strip(m)).toEqual(["X", "Y", "N"]);
    expect(panes(m)).toEqual(["X", "N"]);
  });

  it("sends the DELETE when its tab is closed, and replaces a last tab as any close does", async () => {
    const m = await singlePage();
    server.list = [ok([ended(X)])];
    await failOn(m, "left", X);
    server.post = [created(N)];

    await m.api.close("X");

    expect(server.count("DELETE", "/api/sessions/X")).toBe(1);
    expect(posts()).toBe(1);
    expect(strip(m)).toEqual(["N"]);
    expect(panes(m)).toEqual(["N", null]);
  });

  it("sends the DELETE when its tab is closed beside a live one, creating nothing", async () => {
    const m = await splitPage();
    server.list = [ok([X, ended(Y)])];
    await failOn(m, "right", Y);

    await m.api.close("Y");
    await ticks(5);

    expect(server.count("DELETE", "/api/sessions/Y")).toBe(1);
    expect(posts()).toBe(0);
    expect(strip(m)).toEqual(["X"]);
    expect(m.term.split?.isOpen()).toBe(false);
  });

  it("boots onto a new session when the list names only an ended one", async () => {
    server.layout = [ok(closed("X"))];
    server.list = [ok([ended(X)]), ok([ended(X), N])];
    server.post = [created(N)];

    const m = await page("#a");

    expect(posts()).toBe(1);
    expect(strip(m)).toEqual(["X", "N"]);
    expect(panes(m)).toEqual(["N", null]);
  });

  it("still resyncs onto the restored set when a restart also took an ended tab", async () => {
    const m = await splitPage();
    server.list = [ok([X, ended(Y)])];
    await failOn(m, "right", Y);
    server.list = [ok([X2])];
    server.layout = [ok(closed("X2"))];

    monitor.open();
    await until(() => shown(m.ctx(), "left") === "X2", 200);
    await ticks(5);

    expect(panes(m)).toEqual(["X2", null]);
    expect(strip(m)).toEqual(["X2"]);
    expect(posts()).toBe(0);
  });
});

describe("a session whose process ran", () => {
  it("still gives its pane to a session made elsewhere", async () => {
    const m = await splitPage();
    server.list = [ok([X, { ...Y, status: "exited" }])];
    monitor.emit(status({ ...Y, status: "exited" }));
    engineOn(fake, m.root, "right").callbacks.onProcessExit?.({ code: 4001, reason: "" });
    await ticks(10);

    monitor.emit(status(Z));
    await ticks(10);

    expect(posts()).toBe(0);
    expect(strip(m)).toEqual(["X", "Y", "Z"]);
    expect(panes(m)).toEqual(["X", "Z"]);
  });

  it("still settles onto a new session when the server removes the last tab", async () => {
    const m = await singlePage();
    server.list = [ok([])];
    server.post = [created(N)];

    engineOn(fake, m.root, "left").callbacks.onProcessExit?.({ code: 4001, reason: "" });
    monitor.emit(status({ ...X, status: "exited", removed: true }));

    await until(() => shown(m.ctx(), "left") === "N", 200);
    expect(posts()).toBe(1);
  });

  it.each(listers)(
    "still settles onto a new session when a list misses the last tab (%s)",
    async (_lister, { mount, listAgain }) => {
      server.layout = [ok(closed("X"))];
      server.list = [ok([X])];
      const m = await mount();
      server.list = [ok([]), ok([]), ok([N])];
      server.post = [created(N)];

      engineOn(fake, m.root, "left").callbacks.onProcessExit?.({ code: 4001, reason: "" });
      await listAgain();
      await until(() => shown(m.ctx(), "left") === "N", 200);

      expect(shown(m.ctx(), "left")).toBe("N");
      expect(posts()).toBe(1);
    },
  );
});

describe("a snapshot from the status stream's first open after the panes are shown", () => {
  const oneEnded: [string, object[]][] = [
    ["between the live row and the ended one", [X, Z, ended(Y)]],
    ["first", [Z, X, ended(Y)]],
    ["after the ended one", [X, ended(Y), Z]],
  ];
  it.each(oneEnded)(
    "places an arrival listed %s on the live pane beside the ended one",
    async (_o, rows) => {
      const m = await unopenedSplitPage();
      m.ctx().shell.select("left");
      closeWithReason(m, "right");

      await openWithSnapshot(rows);

      expect(posts()).toBe(0);
      expect(strip(m)).toEqual(["X", "Y", "Z"]);
      expect(panes(m)).toEqual(["Z", "Y"]);
      expect(bannerOn(m, "right")).toBe("Session ended");
    },
  );

  it("gives a snapshot arrival only its chip beside two ended panes", async () => {
    const m = await unopenedSplitPage();
    closeWithReason(m, "left");
    closeWithReason(m, "right");

    await openWithSnapshot([Z, ended(X), ended(Y)]);

    expect(strip(m)).toEqual(["X", "Y", "Z"]);
    expect(panes(m)).toEqual(["X", "Y"]);
  });

  it("places a snapshot arrival beside the ended pane when no pane ever changed state", async () => {
    const m = await unopenedSplitPage();
    m.ctx().shell.select("left");

    await openWithSnapshot([X, ended(Y), Z]);

    expect(panes(m)).toEqual(["Z", "Y"]);
  });
});

describe("a session made elsewhere over a pane whose session failed to start", () => {
  it("moves an arrival off a pane whose session the page then learns failed to start", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await arrive(Z);
    expect(panes(m)).toEqual(["X", "Z"]);

    await arrive(ended(Y));

    expect(panes(m)).toEqual(["Z", "Y"]);
    expect(strip(m)).toEqual(["X", "Y", "Z"]);
    expect(posts()).toBe(0);
  });

  it("keeps a failed start's pane from an arrival when its 4001 lands before the listed end", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    closeWithReason(m, "right");

    await arrive(Z);

    expect(panes(m)).toEqual(["Z", "Y"]);
    expect(bannerOn(m, "right")).toBe("Session ended");
  });

  it("gives a failed start's pane back after the user clicked into the arrival that covered it", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await arrive(Z);
    paneRoot(m.root, "right").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await frames();
    expect(selectedSide(m)).toBe("right");

    await arrive(ended(Y));

    expect(panes(m)).toEqual(["Z", "Y"]);
  });

  it.each(["learned last", "learned first"] as const)(
    "puts an arrival back only where it would have gone when a start failure is %s among later arrivals",
    async (when) => {
      const m = await splitPage();
      m.ctx().shell.select("left");
      if (when === "learned first") {
        await failOn(m, "right", Y);
      }

      await arrive(Z);
      await arrive(Z2);
      if (when === "learned last") {
        await arrive(ended(Y));
      }

      expect(panes(m)).toEqual(["Z2", "Y"]);
      expect(strip(m)).toEqual(["X", "Y", "Z", "Z2"]);
    },
  );

  it("keeps the user's new terminal when a start failure is learned after it", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await arrive(Z);
    server.post = [created(N)];
    await m.api.create();
    await frames();
    expect(panes(m)).toEqual(["N", "Z"]);

    await arrive(ended(Y));

    expect(panes(m)).toEqual(["N", "Y"]);
    expect(strip(m)).toEqual(["X", "Y", "N", "Z"]);
  });

  it("shows a failed start again after the split collapsed onto the arrival that covered it", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await arrive(Z);
    await arrive(removed(X));
    expect(panes(m)).toEqual(["Z", null]);

    await arrive(ended(Y));

    expect(m.term.split?.isOpen()).toBe(false);
    expect(panes(m)).toEqual(["Y", null]);
    expect(strip(m)).toEqual(["Y", "Z"]);
    expect(posts()).toBe(0);
  });

  it.each(["learned last", "learned first"] as const)(
    "keeps the selection where it was when a start failure %s sends an arrival to its chip",
    async (when) => {
      const m = await splitPage();
      await failOn(m, "left", X);
      m.ctx().shell.select("left");
      if (when === "learned first") {
        await failOn(m, "right", Y);
      }

      await arrive(Z);
      if (when === "learned last") {
        await arrive(ended(Y));
      }

      expect(panes(m)).toEqual(["X", "Y"]);
      expect(selectedSide(m)).toBe("left");
      expect(strip(m)).toEqual(["X", "Y", "Z"]);
    },
  );

  it("gives a failed start's pane back during a stream reopen", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await arrive(Z);
    const list = held(ok([X, ended(Y), Z]));
    server.list = [list.answer];
    const before = lists();
    monitor.open();
    await until(() => lists() > before);

    await arrive(ended(Y));
    expect(panes(m)).toEqual(["Z", "Y"]);

    list.release();
    await ticks(10);
    await frames();
    expect(panes(m)).toEqual(["Z", "Y"]);
  });

  it.each(["learned last", "learned first"] as const)(
    "keeps the session a split close kept when a start failure is %s",
    async (when) => {
      const m = await splitPage();
      m.ctx().shell.select("left");
      if (when === "learned first") {
        await failOn(m, "right", Y);
      }
      await arrive(Z);
      const keep = selectedSide(m);

      m.term.split?.closeSide(keep === "left" ? "right" : "left");
      await frames();
      if (when === "learned last") {
        await arrive(ended(Y));
      }

      expect(m.term.split?.isOpen()).toBe(false);
      expect(panes(m)).toEqual(["Z", null]);
      expect(strip(m)).toEqual(["X", "Y", "Z"]);
    },
  );
});

describe("a session made elsewhere while panes are shown", () => {
  it("keeps a session made elsewhere in its pane through a stream reopen", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await arrive(Z);
    const list = held(ok([X, Y, Z]));
    server.list = [list.answer];
    const before = lists();

    monitor.open();
    await until(() => lists() > before);
    await frames();
    expect(panes(m)).toEqual(["X", "Z"]);
    list.release();
    await ticks(10);
    await frames();

    expect(panes(m)).toEqual(["X", "Z"]);
  });

  it("keeps a session made elsewhere in its pane when the user presses +", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await arrive(Z);
    server.post = [created(N)];

    await m.api.create();
    await frames();

    expect(panes(m)).toEqual(["N", "Z"]);
  });

  it.each(["one frame", "two frames"] as const)(
    "gives the same panes when an arrival and a removal land in %s",
    async (frameCount) => {
      const m = await splitPage();
      m.ctx().shell.select("left");

      monitor.emit(status(Z));
      if (frameCount === "two frames") {
        await frames();
      }
      monitor.emit(status(removed(Y)));
      await ticks(2);
      await frames();

      expect(panes(m)).toEqual(["X", "Z"]);
      expect(strip(m)).toEqual(["X", "Z"]);
    },
  );

  it("announces and focuses a session made elsewhere that takes the selected pane", async () => {
    const m = await splitPage();
    await failOn(m, "right", Y);
    m.ctx().shell.select("left");
    await announced();

    await arrive(Z);
    await announced();

    expect(panes(m)).toEqual(["Z", "Y"]);
    expect(paneSaid(m, "left")).toBe("Switched to Z");
    expect(document.activeElement).toBe(textareaOf(m.root, "left"));
  });

  it("places arrivals again after a stream open whose list fails", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    server.list = [{ status: 500, body: { error: "down" } }];
    const before = lists();
    monitor.open();
    await until(() => lists() > before);
    await ticks(10);
    server.list = [ok([X, Y, Z])];

    await arrive(Z);

    expect(panes(m)).toEqual(["X", "Z"]);
  });

  it("does not place a session made elsewhere again when the user opened it during the hold", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    const list = held(ok([X, Y, Z]));
    server.list = [list.answer];
    const before = lists();
    monitor.open();
    await until(() => lists() > before);
    await arrive(Z);

    chipOf(m.root, "Z").click();
    await frames();
    expect(panes(m)).toEqual(["Z", "Y"]);
    list.release();
    await ticks(10);
    await frames();

    expect(panes(m)).toEqual(["Z", "Y"]);
  });

  it("lists a tab's active mark in the status listener that announced it", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    const marks: boolean[] = [];
    monitor.feature.api?.onStatus((s) => {
      if (s.id === "Z") {
        marks.push(m.api.list().find((t) => t.id === "Z")?.active ?? false);
      }
    });

    monitor.emit(status(Z));

    expect(marks).toEqual([true]);
  });

  it.each(["a tab click", "an arrival"] as const)(
    "moves the selected chip, the bottom bar and the page title with %s",
    async (how) => {
      server.layout = [ok(splitRecord("X", "Y"))];
      server.list = [ok([X, Y, W])];
      const m = await page("#a,b");
      m.ctx().shell.select("left");
      const target = how === "a tab click" ? "W" : "Z";

      if (how === "a tab click") {
        chipOf(m.root, "W").click();
        await frames();
      } else {
        await arrive(Z);
      }

      expect(m.root.querySelector(".wt-tab-selected .wt-tab-label")?.textContent).toBe(target);
      expect(m.root.querySelector(".wt-switcher-label")?.textContent).toBe(target);
      expect(document.title.split(" · ")[0]).toBe(target);
    },
  );
});

describe("the switch button's dot when a session made elsewhere arrives with a cue", () => {
  it("keeps a hidden tab's cue when a stream arrival with a cue is placed", async () => {
    server.layout = [ok(splitRecord("X", "Y"))];
    server.list = [ok([X, Y, W])];
    const m = await page("#a,b");
    m.ctx().shell.select("left");
    await arrive(cue(W, "done"));
    expect(swDot(m)).toBe("done");

    await arrive(cue(Z, "input"));

    expect(panes(m)).toEqual(["X", "Z"]);
    expect(swDot(m)).toBe("done");
  });

  it.each([
    ["after", true],
    ["before", false],
  ] as const)(
    "keeps a hidden tab's cue when a poll lists an arrival with a cue %s it",
    async (_o, zLast) => {
      History.prototype.replaceState.call(history, null, "", "#a,b");
      server.layout = [ok(splitRecord("X", "Y"))];
      server.list = [ok([X, Y, W])];
      const root = rootIn(1000);
      const mm = await mountScripted(root, {
        paneFeatures: () => [connectionBanner()],
        tabsOpts: { pollMs: 40 },
      });
      const m: Page = { root, ...mm };
      await until(() => panes(m).join() === "X,Y", 200);
      m.ctx().shell.select("left");
      server.list = [ok([X, Y, cue(W, "done")])];
      let before = lists();
      await until(() => lists() >= before + 2, 400);
      await frames();
      expect(swDot(m)).toBe("done");

      const withZ = zLast
        ? [X, Y, cue(W, "done"), cue(Z, "input")]
        : [X, Y, cue(Z, "input"), cue(W, "done")];
      server.list = [ok(withZ), held(ok(withZ)).answer];
      before = lists();
      await until(() => lists() >= before + 2, 400);
      await ticks(5);
      await frames();

      expect(panes(m)).toEqual(["X", "Z"]);
      expect(swDot(m)).toBe("done");
    },
  );

  it("keeps a hidden tab's cue when a stream reopen's list names an arrival with a cue", async () => {
    server.layout = [ok(splitRecord("X", "Y"))];
    server.list = [ok([X, Y, W])];
    const m = await page("#a,b");
    m.ctx().shell.select("left");
    await arrive(cue(W, "done"));
    server.list = [ok([X, Y, cue(W, "done"), cue(Z, "input")])];

    await reopen();
    await frames();

    expect(panes(m)).toEqual(["X", "Z"]);
    expect(swDot(m)).toBe("done");
  });
});

describe("pane changes the user or the kernel makes", () => {
  const layoutPuts = () =>
    server.log.filter((r) => r.method === "PUT" && r.path === "/api/sessions/layout");

  it("shows this page's new session once when the stream delivers it before its POST answers", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    const answer = held(created(N));
    server.post = [answer.answer];
    const creating = m.api.create();
    await until(() => posts() === 1);

    await arrive(N);
    answer.release();
    await creating;
    await frames();

    expect(panes(m)).toEqual(["X", "N"]);
    expect(strip(m)).toEqual(["X", "Y", "N"]);
  });

  it("closes the split onto the unselected pane's tab without rebinding it", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    const kept = engineOn(fake, m.root, "right");
    kept.connection.setSession.mockClear();

    location.hash = "#b";
    await until(() => m.term.split?.isOpen() === false, 200);
    await frames();

    expect(panes(m)).toEqual(["Y", null]);
    expect(engineOn(fake, m.root, "left")).toBe(kept);
    expect(kept.connection.setSession).not.toHaveBeenCalled();
  });

  it("keeps the right pane's terminal when the left tab is closed elsewhere", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    const kept = engineOn(fake, m.root, "right");
    kept.connection.setSession.mockClear();

    await arrive(removed(X));

    expect(panes(m)).toEqual(["Y", null]);
    expect(engineOn(fake, m.root, "left")).toBe(kept);
    expect(kept.connection.setSession).not.toHaveBeenCalled();
  });

  it("keeps the surviving tab selected when the split collapses onto the right pane", async () => {
    const m = await splitPage();
    m.ctx().shell.select("right");

    await arrive(removed(X));

    expect(panes(m)).toEqual(["Y", null]);
    expect(selectedSide(m)).toBe("left");
    expect(m.root.querySelector(".wt-tab-active .wt-tab-label")?.textContent).toBe("Y");
    expect(document.title.split(" · ")[0]).toBe("Y");
  });

  it("keeps the kept session's terminal when the kernel closes the split", async () => {
    const m = await splitPage();
    m.ctx().shell.select("right");
    const kept = engineOn(fake, m.root, "right");
    kept.connection.setSession.mockClear();

    m.term.split?.closeSide("left");
    await frames();

    expect(panes(m)).toEqual(["Y", null]);
    expect(engineOn(fake, m.root, "left")).toBe(kept);
    expect(kept.connection.setSession).not.toHaveBeenCalled();
  });

  it("returns the keyboard to the input when the shown tab's chip is clicked", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await announced();
    const chip = chipOf(m.root, "X");

    chip.focus();
    chip.click();
    await frames();
    await announced();

    expect(document.activeElement).toBe(textareaOf(m.root, "left"));
    expect(paneSaid(m, "left")).not.toBe("Switched to X");
  });

  it("writes the divider's share after a drag, and keeps it in a pane change's write", async () => {
    const m = await splitPage();
    await ticks(5);
    let before = layoutPuts().length;

    m.term.split?.setRatio(0.3, true);
    await until(() => layoutPuts().length > before);
    expect(layoutPuts().at(-1)?.body).toMatchObject({ left: "X", right: "Y", handle: 0.3 });

    before = layoutPuts().length;
    m.ctx().shell.select("right");
    await until(() => layoutPuts().length > before);
    expect(layoutPuts().at(-1)?.body).toMatchObject({ selected: "right", handle: 0.3 });
  });

  it("remembers the pane the user clicked into across a reload", async () => {
    const m = await splitPage();
    m.ctx().shell.select("left");
    await ticks(5);
    const before = layoutPuts().length;

    paneRoot(m.root, "right").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await until(() => layoutPuts().length > before);

    expect(layoutPuts().at(-1)?.body).toMatchObject({ left: "X", right: "Y", selected: "right" });
  });
});
