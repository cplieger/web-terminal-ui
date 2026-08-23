// @vitest-environment happy-dom
//
// Additional tabs-feature tests for the middle third of src/features/tabs/index.ts:
// the order write and its 409 answer, the explicit drag image, ordered adoption of a
// session the server already placed, the close paths' failure and neighbour rules,
// the stale-menu move guards, the long-press menu's release edge, the reconcile
// overlap guard, and a pinned name arriving from another browser.
//
// A separate file from index.test.ts purely so three concurrent workers do not edit
// one file; the setup idioms (real kernel, stubbed fetch, dynamic import per test,
// a fake activityMonitor for the status stream) are the ones that file established.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";
import type { TerminalFeature } from "../../kernel/types.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
// A plain string constant, so reading it through a separate module instance than
// the (dynamically re-imported) feature under test is safe.
import { CUE_SEEN_KEY } from "./model.js";

// A fake activityMonitor: lets a test push status events (and stream (re)opens)
// into tabs without the real SSE. tabs reads it via ctx.use, so the same feature
// value goes into the features array (before tabs) and into tabs({ activityMonitor }).
// Its presence also switches the poll timer off, so the only list round-trips in a
// test are the ones the test caused.
function fakeMonitor(): {
  feature: TerminalFeature<ActivityMonitorApi>;
  emit: (s: SessionStatus) => void;
  open: () => void;
} {
  const subs = new Set<(s: SessionStatus) => void>();
  const openSubs = new Set<() => void>();
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
          onStreamOpen(cb) {
            openSubs.add(cb);
            return () => openSubs.delete(cb);
          },
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
    open: () => {
      for (const cb of [...openSubs]) {
        cb();
      }
    },
  };
}

let createTerminal: (typeof KernelModule)["createTerminal"];
let tabs: (typeof TabsModule)["tabs"];
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The server's answers, per route, each switchable by a test. Kept as a record
// rather than one flag so a case can fail the order write while leaving DELETE
// healthy (and vice versa) — the paths under test are exactly the ones that
// diverge on a single route failing.
interface ServerBehaviour {
  list: unknown[];
  /** Status for PUT /api/sessions/order. 409 means "your session set is stale". */
  orderStatus: number;
  /** Status for POST /api/sessions (create). */
  createStatus: number;
  /** Body for a FAILED create, so a test can choose whether the server explained
   *  itself: the toast quotes the server's own words when it gave any. */
  createErrorBody: unknown;
  /** Status for DELETE /api/sessions/<id>. */
  deleteStatus: number;
  /** Status for the pinned-title write. */
  pinnedStatus: number;
  /** Delay before the pinned-title answer resolves, so a test can land a status
   *  event while the request is genuinely in flight. */
  pinnedDelayMs: number;
  /** Delay before GET /api/sessions answers, so a test can trigger a second
   *  reconcile while the first one's list is still out. */
  listDelayMs: number;
}
let server: ServerBehaviour;

function delayed<T>(value: T, ms: number): Promise<T> {
  return ms <= 0 ? Promise.resolve(value) : new Promise((r) => setTimeout(() => r(value), ms));
}

const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const path = String(url);
  if (path.includes("/pinned-title")) {
    return delayed(
      jsonResponse(server.pinnedStatus === 204 ? null : { error: "nope" }, server.pinnedStatus),
      server.pinnedDelayMs,
    );
  }
  if (path.endsWith("/order")) {
    return Promise.resolve(
      jsonResponse(server.orderStatus === 204 ? null : { error: "stale" }, server.orderStatus),
    );
  }
  if (method === "POST") {
    return Promise.resolve(
      jsonResponse(
        server.createStatus === 201
          ? { id: "s-new", title: "fresh", createdAt: "9", status: "idle" }
          : server.createErrorBody,
        server.createStatus,
      ),
    );
  }
  if (method === "DELETE") {
    return Promise.resolve(
      jsonResponse(
        server.deleteStatus === 204 ? null : { error: "gone wrong" },
        server.deleteStatus,
      ),
    );
  }
  return delayed(jsonResponse(server.list, 200), server.listDelayMs);
});

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockClear();
  server = {
    list: [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ],
    orderStatus: 204,
    createStatus: 201,
    createErrorBody: { error: "no capacity" },
    deleteStatus: 204,
    pinnedStatus: 204,
    pinnedDelayMs: 0,
    listDelayMs: 0,
  };
  vi.stubGlobal("fetch", fetchMock);
  document.body.replaceChildren();
  localStorage.clear();
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
});

async function until(pred: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Wait out the announcer's ~100ms clear-then-set timer and read the polite
 *  region. Announcements are the only witness several of these paths have.
 *  Polled rather than slept for a fixed span: the timer is real, and a loaded
 *  box that has not run it yet would otherwise read as silence. */
async function announced(root: HTMLElement, tries = 60): Promise<string> {
  for (let i = 0; i < tries && liveText(root) === ""; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return liveText(root);
}

/** Mount the terminal with tabs, optionally wired to a fake status stream, and
 *  wait for the strip to hold one chip per listed session. */
async function mount(
  root: HTMLElement,
  monitor?: TerminalFeature<ActivityMonitorApi>,
): Promise<void> {
  document.body.appendChild(root);
  term = createTerminal(root, {
    features: () => (monitor ? [monitor, tabs({ activityMonitor: monitor })] : [tabs()]),
  });
  await until(() => root.querySelectorAll(".wt-tab").length === server.list.length);
}

function labels(root: HTMLElement): string[] {
  return [
    ...(root.querySelector(".wt-tab-scroll")?.querySelectorAll<HTMLElement>(".wt-tab-label") ?? []),
  ].map((e) => e.textContent ?? "");
}

function chips(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".wt-tab")];
}

function openMenu(root: HTMLElement, index: number, x = 10, y = 10): HTMLButtonElement[] {
  chips(root)[index]?.dispatchEvent(
    new MouseEvent("contextmenu", { clientX: x, clientY: y, bubbles: true, cancelable: true }),
  );
  return [...root.querySelectorAll<HTMLButtonElement>(".wt-tab-menu button")];
}

function item(items: HTMLButtonElement[], label: string): HTMLButtonElement | undefined {
  return items.find((b) => b.textContent === label);
}

function field(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(".wt-tab-rename");
}

function toastText(root: HTMLElement): string {
  return root.querySelector(".wt-toast")?.textContent ?? "";
}

/** The dedicated switch button only earns its place with two or more tabs, so its
 *  aria-hidden is the cheapest witness that a list mutation refreshed the chrome. */
function switchButtonHidden(root: HTMLElement): string | null {
  return root.querySelector(".wt-switcher-switch")?.getAttribute("aria-hidden") ?? null;
}

function liveText(root: HTMLElement): string {
  return root.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

function calls(method: string, match: string): unknown[] {
  return fetchMock.mock.calls.filter(
    (c) => (c[1]?.method ?? "GET") === method && String(c[0]).includes(match),
  );
}

// --- The order write (publishOrder) ---

describe("tabs: the shared tab order", () => {
  it("sends the arrangement a menu move produced to the server", async () => {
    // The write half of tab-order sync: the order belongs to the session set, so a
    // reorder here has to reach the other devices watching the same server. Every
    // other witness of a move (the DOM, the announcement) is local, which is how a
    // deleted write stayed invisible.
    const root = document.createElement("div");
    await mount(root);

    item(openMenu(root, 0), "Move right")?.click();
    await until(() => calls("PUT", "/order").length > 0);

    const puts = calls("PUT", "/order") as [string, RequestInit][];
    expect(puts).toHaveLength(1);
    expect(String(puts[0]?.[1]?.body)).toBe(JSON.stringify({ order: ["s2", "s1"] }));
  });

  it("takes the server's word when the order write is refused as stale (409)", async () => {
    // A 409 says the server's session set is not the one just sent: this client has
    // not seen a session created or closed elsewhere. Re-sending would be a fight it
    // cannot win, so it re-lists instead and adopts what it missed.
    server.orderStatus = 409;
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    // The session this client had not seen — visible to the re-list the 409 triggers.
    server.list = [
      ...(server.list as Record<string, unknown>[]),
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    item(openMenu(root, 0), "Move right")?.click();
    await until(() => chips(root).length === 3);

    expect(labels(root)).toContain("three");
  });

  it("leaves the strip as arranged when the order write fails for any other reason", async () => {
    // Any failure other than 409 is a cosmetic write the next reorder can repeat:
    // no re-list, no toast, and the arrangement the user made stands for this page.
    server.orderStatus = 500;
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    const listsBefore = calls("GET", "/api/sessions").length;
    server.list = [
      ...(server.list as Record<string, unknown>[]),
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    item(openMenu(root, 0), "Move right")?.click();
    await until(() => calls("PUT", "/order").length > 0);
    // Give a reconcile that should not happen every chance to happen.
    await new Promise((r) => setTimeout(r, 5));

    expect(calls("GET", "/api/sessions").length).toBe(listsBefore);
    expect(chips(root)).toHaveLength(2);
    expect(labels(root)).toEqual(["two", "one"]);
    expect(toastText(root)).toBe("");
  });

  it("publishes the arrangement a finished drag left behind", async () => {
    // A drop is the other path that COMMITS a reorder (the preview never writes),
    // and it has to reach the server for the same reason the menu move does.
    const root = document.createElement("div");
    await mount(root);
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const chip = chips(root)[0];
    if (!bar || !chip) {
      throw new Error("no bar or chip");
    }

    const dt = fakeDataTransfer();
    chip.dispatchEvent(dragStartAt(dt, 0, 0));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dt });
    Object.defineProperty(drop, "clientX", { value: 0 });
    bar.dispatchEvent(drop);
    chip.dispatchEvent(new Event("dragend", { bubbles: true }));
    await until(() => calls("PUT", "/order").length > 0);

    expect(calls("PUT", "/order")).toHaveLength(1);
  });
});

// --- The explicit drag image ---

// A DataTransfer stand-in that records the drag image AND its offsets: the offsets
// are the whole point of setDragGhost's arithmetic (the ghost must sit under the
// pointer where the chip was grabbed, not jump so its corner meets the cursor).
interface FakeDataTransfer {
  effectAllowed: string;
  dropEffect: string;
  data: Record<string, string>;
  image: Element | null;
  imageX: number;
  imageY: number;
  setData(type: string, value: string): void;
  setDragImage(node: Element, x: number, y: number): void;
}
function fakeDataTransfer(): FakeDataTransfer {
  return {
    effectAllowed: "",
    dropEffect: "",
    data: {},
    image: null,
    imageX: Number.NaN,
    imageY: Number.NaN,
    setData(type, value) {
      this.data[type] = value;
    },
    setDragImage(node, x, y) {
      this.image = node;
      this.imageX = x;
      this.imageY = y;
    },
  };
}
function dragStartAt(dt: FakeDataTransfer, clientX: number, clientY: number): Event {
  const e = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dt });
  Object.defineProperty(e, "clientX", { value: clientX });
  Object.defineProperty(e, "clientY", { value: clientY });
  return e;
}
/** Give an element a fixed box. happy-dom reports 0 for every layout box, so a
 *  test about coordinates has to supply them; without this the ghost's placement
 *  arithmetic has no observable output at all. */
function stubRect(el: Element, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    }) as DOMRect;
}

describe("tabs: the drag image", () => {
  it("lays an inert clone over the grabbed chip, positioned within the root", async () => {
    // WebKit renders no automatic drag image under a filtered ancestor, so the
    // preview is an explicit clone parked directly under .wt-root — laid exactly
    // over the real chip, so it is indistinguishable from it if it ever paints.
    const root = document.createElement("div");
    await mount(root);
    // The styling boundary is the consumer's own element: the kernel stamps
    // .wt-root onto it, and the ghost is parked directly under it.
    const varRoot = root;
    expect(varRoot.classList.contains("wt-root")).toBe(true);
    const chip = chips(root)[0];
    if (!chip) {
      throw new Error("no chip");
    }
    stubRect(varRoot, 20, 5, 800, 600);
    stubRect(chip, 140, 45, 120, 30);

    const dt = fakeDataTransfer();
    chip.dispatchEvent(dragStartAt(dt, 200, 60));

    const ghost = varRoot.querySelector<HTMLElement>(".wt-tab-ghost");
    expect(ghost).not.toBeNull();
    // Under the root itself, outside the bar's filtered subtree.
    expect(ghost?.parentElement).toBe(varRoot);
    // A duplicated role="tab" must not reach assistive tech for the frame it exists.
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    // Root-relative, so the clone lands on top of the chip it copied.
    expect(ghost?.style.left).toBe("120px");
    expect(ghost?.style.top).toBe("40px");
    expect(ghost?.style.width).toBe("120px");
    expect(ghost?.style.height).toBe("30px");
    // The grab offset is measured from the CHIP's box, so the ghost stays under
    // the finger rather than snapping a corner to it.
    expect(dt.image).toBe(ghost);
    expect(dt.imageX).toBe(60);
    expect(dt.imageY).toBe(15);
  });

  it("drops the clone on the next frame and never leaves two behind", async () => {
    const root = document.createElement("div");
    await mount(root);
    const varRoot = root;
    const first = chips(root)[0];
    const second = chips(root)[1];
    if (!first || !second) {
      throw new Error("no chips");
    }

    first.dispatchEvent(dragStartAt(fakeDataTransfer(), 0, 0));
    // A second gesture starting before the frame that clears the first one must
    // not stack clones under the root.
    second.dispatchEvent(dragStartAt(fakeDataTransfer(), 0, 0));
    expect(varRoot.querySelectorAll(".wt-tab-ghost")).toHaveLength(1);

    await new Promise((r) => {
      requestAnimationFrame(() => {
        r(undefined);
      });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(varRoot.querySelectorAll(".wt-tab-ghost")).toHaveLength(0);
  });
});

// --- Adoption ---

describe("tabs: adopting a session from elsewhere", () => {
  it("inserts an adopted tab where the shared order puts it, not at the end", async () => {
    // The status snapshot and the bootstrap's list race each other, so arrival
    // order is neither source's order. A session the arrangement puts FIRST has to
    // land first in the DOM too, or the strip, the switcher rows and the position
    // announcements read three different orders.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    expect(labels(root)).toEqual(["one", "two"]);

    monitor.emit({ id: "s0", status: "idle", title: "zero", createdAt: "0" });
    await until(() => chips(root).length === 3);

    expect(labels(root)).toEqual(["zero", "one", "two"]);
  });

  it("ignores a stale listing for a tab just closed here", async () => {
    // The server has not reaped the session yet, so its next snapshot still lists
    // it; the close tombstone is what stops that re-adopting the chip the user
    // just dismissed.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 1), "Close")?.click();
    await until(() => chips(root).length === 1);

    monitor.emit({ id: "s2", status: "idle", title: "two", createdAt: "2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(chips(root)).toHaveLength(1);
    expect(labels(root)).toEqual(["one"]);
  });
});

// --- Closing one tab ---

describe("tabs: closing one tab", () => {
  it("still removes the tab locally and says so when the server DELETE fails", async () => {
    server.deleteStatus = 500;
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    expect(switchButtonHidden(root)).toBe("false");

    item(openMenu(root, 1), "Close")?.click();
    await until(() => toastText(root) !== "");

    expect(chips(root)).toHaveLength(1);
    expect(toastText(root)).toBe("Couldn't close the terminal on the server");
    // The chrome reflects the drop straight away: with one tab left there is
    // nothing to switch to, so the switch button stands down.
    expect(switchButtonHidden(root)).toBe("true");
  });

  it("activates the left neighbour when the rightmost tab is the one closed", async () => {
    // There is no tab at the closed tab's own index once it is the last, so the
    // re-home has to step BACK. Getting this wrong leaves the strip with nothing
    // active, or spawns a terminal the user did not ask for.
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    chips(root)[2]?.click(); // make the last tab the active one
    await until(() => chips(root)[2]?.classList.contains("wt-tab-active") === true);
    item(openMenu(root, 2), "Close")?.click();
    await until(() => chips(root).length === 2);
    await new Promise((r) => setTimeout(r, 0));

    const active = chips(root).filter((c) => c.classList.contains("wt-tab-active"));
    expect(active).toHaveLength(1);
    expect(active[0]?.querySelector(".wt-tab-label")?.textContent).toBe("two");
    // No replacement was needed, so none was spawned.
    expect(calls("POST", "/api/sessions")).toHaveLength(0);
  });

  it("opens a fresh terminal when the only tab is removed server-side", async () => {
    // An SSE `removed` for the last session: nothing is left to re-home to, so a
    // replacement is spawned rather than leaving the page with no terminal. No
    // DELETE — the session is already gone.
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    monitor.emit({ id: "s1", status: "exited", title: "one", createdAt: "1", removed: true });
    await until(() => labels(root).includes("fresh"));

    expect(labels(root)).toEqual(["fresh"]);
    expect(calls("POST", "/api/sessions")).toHaveLength(1);
    expect(calls("DELETE", "/s1")).toHaveLength(0);
  });

  it("spawns the replacement before dropping the last tab, and still DELETEs it", async () => {
    // The intercept exists so the strip never empties (the "+" would teleport to
    // the far left and jump back). Its observable signature is the ORDER of the two
    // requests: the create goes first, and the old session is still closed.
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Close")?.click();
    await until(() => calls("DELETE", "/s1").length > 0);

    const order = fetchMock.mock.calls
      .map((c) => c[1]?.method ?? "GET")
      .filter((m) => m === "POST" || m === "DELETE");
    expect(order).toEqual(["POST", "DELETE"]);
    expect(labels(root)).toEqual(["fresh"]);
  });

  it("keeps the last tab when its replacement cannot be spawned", async () => {
    // create() adds nothing and toasts on failure, so dropping the old tab anyway
    // would strand the user on an empty strip with no way back.
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    server.createStatus = 500;
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Close")?.click();
    await until(() => toastText(root) !== "");

    expect(labels(root)).toEqual(["one"]);
    expect(calls("DELETE", "/s1")).toHaveLength(0);
    // A 503 has already been retried on the server's own schedule by this point, so
    // reaching here means it never became ready: say so in the server's own words.
    expect(toastText(root)).toBe("Couldn't open a terminal: no capacity");
  });

  it("falls back to the generic wording when the server explained nothing", async () => {
    // The specific wording is not a template with a hole in it: a failure that
    // carried no message must not read "Couldn't open a terminal: undefined".
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    server.createStatus = 500;
    server.createErrorBody = {};
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Close")?.click();
    await until(() => toastText(root) !== "");

    expect(toastText(root)).toBe("Couldn't open a terminal");
  });

  it("collapses the expanded list when the close leaves a single tab", async () => {
    // Otherwise the tray sits open-but-empty, with the separator shown and the
    // keyboard button hidden.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    root.querySelector<HTMLElement>(".wt-switcher-current")?.click(); // expand
    expect(root.querySelector(".wt-switcher")?.classList.contains("wt-switcher-expanded")).toBe(
      true,
    );

    item(openMenu(root, 1), "Close")?.click();
    await until(() => chips(root).length === 1);

    expect(root.querySelector(".wt-switcher")?.classList.contains("wt-switcher-expanded")).toBe(
      false,
    );
  });

  it("keeps the expanded list open when two tabs remain", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    root.querySelector<HTMLElement>(".wt-switcher-current")?.click(); // expand
    item(openMenu(root, 2), "Close")?.click();
    await until(() => chips(root).length === 2);

    expect(root.querySelector(".wt-switcher")?.classList.contains("wt-switcher-expanded")).toBe(
      true,
    );
  });
});

// --- Closing many tabs ---

describe("tabs: closing many tabs", () => {
  it("does not ask for confirmation when the set is a single tab", async () => {
    // Each tab is a running agent, so two or more are confirmed — but a bulk close
    // that happens to name one tab is no more destructive than the Close item, and
    // prompting for it trains the user to dismiss the prompt that matters.
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Close to the right")?.click();
    await until(() => chips(root).length === 1);

    expect(confirm).not.toHaveBeenCalled();
    expect(labels(root)).toEqual(["one"]);
    // The surviving active tab was not re-homed, so this branch's own chrome
    // refresh is the only thing that can have stood the switch button down.
    expect(switchButtonHidden(root)).toBe("true");
  });

  it("tells the user when a server DELETE fails during a bulk close", async () => {
    vi.stubGlobal("confirm", () => true);
    server.deleteStatus = 500;
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Close to the right")?.click();
    await until(() => toastText(root) !== "");

    expect(toastText(root)).toBe("Couldn't close a terminal on the server");
    expect(labels(root)).toEqual(["one"]);
  });

  it("re-homes onto the first survivor when the bulk close took the active tab", async () => {
    vi.stubGlobal("confirm", () => true);
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
      { id: "s4", title: "four", createdAt: "4", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    chips(root)[3]?.click(); // the active tab is one of the victims
    await until(() => chips(root)[3]?.classList.contains("wt-tab-active") === true);
    item(openMenu(root, 0), "Close to the right")?.click();
    await until(() => chips(root).length === 1);
    await new Promise((r) => setTimeout(r, 0));

    const active = chips(root).filter((c) => c.classList.contains("wt-tab-active"));
    expect(active).toHaveLength(1);
    expect(active[0]?.querySelector(".wt-tab-label")?.textContent).toBe("one");
    // A survivor existed, so no replacement terminal was spawned.
    expect(calls("POST", "/api/sessions")).toHaveLength(0);
  });

  it("leaves the live view alone when the bulk close spared the active tab", async () => {
    // Re-homing is for the case where the active tab went. Doing it anyway would
    // yank the user off the terminal they were watching onto whichever tab happens
    // to be leftmost.
    vi.stubGlobal("confirm", () => true);
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
      { id: "s4", title: "four", createdAt: "4", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    chips(root)[1]?.click(); // active tab: two, which survives the close below
    await until(() => chips(root)[1]?.classList.contains("wt-tab-active") === true);
    item(openMenu(root, 1), "Close to the right")?.click();
    await until(() => chips(root).length === 2);
    await new Promise((r) => setTimeout(r, 0));

    const active = chips(root).filter((c) => c.classList.contains("wt-tab-active"));
    expect(active).toHaveLength(1);
    expect(active[0]?.querySelector(".wt-tab-label")?.textContent).toBe("two");
  });

  it("closes nothing by direction when the target tab has gone", async () => {
    // A stale menu naming a closed tab must not be read as "no target, so every
    // tab": the slice a missing index produces spans the whole strip.
    vi.stubGlobal("confirm", () => true);
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    const items = openMenu(root, 1);
    monitor.emit({ id: "s2", status: "exited", title: "two", createdAt: "2", removed: true });
    await until(() => chips(root).length === 2);

    item(items, "Close to the right")?.click();
    item(items, "Close to the left")?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)).toEqual(["one", "three"]);
  });
});

// --- The context menu itself ---

describe("tabs: the tab context menu", () => {
  it("exposes menu semantics and opens at the pointer", async () => {
    const root = document.createElement("div");
    await mount(root);

    const items = openMenu(root, 0, 42, 24);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((b) => b.getAttribute("role") === "menuitem")).toBe(true);
    const menu = root.querySelector<HTMLElement>(".wt-tab-menu");
    expect(menu?.querySelector(".wt-tab-menu-sep")?.getAttribute("role")).toBe("separator");
    expect(menu?.style.left).toBe("42px");
    expect(menu?.style.top).toBe("24px");
  });

  it("closes itself when one of its items runs", async () => {
    const root = document.createElement("div");
    await mount(root);

    const menu = root.querySelector<HTMLElement>(".wt-tab-menu");
    item(openMenu(root, 0), "Move right")?.click();

    expect(menu?.classList.contains("visible")).toBe(false);
    expect(menu?.childElementCount).toBe(0);
  });
});

// --- A menu that outlived the strip it was built for ---

describe("tabs: a move from a stale menu", () => {
  // The menu holds the id it was opened on and its items' enabled state reflects
  // the strip AT THAT MOMENT. A session closing elsewhere in between is the case
  // moveTab's bounds check exists for; without it the splice indices go negative
  // and rearrange unrelated tabs.
  const three = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
    { id: "s3", title: "three", createdAt: "3", status: "idle" },
  ];

  it("does nothing when the tab it names has since been closed elsewhere", async () => {
    server.list = [...three];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    const items = openMenu(root, 1);
    monitor.emit({ id: "s2", status: "exited", title: "two", createdAt: "2", removed: true });
    await until(() => chips(root).length === 2);
    fetchMock.mockClear();

    item(items, "Move right")?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)).toEqual(["one", "three"]);
    expect(calls("PUT", "/order")).toHaveLength(0);
  });

  it("does not move a tab past the left edge the strip has since acquired", async () => {
    server.list = [...three];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    const items = openMenu(root, 1); // Move left enabled: s2 is not first yet
    monitor.emit({ id: "s1", status: "exited", title: "one", createdAt: "1", removed: true });
    await until(() => chips(root).length === 2);
    fetchMock.mockClear();

    item(items, "Move left")?.click(); // s2 is now the first tab
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)).toEqual(["two", "three"]);
    expect(calls("PUT", "/order")).toHaveLength(0);
    expect(liveText(root)).not.toContain("position 0");
  });

  it("does not move a tab past the right edge the strip has since acquired", async () => {
    server.list = [...three];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    const items = openMenu(root, 1); // Move right enabled: s3 is still there
    monitor.emit({ id: "s3", status: "exited", title: "three", createdAt: "3", removed: true });
    await until(() => chips(root).length === 2);
    fetchMock.mockClear();

    item(items, "Move right")?.click(); // s2 is now the last tab
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)).toEqual(["one", "two"]);
    expect(calls("PUT", "/order")).toHaveLength(0);
    expect(liveText(root)).not.toContain("position 3");
  });
});

// --- The rename field's edges ---

describe("tabs: the rename field", () => {
  it("restores the edited chip's own label and selected state, not the first chip's", async () => {
    const root = document.createElement("div");
    await mount(root);

    chips(root)[1]?.click(); // edit the ACTIVE tab, and not the first one
    await until(() => chips(root)[1]?.classList.contains("wt-tab-active") === true);
    item(openMenu(root, 1), "Rename\u2026")?.click();
    const input = field(root);
    expect(input).not.toBeNull();
    const label = chips(root)[1]?.querySelector<HTMLElement>(".wt-tab-label");
    expect(label?.hidden).toBe(true);

    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const chip = chips(root)[1];
    expect(field(root)).toBeNull();
    expect(label?.hidden).toBe(false);
    expect(chip?.classList.contains("wt-tab-editing")).toBe(false);
    // The tab semantics come back from the CURRENT selected state.
    expect(chip?.getAttribute("role")).toBe("tab");
    expect(chip?.getAttribute("aria-selected")).toBe("true");
    // ...and the untouched chip is left exactly as it was.
    expect(chips(root)[0]?.getAttribute("aria-selected")).toBe("false");
  });

  it("ignores a blur from a field a second edit already replaced", async () => {
    // Entering edit elsewhere resolves the open one and removes its field; the blur
    // that move produces then arrives for a field nobody is editing any more. Acting
    // on it would close the edit the user just opened.
    const root = document.createElement("div");
    await mount(root);

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const first = field(root);
    if (!first) {
      throw new Error("no rename field");
    }
    item(openMenu(root, 1), "Rename\u2026")?.click();
    const second = field(root);
    expect(second).not.toBe(first);

    first.dispatchEvent(new FocusEvent("blur"));

    expect(field(root)).toBe(second);
    expect(chips(root)[1]?.classList.contains("wt-tab-editing")).toBe(true);
  });

  it("does not pull focus to the chip when a reorder closes an open edit", async () => {
    // moveTab resolves the edit itself rather than letting the reparent blur do it,
    // and it is not a user finishing an edit, so it must not move focus — least of
    // all onto the terminal, which on a tablet raises the soft keyboard.
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    await mount(root);
    const termInput = root.querySelector<HTMLElement>(".term-input");

    item(openMenu(root, 0), "Rename\u2026")?.click(); // a pointer-entry edit
    expect(field(root)).not.toBeNull();

    item(openMenu(root, 1), "Move left")?.click(); // ...and a move of the OTHER tab
    await until(() => labels(root)[0] === "two");

    expect(field(root)).toBeNull();
    expect(document.activeElement).not.toBe(termInput);
  });
});

// --- A pinned name that arrives from another browser ---

describe("tabs: a remote pinned name", () => {
  it("adopts a name pinned in another browser", async () => {
    // "" is a meaningful value on this field: it is how a clear made elsewhere
    // reaches this client, so the blank-guard the title gets must not apply here.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    monitor.emit({
      id: "s1",
      status: "idle",
      title: "one",
      createdAt: "1",
      pinnedTitle: "renamed elsewhere",
    });
    await until(() => labels(root)[0] === "renamed elsewhere");
    expect(labels(root)[0]).toBe("renamed elsewhere");

    monitor.emit({ id: "s1", status: "idle", title: "one", createdAt: "1", pinnedTitle: "" });
    await until(() => labels(root)[0] === "one");
    expect(labels(root)[0]).toBe("one");
  });

  it("keeps a pin a status record says nothing about", async () => {
    // A server that keeps no pinned names sends no field at all, and the poll
    // fallback lists SessionInfo. Reading that absence as a clear would un-rename
    // every tab on every status tick.
    server.list = [
      { id: "s1", title: "one", pinnedTitle: "kept", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    expect(labels(root)[0]).toBe("kept");

    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)[0]).toBe("kept");
  });

  it("still rolls a failed rename back when a record predating the PUT arrives", async () => {
    // SSE delivery and REST mutation are not one total order, so a record sampled
    // BEFORE our PUT can arrive after it. Treating that as newer authority would
    // suppress the request's own rollback and its failure toast — the user would
    // be left believing a name was saved that never was.
    server.list = [
      { id: "s1", title: "one", pinnedTitle: "old", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    server.pinnedStatus = 500;
    server.pinnedDelayMs = 30;
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    input.value = "new name";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => labels(root)[0] === "new name");

    // The stale record, carrying the value the server still had when it sampled.
    monitor.emit({ id: "s1", status: "idle", title: "one", createdAt: "1", pinnedTitle: "old" });

    await until(() => toastText(root) !== "", 80);
    expect(toastText(root)).toBe("Couldn't save the terminal name");
    expect(labels(root)[0]).toBe("old");
  });

  it("still rolls a failed rename back when an earlier rename of the same tab has already answered", async () => {
    // Two renames of ONE tab overlap. The in-flight marker exists so that a status
    // record arriving mid-request is applied for display without being treated as
    // newer authority; while it is held, the request's own rollback and failure
    // toast survive. So the marker has to stay held until the LAST request for that
    // id answers — a first request completing while a second PUT is still open must
    // not release it, or the second rename fails silently and the user is left
    // looking at a name the server never accepted.
    server.list = [
      { id: "s1", title: "one", pinnedTitle: "old", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    // Each pinned-title write answers on this test's word rather than on the shared
    // delay: the ordering the rule turns on (first answers, stale record lands,
    // second answers) has to be exact, and two requests sharing one delay decide it
    // by a race of a millisecond.
    const answer: ((r: Response) => void)[] = [];
    vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/pinned-title")) {
        return new Promise<Response>((resolve) => {
          answer.push(resolve);
        });
      }
      return fetchMock(url, init);
    });

    const rename = async (value: string): Promise<void> => {
      item(openMenu(root, 0), "Rename\u2026")?.click();
      const input = field(root);
      if (!input) {
        throw new Error("no rename field");
      }
      input.value = value;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await until(() => labels(root)[0] === value);
    };

    await rename("first");
    await rename("second");
    expect(answer).toHaveLength(2);

    // The first write SUCCEEDS, so the server's pinned name is now "first". One
    // macrotask boundary drains every microtask its completion queues, including
    // the request chain's own finally.
    answer[0]?.(jsonResponse(null, 204));
    await new Promise((r) => setTimeout(r, 0));

    // A record sampled before either PUT, carrying the value the server had then.
    monitor.emit({ id: "s1", status: "idle", title: "one", createdAt: "1", pinnedTitle: "old" });

    // The second write fails. Its toast is the user's only notice, and its rollback
    // target — "first" — is what the server actually holds.
    answer[1]?.(jsonResponse({ error: "nope" }, 500));

    await until(() => toastText(root) !== "", 80);
    expect(toastText(root)).toBe("Couldn't save the terminal name");
    expect(labels(root)[0]).toBe("first");
  });
});

// --- What a rename says out loud ---

describe("tabs: what a rename announces", () => {
  const pinned = [
    { id: "s1", title: "one", pinnedTitle: "mine", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
  ];

  async function edit(root: HTMLElement, index: number): Promise<HTMLInputElement> {
    item(openMenu(root, index), "Rename\u2026")?.click();
    const input = field(root);
    if (!input) {
      throw new Error("no rename field");
    }
    return Promise.resolve(input);
  }

  it("names the field and announces which tab is being renamed", async () => {
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 1);
    // The field replaces the chip's visible label, so it needs its own name.
    expect(input.getAttribute("aria-label")).toBe("Rename terminal");
    expect(document.activeElement).toBe(input);
    expect(await announced(root)).toBe("Renaming two");
  });

  it("scrolls the edited chip into view, only as far as needed", async () => {
    // A chip shrinks toward a 100px floor once the strip is full; editing one that
    // has scrolled out of sight otherwise types into nothing. "nearest" so it does
    // not yank a comfortably visible chip to the middle of the strip.
    const root = document.createElement("div");
    await mount(root);
    const chip = chips(root)[1];
    if (!chip) {
      throw new Error("no chip");
    }
    const scrolled = vi.fn();
    chip.scrollIntoView = scrolled;

    await edit(root, 1);

    expect(scrolled).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("announces the new name on a commit, and nothing more", async () => {
    // A confirm that CHANGED something has already said what it did; the
    // "keeping X" line exists only for a confirm that changed nothing, and adding
    // it here would contradict the rename the user just heard succeed.
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 0);
    input.value = "auth work";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => labels(root)[0] === "auth work");

    expect(await announced(root)).toBe("Renamed to auth work");
  });

  it("announces the automatic name a clear falls back to", async () => {
    // A clear's outcome is whatever the automatic sources now yield, which can be
    // the "New tab" fallback — claiming an automatic name then would be false.
    server.list = [
      { id: "s1", title: "resolved", pinnedTitle: "mine", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    await mount(root);
    expect(labels(root)[0]).toBe("mine");

    item(openMenu(root, 0), "Use automatic name")?.click();
    await until(() => labels(root)[0] === "resolved");

    expect(await announced(root)).toBe("Using automatic name: resolved");
  });

  it("says a cancelled rename kept the label of the tab it was opened on", async () => {
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 1);
    input.value = "discarded";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(labels(root)[1]).toBe("two");
    expect(await announced(root)).toBe("Rename cancelled, keeping two");
  });

  it("closes the narrative when a confirm changes nothing", async () => {
    // Without this a screen reader hears "Renaming X" and then silence, which is
    // indistinguishable from the edit still being open.
    server.list = [...pinned];
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(await announced(root)).toBe("Rename finished, keeping mine");
    expect(calls("PUT", "/pinned-title")).toHaveLength(0);
  });

  it("stays silent when a blur changes nothing", async () => {
    // A blur is not a confirmation, so there is no confirmation to close: the
    // "keeping X" line belongs to Enter alone.
    server.list = [...pinned];
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 0);
    input.dispatchEvent(new FocusEvent("blur"));

    expect(await announced(root)).not.toContain("Rename finished");
    expect(labels(root)[0]).toBe("mine");
  });

  it("does not let a blurred field of spaces clear the pin", async () => {
    // A blur commits a non-empty value, and "   " is not one: the sanitizer folds
    // it to empty, which on a confirm is a deliberate clear. Reading it as a commit
    // deleted the user's name because they brushed the space bar.
    server.list = [...pinned];
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 0);
    input.value = "   ";
    input.dispatchEvent(new FocusEvent("blur"));
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)[0]).toBe("mine");
    expect(calls("PUT", "/pinned-title")).toHaveLength(0);
    expect(calls("DELETE", "/pinned-title")).toHaveLength(0);
  });

  it("rolls the tab it renamed back when the server refuses, not the first tab", async () => {
    server.list = [...pinned];
    server.pinnedStatus = 500;
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 1);
    input.value = "second tab";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => toastText(root) !== "");

    expect(toastText(root)).toBe("Couldn't save the terminal name");
    expect(labels(root)).toEqual(["mine", "two"]);
  });

  it("keeps the chip's own keys away from the field", async () => {
    // The chip treats arrows as tab switching and Delete as close; a field that let
    // them through would switch or close the tab the user is typing into.
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    await mount(root);
    expect(chips(root)[0]?.classList.contains("wt-tab-active")).toBe(true);

    const input = await edit(root, 0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(chips(root)).toHaveLength(2);
    expect(chips(root)[0]?.classList.contains("wt-tab-active")).toBe(true);
    expect(field(root)).not.toBeNull();
  });

  it("cancels the platform default on the two keys it acts on", async () => {
    // Enter would submit an enclosing form and Escape reverts a field's value in
    // some engines; both are handled here, so both are claimed.
    const root = document.createElement("div");
    await mount(root);

    let input = await edit(root, 0);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);

    input = await edit(root, 0);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
  });

  it("does not switch tabs when the field itself is clicked", async () => {
    const root = document.createElement("div");
    await mount(root);
    expect(chips(root)[0]?.classList.contains("wt-tab-active")).toBe(true);

    const input = await edit(root, 1); // edit the BACKGROUND tab
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(chips(root)[0]?.classList.contains("wt-tab-active")).toBe(true);
    expect(field(root)).not.toBeNull();
  });

  it("selects the pin it prefilled, so typing replaces it", async () => {
    server.list = [...pinned];
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 0);
    expect(input.value).toBe("mine");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("mine".length);
  });

  it("does not move focus when a blur ends the edit", async () => {
    // A blur is loss of focus, not the user asking for focus to go anywhere in
    // particular — least of all onto the terminal, which on a tablet is how the
    // soft keyboard the user just dismissed comes straight back.
    const root = document.createElement("div");
    await mount(root);
    const termInput = root.querySelector<HTMLElement>(".term-input");

    const input = await edit(root, 0);
    input.value = "committed on blur";
    input.dispatchEvent(new FocusEvent("blur"));
    await until(() => labels(root)[0] === "committed on blur");

    expect(document.activeElement).not.toBe(termInput);
  });

  it("paints the optimistic name on the tab being renamed", async () => {
    server.list = [...pinned];
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 1);
    input.value = "second tab";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => labels(root)[1] === "second tab");

    expect(labels(root)).toEqual(["mine", "second tab"]);
  });

  it("is idempotent per tab: re-entering the same edit keeps what was typed", async () => {
    // The touch entry path is a double-tap, and the leading click switches tabs, so
    // a second entry on the same chip is ordinary. Resolving and reopening would
    // commit half-typed text as the tab's name.
    const root = document.createElement("div");
    await mount(root);

    const input = await edit(root, 0);
    input.value = "half typed";
    chips(root)[0]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(field(root)).toBe(input);
    expect(field(root)?.value).toBe("half typed");
    expect(labels(root)[0]).toBe("one");
    expect(calls("PUT", "/pinned-title")).toHaveLength(0);
  });

  it("does not summon the keyboard when a pointer edit finishes on a touchscreen", async () => {
    // Focusing the hidden textarea pops the soft keyboard, which is not what
    // finishing a rename by double-tap should do. The gate is the same one
    // focus-on-switch uses.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    const root = document.createElement("div");
    await mount(root);
    const termInput = root.querySelector<HTMLElement>(".term-input");

    const input = await edit(root, 0);
    input.value = "renamed by touch";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => labels(root)[0] === "renamed by touch");

    expect(document.activeElement).not.toBe(termInput);
  });
});

// --- An edit whose tab stops existing ---

describe("tabs: an edit on a tab that is removed under it", () => {
  const three = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
    { id: "s3", title: "three", createdAt: "3", status: "idle" },
  ];

  /** Switch to a tab and report whether the terminal took the keyboard back.
   *  focus-on-switch is gated on there being no open edit, so a state that
   *  outlived its chip suppresses it for the rest of the page's life. */
  async function switchAndCheckFocus(root: HTMLElement, index: number): Promise<boolean> {
    const termInput = root.querySelector<HTMLElement>(".term-input");
    chips(root)[index]?.click();
    await until(() => chips(root)[index]?.classList.contains("wt-tab-active") === true);
    return document.activeElement === termInput;
  }

  it("abandons the edit when a remote close removes its chip", async () => {
    // The field lives inside the chip and goes away with it, so the state must not
    // outlive it: a stale editingId stands focus-on-switch down permanently.
    server.list = [...three];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 2), "Rename\u2026")?.click();
    expect(field(root)).not.toBeNull();
    monitor.emit({ id: "s3", status: "exited", title: "three", createdAt: "3", removed: true });
    await until(() => chips(root).length === 2);

    expect(await switchAndCheckFocus(root, 1)).toBe(true);
  });

  it("leaves an edit on another tab open when one tab is closed", async () => {
    // The guard names the edited tab. Tearing down an edit the user is typing into
    // because some OTHER tab closed loses what they typed for no reason.
    server.list = [...three];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    expect(input).not.toBeNull();
    if (input) {
      input.value = "still typing";
    }

    monitor.emit({ id: "s3", status: "exited", title: "three", createdAt: "3", removed: true });
    await until(() => chips(root).length === 2);

    expect(field(root)).toBe(input);
    expect(field(root)?.value).toBe("still typing");
    expect(chips(root)[0]?.classList.contains("wt-tab-editing")).toBe(true);
  });

  it("abandons the edit when a bulk close removes its chip", async () => {
    vi.stubGlobal("confirm", () => true);
    server.list = [...three, { id: "s4", title: "four", createdAt: "4", status: "idle" }];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 3), "Rename\u2026")?.click();
    expect(field(root)).not.toBeNull();
    item(openMenu(root, 1), "Close to the right")?.click();
    await until(() => chips(root).length === 2);

    expect(await switchAndCheckFocus(root, 1)).toBe(true);
  });

  it("leaves an edit on a surviving tab open through a bulk close", async () => {
    // The guard is for an edit whose own chip is going; tearing down an edit the
    // user is still typing into because some other tab closed is not the same thing.
    vi.stubGlobal("confirm", () => true);
    server.list = [...three, { id: "s4", title: "four", createdAt: "4", status: "idle" }];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Rename\u2026")?.click();
    const input = field(root);
    expect(input).not.toBeNull();

    item(openMenu(root, 1), "Close to the right")?.click();
    await until(() => chips(root).length === 2);

    expect(field(root)).toBe(input);
    expect(chips(root)[0]?.classList.contains("wt-tab-editing")).toBe(true);
  });
});

/** Drop something unrelated on the page and report whether the tab feature took
 *  it. The document-level guard is on for exactly as long as a tab drag, so this
 *  reads whether the feature still believes one is in progress. */
function unrelatedDropPrevented(): boolean {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: fakeDataTransfer() });
  document.body.dispatchEvent(e);
  return e.defaultPrevented;
}

// --- What survives a tab going away ---

describe("tabs: a tab that goes away", () => {
  it("ignores a removal for a session it has no tab for", async () => {
    // An SSE `removed` for an id this client never adopted must not be read as
    // "index -1", which splices the LAST tab out of the strip.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    monitor.emit({ id: "s-nope", status: "exited", title: "", createdAt: "0", removed: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)).toEqual(["one", "two"]);
    expect(calls("POST", "/api/sessions")).toHaveLength(0);
  });

  it("hands the closed session's cache back to the embedder", async () => {
    // The per-session store is the consumer's to drop: left behind, a closed
    // session's scrollback sits in their storage for good.
    const dropped: string[] = [];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
      persistScrollback: {
        load: () => null,
        save: () => undefined,
        drop: (id) => dropped.push(id),
      },
    });
    await until(() => chips(root).length === 2);

    item(openMenu(root, 1), "Close")?.click();
    await until(() => chips(root).length === 1);

    expect(dropped).toContain("s2");
  });

  it("ends a live drag whose own chip was closed from another window", async () => {
    // There is no source left to deliver a dragend, and a browser is not obliged
    // to fire one for a removed node — so without this the feature keeps reading
    // "a tab drag is in progress" for the rest of its life and cancels every
    // unrelated drop on the page.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    const chip = chips(root)[1];
    if (!chip) {
      throw new Error("no chip");
    }

    chip.dispatchEvent(dragStartAt(fakeDataTransfer(), 0, 0));
    // While the gesture is live the document guard is on, which is what makes the
    // assertion after the close mean something.
    expect(unrelatedDropPrevented()).toBe(true);

    monitor.emit({ id: "s2", status: "exited", title: "two", createdAt: "2", removed: true });
    await until(() => chips(root).length === 1);

    expect(unrelatedDropPrevented()).toBe(false);
  });

  it("keeps a live drag alive when some other tab is closed from another window", async () => {
    // The gesture belongs to ONE chip. Ending it because a different tab went would
    // abandon the drag the user is still performing, and (worse) leave the pending
    // slot armed against a strip that has moved on.
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    const chip = chips(root)[2];
    if (!chip) {
      throw new Error("no chip");
    }

    chip.dispatchEvent(dragStartAt(fakeDataTransfer(), 0, 0));
    monitor.emit({ id: "s2", status: "exited", title: "two", createdAt: "2", removed: true });
    await until(() => chips(root).length === 2);

    expect(unrelatedDropPrevented()).toBe(true);
  });

  it("leaves the active tab alone when a background tab closes", async () => {
    // Re-homing is for the tab that WAS active. Doing it for any close would move
    // the user off the terminal they are watching because some other tab ended.
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    expect(chips(root)[0]?.classList.contains("wt-tab-active")).toBe(true);

    item(openMenu(root, 2), "Close")?.click();
    await until(() => chips(root).length === 2);
    await new Promise((r) => setTimeout(r, 0));

    const active = chips(root).filter((c) => c.classList.contains("wt-tab-active"));
    expect(active).toHaveLength(1);
    expect(active[0]?.querySelector(".wt-tab-label")?.textContent).toBe("one");
  });

  it("ends a live drag whose chip a bulk close removed", async () => {
    vi.stubGlobal("confirm", () => true);
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    const chip = chips(root)[2];
    if (!chip) {
      throw new Error("no chip");
    }

    chip.dispatchEvent(dragStartAt(fakeDataTransfer(), 0, 0));
    item(openMenu(root, 0), "Close to the right")?.click();
    await until(() => chips(root).length === 1);

    expect(unrelatedDropPrevented()).toBe(false);
  });

  it("clears the switch-button cue a bulk close made moot", async () => {
    // A dot the user can no longer resolve by visiting the tab is worse than no
    // dot: nothing they do will clear it. Its stored acknowledgement goes too, or
    // the entry sits in storage for a session that no longer exists.
    vi.stubGlobal("confirm", () => true);
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");

    // A background tab needs input: the switch button raises the cue.
    monitor.emit({ id: "s3", status: "input", title: "three", createdAt: "3" });
    await until(() => dot?.dataset["status"] === "input");
    expect(dot?.dataset["status"]).toBe("input");

    item(openMenu(root, 0), "Close to the right")?.click();
    await until(() => chips(root).length === 1);

    expect(dot?.dataset["status"]).toBeUndefined();
    expect(localStorage.getItem(CUE_SEEN_KEY) ?? "").not.toContain("s3");
  });

  it("drops a bulk-closed tab's stored acknowledgement", async () => {
    // An acknowledgement is per session, so once the session is gone the entry can
    // only sit in storage until the 200-entry cap evicts it.
    vi.stubGlobal("confirm", () => true);
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    // The ACTIVE tab latching while the page is visible is acknowledged on the
    // spot, which is what puts an entry in storage.
    monitor.emit({ id: "s1", status: "input", title: "one", createdAt: "1" });
    await until(() => (localStorage.getItem(CUE_SEEN_KEY) ?? "").includes("s1"));
    expect(localStorage.getItem(CUE_SEEN_KEY) ?? "").toContain("s1");

    item(openMenu(root, 1), "Close others")?.click();
    await until(() => chips(root).length === 1);

    expect(localStorage.getItem(CUE_SEEN_KEY) ?? "").not.toContain("s1");
  });

  it("hands every bulk-closed session's cache back to the embedder", async () => {
    vi.stubGlobal("confirm", () => true);
    const dropped: string[] = [];
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
      persistScrollback: {
        load: () => null,
        save: () => undefined,
        drop: (id) => dropped.push(id),
      },
    });
    await until(() => chips(root).length === 3);

    item(openMenu(root, 0), "Close to the right")?.click();
    await until(() => chips(root).length === 1);

    expect(dropped).toEqual(expect.arrayContaining(["s2", "s3"]));
  });

  it("does not re-adopt a bulk-closed tab from a stale listing", async () => {
    vi.stubGlobal("confirm", () => true);
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    item(openMenu(root, 0), "Close to the right")?.click();
    await until(() => chips(root).length === 1);

    monitor.emit({ id: "s3", status: "idle", title: "three", createdAt: "3" });
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)).toEqual(["one"]);
  });
});

// --- The active tab, once there is one ---

describe("tabs: the boot-repair activation", () => {
  it("does not re-decide the active tab once one is chosen", async () => {
    // ensureActive runs on every status event and every reconcile. Without its
    // early return it would re-run the "first live tab" ladder each time and drag
    // the user back to the leftmost tab on every dot update.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    chips(root)[1]?.click();
    await until(() => chips(root)[1]?.classList.contains("wt-tab-active") === true);

    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(chips(root)[1]?.classList.contains("wt-tab-active")).toBe(true);
    expect(chips(root)[0]?.classList.contains("wt-tab-active")).toBe(false);
  });
});

// --- One gesture, one terminal ---

describe("tabs: creating a terminal", () => {
  it("reuses the tab the status stream already adopted for the session it created", async () => {
    // The server broadcasts a new session to every client, so the stream can adopt
    // it during the POST round-trip. Adding a second chip for it would leave the
    // user closing a duplicate of the terminal they just opened.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    root.querySelector<HTMLElement>(".wt-tab-new")?.click();
    // The broadcast arrives while the create is still open.
    monitor.emit({ id: "s-new", status: "idle", title: "fresh", createdAt: "9" });
    await until(() => chips(root).length === 3);
    await new Promise((r) => setTimeout(r, 0));

    expect(chips(root)).toHaveLength(3);
    expect(labels(root).filter((l) => l === "fresh")).toHaveLength(1);
  });
});

// --- The strip as a drop zone ---

describe("tabs: the strip's dragover contract", () => {
  it("accepts a tab drag as a move and leaves an unrelated drag alone", async () => {
    // An uncancelled dragover means "no drop allowed here"; cancelling one that is
    // not a tab drag would take over a file drop the page might want.
    const root = document.createElement("div");
    await mount(root);
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const chip = chips(root)[0];
    if (!bar || !chip) {
      throw new Error("no bar or chip");
    }

    const unrelated = new Event("dragover", { bubbles: true, cancelable: true });
    const foreign = fakeDataTransfer();
    Object.defineProperty(unrelated, "dataTransfer", { value: foreign });
    Object.defineProperty(unrelated, "clientX", { value: 5 });
    bar.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
    expect(foreign.dropEffect).toBe("");

    chip.dispatchEvent(dragStartAt(fakeDataTransfer(), 0, 0));
    const dt = fakeDataTransfer();
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: dt });
    Object.defineProperty(over, "clientX", { value: 5 });
    bar.dispatchEvent(over);

    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe("move");
  });
});

// --- A status record's other fields ---
describe("tabs: a status record's position and title", () => {
  // The server's arrangement wins over age, so a list that disagrees with creation
  // order is the fixture that makes a position observable at all.
  const reversed = [
    { id: "s1", title: "one", createdAt: "1", status: "idle", order: 1 },
    { id: "s2", title: "two", createdAt: "2", status: "idle", order: 0 },
  ];

  it("moves a tab when a status record carries a new position", async () => {
    server.list = [...reversed];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    expect(labels(root)).toEqual(["two", "one"]);

    monitor.emit({ id: "s2", status: "idle", title: "two", createdAt: "2", order: 5 });
    await until(() => labels(root)[0] === "one");

    expect(labels(root)).toEqual(["one", "two"]);
  });

  it("leaves the position alone when a status record carries none", async () => {
    // An engine that keeps no order sends no field, and the poll fallback lists
    // SessionInfo. Reading that absence as "position 0" would drag every tab to the
    // front of the strip on every status tick.
    server.list = [...reversed];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    expect(labels(root)).toEqual(["two", "one"]);

    monitor.emit({ id: "s2", status: "working", title: "two", createdAt: "2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)).toEqual(["two", "one"]);
  });

  it("holds the last good title through a whitespace-only one", async () => {
    // A status sweep (or a process clearing its OSC 0/2 window title) reports a
    // blank; overwriting a good label with it dropped an idle tab back to "New tab".
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    monitor.emit({ id: "s1", status: "working", title: "kiro: building", createdAt: "1" });
    await until(() => labels(root)[0] === "kiro: building");

    monitor.emit({ id: "s1", status: "idle", title: "   ", createdAt: "1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)[0]).toBe("kiro: building");
  });

  it("survives a record whose title is not a string at all", async () => {
    // rec comes from unvalidated server JSON. A non-string title reaching .trim()
    // threw and aborted the caller's whole reconcile loop, so the guard is a type
    // check and not only an emptiness check.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);

    monitor.emit({ id: "s1", status: "working", title: "kiro: building", createdAt: "1" });
    await until(() => labels(root)[0] === "kiro: building");

    monitor.emit({
      id: "s1",
      status: "idle",
      createdAt: "1",
      title: 42,
    } as unknown as SessionStatus);
    await new Promise((r) => setTimeout(r, 0));

    // The label survives, and so does the rest of the strip: a throw here would
    // have taken the sweep's remaining work with it.
    expect(labels(root)[0]).toBe("kiro: building");
    expect(labels(root)).toHaveLength(2);
  });
});

// --- Runtime repair when the bootstrap activated nothing ---

describe("tabs: activating a tab the bootstrap never saw", () => {
  it("prefers a live session over a corpse when it repairs the boot", async () => {
    // The bootstrap total-failed (list AND create), so it activated nothing. When
    // the stream reopens and the reconcile adopts what the server has, an ENDED
    // session is exactly as unable to produce output as it looks: activating it
    // would wedge the page, so a live sibling outranks it. A corpse is only
    // auto-activated when nothing else exists.
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("server down")));
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("server down")));
    server.list = [
      { id: "s-dead", title: "dead", createdAt: "1", status: "exited" },
      { id: "s-live", title: "live", createdAt: "2", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => fetchMock.mock.calls.length >= 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(chips(root)).toHaveLength(0);

    // The server is back: the stream reopens and the reconcile adopts both
    // sessions before deciding which one to attach to.
    monitor.open();
    await until(() => root.querySelectorAll(".wt-tab.wt-tab-active").length === 1);

    const active = chips(root).filter((c) => c.classList.contains("wt-tab-active"));
    expect(active).toHaveLength(1);
    expect(active[0]?.querySelector(".wt-tab-label")?.textContent).toBe("live");
  });
});

// --- The keydown observer ---

describe("tabs: the physical-keyboard observer", () => {
  it("observes keystrokes without consuming them", async () => {
    // It is an observer, not a handler: reporting a keystroke as handled would take
    // every key away from the terminal, which is the whole product.
    const root = document.createElement("div");
    await mount(root);
    const input = root.querySelector<HTMLElement>(".term-input");
    if (!input) {
      throw new Error("no terminal input");
    }

    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(ev);

    // The kernel maps and sends the key, which cancels the event; a handler that
    // claimed it would have returned before the mapping ran.
    expect(ev.defaultPrevented).toBe(true);
  });
});

// --- The reconcile's overlap guard ---
describe("tabs: the list reconcile", () => {
  it("skips a run that overlaps one already in flight", async () => {
    // A server slower than the trigger cadence would otherwise have two runs
    // mutating tabList at once. The extra run is dropped, not queued.
    server.listDelayMs = 20;
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    fetchMock.mockClear();

    monitor.open();
    monitor.open();
    monitor.open();
    await until(() => calls("GET", "/api/sessions").length > 0);
    await new Promise((r) => setTimeout(r, 40));

    expect(calls("GET", "/api/sessions")).toHaveLength(1);
  });

  it("relabels the strip after adopting what the server listed", async () => {
    // A newly adopted tab sharing a name with an existing one has to pick up the
    // de-duplication suffix, and only the chrome refresh at the end of the
    // reconcile computes it: the chip is created with the raw server title.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    await mount(root, monitor.feature);
    expect(labels(root)).toEqual(["one", "two"]);

    server.list = [
      ...(server.list as Record<string, unknown>[]),
      { id: "s3", title: "one", createdAt: "3", status: "idle" },
    ];
    monitor.open();
    await until(() => chips(root).length === 3);
    await new Promise((r) => setTimeout(r, 0));

    expect(labels(root)).toEqual(["one", "two", "one (2)"]);
  });
});

// --- The long-press menu's release edge ---

describe("tabs: the long-press menu's trailing click", () => {
  // iPadOS raises the context menu from a long press and the same gesture emits a
  // click on release, which the click-away handler would read as a dismiss. The
  // swallow window is armed when the menu opens AND re-armed on the release edge,
  // because a press held longer than the window would otherwise dismiss its own menu.
  function touchDown(bar: HTMLElement): void {
    bar.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
  }
  function release(bar: HTMLElement): void {
    bar.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }));
  }

  it("survives its own trailing click after a press held past the swallow window", async () => {
    const root = document.createElement("div");
    await mount(root);
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const menu = root.querySelector<HTMLElement>(".wt-tab-menu");
    if (!bar) {
      throw new Error("no tab bar");
    }

    touchDown(bar);
    openMenu(root, 0);
    expect(menu?.classList.contains("visible")).toBe(true);
    // Held long enough that the window armed when the menu opened has expired.
    await new Promise((r) => setTimeout(r, 500)); // past the 350ms swallow window
    release(bar);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu?.classList.contains("visible")).toBe(true);
  });

  it("lets a later unrelated tap's click dismiss the menu", async () => {
    // The re-arm belongs to the press that opened the menu and to no other, or a
    // genuine dismiss would be swallowed for as long as the user keeps tapping.
    const root = document.createElement("div");
    await mount(root);
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const menu = root.querySelector<HTMLElement>(".wt-tab-menu");
    if (!bar) {
      throw new Error("no tab bar");
    }

    touchDown(bar);
    openMenu(root, 0);
    await new Promise((r) => setTimeout(r, 500)); // past the 350ms swallow window
    release(bar); // the release of the opening press: re-arms, and clears the flag
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu?.classList.contains("visible")).toBe(true);

    await new Promise((r) => setTimeout(r, 500)); // past the 350ms swallow window
    // A stray second release with no press behind it: the flag the opening release
    // cleared is what keeps this from arming again.
    release(bar);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu?.classList.contains("visible")).toBe(false);
  });

  it("does not arm on the release of a press that opened nothing", async () => {
    // Every press on the bar goes through the same pointerdown, so the flag has to
    // be cleared there too: otherwise the first tap after a long-press menu would
    // swallow the click that was meant to dismiss it.
    const root = document.createElement("div");
    await mount(root);
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const menu = root.querySelector<HTMLElement>(".wt-tab-menu");
    if (!bar) {
      throw new Error("no tab bar");
    }

    touchDown(bar);
    openMenu(root, 0);
    await new Promise((r) => setTimeout(r, 500)); // past the 350ms swallow window
    release(bar);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu?.classList.contains("visible")).toBe(true);

    await new Promise((r) => setTimeout(r, 500)); // past the 350ms swallow window
    touchDown(bar); // a fresh press, which opens no menu...
    release(bar); // ...so its release has nothing to protect
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu?.classList.contains("visible")).toBe(false);
  });

  it("lets the next click dismiss a menu a mouse opened", async () => {
    // A mouse right-click emits no trailing click, so nothing is swallowed: the
    // very next click away is a genuine dismiss. Neither the pointer-type record
    // nor the opened-in-press flag may start out claiming otherwise.
    const root = document.createElement("div");
    await mount(root);
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const menu = root.querySelector<HTMLElement>(".wt-tab-menu");
    if (!bar) {
      throw new Error("no tab bar");
    }

    openMenu(root, 0); // contextmenu only: no pointerdown, so no press to belong to
    expect(menu?.classList.contains("visible")).toBe(true);
    // A stray release with no press before it must not arm anything either.
    bar.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }));
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu?.classList.contains("visible")).toBe(false);
  });
});
