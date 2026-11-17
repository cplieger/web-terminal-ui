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
  chipOf,
  engineOn,
  fakeMonitor,
  rootIn,
  shown,
  tick,
  until,
  type FakeMonitor,
} from "./test-helpers/split.js";
import {
  created,
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

  it("places a session made elsewhere as for any tab and keeps the ended tabs listed", async () => {
    const m = await splitPage();
    server.list = [ok([ended(X), ended(Y)])];
    await failOn(m, "left", X);
    await failOn(m, "right", Y);

    monitor.emit(status(Z));
    await ticks(10);

    expect(posts()).toBe(0);
    expect(strip(m)).toEqual(["X", "Y", "Z"]);
    expect(panes(m)).toEqual(["X", "Z"]);
    expect(chipOf(m.root, "Y").querySelector(".wt-tab-dot")?.getAttribute("title")).toBe(
      "could not start",
    );
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
