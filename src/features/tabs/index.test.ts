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
import type * as KernelModule from "../../kernel/kernel.js";
import type * as TabsModule from "./index.js";
import type { TerminalFeature } from "../../kernel/types.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
import type { MobileToolbarApi } from "../mobile-toolbar.js";
// A plain string constant, so reading it through a separate module instance than
// the (dynamically re-imported) feature under test is safe.
import { CUE_SEEN_KEY } from "./model.js";
// The reorder preview's timings, imported rather than restated: the tests below pin the
// SHAPE of the interaction (a sweep rearranges nothing, a stationary dragover opens the
// slot, the no-events fallback clears the drag loop's cadence, a drop never waits), not
// what the numbers happen to be, so a deliberate retune moves one definition and not a
// dozen magic numbers in a test file.
import {
  REORDER_REST_MS,
  REORDER_SETTLE_MS,
  REORDER_SLOT_FADE_MS,
  REORDER_STILL_MS,
} from "./strip.js";

// A fake activityMonitor feature: lets a test push status events into tabs
// without the real SSE. tabs reads it via ctx.use, so passing the same feature
// value in the features array (before tabs) and to tabs({ activityMonitor })
// wires them together.
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

// A fake activityMonitor that delivers a status snapshot synchronously when
// tabs subscribes (onStatus), mimicking the server pushing the existing
// sessions on SSE open before the initial GET /api/sessions resolves. This is
// the ordering that used to duplicate every session (the list loop re-added the
// already-adopted tabs).
function snapshotMonitor(snapshot: readonly SessionStatus[]): TerminalFeature<ActivityMonitorApi> {
  return {
    name: "activityMonitor",
    setup() {
      return {
        api: {
          onStatus(cb) {
            for (const s of snapshot) {
              cb(s);
            }
            return () => undefined;
          },
          current: () => undefined,
        },
        teardown: () => undefined,
      };
    },
  };
}

// A fake keyboardToggle feature (a MobileToolbarApi provider) so a test can
// verify tabs renders + wires its keyboard buttons without the real toolbar.
// Passed both in the features array (before tabs) and to tabs({ keyboardToggle })
// so ctx.use wires them, mirroring the activityMonitor fakes above.
function fakeKeyboardToggle(): {
  feature: TerminalFeature<MobileToolbarApi>;
  isOpen: () => boolean;
} {
  let open = false;
  const feature: TerminalFeature<MobileToolbarApi> = {
    name: "mobileToolbar",
    setup() {
      return {
        api: {
          toggle() {
            open = !open;
          },
          isOpen: () => open,
          isCtrlArmed: () => false,
          onCtrlArmedChange: () => () => undefined,
        },
        teardown: () => undefined,
      };
    },
  };
  return { feature, isOpen: () => open };
}

const setSession = vi.fn<(id: string) => void>();
const forgetSession = vi.fn<(id: string) => void>();
const bind = vi.fn();
// The renderer owns the abs<->pixel mapping, so per-tab view memory is captured
// through it. Returns a real ViewMemory shape (not null) so the switch assertions
// below can prove the SAVED view of the outgoing tab is the one handed back to
// bind for the incoming one — the round trip is the behavior, and a null-returning
// double would let a broken round trip pass.
const captureViewMemory = vi.fn(() => ({ abs: 7, screenTop: -3, following: false }));

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
      pendingRowCount: vi.fn(() => 0),
      noteResumeBounds: vi.fn(),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      updateReverseVideo: vi.fn(),
      resetScrollback: vi.fn(),
      resetScreen: vi.fn(),
      // Only reached by the kernel's own `freeze` handler, which a tabs test
      // dispatches when it checks that freezing a background tab does NOT clear
      // the attention surfaces.
      dropBrowseCache: vi.fn(),
      bind,
      captureViewMemory,
      boundStore: vi.fn(() => ({ getWindow: () => ({ base: 0 }) })),
    },
    scroll: {
      init: vi.fn(),
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      restoreScrollTop: vi.fn(),
      restoreView: vi.fn(),
    },
    connection: {
      init: vi.fn(),
      connect: vi.fn(),
      sendBinary: vi.fn(() => true),
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect: vi.fn(),
      setSession,
      forgetSession,
      // Persistence reads the epoch a session's content belongs to and seeds it
      // back on a hydrate; a non-zero epoch is what makes a stored snapshot
      // usable at all, so the fake reports one.
      serverEpochOf: vi.fn(() => 777),
      adoptPersistedEpoch: vi.fn(),
      currentSessionId: vi.fn(() => "unmanaged"),
    },
  };
});

let createTerminal: (typeof KernelModule)["createTerminal"];
let tabs: (typeof TabsModule)["tabs"];
// Track the created terminal so afterEach can destroy it: tabs without an
// activityMonitor starts a polling setInterval, which must be cleared between
// tests (destroy() runs the feature teardown that clears it).
let term: ReturnType<(typeof KernelModule)["createTerminal"]> | undefined;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    // A real Response always has headers, and the session API reads Retry-After
    // off a failed one. Without this the fake would throw a TypeError that the
    // call sites' catch blocks swallow, so a retry test would pass for the wrong
    // reason.
    headers: {
      get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
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
  return Promise.resolve(jsonResponse(listBody, 200));
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
  localStorage.clear(); // isolate the persisted active-tab id between tests
  ({ createTerminal } = await import("../../kernel/kernel.js"));
  ({ tabs } = await import("./index.js"));
});

// Page visibility is a FIXTURE here, not ambient state: two suites decide behaviour
// on it (the notification suppression rule, and the active-tab acknowledgement that
// defers while hidden), and a test that inherited whatever the previous one left
// would pass or fail by ordering.
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

afterEach(() => {
  term?.destroy();
  term = undefined;
  vi.unstubAllGlobals();
  // Reset for every test, so a case that throws mid-way cannot leak "hidden".
  setVisibility("visible");
});

async function until(pred: () => boolean, tries = 20): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// A minimal DataTransfer stand-in recording what the strip's drag handlers put
// on it, plus a synthetic DragEvent (happy-dom has no drag event constructors).
interface FakeDataTransfer {
  effectAllowed: string;
  dropEffect: string;
  data: Record<string, string>;
  image: Element | null;
  setData(type: string, value: string): void;
  setDragImage(node: Element, x: number, y: number): void;
}
function fakeDataTransfer(): FakeDataTransfer {
  return {
    effectAllowed: "",
    dropEffect: "",
    data: {},
    image: null,
    setData(type, value) {
      this.data[type] = value;
    },
    setDragImage(node) {
      this.image = node;
    },
  };
}
function dragEvent(type: string, dt: FakeDataTransfer): Event {
  return dragAt(type, dt, 0);
}
// A dragover at a specific x. The reorder preview distinguishes a MOVING pointer from a
// stopped one, so a test that wants to say "still sweeping" has to change the
// coordinate; repeating one is how it says "stopped".
function dragAt(type: string, dt: FakeDataTransfer, clientX: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dt });
  Object.defineProperty(e, "clientX", { value: clientX });
  Object.defineProperty(e, "clientY", { value: 0 });
  return e;
}

// The strip's labels in DOM order. Scoped to the scroller, which holds ONLY
// tabs: a drag's ghost is a chip clone parked under .wt-root until the next
// frame, so a root-wide query would count the dragged tab twice.
function idsOf(root: HTMLElement): string[] {
  return [
    ...(root.querySelector(".wt-tab-scroll")?.querySelectorAll<HTMLElement>(".wt-tab-label") ?? []),
  ].map((e) => e.textContent ?? "");
}

describe("tabs feature", () => {
  it("builds a tab per listed session with the first active and connects to it", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEls = root.querySelectorAll(".wt-tab");
    expect(tabEls.length).toBe(2);
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(true);
    expect(tabEls[1]?.classList.contains("wt-tab-active")).toBe(false);
    // The first (oldest) session is activated: renderer bound + WS connected.
    expect(bind).toHaveBeenCalled();
    expect(setSession).toHaveBeenCalledWith("s1");
  });

  it("creates every per-tab store through ctx.newLineStore, so scrollbackLines caps them", async () => {
    // End-to-end through the real kernel: the consumer's one option must reach
    // the tabs switching cache, not only the kernel's implicit store. The
    // renderer's bind mock captures the actual per-tab LineStore; a cap of 8
    // is observable through eviction (12 lines committed -> oldest 4 gone).
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()], scrollbackLines: 8 });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const store = bind.mock.calls[0]?.[0] as InstanceType<typeof Engine.LineStore>;
    expect(store).toBeDefined();
    const row = (t: string): { t: string; f: number; b: number; a: number; uc: number }[] => [
      { t, f: -1, b: -1, a: 0, uc: -1 },
    ];
    store.applyScroll({
      type: "scroll",
      firstIndex: 0,
      lines: Array.from({ length: 12 }, (_, i) => row(`l${String(i)}`)),
    });
    expect(store.highestIndex()).toBe(11);
    expect(store.oldestIndex()).toBe(4); // cap 8 applied to the TAB's store
  });

  it("names each session when it creates its store, so a tab restores its scrollback", async () => {
    // The end-to-end pin for the tabbed half of persistScrollback. tabs must pass
    // the session id to ctx.newLineStore, or the kernel has no key to look a
    // snapshot up by and every tab silently starts cold — a regression that would
    // otherwise be invisible, because an unhydrated store is still a correct one.
    const { LineStore } = await import("@cplieger/web-terminal-engine");
    const seed = new LineStore();
    seed.applyScroll({
      type: "scroll",
      firstIndex: 500,
      lines: [[{ t: "restored", f: -1, b: -1, a: 0, uc: -1 }]],
    });
    const snapshot = seed.snapshot(777);
    expect(snapshot).not.toBeNull();
    const entries = new Map([["s1", { savedAt: Date.now(), snapshot: snapshot! }]]);

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [tabs()],
      persistScrollback: {
        load: (id) => entries.get(id) ?? null,
        save: (id, entry) => {
          entries.set(id, entry);
        },
        drop: (id) => {
          entries.delete(id);
        },
      },
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const store = bind.mock.calls[0]?.[0] as InstanceType<typeof Engine.LineStore>;
    expect(store.highestIndex()).toBe(500);
    expect(store.getLine(500)?.[0]?.t).toBe("restored");
  });

  it("restores the previously-active tab on reload from localStorage", async () => {
    // A prior session left s2 active; a reload must reopen s2, not the oldest s1.
    localStorage.setItem("wt-active-session", "s2");
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEls = root.querySelectorAll(".wt-tab");
    expect(tabEls[1]?.classList.contains("wt-tab-active")).toBe(true);
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(false);
    expect(setSession).toHaveBeenCalledWith("s2");
  });

  it("restores the saved active tab when the status snapshot wins the boot race", async () => {
    // The test above passes with no activityMonitor, so nothing races the
    // bootstrap. The real app always has one, and it always wins: tabs subscribes
    // during setup, before resolveInitialSession issues GET /api/sessions, so the
    // SSE snapshot adopts every session first. ensureActive then fired on the
    // FIRST of those events — a one-tab view — activated it, and the bootstrap
    // ladder found activeId already set and returned before ever reading the saved
    // id. Every reload landed on the oldest tab.
    localStorage.setItem("wt-active-session", "s2");
    const monitor = snapshotMonitor([
      { id: "s1", status: "idle", title: "one", createdAt: "1" },
      { id: "s2", status: "idle", title: "two", createdAt: "2" },
    ]);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [monitor, tabs({ activityMonitor: monitor })] });
    await until(() => root.querySelectorAll(".wt-tab").length >= 2);
    // Let the bootstrap's list round-trip settle, which is what chooses the tab.
    await new Promise((r) => setTimeout(r, 0));

    const tabEls = root.querySelectorAll(".wt-tab");
    expect(tabEls[1]?.classList.contains("wt-tab-active")).toBe(true);
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(false);
    // Exactly one connect, to the saved session: activating s1 first and
    // correcting to s2 would flash the wrong screen and burn a WS attach.
    expect(setSession.mock.calls.map((c) => c[0])).toEqual(["s2"]);
  });

  it("activates a tab adopted after the bootstrap failed (server down at load, then back)", async () => {
    // The bootstrap total-fails: the list rejects, and so does the create it falls
    // back to, so it returns having activated nothing and leaves the retry chrome
    // up. When the server comes back and the status stream adopts a session,
    // ensureActive must activate it, or the tab renders inert (blank, never
    // connecting) until the user taps it.
    //
    // This is the path ensureActive's `started` gate must NOT close, and the
    // reason `started` is set on every exit from the bootstrap rather than only
    // the successful one. Two rejections, so the shared fetch mock's base
    // implementation is left intact for the rest of the suite.
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("server down")));
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("server down")));
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => fetchMock.mock.calls.length >= 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelectorAll(".wt-tab").length).toBe(0);
    expect(setSession).not.toHaveBeenCalled();

    // The server is back, and the stream pushes a session that already exists.
    monitor.emit({ id: "s9", status: "idle", title: "recovered", createdAt: "9" });
    await until(() => root.querySelectorAll(".wt-tab.wt-tab-active").length === 1);
    expect(root.querySelectorAll(".wt-tab.wt-tab-active").length).toBe(1);
    expect(setSession).toHaveBeenCalledWith("s9");
  });

  it("falls back to the oldest tab when the saved active id no longer exists", async () => {
    // The saved tab was closed before the reload; activate the oldest instead.
    localStorage.setItem("wt-active-session", "s-gone");
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEls = root.querySelectorAll(".wt-tab");
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(true);
    expect(setSession).toHaveBeenCalledWith("s1");
  });

  it("spawns and activates a fresh session when every listed session is exited", async () => {
    // The agent died in every listed session (e.g. a sign-in dead end). The
    // bootstrap must not wedge on a corpse: it spawns a fresh live session,
    // activates it, and keeps the exited one around as a viewable tab.
    listBody = [{ id: "s1", title: "", createdAt: "1", status: "exited" }];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(setSession).toHaveBeenCalledWith("s-new");
    expect(setSession).not.toHaveBeenCalledWith("s1");
    // The exited session still has a tab (switch to it to read its last screen).
    expect(root.querySelectorAll(".wt-tab").length).toBe(2);
  });

  it("activates the oldest LIVE session, not an older exited one", async () => {
    listBody = [
      { id: "s1", title: "dead", createdAt: "1", status: "exited" },
      { id: "s2", title: "alive", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(setSession).toHaveBeenCalledWith("s2");
    // No fresh session was spawned: a live one existed.
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });

  it("ignores a saved active id whose session has exited (no reload-onto-a-corpse)", async () => {
    localStorage.setItem("wt-active-session", "s1");
    listBody = [
      { id: "s1", title: "dead", createdAt: "1", status: "exited" },
      { id: "s2", title: "alive", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(setSession).toHaveBeenCalledWith("s2");
    expect(setSession).not.toHaveBeenCalledWith("s1");
  });

  it("falls back to the exited tab when nothing is live and the fresh spawn fails", async () => {
    // Server lists only a corpse and refuses to create (e.g. rate limited).
    // A frozen final screen + "Session ended" still beats a blank page, so the
    // exited tab is activated as the last resort.
    listBody = [{ id: "s1", title: "dead", createdAt: "1", status: "exited" }];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") {
          return Promise.resolve(jsonResponse({ error: "rate_limited" }, 429));
        }
        return Promise.resolve(jsonResponse(listBody, 200));
      }),
    );
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => setSession.mock.calls.length > 0);

    expect(setSession).toHaveBeenCalledWith("s1");
  });

  it("switches to another tab: re-points the renderer and reconnects the WS", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
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
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    root.querySelector<HTMLElement>(".wt-tab-new")?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    expect(root.querySelectorAll(".wt-tab").length).toBe(3);
    expect(setSession).toHaveBeenCalledWith("s-new");
  });

  it("paints a press state on the + while it is held", async () => {
    // The "+" cancels its pointerdown default to keep the keyboard on the
    // terminal, and that also suppresses the browser's own :active in Firefox —
    // so the press class is the only press feedback the button has there. It
    // shipped without one: the "+" was the single control in the desktop strip
    // that acknowledged nothing on mousedown.
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const plus = root.querySelector<HTMLElement>(".wt-tab-new");
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    plus?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(plus?.classList.contains("wt-pressed")).toBe(true);
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(plus?.classList.contains("wt-pressed")).toBe(false);
  });

  it("opens one terminal when one press delivers two + activations", async () => {
    // iPadOS can deliver two activations for a single press on the strip (the
    // web-terminal-kiro server logged two POST /api/sessions 0-3ms apart for one
    // "+" tap), which used to spawn two sessions. Unique POST ids so a second
    // create cannot hide behind the shared-id dedup in create().
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") {
          posts += 1;
          return Promise.resolve(
            jsonResponse(
              { id: `s-dup${String(posts)}`, title: "", createdAt: "3", status: "idle" },
              201,
            ),
          );
        }
        if (method === "DELETE") {
          return Promise.resolve(jsonResponse(null, 204));
        }
        return Promise.resolve(jsonResponse(listBody, 200));
      }),
    );
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const plus = root.querySelector<HTMLElement>(".wt-tab-new");
    plus?.click();
    plus?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 3);
    // Let any second create that slipped the guard land before asserting.
    await until(() => posts > 1, 5);

    expect(posts).toBe(1);
    expect(root.querySelectorAll(".wt-tab").length).toBe(3);

    // A deliberate second press, once the first create has resolved, still opens
    // a second terminal: the guard is the in-flight window, not a rate limit.
    plus?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 4);
    expect(posts).toBe(2);
  });

  it("hands the keyboard back to the terminal when a press re-selects the active tab", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const input = root.querySelector<HTMLElement>(".term-input");
    const active = root.querySelector<HTMLElement>(".wt-tab-active");
    expect(input).toBeTruthy();
    expect(active).toBeTruthy();
    input?.focus();
    // happy-dom runs no browser default actions, so play the one that matters:
    // a pointer press focuses the chip it lands on, blurring the terminal input.
    active?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    active?.focus();
    expect(document.activeElement).toBe(active);

    active?.click(); // switchTo bails (already active) — the focus rule must not
    expect(document.activeElement).toBe(input);
  });

  it("restores keyboard focus a chip press displaced, without summoning it", async () => {
    // A coarse-pointer device with no keyboard attached: focus-on-switch is off
    // (it would pop the soft keyboard), so the only thing that may move the
    // keyboard is putting back what the press itself took.
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
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const input = root.querySelector<HTMLElement>(".term-input");
    const [first, second] = [...root.querySelectorAll<HTMLElement>(".wt-tab")];
    expect(second).toBeTruthy();

    // Press with the terminal focused: the switch hands the keyboard back.
    input?.focus();
    second?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    second?.focus();
    second?.click();
    expect(document.activeElement).toBe(input);

    // Press with the terminal NOT focused (nothing to restore): the switch
    // leaves the keyboard alone rather than opening the soft keyboard.
    document.body.focus();
    first?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    first?.focus();
    first?.click();
    expect(document.activeElement).toBe(first);
  });

  it("renders the + button as a fixed bar item outside the scrolling tab list", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const scroller = root.querySelector(".wt-tab-scroll");
    const newBtn = root.querySelector(".wt-tab-new");
    expect(newBtn).toBeTruthy();
    // The close-all bar button is gone (it moved to the right-click menu). The
    // + sits OUTSIDE the scroller, directly after it in the bar, so an
    // overflowing tab list scrolls under it and can never push it away; the
    // scroller holds only the tabs, its last child being the last tab.
    expect(root.querySelector(".wt-tab-closeall")).toBeNull();
    expect(scroller?.contains(newBtn ?? null)).toBe(false);
    expect(newBtn?.previousElementSibling).toBe(scroller);
    expect(scroller?.lastElementChild?.classList.contains("wt-tab")).toBe(true);
  });

  it("keeps a tab's dot hidden until its session reports activity (default)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // The listed sessions carry no reportsActivity flag: evidence-driven
    // reveal keeps every dot unrevealed (a plain shell's tabs stay label-only).
    const dot = root.querySelector<HTMLElement>(".wt-tab .wt-tab-dot");
    expect(dot).toBeTruthy();
    expect(dot?.classList.contains("wt-reports")).toBe(false);
  });

  it("shows the idle dot from tab creation with presumeReports (agent shell)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs({ presumeReports: true })] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // An agent shell presumes every session reports (presetAgentTabbed): the
    // dot is revealed as idle immediately, without waiting for the agent's
    // first OSC 9;4 signal.
    for (const dot of root.querySelectorAll<HTMLElement>(".wt-tab .wt-tab-dot")) {
      expect(dot.classList.contains("wt-reports")).toBe(true);
      expect(dot.dataset["status"]).toBe("idle");
    }
  });

  it("closes a tab on middle-click", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    fetchMock.mockClear();
    // Middle-click (button 1) the second tab.
    root
      .querySelectorAll<HTMLElement>(".wt-tab")[1]
      ?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    const deleted = fetchMock.mock.calls.some(
      (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith("/s2"),
    );
    expect(deleted).toBe(true);
  });

  it("does not duplicate tabs when the status snapshot arrives before the initial list", async () => {
    // The SSE snapshot adopts s1+s2 as tabs.setup subscribes, before the awaited
    // GET /api/sessions (which also lists s1+s2) resolves. The list loop must
    // dedup against the adopted tabs: a straight push doubled every session
    // (4 tabs from 2) and painted two active (both copies of the active id).
    const monitor = snapshotMonitor([
      { id: "s1", status: "idle", title: "one", createdAt: "1" },
      { id: "s2", status: "idle", title: "two", createdAt: "2" },
    ]);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [monitor, tabs({ activityMonitor: monitor })] });
    await until(() => root.querySelectorAll(".wt-tab").length >= 2);
    // Give the initial list loop a turn to (wrongly) add duplicates.
    await new Promise((r) => setTimeout(r, 0));

    expect(root.querySelectorAll(".wt-tab").length).toBe(2);
    expect(root.querySelectorAll(".wt-tab.wt-tab-active").length).toBe(1);
  });

  it("replaces the sole tab on close (spawns first, then drops) without emptying the strip", async () => {
    listBody = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    fetchMock.mockClear();
    // Close the only tab (middle-click). A fresh session is POSTed and the old
    // one DELETEd; the strip keeps exactly one tab (the replacement) throughout.
    root
      .querySelector<HTMLElement>(".wt-tab")
      ?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await until(() => fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "POST"));
    await until(() =>
      fetchMock.mock.calls.some(
        (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith("/s1"),
      ),
    );

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    expect(root.querySelector(".wt-tab.wt-tab-active")).toBeTruthy();
    // The replacement is the fresh session, not the closed one.
    expect(root.querySelector(".wt-tab-label")?.textContent).toBe("New tab");
  });

  // --- Right-click tab context menu (round-4) ---
  // openTabMenu right-clicks a tab and returns the menu's buttons (the "button"
  // tag overload types these as HTMLButtonElement, so .disabled/.click() work).
  function openTabMenu(root: HTMLElement, index: number): HTMLButtonElement[] {
    const tab = root.querySelectorAll<HTMLElement>(".wt-tab")[index];
    tab?.dispatchEvent(new MouseEvent("contextmenu", { clientX: 10, clientY: 10, bubbles: true }));
    const menu = root.querySelector(".wt-tab-menu");
    return menu ? [...menu.querySelectorAll("button")] : [];
  }
  function menuItem(items: HTMLButtonElement[], label: string): HTMLButtonElement | undefined {
    return items.find((b) => b.textContent === label);
  }
  function wasDeleted(id: string): boolean {
    return fetchMock.mock.calls.some(
      (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith(`/${id}`),
    );
  }

  it("opens a right-click context menu on a tab with the move and close actions", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const menu = root.querySelector(".wt-tab-menu");
    expect(menu?.classList.contains("visible")).toBe(false);

    const items = openTabMenu(root, 0);
    expect(menu?.classList.contains("visible")).toBe(true);
    expect(items.map((b) => b.textContent)).toEqual([
      "Rename\u2026",
      "Use automatic name",
      "Move left",
      "Move right",
      "Close",
      "Close others",
      "Close to the right",
      "Close to the left",
      "Close all",
    ]);
    // The naming pair sits above a separator, away from the close items.
    expect(menu?.querySelectorAll(".wt-tab-menu-sep").length).toBe(1);
    // With no pinned name there is nothing to revert to, so the item is present
    // but inert — the menu's item positions never shift.
    expect(menuItem(items, "Use automatic name")?.disabled).toBe(true);
    expect(menuItem(items, "Rename\u2026")?.disabled).toBe(false);
    // On the first of two tabs, the leftward actions are disabled; the rest enabled.
    expect(menuItem(items, "Move left")?.disabled).toBe(true);
    expect(menuItem(items, "Move right")?.disabled).toBe(false);
    expect(menuItem(items, "Close to the left")?.disabled).toBe(true);
    expect(menuItem(items, "Close to the right")?.disabled).toBe(false);
    expect(menuItem(items, "Close others")?.disabled).toBe(false);
  });

  // --- Keyboard interaction on the desktop strip (WCAG 2.1.1; APG Tabs) ---
  function pressKey(el: HTMLElement | undefined, key: string): void {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  it("manages a roving tabindex: exactly the selected tab is in the Tab order", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEls = [...root.querySelectorAll<HTMLElement>(".wt-tab")];
    expect(tabEls.map((t) => t.tabIndex)).toEqual([0, -1]);
    tabEls[1]?.click();
    expect(tabEls.map((t) => t.tabIndex)).toEqual([-1, 0]);
  });

  it("ArrowRight/ArrowLeft move the selection and focus, wrapping at the ends", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    const tabEls = [...root.querySelectorAll<HTMLElement>(".wt-tab")];
    setSession.mockClear();
    // Arrow from the focused (active) tab selects and focuses its neighbor.
    pressKey(tabEls[0], "ArrowRight");
    expect(setSession).toHaveBeenCalledWith("s2");
    expect(tabEls[1]?.classList.contains("wt-tab-active")).toBe(true);
    expect(document.activeElement).toBe(tabEls[1]);
    // ArrowRight from the last tab wraps to the first.
    pressKey(tabEls[2], "ArrowRight");
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(true);
    // ArrowLeft from the first tab wraps to the last.
    pressKey(tabEls[0], "ArrowLeft");
    expect(tabEls[2]?.classList.contains("wt-tab-active")).toBe(true);
    expect(document.activeElement).toBe(tabEls[2]);
  });

  it("Home and End select the boundary tabs", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    const tabEls = [...root.querySelectorAll<HTMLElement>(".wt-tab")];
    pressKey(tabEls[0], "End");
    expect(tabEls[2]?.classList.contains("wt-tab-active")).toBe(true);
    pressKey(tabEls[2], "Home");
    expect(tabEls[0]?.classList.contains("wt-tab-active")).toBe(true);
  });

  it("Delete closes the focused tab", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    fetchMock.mockClear();
    pressKey(root.querySelectorAll<HTMLElement>(".wt-tab")[1], "Delete");
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(wasDeleted("s2")).toBe(true);
  });

  // --- Move left / Move right (WCAG 2.5.7 single-pointer reorder) ---
  it("moves a tab one slot per command, keeping DOM and list order aligned", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const feature = tabs();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    // "Move right" on the first tab moves it exactly one slot.
    menuItem(openTabMenu(root, 0), "Move right")?.click();
    let labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels).toEqual(["two", "one", "three"]);
    // The internal order follows the DOM (positions, switcher, close-to-side).
    expect(feature.api?.list().map((t) => t.id)).toEqual(["s2", "s1", "s3"]);
    // The scroller still holds only tabs after the re-insertion (the "+" is a
    // fixed bar item outside it), so the last child is the last TAB.
    const scroller = root.querySelector(".wt-tab-scroll");
    expect(scroller?.querySelectorAll(":scope > :not(.wt-tab)").length).toBe(0);
    expect(scroller?.lastElementChild?.querySelector(".wt-tab-label")?.textContent).toBe("three");

    // "Move left" on it (now second) restores the original order: one slot back.
    menuItem(openTabMenu(root, 1), "Move left")?.click();
    labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels).toEqual(["one", "two", "three"]);
    expect(feature.api?.list().map((t) => t.id)).toEqual(["s1", "s2", "s3"]);
    // A reorder publishes the shared order (PUT /api/sessions/order) and must
    // still create and close nothing.
    const methods = fetchMock.mock.calls.map((c) => c[1]?.method ?? "GET");
    expect(methods.filter((m) => m === "POST" || m === "DELETE")).toEqual([]);
  });

  it("swallows a tab drop rather than letting the browser act on the payload", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const tabEl = root.querySelector<HTMLElement>(".wt-tab");
    const surface = root.querySelector(".term");
    const dt = fakeDataTransfer();
    tabEl?.dispatchEvent(dragEvent("dragstart", dt));

    // The id rides a PRIVATE type. WebKit loads dropped text/plain as a URL, so a
    // bare session id there navigated iPadOS to /<session-id> mid-reorder.
    expect(dt.data["text/plain"]).toBeUndefined();
    expect(dt.data["application/x-web-terminal-tab"]).toBe("s1");
    // And an EXPLICIT drag image: WebKit renders none of its own for an element
    // under the strip's backdrop-filter (webkit.org/b/22787).
    expect(dt.image?.classList.contains("wt-tab-ghost")).toBe(true);

    // The drop is cancelled on the strip AND anywhere else it may land.
    const onStrip = dragEvent("drop", dt);
    tabEl?.dispatchEvent(onStrip);
    expect(onStrip.defaultPrevented).toBe(true);
    const offStrip = dragEvent("drop", dt);
    surface?.dispatchEvent(offStrip);
    expect(offStrip.defaultPrevented).toBe(true);
    // Order still follows the DOM. A committed drop publishes the shared order,
    // so the only writes are that PUT: nothing was closed or created.
    const dropMethods = fetchMock.mock.calls.map((c) => c[1]?.method ?? "GET");
    expect(dropMethods.filter((m) => m === "POST" || m === "DELETE")).toEqual([]);

    // The document guard lasts only as long as the tab drag: an unrelated drop
    // (a file onto the page) is left entirely to the browser.
    tabEl?.dispatchEvent(dragEvent("dragend", dt));
    const unrelated = dragEvent("drop", dt);
    surface?.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
  });

  it("announces a tab move on the polite live region", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    menuItem(openTabMenu(root, 0), "Move right")?.click();
    // The announcer re-sets the cleared region after a ~100ms timer.
    await new Promise((r) => setTimeout(r, 130));
    const live = root.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Moved one to position 2");
  });

  it("disables 'Close to the right' on the last tab", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    const items = openTabMenu(root, 2);
    expect(menuItem(items, "Close to the right")?.disabled).toBe(true);
    expect(menuItem(items, "Close to the left")?.disabled).toBe(false);
  });

  it("survives the terminal auto-scrolling under it, and closes when the strip scrolls", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const menu = root.querySelector(".wt-tab-menu");
    openTabMenu(root, 0);
    expect(menu?.classList.contains("visible")).toBe(true);

    // A background agent printing into the TUI scrolls the terminal surface to
    // the bottom on every chunk. That scroll moves neither the menu (placed
    // root-relative) nor the chip it is anchored to, so it must not dismiss.
    root.querySelector(".term")?.dispatchEvent(new Event("scroll"));
    expect(menu?.classList.contains("visible")).toBe(true);

    // The strip's own scroller DOES move the anchor chip out from under the menu.
    root.querySelector(".wt-tab-scroll")?.dispatchEvent(new Event("scroll"));
    expect(menu?.classList.contains("visible")).toBe(false);
  });

  it("closes all other tabs from the context menu (Close others)", async () => {
    vi.stubGlobal("confirm", () => true);
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    fetchMock.mockClear();
    // Right-click the middle tab (s2) and choose "Close others".
    menuItem(openTabMenu(root, 1), "Close others")?.click();
    // The closes are async (sequential DELETEs); wait for both to land.
    await until(
      () => fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "DELETE").length === 2,
    );

    expect(wasDeleted("s1")).toBe(true);
    expect(wasDeleted("s3")).toBe(true);
    expect(wasDeleted("s2")).toBe(false);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    // s2 is the survivor and becomes active.
    expect(root.querySelector(".wt-tab-label")?.textContent).toBe("two");
  });

  // Title RESOLUTION now lives entirely in the engine: the input-derived name and
  // its eligibility filter and session-scoped latch are Go code
  // (terminal/inputtitle.go), and the precedence between pinned / derived / OSC /
  // client-pushed / process-inferred is resolved server-side into one `title`
  // field. Seven tests here used to cover the browser's own version of that; the
  // server is the source of truth for a session's name, because a browser can only
  // ever derive from ITS OWN keyboard and so disagreed with every other client.
  //
  // What the UI still owes is rendering what the server resolved — including a
  // name that arrives MID-SESSION, which is exactly what a server-side deriver
  // produces and what no earlier test covered.
  it("renders the title the server resolved, including one that arrives later", async () => {
    const monitor = fakeMonitor();
    listBody = [{ id: "s1", title: "", createdAt: "1", status: "idle" }];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    const labels = (): (string | null)[] =>
      [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels()).toEqual(["New tab"]);

    // The engine latched a name from the input stream and pushed it.
    monitor.emit({
      id: "s1",
      status: "idle",
      title: "refactor the auth module",
      createdAt: "1",
      reportsActivity: false,
    });
    await until(() => labels()[0] === "refactor the auth module");

    // A blank title never overwrites a good one (a program clearing its own OSC
    // title reports ""), so the name holds.
    monitor.emit({
      id: "s1",
      status: "working",
      title: "",
      createdAt: "1",
      reportsActivity: false,
    });
    await until(() => false, 5);
    expect(labels()).toEqual(["refactor the auth module"]);
  });

  it("closes tabs to the right from the context menu", async () => {
    vi.stubGlobal("confirm", () => true);
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    fetchMock.mockClear();
    // Right-click the first tab and choose "Close to the right" (closes s2, s3).
    menuItem(openTabMenu(root, 0), "Close to the right")?.click();
    // The closes are async (sequential DELETEs); wait for both to land.
    await until(
      () => fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "DELETE").length === 2,
    );

    expect(wasDeleted("s2")).toBe(true);
    expect(wasDeleted("s3")).toBe(true);
    expect(wasDeleted("s1")).toBe(false);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
  });

  it("closes every tab and opens a fresh one via 'Close all' (confirmed)", async () => {
    vi.stubGlobal("confirm", () => true);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    fetchMock.mockClear();
    menuItem(openTabMenu(root, 0), "Close all")?.click();
    // Both existing sessions are DELETEd and one fresh session is POSTed.
    await until(
      () =>
        fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "DELETE").length === 2 &&
        fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "POST"),
    );
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
  });

  it("does not close tabs when 'Close all' is cancelled", async () => {
    vi.stubGlobal("confirm", () => false);
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    fetchMock.mockClear();
    menuItem(openTabMenu(root, 0), "Close all")?.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(root.querySelectorAll(".wt-tab").length).toBe(2);
    expect(fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "DELETE")).toBe(false);
  });

  it("labels tabs from the server title and shows 'New tab' for untitled ones", async () => {
    listBody = [
      { id: "s1", title: "kiro: fix bug", createdAt: "1", status: "idle" },
      { id: "s2", title: "", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels[0]).toBe("kiro: fix bug");
    // An untitled session reads "New tab" (no "Tab N" number).
    expect(labels[1]).toBe("New tab");
  });

  it("shows 'New tab' for every untitled tab, with no numeric suffix", async () => {
    listBody = [
      { id: "s1", title: "", createdAt: "1", status: "idle" },
      { id: "s2", title: "", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    // Fallback labels are not de-duplicated, so both stay plain "New tab".
    expect(labels).toEqual(["New tab", "New tab"]);
  });

  it("de-duplicates identical tab titles with a numeric suffix", async () => {
    listBody = [
      { id: "s1", title: "kiro: workspace", createdAt: "1", status: "idle" },
      { id: "s2", title: "kiro: workspace", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const labels = [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels[0]).toBe("kiro: workspace");
    expect(labels[1]).toBe("kiro: workspace (2)");
  });

  it("keeps the suffix with its own session across a reorder", async () => {
    // The number is an IDENTITY, not a rank, so it is keyed on age and never on
    // position. It used to be assigned by encounter order while walking the list,
    // which made it a property of the SLOT: two tabs called the same thing always
    // read "x" then "x (2)" whichever way round they sat, so the label text stayed
    // put while the sessions moved underneath it. A reorder of same-titled tabs was
    // invisible on screen even though it had worked correctly all along, server
    // included -- and dragging one tab renumbered the other, which is the clearest
    // sign the number belonged to the wrong thing.
    //
    // Prioritisation applies to the ORDER (a custom arrangement outranks age,
    // compareTabOrder) and deliberately NOT to the identity: feeding the custom
    // order into the numbering is exactly what made the reorder invisible.
    listBody = [
      { id: "s1", title: "kiro: workspace", createdAt: "1", status: "idle" },
      { id: "s2", title: "kiro: workspace", createdAt: "2", status: "idle" },
    ];
    const feature = tabs();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    const labels = (): (string | null)[] =>
      [...root.querySelectorAll(".wt-tab-label")].map((e) => e.textContent);
    expect(labels()).toEqual(["kiro: workspace", "kiro: workspace (2)"]);

    // Move the younger tab to the front. Its number must travel with it, so the
    // strip now reads "(2)" FIRST -- which is what makes the move visible at all.
    menuItem(openTabMenu(root, 1), "Move left")?.click();

    expect(feature.api?.list().map((t) => t.id)).toEqual(["s2", "s1"]);
    expect(labels()).toEqual(["kiro: workspace (2)", "kiro: workspace"]);
  });

  it("creates one session when the list is empty", async () => {
    listBody = [];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    // POST was used to create the initial session.
    const posted = fetchMock.mock.calls.some((c) => (c[1]?.method ?? "GET") === "POST");
    expect(posted).toBe(true);
  });

  it("renders the mobile bar reflecting the active tab, with a close button and no position counter", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    expect(root.querySelector(".wt-switcher-label")?.textContent).toBe("one");
    // The n/m counter is gone (the list rotates, so an absolute position number
    // is meaningless); the active row instead carries the standard close (x)
    // that every other row has.
    expect(root.querySelector(".wt-switcher-pos")).toBeNull();
    expect(root.querySelector(".wt-switcher-current-close")).toBeTruthy();
    // The mobile "+" is present; the keyboard button stays hidden without a
    // keyboardToggle wired (the separate overview button + count are gone).
    expect(root.querySelector(".wt-switcher-new")).toBeTruthy();
    expect(root.querySelector<HTMLElement>(".wt-switcher-kb")?.hidden).toBe(true);
  });

  it("expands the bar to list the other tabs; a row selects it and collapses", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const switcher = root.querySelector(".wt-switcher");
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(false);

    // Tapping the active surface expands the bar to list the OTHER tabs (s2);
    // the active tab (s1) stays in the bar row, so only one row is listed.
    root.querySelector<HTMLElement>(".wt-switcher-current")?.click();
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(true);
    expect(root.querySelectorAll(".wt-switcher-row").length).toBe(1);

    setSession.mockClear();
    root.querySelector<HTMLElement>(".wt-switcher-row .wt-switcher-row-select")?.click();
    expect(setSession).toHaveBeenCalledWith("s2");
    // Selecting a tab collapses the list.
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(false);
  });

  it("orders the expanded list circularly starting after the active tab", async () => {
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
      { id: "s4", title: "four", createdAt: "4", status: "idle" },
    ];
    const feature = tabs();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 4);

    // Make s2 active, then open the list: it should read as the circular queue
    // that follows s2 -> three, four, one (s1 wraps to the end).
    feature.api?.switchTo("s2");
    root.querySelector<HTMLElement>(".wt-switcher-current")?.click();
    const labels = [...root.querySelectorAll(".wt-switcher-row-label")].map((e) => e.textContent);
    expect(labels).toEqual(["three", "four", "one"]);
  });

  it("keeps the last good title when a later status update reports a blank one", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // The process sets a window title.
    monitor.emit({ id: "s1", status: "working", title: "kiro: building", createdAt: "1" });
    expect(root.querySelectorAll(".wt-tab-label")[0]?.textContent).toBe("kiro: building");

    // A later sweep reports a BLANK title (the process cleared its OSC 0/2
    // title, or an idle-session record has none). It must NOT revert the label
    // to "New tab": the last good title is held until a real one replaces it.
    monitor.emit({ id: "s1", status: "idle", title: "", createdAt: "1" });
    expect(root.querySelectorAll(".wt-tab-label")[0]?.textContent).toBe("kiro: building");

    // A genuine new non-blank title still replaces it.
    monitor.emit({ id: "s1", status: "idle", title: "kiro: tests", createdAt: "1" });
    expect(root.querySelectorAll(".wt-tab-label")[0]?.textContent).toBe("kiro: tests");
  });

  it("closes a tab from an expanded list row (DELETE)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    root.querySelector<HTMLElement>(".wt-switcher-current")?.click(); // expand
    fetchMock.mockClear();
    root.querySelector<HTMLElement>(".wt-switcher-row .wt-switcher-row-close")?.click();
    await until(() => root.querySelectorAll(".wt-tab").length === 1);

    const deleted = fetchMock.mock.calls.some(
      (c) => (c[1]?.method ?? "GET") === "DELETE" && String(c[0]).endsWith("/s2"),
    );
    expect(deleted).toBe(true);
  });

  it("collapses the expanded list on a second tap", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const switcher = root.querySelector(".wt-switcher");
    const current = root.querySelector<HTMLElement>(".wt-switcher-current");
    current?.click(); // expand
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(true);
    current?.click(); // a second tap toggles it closed
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(false);
  });

  it("switches tabs on a horizontal swipe of the switcher bar", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const cur = root.querySelector<HTMLElement>(".wt-switcher-current");
    setSession.mockClear();
    // A leftward drag (dx < 0) advances to the next tab.
    cur?.dispatchEvent(new MouseEvent("pointerdown", { clientX: 220, clientY: 10, bubbles: true }));
    cur?.dispatchEvent(new MouseEvent("pointerup", { clientX: 90, clientY: 14, bubbles: true }));
    expect(setSession).toHaveBeenCalledWith("s2");
  });

  it("shows the switch-button dot for a background needs-input, greens on done (latest-wins)", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // No pending notification on the dedicated switch button initially.
    expect(dot?.dataset["status"]).toBeUndefined();

    // s2 is a background tab (s1 is active) that needs input -> amber cue.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");

    // The same background tab then finishes a turn -> green cue (latest wins:
    // the newer "done" overwrites the earlier "input").
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("done");
  });

  it("clears the switch-button dot when the list opens (click the switch button)", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // A background tab raises the cue.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");

    // Opening the switcher acknowledges it: the dot clears (reset happens only
    // on open, not on close).
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    expect(root.querySelector(".wt-switcher")?.classList.contains("wt-switcher-expanded")).toBe(
      true,
    );
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("clears the switch-button dot when a swipe arrives on the tab that raised it", async () => {
    // Swiping through the tabs must acknowledge the cue on arrival at its
    // subject, not only opening the list (the reported bug: the dot survived a
    // swipe onto the concerned tab).
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // Background s2 needs input -> the cue lights.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");

    // A leftward swipe on the active row advances to s2 (the raising tab): the
    // cue is resolved by arriving there.
    const cur = root.querySelector<HTMLElement>(".wt-switcher-current");
    cur?.dispatchEvent(new MouseEvent("pointerdown", { clientX: 220, clientY: 10, bubbles: true }));
    cur?.dispatchEvent(new MouseEvent("pointerup", { clientX: 90, clientY: 14, bubbles: true }));
    expect(setSession).toHaveBeenCalledWith("s2");
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("keeps the switch-button dot when switching to a tab other than the raiser", async () => {
    const monitor = fakeMonitor();
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    const feature = tabs({ activityMonitor: monitor.feature });
    term = createTerminal(root, { features: () => [monitor.feature, feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // Background s3 raised the cue; visiting s2 does NOT resolve it.
    monitor.emit({ id: "s3", status: "done", title: "three", createdAt: "3" });
    expect(dot?.dataset["status"]).toBe("done");
    feature.api?.switchTo("s2");
    expect(dot?.dataset["status"]).toBe("done");
    // Arriving on s3 does.
    feature.api?.switchTo("s3");
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("does not re-raise the switch-button dot for a cue already dismissed (reload)", async () => {
    // The reported bug: dismissing the dot, then reloading, brought it back.
    // "input"/"done" are LATCHED server-side (cleared only by the session's next
    // working phase) and the status stream re-pushes the latch in the snapshot it
    // sends on every open, so the fresh page re-raised a cue the user had already
    // resolved. A dismissal is therefore remembered in localStorage — this
    // simulates the reload by pre-seeding what the previous page wrote.
    localStorage.setItem(CUE_SEEN_KEY, JSON.stringify({ s2: "done" }));
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // The re-delivered latch for s2 raises nothing: this viewer saw it already.
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBeUndefined();
    // A DIFFERENT latch on the same session is a new event and still notifies.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");
  });

  it("persists the dismissal of every listed tab when the switcher opens", async () => {
    // The tray shows each tab's own dot, so opening it acknowledges all of them,
    // not just the cue's latest subject: several tabs can hold a latch at once
    // while the dot only ever shows the newest, and an unacknowledged sibling
    // would re-raise it on the next load.
    const monitor = fakeMonitor();
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 3);

    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    monitor.emit({ id: "s3", status: "done", title: "three", createdAt: "3" });
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();

    expect(JSON.parse(localStorage.getItem(CUE_SEEN_KEY) ?? "{}")).toEqual({
      s2: "input",
      s3: "done",
    });
  });

  it("persists the dismissal when a switch arrives on the raising tab", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const feature = tabs({ activityMonitor: monitor.feature });
    term = createTerminal(root, { features: () => [monitor.feature, feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
    feature.api?.switchTo("s2");
    expect(JSON.parse(localStorage.getItem(CUE_SEEN_KEY) ?? "{}")).toEqual({ s2: "done" });
  });

  it("does not notify about a latch that happened on the tab in front of the user", async () => {
    // A turn finishing on the ACTIVE tab raises no cue (the user is watching it),
    // so moving away and reloading must not invent one either.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // s1 is the active tab.
    monitor.emit({ id: "s1", status: "done", title: "one", createdAt: "1" });
    expect(root.querySelector<HTMLElement>(".wt-switcher-switch-dot")?.dataset["status"]).toBe(
      undefined,
    );
    expect(JSON.parse(localStorage.getItem(CUE_SEEN_KEY) ?? "{}")).toEqual({ s1: "done" });
  });

  it("forgets the dismissal once the session's status moves on", async () => {
    // The acknowledgement is on the (session, latch) pair: a new working phase
    // clears the latch server-side, so the NEXT done is a fresh cue rather than a
    // re-delivery of the dismissed one.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    expect(dot?.dataset["status"]).toBeUndefined();

    monitor.emit({ id: "s2", status: "working", title: "two", createdAt: "2" });
    expect(localStorage.getItem(CUE_SEEN_KEY)).toBe("{}");
    monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("done");
  });

  it("drops a closed session's dismissal instead of leaving it in storage", async () => {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    expect(localStorage.getItem(CUE_SEEN_KEY)).toContain("s2");

    root
      .querySelectorAll<HTMLElement>(".wt-tab")[1]
      ?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(localStorage.getItem(CUE_SEEN_KEY)).toBe("{}");
  });

  it("clears the switch-button dot when the tab that raised it is closed", async () => {
    // A cue whose subject is gone can never be resolved by visiting it; a close
    // must clear it rather than leave a permanently lit dot.
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(dot?.dataset["status"]).toBe("input");

    // Middle-click closes s2 (a background close from the desktop strip).
    root
      .querySelectorAll<HTMLElement>(".wt-tab")[1]
      ?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(dot?.dataset["status"]).toBeUndefined();
  });

  it("toggles the switcher list closed when the switch button is clicked while open", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const switcher = root.querySelector(".wt-switcher");
    const btn = root.querySelector<HTMLElement>(".wt-switcher-switch");
    // The switch button sits between the keyboard and "+" buttons in the bar.
    const bar = root.querySelector(".wt-switcher-bar");
    expect(bar?.contains(btn ?? null)).toBe(true);
    expect(btn?.previousElementSibling?.classList.contains("wt-switcher-kb")).toBe(true);
    expect(btn?.nextElementSibling?.classList.contains("wt-switcher-new")).toBe(true);

    // First click opens the list.
    btn?.click();
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(true);
    // A second click (while open) closes it (toggle).
    btn?.click();
    expect(switcher?.classList.contains("wt-switcher-expanded")).toBe(false);
  });

  it("arms the catching-up cue when a switch lands on a tab with nothing cached", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const cue = root.querySelector(".wt-catchup");
    // Not shown on initial load (no switch), nor immediately on switch.
    expect(cue?.classList.contains("visible")).toBe(false);
    root.querySelectorAll<HTMLElement>(".wt-tab")[1]?.click();
    expect(cue?.classList.contains("visible")).toBe(false);
    // Shown once the short grace elapses: the incoming tab holds nothing, so its
    // whole screen is still coming over the network (the mocked connection sends
    // no frames, so it stays up until the poll's deadline).
    await new Promise((r) => setTimeout(r, 180));
    expect(cue?.classList.contains("visible")).toBe(true);
  });

  it("polls the session list to update dots and drop reaped tabs without activityMonitor", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs({ pollMs: 10 })] });
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

  it("carries a desktop-strip keyboard button, hidden without a keyboardToggle", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // The desktop strip carries its own keyboard button (like the switcher's):
    // the bar's LAST flex item, OUTSIDE the scrolling tab list, so it is pinned
    // at the bar's right edge (the scroll-to-bottom button's column) and an
    // overflowing tab list can never push or scroll it away. It stays hidden
    // until a keyboardToggle feature is wired, and never counts as a tab.
    const deskKb = root.querySelector<HTMLElement>(".wt-tab-kb");
    const bar = root.querySelector(".wt-tab-bar");
    expect(deskKb).toBeTruthy();
    expect(deskKb?.hidden).toBe(true);
    expect(bar?.contains(deskKb ?? null)).toBe(true);
    expect(bar?.lastElementChild).toBe(deskKb);
    expect(root.querySelector(".wt-tab-scroll")?.contains(deskKb)).toBe(false);
    // Bar order [scroller | + | kb]: the kb button anchors to the right of the
    // fixed "+" (both outside the scroller).
    expect(deskKb?.previousElementSibling?.classList.contains("wt-tab-new")).toBe(true);
  });

  it("maps a vertical wheel over the bar to horizontal tab-list scrolling", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const scroller = root.querySelector<HTMLElement>(".wt-tab-scroll");
    if (!bar || !scroller) {
      throw new Error("missing tab bar chrome");
    }

    // Not overflowing (happy-dom reports scrollWidth = clientWidth = 0): the
    // wheel falls through untouched so the page keeps it.
    const inert = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    bar.dispatchEvent(inert);
    expect(inert.defaultPrevented).toBe(false);
    expect(scroller.scrollLeft).toBe(0);

    // Overflowing: a vertical wheel translates to scrollLeft and claims the
    // event; a horizontal-dominant delta (trackpad pan) keeps native handling.
    Object.defineProperty(scroller, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 200, configurable: true });
    const vertical = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    bar.dispatchEvent(vertical);
    expect(vertical.defaultPrevented).toBe(true);
    expect(scroller.scrollLeft).toBe(120);

    const lines = new WheelEvent("wheel", {
      deltaY: 3,
      deltaMode: 1, // DOM_DELTA_LINE (Firefox wheel): fixed per-line step
      bubbles: true,
      cancelable: true,
    });
    bar.dispatchEvent(lines);
    expect(scroller.scrollLeft).toBe(120 + 3 * 32);

    const pan = new WheelEvent("wheel", {
      deltaX: 80,
      deltaY: 10,
      bubbles: true,
      cancelable: true,
    });
    bar.dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(false);
    expect(scroller.scrollLeft).toBe(120 + 3 * 32);
  });

  it("closes the key grid on a second tap of the desktop keyboard button", async () => {
    const kbt = fakeKeyboardToggle();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [kbt.feature, tabs({ keyboardToggle: kbt.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const deskKb = root.querySelector<HTMLElement>(".wt-tab-kb");
    deskKb?.click();
    expect(kbt.isOpen()).toBe(true);

    // A real tap delivers pointerup (bubbling to the document's capture-phase
    // tap-dismiss handler) BEFORE the click. The handler used to treat the tab
    // strip as "outside" chrome: it closed the grid on the pointerup and the
    // button's click then re-opened it — so a second tap never closed the grid
    // (the landscape-phone / iPad bug). The strip now counts as chrome.
    deskKb?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    deskKb?.click();
    expect(kbt.isOpen()).toBe(false);
  });

  it("wires the desktop + mobile keyboard buttons to the one shared grid toggle", async () => {
    const kbt = fakeKeyboardToggle();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [kbt.feature, tabs({ keyboardToggle: kbt.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    const deskKb = root.querySelector<HTMLElement>(".wt-tab-kb");
    const mobKb = root.querySelector<HTMLElement>(".wt-switcher-kb");
    // Both keyboard buttons come from the one factory and are un-hidden once a
    // keyboardToggle is wired (CSS then gates the desktop one to a wide
    // touchscreen and the mobile one to the switcher).
    expect(deskKb?.hidden).toBe(false);
    expect(mobKb?.hidden).toBe(false);

    // Clicking the desktop keyboard button toggles the SAME grid and reflects
    // the open state on BOTH buttons (one wiring, placed per layout).
    deskKb?.click();
    expect(kbt.isOpen()).toBe(true);
    expect(deskKb?.getAttribute("aria-expanded")).toBe("true");
    expect(mobKb?.getAttribute("aria-expanded")).toBe("true");
    expect(deskKb?.classList.contains("wt-active")).toBe(true);
    expect(mobKb?.classList.contains("wt-active")).toBe(true);
  });

  // --- Tab arrangement and hostile storage ---
  //
  // The arrangement itself is the SERVER's since engine 3.10.0: a reorder is
  // published with PUT /api/sessions/order and read back as SessionInfo.order,
  // so every viewer of one server shares it and it outlives a reload without the
  // client storing anything. The localStorage arrangement this section used to
  // pin is gone with it. What remains worth pinning is that the strip still
  // works when Storage itself is hostile, which the active-tab and cue-seen
  // writes still touch.

  it("survives storage that throws (Safari private mode) without losing the reorder", async () => {
    const boom = (): never => {
      throw new Error("storage disabled");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    listBody = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    menuItem(openTabMenu(root, 1), "Move left")?.click();
    // The reorder still applies: it is published to the server, not stored here.
    expect(idsOf(root)).toEqual(["two", "one"]);
  });
});

describe("tabs feature: a host that temporarily refuses session creation (503)", () => {
  // web-terminal-kiro holds session creation with 503 + Retry-After while its
  // tool engine installs the manifest's tools on first boot, a window its own
  // HEALTHCHECK budgets 20 minutes for. That used to surface as the same fixed
  // "Couldn't open a terminal" toast as a 500, with no retry: an empty tab bar
  // and a page that read as broken while the server was deliberately waiting
  // (and /api/health reported healthy at the same time).
  it("retries on the server's own hint and opens the terminal once it is ready", async () => {
    listBody = []; // nothing live, so the bootstrap must create
    let posts = 0;
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        posts++;
        // Refuse twice with a 0s hint (keeps the test fast; the parse itself is
        // covered in model.test.ts), then succeed.
        if (posts <= 2) {
          return Promise.resolve(
            jsonResponse({ error: "tools installing" }, 503, { "Retry-After": "0" }),
          );
        }
        return Promise.resolve(
          jsonResponse({ id: "s-new", title: "", createdAt: "3", status: "idle" }, 201),
        );
      }
      return Promise.resolve(jsonResponse(listBody, 200));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });

    await until(() => root.querySelectorAll(".wt-tab").length === 1, 200);
    expect(posts).toBe(3);
    expect(setSession).toHaveBeenCalledWith("s-new");
  });

  it("repeats the server's explanation rather than inventing library wording", async () => {
    listBody = [];
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          jsonResponse({ error: "tools installing" }, 503, { "Retry-After": "0" }),
        );
      }
      return Promise.resolve(jsonResponse(listBody, 200));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });

    // The host's own words reach the page; the library never hardcodes "tools",
    // which is a web-terminal-kiro concept it knows nothing about.
    await until(() => root.textContent?.includes("tools installing") === true, 200);
    expect(root.textContent).toContain("tools installing");
  });

  it("does NOT retry a 500: that is not 'come back shortly'", async () => {
    listBody = [];
    let posts = 0;
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        posts++;
        return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      }
      return Promise.resolve(jsonResponse(listBody, 200));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });

    await until(() => posts > 0, 200);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toBe(1);
  });
});

describe("tabs feature: stream-open reconcile (manager-restart zombie tabs)", () => {
  it("drops tabs the server no longer lists when the status stream (re)opens", async () => {
    // A manager restart kills every session; the replacement server's SSE
    // snapshot carries no tombstones for sessions it never knew, so the only
    // signal is the stream REOPEN. tabs must reconcile against
    // GET /api/sessions there and drop the zombies (no DELETE — they are
    // already gone) instead of leaving them spinning "Reconnecting…".
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);

    // Restart: s1 died with the old manager; the new one lists only s2
    // (recreated elsewhere). The reopen triggers the one-shot reconcile.
    listBody = [{ id: "s2", title: "two", createdAt: "2", status: "idle" }];
    fetchMock.mockClear();
    monitor.open();

    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    // The zombie was dropped locally, never DELETEd (it is already gone).
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(false);
    // The reconcile listed sessions exactly once for this open.
    const gets = fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "GET");
    expect(gets.length).toBe(1);
  });
});

describe("tabs feature: boot race (stream-open reconcile vs bootstrap create)", () => {
  it("spares a tab adopted while the reconcile's list was in flight (no double create)", async () => {
    // The real boot interleaving (the double-create bug): the SSE stream opens
    // while the bootstrap's create POST is in flight, so the stream-open
    // reconcile's GET /api/sessions is answered from a snapshot taken BEFORE
    // the create committed (an empty list). That stale listing is not
    // authoritative for the tab the bootstrap adopts meanwhile: dropping it
    // cascaded into dropTab's last-tab intercept spawning a replacement — a
    // second POST, an orphaned server session, and an aborted first WS.
    const monitor = fakeMonitor();
    const stale: { resolve: (() => void) | null } = { resolve: null };
    let posts = 0;
    let gets = 0;
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        posts++;
        if (posts === 1) {
          // The stream opens exactly while the create is in flight: the
          // reconcile snapshots its epoch NOW (no tabs adopted yet) and its
          // GET hangs until after the bootstrap adopted the created session.
          monitor.open();
        }
        return Promise.resolve(
          jsonResponse({ id: `s-new-${posts}`, title: "", createdAt: "3", status: "idle" }, 201),
        );
      }
      if (method === "DELETE") {
        return Promise.resolve(jsonResponse(null, 204));
      }
      gets++;
      if (gets === 1) {
        // The bootstrap's own list: empty server, so it proceeds to create.
        return Promise.resolve(jsonResponse([], 200));
      }
      // The reconcile's list: deferred, resolved by the test AFTER the
      // bootstrap adopted its tab, with the stale pre-create body.
      return new Promise<Response>((res) => {
        stale.resolve = () => {
          res(jsonResponse([], 200));
        };
      });
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });

    // Bootstrap created + adopted its session while the reconcile's GET hangs.
    await until(() => root.querySelectorAll(".wt-tab").length === 1);
    await until(() => stale.resolve !== null);
    expect(stale.resolve).not.toBeNull();
    stale.resolve?.();
    // Let the reconcile finish; the adopted tab must survive its stale listing.
    await until(() => posts > 1, 5); // settles (no second create expected)

    expect(root.querySelectorAll(".wt-tab").length).toBe(1);
    expect(posts).toBe(1); // no duplicate replacement session
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(false);
  });
});

// OSC 9 chrome: the progress states, the percentage's two display modes, the
// notification, the aggregate cue's allowed set, and the accessible name.
// Driven through the real feature over happy-dom, so what is asserted is the DOM
// a browser would paint.
describe("tabs OSC 9 status chrome", () => {
  /** Build a terminal with a fake status monitor and wait for both tabs. */
  async function withMonitor(
    opts: Parameters<typeof tabs>[0] = {},
  ): Promise<{ root: HTMLElement; monitor: ReturnType<typeof fakeMonitor> }> {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ ...opts, activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    return { root, monitor };
  }
  const tabDot = (root: HTMLElement, i: number): HTMLElement | null =>
    root.querySelectorAll<HTMLElement>(".wt-tab .wt-tab-dot")[i] ?? null;
  const tabLabel = (root: HTMLElement, i: number): HTMLElement | null =>
    root.querySelectorAll<HTMLElement>(".wt-tab .wt-tab-label")[i] ?? null;
  const tabBar = (root: HTMLElement, i: number): HTMLElement | null =>
    root.querySelectorAll<HTMLElement>(".wt-tab .wt-progress-bar")[i] ?? null;

  it("paints every new status onto the dot, tooltip included", async () => {
    const { root, monitor } = await withMonitor();
    for (const [status, phrase] of [
      ["working", "working"],
      ["warning", "warning reported"],
      ["failed", "error reported"],
      ["crashed", "process crashed"],
      ["done", "turn finished"],
      ["input", "waiting for you"],
      ["exited", "session ended"],
      ["idle", "idle"],
    ] as const) {
      monitor.emit({ id: "s1", status, title: "one", createdAt: "1" });
      expect(tabDot(root, 0)?.dataset["status"], status).toBe(status);
      // The dots are aria-hidden decoration, so a hover tooltip is how a sighted
      // user reads an eight-state colour vocabulary they never memorised.
      expect(tabDot(root, 0)?.title, status).toBe(phrase);
    }
  });

  it("reveals warning, failed and crashed dots even with no reportsActivity flag", async () => {
    const { root, monitor } = await withMonitor();
    // None of these events carries reportsActivity: the reveal gate is floored by
    // the status itself, or a plain shell that crashed would show nothing at all.
    for (const status of ["warning", "failed", "crashed"] as const) {
      monitor.emit({ id: "s1", status, title: "one", createdAt: "1" });
      expect(tabDot(root, 0)?.classList.contains("wt-reports"), status).toBe(true);
    }
    // A clean exit stays gated (not news), as does plain idle.
    for (const status of ["exited", "idle"] as const) {
      monitor.emit({ id: "s1", status, title: "one", createdAt: "1" });
      expect(tabDot(root, 0)?.classList.contains("wt-reports"), status).toBe(false);
    }
  });

  it("renders a percentage as a determinate bar, and never as visible text", async () => {
    const { root, monitor } = await withMonitor();
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1", progressValue: 78 });

    // The label stays the plain name. No terminal emulator puts a number next to
    // a tab label, and a chip that shrinks toward a 100px floor cannot spare the
    // width; the bar is the affordance, and the accessible name carries the value
    // for a reader who cannot see it.
    expect(tabLabel(root, 0)?.textContent).toBe("one");
    const bar = tabBar(root, 0);
    expect(bar?.hidden).toBe(false);
    expect(bar?.style.width).toBe("78%");
    // Every chip site renders it from the one stored value: the mobile active row
    // carries its own bar and the same unprefixed label.
    expect(root.querySelector<HTMLElement>(".wt-switcher-label")?.textContent).toBe("one");
    const swBar = root.querySelector<HTMLElement>(".wt-switcher-current .wt-progress-bar");
    expect(swBar?.hidden).toBe(false);
    expect(swBar?.style.width).toBe("78%");
  });

  it("renders NO bar when the percentage is absent (-1), not a zero-width one", async () => {
    const { root, monitor } = await withMonitor();
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1", progressValue: 60 });
    expect(tabBar(root, 0)?.hidden).toBe(false);

    // The spec's own clear (OSC 9;4;0 / the abbreviated form) arrives as -1.
    monitor.emit({ id: "s1", status: "idle", title: "one", createdAt: "1", progressValue: -1 });
    const bar = tabBar(root, 0);
    expect(bar?.hidden).toBe(true);
    expect(bar?.style.width).toBe("");
    expect(tabLabel(root, 0)?.textContent).toBe("one");
  });

  it("keeps 0% visible as a real bar (0 is not absence)", async () => {
    const { root, monitor } = await withMonitor();
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1", progressValue: 0 });
    expect(tabBar(root, 0)?.hidden).toBe(false);
    expect(tabBar(root, 0)?.style.width).toBe("0%");
  });

  it("keeps 100% until the program clears it: no completion signal, no timeout", async () => {
    // 100% is not a completion signal: state 1 at 100 is a STATE that persists,
    // and the progress channel carries no "done" of its own (our done is a
    // classified notification on a separate channel). So a program that pins 100
    // and goes quiet keeps its bar — asserting otherwise would report a state
    // change the program never made.
    const { root, monitor } = await withMonitor();
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1", progressValue: 100 });
    expect(tabBar(root, 0)?.style.width).toBe("100%");

    // And NO timer clears it: five minutes of wall clock with the page left
    // alone. A timeout would assert a state change the program never made.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    } finally {
      vi.useRealTimers();
    }
    expect(tabBar(root, 0)?.hidden).toBe(false);
    expect(tabBar(root, 0)?.style.width).toBe("100%");
  });

  it("hides the bar under a status the progress channel does not own", async () => {
    // A latch is the NOTIFICATION channel talking, so a percentage retained from
    // the progress channel must not be painted underneath it. Measured against
    // kiro-cli, which parks progress state 4 at its context-window usage once
    // idle: a finished turn painted a green done dot beside a 72% bar, and a
    // pending approval a full one, neither of which was how far along anything
    // was. The engine is right to keep sending the value (a progress state
    // persists); this is the consumer deciding it is not the current word.
    for (const status of ["done", "input", "idle"] as const) {
      const { root, monitor } = await withMonitor();
      monitor.emit({
        id: "s1",
        status: "working",
        title: "one",
        createdAt: "1",
        progressValue: 72,
      });
      expect(tabBar(root, 0)?.hidden, `working precondition for ${status}`).toBe(false);

      monitor.emit({ id: "s1", status, title: "one", createdAt: "1", progressValue: 72 });
      expect(tabBar(root, 0)?.hidden, status).toBe(true);
      expect(tabLabel(root, 0)?.textContent, status).toBe("one");
      // The value is not forgotten, only unshown: the program's own progress
      // states paint it again without needing a fresh report.
      monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1" });
      expect(tabBar(root, 0)?.style.width, status).toBe("72%");
    }
  });

  it("keeps the bar under the three statuses the progress channel does own", async () => {
    for (const status of ["working", "warning", "failed"] as const) {
      const { root, monitor } = await withMonitor();
      monitor.emit({ id: "s1", status, title: "one", createdAt: "1", progressValue: 40 });
      expect(tabBar(root, 0)?.hidden, status).toBe(false);
      expect(tabBar(root, 0)?.style.width, status).toBe("40%");
    }
  });

  it("clears the bar and the prefix when the process ends (the second clear)", async () => {
    // The only clear the UI applies itself: a dead process's progress is
    // meaningless, and nothing will ever arrive to clear it. Both ends count.
    for (const ended of ["exited", "crashed"] as const) {
      const { root, monitor } = await withMonitor();
      monitor.emit({
        id: "s1",
        status: "working",
        title: "one",
        createdAt: "1",
        progressValue: 70,
      });
      expect(tabBar(root, 0)?.hidden).toBe(false);

      // The server keeps reporting the last percentage after the exit (the
      // engine's screen still holds it); the UI drops it anyway.
      monitor.emit({ id: "s1", status: ended, title: "one", createdAt: "1", progressValue: 70 });
      expect(tabBar(root, 0)?.hidden, ended).toBe(true);
      expect(tabLabel(root, 0)?.textContent, ended).toBe("one");

      term?.destroy();
      term = undefined;
      root.remove();
    }
  });

  it("does not clear a live percentage when a status source omits the field", async () => {
    // The polling fallback lists SessionInfo, which has no percentage at all.
    // Absence there means "no information", never "cleared".
    const { root, monitor } = await withMonitor();
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1", progressValue: 45 });
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1" });
    expect(tabBar(root, 0)?.style.width).toBe("45%");
  });

  it("never writes the percentage into the browser document title", async () => {
    // Deliberate product decision, not an oversight: a page has ONE title while
    // this UI multiplexes many sessions, so whose percentage it would show is
    // arbitrary — and the title doubles as the browser-tab label and the
    // bookmark name. The per-chip bar carries the same information without
    // the conflict. This test is the guard against re-adding it.
    document.title = "Host page";
    const { root, monitor } = await withMonitor();

    // The active tab's percentage renders on its own chip...
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1", progressValue: 40 });
    expect(tabBar(root, 0)?.style.width).toBe("40%");
    // ...and a background tab's too, but neither reaches the page title.
    monitor.emit({ id: "s2", status: "working", title: "two", createdAt: "2", progressValue: 90 });
    expect(document.title).toBe("Host page");

    // Including across a destroy, which must leave no trace either way.
    term?.destroy();
    term = undefined;
    expect(document.title).toBe("Host page");
  });

  it("composes the unseen-cue count onto the document title, and cleans it up", async () => {
    // The COUNT is what the title carries, and it is a different proposal from the
    // percentage above rather than a softening of it: a count names no session, so
    // it needs no arbitrary choice among them.
    //
    // This is also the only test of the kernel's title composition. The kernel owns
    // document.title precisely so a program's OSC 0/2 window title cannot erase a
    // feature's prefix, and nothing else asserts that: attention.test.ts checks the
    // sink is CALLED with the right string, which passes just as well if the kernel
    // appends the prefix after the base, ignores it, or drops it on destroy.
    document.title = "Host page";
    const { root, monitor } = await withMonitor();
    expect(document.title).toBe("Host page");

    // A background tab wanting the user puts the count FIRST, where a truncating
    // tab strip still shows it.
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(document.title).toBe("(1) Host page");

    // Acknowledging the cue drops the prefix and leaves the base alone. (The
    // prefix surviving a program's OSC 0/2 title is the other half of the kernel's
    // composition contract; it needs a wire frame, so it is asserted in
    // kernel.test.ts where the connection callbacks are reachable.)
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click();
    expect(document.title).toBe("Host page");

    // And a destroy with a cue still raised must not strand the count on a page
    // the user comes back to.
    monitor.emit({ id: "s2", status: "crashed", title: "two", createdAt: "2" });
    expect(document.title).toBe("(1) Host page");
    term?.destroy();
    term = undefined;
    expect(document.title).toBe("Host page");
  });

  it("raises the attention surfaces for the ACTIVE tab when the page is hidden", async () => {
    // The single-session case, and the one the out-of-page surfaces exist for: with
    // one tab that tab is necessarily the active one, so an acknowledgement keyed on
    // "is this the active tab" alone swallowed the cue of the very session the user
    // left running. notify.ts states the same rule for notifications; these surfaces
    // now read it too.
    document.title = "Host page";
    const { root, monitor } = await withMonitor();

    // Visible + active: nothing to tell anyone, exactly as before.
    monitor.emit({ id: "s1", status: "done", title: "one", createdAt: "1" });
    expect(document.title).toBe("Host page");

    // Hidden + active: the user cannot see the terminal, so it raises.
    setVisibility("hidden");
    monitor.emit({ id: "s1", status: "input", title: "one", createdAt: "1" });
    expect(document.title).toBe("(1) Host page");

    // Coming back acknowledges it, because now they ARE looking at it. Deferred
    // rather than dropped: this is the same acknowledgement, at the moment it
    // becomes true.
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("Host page");

    // ...and only for the ACTIVE tab. A background tab's cue must survive a return
    // to a DIFFERENT tab, or the viewer loses the thing it came back for.
    setVisibility("hidden");
    monitor.emit({ id: "s2", status: "crashed", title: "two", createdAt: "2" });
    expect(document.title).toBe("(1) Host page");
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("(1) Host page");
    void root;
  });

  it("hands the page's own icon and title back when the page goes away", async () => {
    // A browser remembers ONE icon per URL and renders it for the bookmark, the
    // history row and the new-tab tile, so a tab closed on a lit cue would leave a
    // status variant standing in for the app until the page is next loaded.
    document.title = "Host page";
    document.head.insertAdjacentHTML("beforeend", '<link rel="icon" href="/favicon.svg">');
    const iconHref = (): string | null =>
      document.querySelector('link[rel~="icon"]')?.getAttribute("href") ?? null;
    try {
      const { root, monitor } = await withMonitor({ attentionIcons: true });
      monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
      expect(document.title).toBe("(1) Host page");
      expect(iconHref()).toBe("/favicon-input.svg");

      window.dispatchEvent(new Event("pagehide"));
      expect(document.title).toBe("Host page");
      expect(iconHref()).toBe("/favicon.svg");

      // A bfcache entry fires the same event and that page comes BACK, so the
      // fold has to re-run rather than be trusted: the sinks are change-gated on
      // the last applied value, so nothing else would repaint the cue.
      const restored = new Event("pageshow");
      Object.defineProperty(restored, "persisted", { value: true });
      window.dispatchEvent(restored);
      expect(document.title).toBe("(1) Host page");
      expect(iconHref()).toBe("/favicon-input.svg");
      void root;
    } finally {
      document.querySelector('link[rel~="icon"]')?.remove();
    }
  });

  it("KEEPS the cue when the browser merely freezes a background tab", async () => {
    // The case the restore must not reach. A frozen tab is still in the strip
    // rendering its icon and its title, so `freeze` is not a proxy for the page
    // going away and restoring there would blank the cue in exactly the case the
    // cue exists for. (The kernel listens to `freeze` for its own scrollback
    // write; that is a different question with a different answer.)
    document.title = "Host page";
    const { root, monitor } = await withMonitor();
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    expect(document.title).toBe("(1) Host page");

    document.dispatchEvent(new Event("freeze"));

    expect(document.title).toBe("(1) Host page");
    void root;
  });

  it("raises the switcher's aggregate cue for exactly input, done, crashed and failed", async () => {
    const { root, monitor } = await withMonitor();
    const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");
    // s2 is a BACKGROUND tab (s1 is active), which is what the aggregate is for.
    for (const status of ["input", "done", "crashed", "failed"] as const) {
      monitor.emit({ id: "s2", status, title: "two", createdAt: "2" });
      expect(dot?.dataset["status"], status).toBe(status);
      // Same wording map as the per-tab dots, so the aggregate cue explains
      // itself on hover instead of being an unexplained coloured dot.
      expect(dot?.title, status).toBe(
        {
          input: "waiting for you",
          done: "turn finished",
          crashed: "process crashed",
          failed: "error reported",
        }[status],
      );
      // Reset via the tab's own acknowledgement path (a working phase drops it).
      monitor.emit({ id: "s2", status: "working", title: "two", createdAt: "2" });
    }
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click(); // clear the cue
    root.querySelector<HTMLElement>(".wt-switcher-switch")?.click(); // collapse again
    expect(dot?.dataset["status"]).toBeUndefined();

    // The other four states never raise it: working/warning are ongoing and
    // informational (an animated dot pinned to the button would nag with nothing
    // to act on), and idle/exited ask nothing of anyone.
    for (const status of ["working", "warning", "idle", "exited"] as const) {
      monitor.emit({ id: "s2", status, title: "two", createdAt: "2" });
      expect(dot?.dataset["status"], status).toBeUndefined();
    }
  });

  it("carries the session state in each tab's accessible name, agreeing with the tooltip", async () => {
    const { root, monitor } = await withMonitor();
    const chip = root.querySelectorAll<HTMLElement>(".wt-tab")[0];
    monitor.emit({ id: "s1", status: "crashed", title: "one", createdAt: "1" });
    expect(chip?.getAttribute("aria-label")).toBe("one — process crashed");

    // The percentage rides along in the ANNOUNCED name only. It is the one place
    // it appears as text: a screen reader cannot see the 2px bar, and the visible
    // label must not spend chip width on it.
    monitor.emit({ id: "s1", status: "working", title: "one", createdAt: "1", progressValue: 30 });
    expect(chip?.getAttribute("aria-label")).toBe("one — working, 30%");
    expect(tabLabel(root, 0)?.textContent).toBe("one");

    // A percentage the tab is not SHOWING is not announced either: the announced
    // name follows the same statusOwnsProgress rule the bar does.
    monitor.emit({ id: "s1", status: "done", title: "one", createdAt: "1", progressValue: 30 });
    expect(chip?.getAttribute("aria-label")).toBe("one — turn finished");

    // Both halves come from ONE wording map, so hover text and announced text
    // cannot drift apart. Asserted for every state, in both directions.
    for (const status of [
      "idle",
      "working",
      "warning",
      "failed",
      "input",
      "done",
      "exited",
      "crashed",
    ] as const) {
      monitor.emit({ id: "s1", status, title: "one", createdAt: "1", progressValue: -1 });
      const phrase = tabDot(root, 0)?.title;
      expect(phrase, status).toBeTruthy();
      expect(chip?.getAttribute("aria-label"), status).toBe(`one — ${String(phrase)}`);
    }
  });
});

// The OSC 9 Form B notification, wired through the real feature. The policy
// itself is unit-tested in notify.test.ts; these pin that the feature feeds it
// the right session/visibility view and the right gesture.
describe("tabs OSC 9 notifications", () => {
  /** A stubbed browser Notification API: records constructions, and lets a test
   *  choose the permission state and observe a permission request. */
  function stubNotification(permission: string): {
    posts: { title: string; body: string | undefined }[];
    requestPermission: ReturnType<typeof vi.fn>;
  } {
    const posts: { title: string; body: string | undefined }[] = [];
    const requestPermission = vi.fn();
    class FakeNotification {
      static permission = permission;
      static requestPermission = requestPermission;
      constructor(title: string, options?: { body?: string }) {
        posts.push({ title, body: options?.body });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    return { posts, requestPermission };
  }
  afterEach(() => {
    setVisibility("visible");
  });

  async function boot(): Promise<{ root: HTMLElement; monitor: ReturnType<typeof fakeMonitor> }> {
    const monitor = fakeMonitor();
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, {
      features: () => [monitor.feature, tabs({ activityMonitor: monitor.feature })],
    });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    return { root, monitor };
  }

  it("posts a background session's notification", async () => {
    const { posts } = stubNotification("granted");
    const { monitor } = await boot();
    monitor.emit({
      id: "s2", // s1 is active
      status: "done",
      title: "two",
      createdAt: "2",
      notification: "Response complete",
      notificationSeq: 1,
    });
    expect(posts).toEqual([{ title: "two", body: "Response complete" }]);
  });

  it("suppresses the ACTIVE session's notification while the page is visible", async () => {
    const { posts } = stubNotification("granted");
    setVisibility("visible");
    const { monitor } = await boot();
    monitor.emit({
      id: "s1", // the active tab, on screen
      status: "done",
      title: "one",
      createdAt: "1",
      notification: "Response complete",
      notificationSeq: 1,
    });
    expect(posts).toEqual([]);
  });

  it("posts the ACTIVE session's notification when the page is HIDDEN", async () => {
    // The direction most likely to regress: a backgrounded browser tab or a
    // locked phone is exactly when the user cannot see the terminal.
    const { posts } = stubNotification("granted");
    const { monitor } = await boot();
    setVisibility("hidden");
    monitor.emit({
      id: "s1",
      status: "done",
      title: "one",
      createdAt: "1",
      notification: "Response complete",
      notificationSeq: 1,
    });
    expect(posts).toEqual([{ title: "one", body: "Response complete" }]);
  });

  it("passes untrusted notification text as data, never into the DOM", async () => {
    const { posts } = stubNotification("granted");
    const { root, monitor } = await boot();
    const hostile = `<img src=x onerror="globalThis.__pwned2 = true">`;
    monitor.emit({
      id: "s2",
      status: "done",
      title: "two",
      createdAt: "2",
      notification: hostile,
      notificationSeq: 1,
    });
    expect(posts[0]?.body).toBe(hostile);
    expect(root.querySelector("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect((globalThis as { __pwned2?: boolean }).__pwned2).toBeUndefined();
  });

  it("requests permission on a user gesture once a session reports activity", async () => {
    const { requestPermission } = stubNotification("default");
    const { root, monitor } = await boot();

    // A press before any activity must not prompt: a plain shell's user can only
    // answer such a prompt wrongly.
    root
      .querySelector(".wt-tab-bar")
      ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(requestPermission).not.toHaveBeenCalled();

    // A reporting session arms it; the next gesture asks, exactly once.
    monitor.emit({
      id: "s1",
      status: "working",
      title: "one",
      createdAt: "1",
      reportsActivity: true,
    });
    root
      .querySelector(".wt-tab-bar")
      ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    root
      .querySelector(".wt-tab-bar")
      ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("degrades to tab-only when permission is denied, without throwing", async () => {
    const { posts } = stubNotification("denied");
    const { root, monitor } = await boot();
    expect(() => {
      monitor.emit({
        id: "s2",
        status: "done",
        title: "two",
        createdAt: "2",
        reportsActivity: true,
        notification: "Response complete",
        notificationSeq: 1,
      });
    }).not.toThrow();
    expect(posts).toEqual([]);
    // Tab-only: the session's own dot and the switcher's aggregate cue still say
    // something happened.
    expect(root.querySelector<HTMLElement>(".wt-switcher-switch-dot")?.dataset["status"]).toBe(
      "done",
    );
  });

  it("degrades to tab-only when the API is absent (no Notification global)", async () => {
    const { monitor } = await boot();
    expect(() => {
      monitor.emit({
        id: "s2",
        status: "done",
        title: "two",
        createdAt: "2",
        notification: "Response complete",
        notificationSeq: 1,
      });
    }).not.toThrow();
  });
});

// The switch animation's lifecycle (docs/tab-switch-repaint.md §3.2). The class
// comes off on the animation's own end, with the 360ms timer kept as the net for
// the cases no event covers: an interrupted animation (animationend does not
// fire, and animationcancel is not reliably delivered in Blink), a host with no
// animations feature or reduced motion set (no animation runs at all), and a
// consumer stylesheet without the rules.
//
// Fidelity notes, each one a correction from adversarial review:
//   - The event is dispatched from `.term-output`, which is where all three rules
//     actually declare the animation (css/40-animations.css), and it BUBBLES to
//     `.term` where the listener lives. Manufacturing it on `.term` tested a path
//     the browser never takes.
//   - The "unrelated animation" names are real ones from the bundle. `wt-tab-in`
//     is the tab bar's (and a sibling of the surface, so in production it cannot
//     even bubble here) and `wt-blink-anim` is the only other animation inside
//     `.term`. An invented name proves the filter rejects invented names.
//   - rAF handles are monotonic and cancellation is real, via a Map. The earlier
//     stub returned an array length that restarted at 1 after every pump, so a
//     retained handle could alias a later callback. Nothing depended on that yet,
//     which is exactly why it was worth removing.
describe("tabs switch-animation lifecycle", () => {
  const SWITCH_CLASSES = ["wt-switching", "wt-switching-next", "wt-switching-prev"];

  function switchClass(surface: Element): string | undefined {
    return SWITCH_CLASSES.find((c) => surface.classList.contains(c));
  }

  // happy-dom has no AnimationEvent constructor, so carry animationName on a
  // plain bubbling Event. Dispatched from the element the CSS animates, so
  // `target` is set by dispatch rather than asserted into place.
  function fireAnimEnd(output: Element, name: string): void {
    const e = new Event("animationend", { bubbles: true });
    Object.defineProperty(e, "animationName", { value: name });
    output.dispatchEvent(e);
  }

  interface Harness {
    root: HTMLElement;
    surface: Element;
    output: Element;
    chips: () => NodeListOf<HTMLElement>;
    pumpFrame: () => void;
    pendingFrames: () => number;
  }

  /** Mount two tabs, then take over rAF with a manual pump and freeze the timers
   *  so both halves of the lifecycle can be driven independently.
   *
   *  A pump, NOT a synchronous rAF: the catch-up cue polls itself through a
   *  self-chaining rAF (`pollCatchup`), so a stub that invokes its callback
   *  inline recurses until the stack blows. */
  async function mount2(): Promise<Harness> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    term = createTerminal(root, { features: () => [tabs()] });
    await until(() => root.querySelectorAll(".wt-tab").length === 2);
    const surface = root.querySelector(".term");
    const output = root.querySelector(".term-output");
    if (!surface || !output) {
      throw new Error("no .term / .term-output");
    }
    let nextHandle = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      const h = nextHandle++;
      frames.set(h, cb);
      return h;
    });
    vi.stubGlobal("cancelAnimationFrame", (h: number): void => {
      frames.delete(h);
    });
    const pumpFrame = (): void => {
      const due = [...frames.entries()];
      frames.clear();
      for (const [, cb] of due) {
        cb(0);
      }
    };
    // Only the timers, NOT requestAnimationFrame: vitest fakes rAF by default,
    // which would queue the class add behind the same clock the net is driven on
    // and make every assertion below read an un-added class.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return {
      root,
      surface,
      output,
      chips: () => root.querySelectorAll<HTMLElement>(".wt-tab"),
      pumpFrame,
      pendingFrames: () => frames.size,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the class on the animation's own end, long before the net", async () => {
    const h = await mount2();
    h.chips()[1]?.click();
    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-next");

    fireAnimEnd(h.output, "wt-switch-next");

    expect(switchClass(h.surface)).toBeUndefined();
    // And the net does not fire a second removal against a later switch.
    vi.advanceTimersByTime(1000);
    expect(switchClass(h.surface)).toBeUndefined();
  });

  it("ignores an animationend from other animations in the subtree", async () => {
    // Real names from the bundle: wt-tab-in is the tab bar's, wt-blink-anim the
    // only other animation inside .term. Neither may end the switch.
    const h = await mount2();
    h.chips()[1]?.click();
    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-next");

    fireAnimEnd(h.output, "wt-tab-in");
    fireAnimEnd(h.output, "wt-blink-anim");

    expect(switchClass(h.surface)).toBe("wt-switching-next");
  });

  it("ignores the OTHER switch animation's end, so a stale event cannot cut a switch short", async () => {
    // The reachable race: switch 1's animation completes, its event is queued, a
    // re-switch lands before the task runs. The old listener is gone by dispatch
    // time, so the NEW listener receives it. A listener accepting any of the three
    // names would end switch 2 a frame in.
    const h = await mount2();
    h.chips()[1]?.click();
    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-next");

    h.chips()[0]?.click();
    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-prev");

    fireAnimEnd(h.output, "wt-switch-next");

    expect(switchClass(h.surface)).toBe("wt-switching-prev");
  });

  it("still drops the class with no animation at all, via the net", async () => {
    // Reduced motion or a host without the animations feature: no .wt-animate, so
    // no animation runs and no animationend ever fires. The class must not stick.
    const h = await mount2();
    h.chips()[1]?.click();
    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-next");

    vi.advanceTimersByTime(359);
    expect(switchClass(h.surface)).toBe("wt-switching-next");
    vi.advanceTimersByTime(1);

    expect(switchClass(h.surface)).toBeUndefined();
  });

  it("arms the net only once the class is on, so a starved frame cannot skip the animation", async () => {
    // The net is armed inside the class-add frame. Armed beside it, a 360ms timer
    // could fire first in a hidden document or under a blocked main thread, and its
    // cleanup would cancel the pending class-add: the animation would be skipped
    // outright, which the no-skip constraint forbids.
    const h = await mount2();
    h.chips()[1]?.click();
    // At least the class-add frame is pending (other features queue frames too).
    expect(h.pendingFrames()).toBeGreaterThanOrEqual(1);

    // A very long stall before the frame runs. Nothing may be armed yet.
    vi.advanceTimersByTime(5000);
    expect(switchClass(h.surface)).toBeUndefined();

    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-next");
    vi.advanceTimersByTime(360);
    expect(switchClass(h.surface)).toBeUndefined();
  });

  it("does not let a matching event BEFORE the class lands skip the animation", async () => {
    // The listener is attached in the click's task; the class lands a frame later.
    // In that window a matching animationend from anywhere in the subtree would,
    // without the class check, cancel the pending class-add and skip the animation
    // outright. An animationend cannot precede its own animation, so the only
    // sender here is something else, and it must be ignored.
    const h = await mount2();
    h.chips()[1]?.click();
    expect(switchClass(h.surface)).toBeUndefined();

    fireAnimEnd(h.output, "wt-switch-next");
    h.pumpFrame();

    expect(switchClass(h.surface)).toBe("wt-switching-next");
    vi.advanceTimersByTime(360);
    expect(switchClass(h.surface)).toBeUndefined();
  });

  it("does not let a previous switch's net strip the current switch's class", async () => {
    // The rapid re-switch the class-add frame exists to serve.
    const h = await mount2();
    h.chips()[1]?.click();
    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-next");

    vi.advanceTimersByTime(200);
    h.chips()[0]?.click();
    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-prev");

    // Past switch 1's deadline, well inside switch 2's.
    vi.advanceTimersByTime(200);
    expect(switchClass(h.surface)).toBe("wt-switching-prev");

    // Switch 2's own net still lands.
    vi.advanceTimersByTime(200);
    expect(switchClass(h.surface)).toBeUndefined();
  });

  it("plays the animation of the switch that happened, when both land before a frame", async () => {
    // Two clicks inside one frame leave two pending class-add callbacks. Without
    // cancellation both classes land, and the cascade then picks whichever of the
    // three rules comes LAST in the stylesheet rather than the one the user's switch
    // asked for: a forward switch animates backwards. This is the defect that
    // predates the change.
    const h = await mount2();
    h.chips()[1]?.click();
    h.chips()[0]?.click();

    h.pumpFrame();

    const present = SWITCH_CLASSES.filter((c) => h.surface.classList.contains(c));
    expect(present).toEqual(["wt-switching-prev"]);
  });

  it("cancels a pending class-add on destroy, so no class lands after teardown", async () => {
    const h = await mount2();
    h.chips()[1]?.click();
    expect(h.pendingFrames()).toBeGreaterThanOrEqual(1);

    term?.destroy();
    term = undefined;
    h.pumpFrame();
    vi.advanceTimersByTime(1000);

    expect(switchClass(h.surface)).toBeUndefined();
  });

  it("removes the listener on destroy, not just the class", async () => {
    // The earlier version of this test dispatched an event after destroy and
    // asserted no class and no throw. Both hold with the listener teardown DELETED,
    // because teardown already removed the class and a leaked listener would only
    // remove it again. So that leg of "torn down as one unit" had no red check.
    //
    // The observable difference: put a class back by hand after destroy. A leaked
    // listener strips it; no listener leaves it alone.
    const h = await mount2();
    h.chips()[1]?.click();
    h.pumpFrame();
    expect(switchClass(h.surface)).toBe("wt-switching-next");

    term?.destroy();
    term = undefined;
    expect(switchClass(h.surface)).toBeUndefined();

    h.surface.classList.add("wt-switching-next");
    expect(() => {
      fireAnimEnd(h.output, "wt-switch-next");
    }).not.toThrow();

    expect(switchClass(h.surface)).toBe("wt-switching-next");
  });
});

// --- Desktop reorder preview: sweep, rest, slide, cancel --------------------
//
// The reorder answers a moving pointer and a stopped one differently, and these pin
// that split: sweeping across the strip rearranges NOTHING, and the slot opens when the
// pointer comes to REST. Rest is detected by re-arming a window on movement, so it is
// not a hold — stopping commits, and a drop never waits for it at all.
//
// What these CANNOT prove: happy-dom applies no stylesheet and reports every rect as
// zero, so the slide only runs where a test stubs geometry, and the dashed slot's
// appearance is unverifiable here. Every stage's inline-style bookkeeping IS checkable.
// How the motion FEELS is on the manual checklist.
//
// Zero layout offsets also mean dropTargetBefore never finds a midpoint past clientX,
// so every candidate below is "past the last chip" — enough to exercise the machinery,
// and the reason the expected orders all rotate the dragged tab to the end. Movement is
// expressed by passing a different clientX, which is what `dragAt` is for.
describe("tabs reorder preview", () => {
  async function mountDrag(
    count: number,
    opts: { reducedMotion?: boolean } = {},
  ): Promise<{
    root: HTMLElement;
    bar: HTMLElement;
    surface: HTMLElement;
    dt: FakeDataTransfer;
    chips: () => HTMLElement[];
    live: () => string;
    ids: () => string[];
    sweepTo: (x: number) => void;
    stubLayout: () => void;
    stubRects: () => void;
  }> {
    if (opts.reducedMotion === true) {
      // prefersReduce() is read live on every use, so one stub covers the whole drag.
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        })),
      );
    }
    listBody = ["one", "two", "three", "four"]
      .slice(0, count)
      .map((title, i) => ({ id: `s${String(i + 1)}`, title, createdAt: String(i + 1) }));
    const root = document.createElement("div");
    document.body.appendChild(root);
    const feature = tabs();
    term = createTerminal(root, { features: () => [feature] });
    await until(() => root.querySelectorAll(".wt-tab").length === count);
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    const surface = root.querySelector<HTMLElement>(".term");
    if (!bar || !surface) {
      throw new Error("strip chrome missing");
    }
    const chips = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".wt-tab")];
    const dt = fakeDataTransfer();
    // Only the timers, and only AFTER the async mount: until() drives itself on
    // setTimeout, and the tabs feature's status poll is a setInterval that must keep
    // running on the real clock (freezing it deadlocks teardown). Date is faked with
    // them because rest detection compares Date.now() against the last movement, so the
    // clock the assertions advance has to be the clock the feature reads.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    return {
      root,
      bar,
      surface,
      dt,
      chips,
      live: () => root.querySelector('[aria-live="polite"]')?.textContent ?? "",
      // The feature's OWN order, which is what a drop commits (syncOrderFromDom writes
      // tabList). Deliberately not localStorage: where an arrangement is PERSISTED is a
      // separate concern with its own tests, and asserting it here couples this suite to
      // a storage backend two layers away from the seam under test.
      ids: () => feature.api?.list().map((t) => t.id) ?? [],
      // One dragover at a given x. Passing a NEW x is how a test says "still moving";
      // repeating the last x is how it says "stopped", which is the distinction the
      // whole preview turns on.
      sweepTo: (x: number) => {
        bar.dispatchEvent(dragAt("dragover", dt, x));
      },
      // Give the chips real horizontal geometry, derived from their LIVE DOM index so a
      // reorder changes what they report. Without this the FLIP finds every delta zero
      // and returns before writing a style, which silently makes any assertion about
      // the slide vacuous. Deliberately does not stub offsetLeft/offsetWidth: the hit
      // test reads those, and leaving them at zero keeps every candidate "past the last
      // chip", which is the one target this environment can express.
      // Give the chips real LAYOUT geometry (what dropTargetBefore reads), so a test can
      // aim at a specific slot. Without it every offset is zero and the only expressible
      // candidate is "past the last chip".
      stubLayout: () => {
        chips().forEach((chip, i) => {
          Object.defineProperty(chip, "offsetLeft", { value: i * 100, configurable: true });
          Object.defineProperty(chip, "offsetWidth", { value: 100, configurable: true });
        });
      },
      stubRects: () => {
        for (const chip of chips()) {
          chip.getBoundingClientRect = (): DOMRect => {
            const at = chips().indexOf(chip);
            const left = at * 100;
            return {
              left,
              right: left + 100,
              width: 100,
              x: left,
              y: 0,
              top: 0,
              bottom: 0,
              height: 0,
              toJSON: () => ({}),
            } as DOMRect;
          };
        }
      },
    };
  }
  afterEach(() => {
    vi.useRealTimers();
  });

  // happy-dom returns undefined for a `translate` that was never set and "" for one
  // that was cleared, and it does not implement the property through getPropertyValue
  // at all; a real browser returns "" in both cases. Normalise, so "no displacement"
  // reads the same either way. The cast is the honest way to say the DOM emulator can
  // hand back undefined where lib.dom promises a string.
  function translateOf(el: HTMLElement): string {
    return (el.style.translate as string | undefined) ?? "";
  }
  it("rearranges nothing while the pointer sweeps, however long the sweep lasts", async () => {
    const h = await mountDrag(3);
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));

    for (const x of [10, 40, 80, 130, 190]) {
      h.sweepTo(x);
      vi.advanceTimersByTime(REORDER_REST_MS - 20);
    }

    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    // Nothing was displaced either: a moving pointer writes no inline style at all.
    for (const chip of h.chips()) {
      expect(translateOf(chip)).toBe("");
      expect(chip.style.transition).toBe("");
    }
  });

  it("does not commit between two dragover events of a FAST sweep", async () => {
    // The production bug this window is sized against: HTML5 drag-and-drop only
    // guarantees a `dragover` every 350ms — the drag loop runs on that cadence, not per
    // mouse movement — so a window at or below it expires BETWEEN two events of a quick
    // pass and the strip commits every slot the pointer crosses. At 120ms a fast sweep
    // over five tabs moved all five. Simulated here at the platform's worst-case
    // cadence, which is the case a shorter window cannot survive.
    const h = await mountDrag(4);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));

    for (const x of [20, 90, 160, 240, 320]) {
      h.sweepTo(x);
      vi.advanceTimersByTime(350);
    }

    expect(idsOf(h.root)).toEqual(["one", "two", "three", "four"]);
    // The guarantee, stated as the assertion rather than left implicit in the number:
    // only the no-events fallback can expire mid-sweep, so only it must clear 350ms.
    expect(REORDER_REST_MS).toBeGreaterThan(350);
  });

  it("opens the slot on the first stationary dragover, not on a long quiet window", async () => {
    // The signal that normally decides. A dragover at an unchanged position is positive
    // evidence the pointer stopped, so the slot opens after a short confirmation rather
    // than after the no-events fallback runs down.
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);
    h.sweepTo(40); // still moving
    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);

    // The pointer stops. The drag loop keeps delivering events at the same position.
    vi.advanceTimersByTime(REORDER_STILL_MS);
    h.sweepTo(40);

    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);
    // ...and it did NOT need the fallback, which is the whole point of the split.
    expect(REORDER_STILL_MS).toBeLessThan(REORDER_REST_MS / 4);
  });

  it("ignores a single stationary frame in the middle of a sweep", async () => {
    // One event of a fast sweep can land within the movement epsilon of the previous —
    // a direction reversal, or a frame whose motion was almost all vertical. That is not
    // a stop, so the confirmation window has to outlast it.
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);
    vi.advanceTimersByTime(16); // one frame
    h.sweepTo(11); // within REORDER_MOVE_EPS_PX: reads as stationary, but far too soon

    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
  });

  it("lets go of a committed slot when the pointer moves to another one", async () => {
    // The reported unreliability, and it was not flaky so much as state-dependent: once a
    // slot had been committed, moving to a different one did not always let go of the old
    // one, and the user had to jiggle the mouse until it took. Worst on leftward drags.
    //
    // Cause: the pending slot lived in a field, and the "already in that slot" branch
    // nulled it. Right after a commit the dragged chip sits immediately beside where the
    // pointer is heading, so that branch fires constantly — and once it had nulled the
    // field, the stillness branch had nothing to commit and bailed. The candidate is now
    // recomputed from the current event, so passing through "already there" cannot lose it.
    const h = await mountDrag(4);
    h.stubLayout();
    const dragged = h.chips()[3];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));

    // Land it in slot 2 (before the third chip, whose midpoint sits at 250).
    h.sweepTo(210);
    vi.advanceTimersByTime(REORDER_STILL_MS);
    h.sweepTo(210);
    expect(idsOf(h.root)).toEqual(["one", "two", "four", "three"]);

    // Now move LEFT to the first slot, crossing the position the dragged chip now holds
    // (which is what used to null the pending target), and stop.
    h.stubLayout();
    h.sweepTo(120);
    h.sweepTo(40);
    vi.advanceTimersByTime(REORDER_STILL_MS);
    h.sweepTo(40);

    expect(idsOf(h.root)).toEqual(["four", "one", "two", "three"]);
  });

  it("commits from the fallback when dragover stops arriving at all", async () => {
    // No stationary event ever comes, so the only remaining signal is the absence of
    // events. Slow on purpose: it has to out-wait the drag loop's cadence.
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);

    vi.advanceTimersByTime(REORDER_REST_MS - 1);
    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    vi.advanceTimersByTime(1);
    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);
  });

  it("treats a hand's tremor as stillness, not as a sweep", async () => {
    // A hand resting on a mouse is never perfectly still. Re-arming on a 1px tremor
    // would push the commit out for as long as someone held the tab, which is the bug a
    // naive movement check ships with.
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(50);

    vi.advanceTimersByTime(REORDER_STILL_MS);
    h.sweepTo(51); // 1px of jitter, under REORDER_MOVE_EPS_PX: still a stop
    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);
  });

  it("commits on release without waiting for the rest window at all", async () => {
    // A release is a decision, so dropping mid-sweep lands the tab where the lean said
    // it would rather than discarding the gesture.
    const h = await mountDrag(2);
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);
    expect(idsOf(h.root)).toEqual(["one", "two"]);

    dragged?.dispatchEvent(dragEvent("drop", h.dt));

    expect(idsOf(h.root)).toEqual(["two", "one"]);
    // ...and the model follows the DOM, which is what the drop commits.
    expect(h.ids()).toEqual(["s2", "s1"]);
  });

  it("fades the slot in at the position the rest opened", async () => {
    const h = await mountDrag(3);
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);
    vi.advanceTimersByTime(REORDER_REST_MS);

    expect(dragged?.classList.contains("wt-tab-slotted")).toBe(true);
    vi.advanceTimersByTime(REORDER_SLOT_FADE_MS);
    expect(dragged?.classList.contains("wt-tab-slotted")).toBe(false);
  });

  it("withdraws a pending slot when the pointer leaves the strip", async () => {
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);

    // Off the strip there is no candidate, so no rest can open a slot for a target the
    // pointer has already left.
    h.surface.dispatchEvent(dragEvent("dragover", h.dt));

    vi.advanceTimersByTime(REORDER_REST_MS * 4);
    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    for (const chip of h.chips()) {
      expect(translateOf(chip)).toBe("");
      expect(chip.style.transition).toBe("");
    }
  });

  it("withdraws a pending slot when the pointer leaves through the window edge", async () => {
    // The strip is docked at the viewport EDGE, so a pointer can leave it by leaving the
    // window, and then no other element receives a dragover to notice with. Only
    // dragleave sees this, which is why the bar carries one despite the child-churn
    // problem: a null relatedTarget is the window exit. A pointer that left the window
    // is also, by definition, one that has stopped moving over the strip, so the rest
    // window would otherwise run down and commit.
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);

    const leave = dragEvent("dragleave", h.dt);
    Object.defineProperty(leave, "relatedTarget", { value: null });
    h.bar.dispatchEvent(leave);

    vi.advanceTimersByTime(REORDER_REST_MS * 4);
    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
  });

  it("keeps a pending slot when dragleave is only a move between the bar's own children", async () => {
    // The reason dragleave cannot be used bare: crossing from a chip to its label fires
    // one, and treating that as an exit would make the strip unreorderable.
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);

    const inner = dragEvent("dragleave", h.dt);
    Object.defineProperty(inner, "relatedTarget", {
      value: h.root.querySelector(".wt-tab-label"),
    });
    h.bar.dispatchEvent(inner);

    vi.advanceTimersByTime(REORDER_REST_MS);
    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);
  });

  it("cancels rather than commits when the tab is released off the strip", async () => {
    // The strip is the drop zone. Committing an out-of-strip release would persist an
    // arrangement chosen at a position the user visibly left, and the outcome would
    // depend on whether the browser chose to emit `drop` at all: an accepted document
    // drop would commit while a refused release fell through to dragend and reverted.
    // That distinction is invisible to the person dragging, so both cancel.
    const h = await mountDrag(3);
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);
    vi.advanceTimersByTime(REORDER_REST_MS);
    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);

    const offStrip = dragEvent("drop", h.dt);
    h.surface.dispatchEvent(offStrip);
    // Still swallowed, so WebKit cannot read the payload as a URL and navigate.
    expect(offStrip.defaultPrevented).toBe(true);
    dragged?.dispatchEvent(dragEvent("dragend", h.dt));

    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    // The model was never written, because only a drop ON the strip writes it.
    expect(h.ids()).toEqual(["s1", "s2", "s3"]);
    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("Move cancelled");
  });

  it("reverts the whole preview when a drag is abandoned without a drop", async () => {
    // Escape (and any release the browser refuses) fires dragend with no drop at all,
    // which is the exact signal for "cancel". The old reorder had no revert path: it
    // committed whatever the strip happened to be showing, so an abandoned drag left the
    // tabs rearranged. Nothing is snapshotted to make this work — tabList is untouched
    // for the whole gesture, so the original order is simply re-projected.
    const h = await mountDrag(3);
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);
    vi.advanceTimersByTime(REORDER_REST_MS);
    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);

    dragged?.dispatchEvent(dragEvent("dragend", h.dt));

    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    // The model never moved at all: commitSlot writes the DOM only, so a cancelled
    // gesture leaves nothing to undo in tabList and nothing to persist downstream.
    expect(h.ids()).toEqual(["s1", "s2", "s3"]);
    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("Move cancelled");
  });

  it("announces an opened slot as a target, not as a completed move", async () => {
    // commitSlot moves the DOM but not tabList, so an opened slot is a PREVIEW that
    // Escape can still undo. Announcing it as "Moved one to position 2" told a
    // screen-reader user a reversible state was a finished action, sometimes followed by
    // "Move cancelled" contradicting it.
    const h = await mountDrag(2);
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);
    vi.advanceTimersByTime(REORDER_REST_MS);

    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("Drop position 2");

    // The completed move is announced once, by the release.
    dragged?.dispatchEvent(dragEvent("drop", h.dt));
    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("Moved one to position 2");
  });

  it("previews nothing when the candidate is the slot the tab already holds", async () => {
    // Dragging the LAST tab past the end of the strip: with zero layout offsets the
    // candidate is "after everything", which is where it already is. No lean, no rest, no
    // announcement — the cheap idempotent path every dragover takes when the pointer has
    // not actually chosen anything new.
    const h = await mountDrag(3);
    const chips = h.chips();
    chips[2]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);

    expect(chips.map(translateOf)).toEqual(["", "", ""]);
    vi.advanceTimersByTime(REORDER_REST_MS * 4);
    expect(idsOf(h.root)).toEqual(["one", "two", "three"]);
    vi.advanceTimersByTime(150);
    expect(h.live()).toBe("");
  });

  it("survives the pending target being closed from another window", async () => {
    // insertBefore throws NotFoundError on a reference node that is no longer a child,
    // which would abandon the reorder half-done and leave the lean stranded — the rest
    // net has already been dropped by then, so nothing else would clear it.
    const h = await mountDrag(3);
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);

    h.chips()[1]?.remove(); // the chip the pending slot is anchored to goes away
    expect(() => {
      vi.advanceTimersByTime(REORDER_REST_MS);
    }).not.toThrow();

    vi.advanceTimersByTime(REORDER_SETTLE_MS);
    for (const chip of h.chips()) {
      expect(translateOf(chip)).toBe("");
      expect(chip.style.transition).toBe("");
    }
  });

  it("ends the gesture when the dragged tab itself is closed from another window", async () => {
    // There is no source left to deliver a dragend, and a browser is not obliged to fire
    // one for a removed source. Without an explicit abort the feature would hold
    // `draggingEl` on a detached node forever, and the document-level guard reads that as
    // "a tab drag is in progress" and would swallow every unrelated drop on the page from
    // then on.
    const h = await mountDrag(3);
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);

    h.root.querySelector<HTMLElement>(".wt-tab-close")?.click(); // closes the dragged tab
    await until(() => h.chips().length === 2);

    // No dragend is dispatched. An unrelated drag must be the browser's business again.
    const unrelated = dragEvent("drop", h.dt);
    h.surface.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
    for (const chip of h.chips()) {
      expect(translateOf(chip)).toBe("");
      expect(chip.classList.contains("wt-tab-dragging")).toBe(false);
    }
  });

  it("writes no inline transition at all under reduced motion", async () => {
    // The lean and the slide are inline transitions, so no stylesheet gate can reach
    // them: .wt-animate and the scoped prefers-reduced-motion reset in 01-scope.css both
    // govern CSS only. The reorder has to check the preference itself, and it has to
    // still REORDER — motion is what the user opted out of, not the feature.
    const h = await mountDrag(3, { reducedMotion: true });
    h.chips()[0]?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);

    for (const chip of h.chips()) {
      expect(translateOf(chip)).toBe("");
      expect(chip.style.transition).toBe("");
    }
    vi.advanceTimersByTime(REORDER_REST_MS);
    expect(idsOf(h.root)).toEqual(["two", "three", "one"]);
    for (const chip of h.chips()) {
      expect(chip.style.transition).toBe("");
    }
  });

  it("leaves no inline style on any chip once a real slide has run", async () => {
    // happy-dom reports every rect as zero, so an unstubbed FLIP finds nothing to invert
    // and returns before writing a single style — which made an earlier version of this
    // test vacuous for the half it names. Stubbing rects from live DOM index makes the
    // slide branch actually execute, so this can prove the settle timer hands every chip
    // back.
    const h = await mountDrag(3);
    h.stubRects();
    const dragged = h.chips()[0];
    dragged?.dispatchEvent(dragEvent("dragstart", h.dt));
    h.sweepTo(10);
    vi.advanceTimersByTime(REORDER_REST_MS);

    // The slide is really running: the displaced chips are mid-transition.
    const sliding = h.chips().filter((c) => c.style.transition !== "");
    expect(sliding.length).toBeGreaterThan(0);
    expect(sliding[0]?.style.transition).toContain("translate");

    dragged?.dispatchEvent(dragEvent("drop", h.dt));
    dragged?.dispatchEvent(dragEvent("dragend", h.dt));
    vi.advanceTimersByTime(REORDER_SETTLE_MS + REORDER_SLOT_FADE_MS);

    for (const chip of h.chips()) {
      expect(translateOf(chip)).toBe("");
      expect(chip.style.transition).toBe("");
      expect(chip.classList.contains("wt-tab-dragging")).toBe(false);
      expect(chip.classList.contains("wt-tab-slotted")).toBe(false);
    }
  });
});
