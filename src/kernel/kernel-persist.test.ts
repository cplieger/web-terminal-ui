// @vitest-environment happy-dom
//
// Scrollback persistence wired through the real kernel: the parts that are about
// PLACEMENT rather than policy (scrollback.test.ts owns the policy).
//
// Three things can only be verified here. That a restored store is in place
// before the socket opens — which is the whole feature, because a resume
// announces what the client already holds and is not restartable. That both
// compositions are served: the kernel's implicit store for a single unmanaged
// terminal, and a per-session store for a feature that owns sessions. And that
// the page-lifecycle callbacks a discard actually runs are the ones that write.
//
// The render mock implements the real RenderHandle contract for
// bind/boundStore/getHighestIndex rather than returning constants, because the
// bound store is what a restore reaches the wire through: the kernel no longer
// supplies `getHaveThrough` (the engine defaults it to its own renderer), so a
// mock that ignored the bound store would make the central assertion of this
// file meaningless. What goes on the wire from that store is pinned in the
// engine's own connection suite.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { LineStore } from "@cplieger/web-terminal-engine";
import type * as KernelModule from "./kernel.js";
import type {
  PersistedScrollback,
  ScrollbackPersistence,
  SessionRef,
  TerminalContext,
  TerminalFeature,
} from "./types.js";

const hoisted = vi.hoisted(() => ({
  connectionInit: vi.fn(),
  connect: vi.fn(),
  setSession: vi.fn<(id: string) => void>(),
  forgetSession: vi.fn<(id: string) => void>(),
  currentSessionId: vi.fn<() => string>(() => "unmanaged-1"),
  serverEpochOf: vi.fn<(id: string) => number>(() => 0),
  adoptPersistedEpoch: vi.fn<(id: string, epoch: number) => void>(),
  bind: vi.fn(),
  resetScreen: vi.fn(),
}));
/** The renderer's bound store, reachable from the tests so output can be printed
 *  onto whatever the kernel actually left the renderer pointing at. */
const engineState = vi.hoisted(() => ({ bound: null as unknown }));

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  const boundStore = (): InstanceType<typeof actual.LineStore> => {
    engineState.bound ??= new actual.LineStore();
    return engineState.bound as InstanceType<typeof actual.LineStore>;
  };
  return {
    ...actual,
    render: {
      init: vi.fn(),
      updateFontMetrics: vi.fn(),
      setPredictedCursor: vi.fn(),
      computeSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getCursorPx: vi.fn(() => ({ left: 0, top: 0, cellH: 16 })),
      getHighestIndex: (): number => boundStore().highestIndex(),
      pendingRowCount: vi.fn(() => 0),
      noteResumeBounds: vi.fn(),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      updateReverseVideo: vi.fn(),
      // Faithful to the real module (render.ts: `store.reset()`), because the
      // assertion that matters here is what the RESTORE looks like afterwards — a
      // no-op mock would let a missing reset pass.
      resetScrollback: (): void => {
        boundStore().reset();
      },
      resetScreen: hoisted.resetScreen,
      // Demand-paged scrollback: the kernel's browse-cache TTL reads these on
      // every visibility transition and on its sweep, so the double has to carry
      // them. Zero cache means the TTL is a no-op, which is what these
      // persistence tests want.
      browseCacheSize: vi.fn(() => 0),
      lastBrowseActivityMs: vi.fn(() => 0),
      dropBrowseCache: vi.fn(),
      maybeFetchHistory: vi.fn(),
      handleScrollPosition: vi.fn(),
      replayMaxForResume: vi.fn(() => 1500),
      handleHistoryReply: vi.fn(),
      applyResumeTransition: vi.fn(),
      noteSolicited: vi.fn(),
      clearSolicited: vi.fn(),
      bind: (store: unknown): void => {
        engineState.bound = store;
        hoisted.bind(store);
      },
      boundStore,
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
      init: hoisted.connectionInit,
      connect: hoisted.connect,
      sendBinary: vi.fn(() => true),
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      disconnect: vi.fn(),
      setSession: hoisted.setSession,
      forgetSession: hoisted.forgetSession,
      currentSessionId: hoisted.currentSessionId,
      serverEpochOf: hoisted.serverEpochOf,
      adoptPersistedEpoch: hoisted.adoptPersistedEpoch,
    },
  };
});

const {
  connectionInit,
  connect,
  setSession,
  forgetSession,
  currentSessionId,
  serverEpochOf,
  adoptPersistedEpoch,
  bind,
  resetScreen,
} = hoisted;

let createTerminal: (typeof KernelModule)["createTerminal"];
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function row(t: string): { t: string; f: number; b: number; a: number; uc: number }[] {
  return [{ t, f: -1, b: -1, a: 0, uc: -1 }];
}

function seeded(n: number, from = 0): LineStore {
  const store = new LineStore();
  store.applyScroll({
    type: "scroll",
    firstIndex: from,
    lines: Array.from({ length: n }, (_, i) => row(`L${String(from + i)}`)),
  });
  return store;
}

/** Print onto the store the kernel left the renderer bound to — the live store,
 *  whichever one that turned out to be. */
function printOnBoundStore(n: number, from: number): void {
  const store = engineState.bound as LineStore | null;
  if (store === null) {
    throw new Error("test: the renderer has no bound store");
  }
  store.applyScroll({
    type: "scroll",
    firstIndex: from,
    lines: Array.from({ length: n }, (_, i) => row(`P${String(from + i)}`)),
  });
}

function entryFor(store: LineStore, epoch: number): PersistedScrollback {
  const snapshot = store.snapshot(epoch);
  if (snapshot === null) {
    throw new Error("test fixture: the store was empty");
  }
  return { savedAt: Date.now(), snapshot };
}

function storage(seed: Record<string, PersistedScrollback> = {}): ScrollbackPersistence & {
  readonly entries: Map<string, PersistedScrollback>;
  readonly dropped: string[];
} {
  const entries = new Map(Object.entries(seed));
  const dropped: string[] = [];
  return {
    entries,
    dropped,
    load: (id) => entries.get(id) ?? null,
    save: (id, entry) => {
      entries.set(id, entry);
    },
    drop: (id) => {
      dropped.push(id);
      entries.delete(id);
    },
  };
}

/** The callbacks the kernel handed the engine's connection layer. */
function engineCallbacks(): Parameters<typeof Engine.connection.init>[0] {
  const first = connectionInit.mock.calls[0]?.[0] as
    Parameters<typeof Engine.connection.init>[0] | undefined;
  if (!first) {
    throw new Error("connection.init was never called");
  }
  return first;
}

/** The claim this client will put on the wire, read where it is now decided: the
 *  BOUND store's replay boundary. The kernel supplies no `getHaveThrough`, so the
 *  engine answers from the renderer — which means "did the restore land, and land
 *  before connect()" is a question about the store the renderer is pointing at. */
const haveThrough = (): number => {
  const store = engineState.bound as LineStore | null;
  return store === null ? -1 : store.replayBoundary();
};

beforeEach(async () => {
  vi.resetModules();
  for (const fn of Object.values(hoisted)) {
    fn.mockClear();
  }
  currentSessionId.mockReturnValue("unmanaged-1");
  serverEpochOf.mockReturnValue(0);
  engineState.bound = null;
  document.body.replaceChildren();
  ({ createTerminal } = await import("./kernel.js"));
});

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("persistScrollback: the single unmanaged terminal", () => {
  it("supplies no getHaveThrough, so the engine's own answer is what goes out", () => {
    // The premise every haveThrough() assertion in this file rests on, and the
    // regression worth a test of its own: an explicit member WINS over the
    // engine's default (connection.init spreads the consumer last), so re-adding
    // one here silently restores the claim that parked a frozen copy of the
    // composer in scrollback on every reattach. Absence IS the fix.
    const term = createTerminal(rootIn(), {});
    try {
      expect(engineCallbacks().getHaveThrough).toBeUndefined();
    } finally {
      term.destroy();
    }
  });

  it("announces the restored content as haveThrough, so the resume is a delta", () => {
    // The reason the feature exists, asserted at the only place it is observable:
    // what this client tells the server it already holds. Without a restore this
    // is -1 and the server replays its whole ring line by line, which is the
    // reported symptom on a phone whose tab was discarded while it slept.
    const store = storage({ "unmanaged-1": entryFor(seeded(400, 1000), 777) });
    const term = createTerminal(rootIn(), { persistScrollback: store });
    try {
      expect(haveThrough()).toBe(1399);
      // And the epoch was adopted, so a server that restarted while the tab was
      // away is detected on the first resumeAck instead of silently
      // contradicting these indices.
      expect(adoptPersistedEpoch).toHaveBeenCalledWith("unmanaged-1", 777);
    } finally {
      term.destroy();
    }
  });

  it("restores before the socket opens, because a resume cannot be taken back", () => {
    const store = storage({ "unmanaged-1": entryFor(seeded(5, 200), 777) });
    let atConnect = -99;
    connect.mockImplementation(() => {
      atConnect = haveThrough();
    });
    const term = createTerminal(rootIn(), { persistScrollback: store });
    try {
      expect(connect).toHaveBeenCalled();
      expect(atConnect).toBe(204);
    } finally {
      connect.mockReset();
      term.destroy();
    }
  });

  it("keeps the renderer's own store when there is nothing to restore", () => {
    // A terminal with no snapshot must behave exactly as it did before this
    // feature existed: no swap, no empty replacement, no rebuild.
    const term = createTerminal(rootIn(), { persistScrollback: storage() });
    try {
      expect(bind).not.toHaveBeenCalled();
      expect(haveThrough()).toBe(-1);
    } finally {
      term.destroy();
    }
  });

  it("changes nothing at all when the consumer did not opt in", () => {
    const term = createTerminal(rootIn(), {});
    try {
      expect(bind).not.toHaveBeenCalled();
      expect(currentSessionId).not.toHaveBeenCalled();
      expect(adoptPersistedEpoch).not.toHaveBeenCalled();
    } finally {
      term.destroy();
    }
  });

  it("restores a snapshot of a single line, which is the boundary the check sits on", () => {
    // One line of output is a real snapshot, and the smallest one that exists:
    // highestIndex() is 0, not a positive number. A check written one off starts
    // the resume from nothing instead, so the server replays a page this client
    // is already holding — the exact cost this feature exists to avoid.
    const store = storage({ "unmanaged-1": entryFor(seeded(1, 0), 777) });
    const term = createTerminal(rootIn(), { persistScrollback: store });
    try {
      expect(bind).toHaveBeenCalledTimes(1);
      expect(haveThrough()).toBe(0);
    } finally {
      term.destroy();
    }
  });

  it("saves the implicit store it did not restore, so a first visit is not wasted", () => {
    // The store the renderer created is tracked as well as a hydrated one, or
    // every reload would be a cold start until the second one.
    serverEpochOf.mockReturnValue(555);
    const store = storage();
    const term = createTerminal(rootIn(), { persistScrollback: store });
    try {
      printOnBoundStore(4, 0);
      window.dispatchEvent(new Event("pagehide"));
      expect(store.entries.get("unmanaged-1")?.snapshot.highest).toBe(3);
      expect(store.entries.get("unmanaged-1")?.snapshot.serverEpoch).toBe(555);
    } finally {
      term.destroy();
    }
  });
});

describe("persistScrollback: a session-owning feature", () => {
  /** A minimal stand-in for tabs: it owns sessions, and it creates each
   *  session's store through the kernel factory. */
  function owner(
    sessionId: string,
    onCtx: (ctx: TerminalContext) => void = () => undefined,
  ): TerminalFeature<{ readonly store: LineStore | null }> {
    let store: LineStore | null = null;
    return {
      name: "fake-session-owner",
      sessionOwner: {
        resolveInitialSession: (): Promise<SessionRef | null> => Promise.resolve({ id: sessionId }),
      },
      setup(ctx) {
        onCtx(ctx);
        store = ctx.newLineStore(sessionId);
        ctx.render.bind(store);
        return {
          api: {
            get store(): LineStore | null {
              return store;
            },
          },
          teardown: () => undefined,
        };
      },
    };
  }

  it("hands a hydrated store to the feature that owns the session", async () => {
    const store = storage({ "sess-7": entryFor(seeded(9, 300), 777) });
    const feature = owner("sess-7");
    const term = createTerminal(rootIn(), { features: () => [feature], persistScrollback: store });
    try {
      await tick();
      expect(feature.api?.store?.highestIndex()).toBe(308);
      expect(adoptPersistedEpoch).toHaveBeenCalledWith("sess-7", 777);
      // The switch — which opens the socket for this session — runs after every
      // feature's setup, so the restore is necessarily in place first.
      expect(setSession).toHaveBeenCalledWith("sess-7");
      expect(haveThrough()).toBe(308);
    } finally {
      term.destroy();
    }
  });

  it("applies the consumer's retained-line cap to a hydrated per-session store", async () => {
    const store = storage({ "sess-7": entryFor(seeded(20, 0), 777) });
    const feature = owner("sess-7");
    const term = createTerminal(rootIn(), {
      features: () => [feature],
      persistScrollback: store,
      scrollbackLines: 8,
    });
    try {
      await tick();
      // Restored at the consumer's cap, not the engine default.
      expect(feature.api?.store?.oldestIndex()).toBe(12);
      expect(feature.api?.store?.highestIndex()).toBe(19);
    } finally {
      term.destroy();
    }
  });

  it("warns once when a feature creates a store without naming its session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    const term = createTerminal(rootIn(), {
      features: () => [probe],
      persistScrollback: storage(),
    });
    try {
      await tick();
      captured?.newLineStore();
      captured?.newLineStore();
      const hits = warn.mock.calls.filter((c) => String(c[0]).includes("without a session id"));
      expect(hits.length).toBe(1);
    } finally {
      warn.mockRestore();
      term.destroy();
    }
  });

  it("deletes a closed session's snapshot through ctx.dropSession", async () => {
    const store = storage({ "sess-7": entryFor(seeded(9, 300), 777) });
    let captured: TerminalContext | undefined;
    const feature = owner("sess-7", (ctx) => {
      captured = ctx;
    });
    const term = createTerminal(rootIn(), { features: () => [feature], persistScrollback: store });
    try {
      await tick();
      captured?.dropSession("sess-7");
      expect(forgetSession).toHaveBeenCalledWith("sess-7");
      expect(store.dropped).toEqual(["sess-7"]);
      expect(store.entries.has("sess-7")).toBe(false);
    } finally {
      term.destroy();
    }
  });
});

describe("persistScrollback: when the snapshot is written", () => {
  function booted(): {
    readonly term: ReturnType<typeof createTerminal>;
    readonly store: ReturnType<typeof storage>;
  } {
    serverEpochOf.mockReturnValue(555);
    const store = storage();
    const term = createTerminal(rootIn(), { persistScrollback: store });
    return { term, store };
  }

  it("writes when the page is hidden, the last callback a discard reliably runs", () => {
    const { term, store } = booted();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      printOnBoundStore(6, 40);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(store.entries.get("unmanaged-1")?.snapshot.highest).toBe(45);
    } finally {
      visibility.mockRestore();
      term.destroy();
    }
  });

  it("writes on pagehide, which fires on unload and on a freeze into bfcache", () => {
    const { term, store } = booted();
    try {
      printOnBoundStore(3, 10);
      window.dispatchEvent(new Event("pagehide"));
      expect(store.entries.get("unmanaged-1")?.snapshot.highest).toBe(12);
    } finally {
      term.destroy();
    }
  });

  it("writes on destroy, because a closed panel is still a page to come back to", () => {
    const { term, store } = booted();
    printOnBoundStore(3, 10);
    term.destroy();
    expect(store.entries.get("unmanaged-1")?.snapshot.highest).toBe(12);
  });

  it("does not write while the page is becoming VISIBLE", () => {
    // One event fires both ways. Only the hidden transition is a last chance, and
    // a wake is the moment the terminal is busiest reconnecting.
    const { term, store } = booted();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      printOnBoundStore(3, 10);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(store.entries.size).toBe(0);
    } finally {
      visibility.mockRestore();
      term.destroy();
    }
  });
});

describe("persistScrollback: a restore that will never be verified", () => {
  /** The epoch makes a stale restore self-correcting only when a resumeAck
   *  ARRIVES — that is what compares the seeded epoch and fires the reset. Two
   *  closes reach markReady without one, and both are what a container restart
   *  leaves behind. */
  function bootRestored(): {
    readonly term: ReturnType<typeof createTerminal>;
    readonly cb: Parameters<typeof Engine.connection.init>[0];
  } {
    const store = storage({ "unmanaged-1": entryFor(seeded(9, 300), 777) });
    const term = createTerminal(rootIn(), { persistScrollback: store });
    expect(haveThrough()).toBe(308);
    return { term, cb: engineCallbacks() };
  }

  it("discards it when the session is already gone (4001 before any resume)", () => {
    // Without this the overlay lifts over the PREVIOUS run's output under a
    // "Session ended" banner — the one path where the design's stated worst case
    // was reachable.
    const { term, cb } = bootRestored();
    try {
      cb.onProcessExit?.();
      expect(haveThrough()).toBe(-1);
    } finally {
      term.destroy();
    }
  });

  it("discards it when the client is refused as incompatible", () => {
    // A cached client one wire revision behind is what an image update leaves
    // behind, so this arrives with a restart for exactly the same reason.
    const { term, cb } = bootRestored();
    try {
      cb.onWireIncompatible?.({} as never);
      expect(haveThrough()).toBe(-1);
    } finally {
      term.destroy();
    }
  });

  it("KEEPS it once a resume has confirmed it", () => {
    // The other half, and the one that makes this safe to do at all: after a
    // resume the content is verified, so a later process exit is an ordinary end
    // of session and must leave the final screen on display.
    const { term, cb } = bootRestored();
    try {
      cb.onResumeBounds?.(400, 300);
      cb.onProcessExit?.();
      expect(haveThrough()).toBe(308);
    } finally {
      term.destroy();
    }
  });

  it("verifies and discards PER SESSION, not per page", () => {
    // The shape every reference app actually runs: several sessions hydrated at
    // boot, one socket. Two booleans stood here — set once per hydrated session,
    // cleared by the first ack of the page load, and resetting only the
    // renderer-BOUND store. So the active tab's first ack disarmed the guard for
    // every other tab, and the failure it exists to prevent stayed one tab switch
    // away.
    const store = storage({
      "sess-a": entryFor(seeded(9, 300), 777),
      "sess-b": entryFor(seeded(9, 500), 777),
    });
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    const term = createTerminal(rootIn(), {
      persistScrollback: store,
      features: () => [probe],
    });
    try {
      const a = captured?.newLineStore("sess-a");
      const b = captured?.newLineStore("sess-b");
      if (a === undefined || b === undefined) {
        throw new Error("the feature never ran");
      }
      expect(a.highestIndex()).toBe(308);
      expect(b.highestIndex()).toBe(508);

      // The socket is on session A, so its ack verifies A and says nothing at all
      // about B.
      currentSessionId.mockReturnValue("sess-a");
      const cb = engineCallbacks();
      cb.onResumeBounds?.(400, 300);

      // A's process exits. That condemns A's restore only — B's session is alive.
      cb.onProcessExit?.();
      expect(b.highestIndex()).toBe(508);

      // A wire refusal is terminal for the whole page, so every unverified
      // restore goes — including B's, which no ack ever vouched for.
      cb.onWireIncompatible?.({} as never);
      expect(b.highestIndex()).toBe(-1);
    } finally {
      term.destroy();
    }
  });

  it("keeps a VERIFIED session's restore when a different session is refused", () => {
    // The other direction: verification is per session too, so a page-wide
    // discard must not reach a session whose resume already confirmed it.
    const store = storage({
      "sess-a": entryFor(seeded(9, 300), 777),
      "sess-b": entryFor(seeded(9, 500), 777),
    });
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    const term = createTerminal(rootIn(), {
      persistScrollback: store,
      features: () => [probe],
    });
    try {
      const b = captured?.newLineStore("sess-b");
      if (b === undefined) {
        throw new Error("the feature never ran");
      }
      currentSessionId.mockReturnValue("sess-b");
      const cb = engineCallbacks();
      cb.onResumeBounds?.(600, 500); // B is confirmed

      cb.onWireIncompatible?.("page" as never);
      expect(b.highestIndex()).toBe(508);
    } finally {
      term.destroy();
    }
  });

  it("does nothing when there was no restore to discard", () => {
    const store = storage();
    const term = createTerminal(rootIn(), { persistScrollback: store });
    try {
      printOnBoundStore(4, 0);
      engineCallbacks().onProcessExit?.();
      // Live content, not a restore: an exit must not erase what this session drew.
      expect(haveThrough()).toBe(3);
    } finally {
      term.destroy();
    }
  });

  it("reconciles the SCREEN as well when the discarded restore is the bound one", () => {
    // The bound store is the one with a reader, and the DOM belongs to the
    // renderer: resetting the store directly empties the model and leaves the
    // previous run's rows on display, which is the exact picture this guard exists
    // to prevent.
    const { term, cb } = bootRestored();
    try {
      resetScreen.mockClear();

      cb.onProcessExit?.();

      expect(resetScreen).toHaveBeenCalledTimes(1);
      expect(haveThrough()).toBe(-1);
    } finally {
      term.destroy();
    }
  });

  it("condemns a one-line restore too, which is the smallest one there is", () => {
    // The per-session hydration arms the guard on the same boundary the unmanaged
    // path uses: a session restored from a single line is still showing last
    // run's output, and a check written one off would leave it on display under a
    // "Session ended" banner.
    const store = storage({ "sess-a": entryFor(seeded(1, 0), 777) });
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    const term = createTerminal(rootIn(), { persistScrollback: store, features: () => [probe] });
    try {
      const a = captured?.newLineStore("sess-a");
      if (a === undefined) {
        throw new Error("the feature never ran");
      }
      expect(a.highestIndex()).toBe(0);

      currentSessionId.mockReturnValue("sess-a");
      engineCallbacks().onProcessExit?.();

      expect(a.highestIndex()).toBe(-1);
    } finally {
      term.destroy();
    }
  });

  it("arms nothing for a session with no snapshot, so its LIVE output survives an exit", () => {
    // The stated invariant of this guard: it only ever discards a restore, never
    // content this run drew. A session that was never hydrated must not enter the
    // set at all — otherwise the first process exit wipes the output the user was
    // reading, which is strictly worse than the stale-restore case the guard is for.
    const store = storage();
    let captured: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "probe",
      setup(ctx) {
        captured = ctx;
        return { teardown: () => undefined };
      },
    };
    const term = createTerminal(rootIn(), { persistScrollback: store, features: () => [probe] });
    try {
      const a = captured?.newLineStore("sess-a");
      if (a === undefined) {
        throw new Error("the feature never ran");
      }
      a.applyScroll({
        type: "scroll",
        firstIndex: 0,
        lines: Array.from({ length: 4 }, (_, i) => row(`live ${String(i)}`)),
      });
      expect(a.highestIndex()).toBe(3);

      currentSessionId.mockReturnValue("sess-a");
      engineCallbacks().onProcessExit?.();

      expect(a.highestIndex()).toBe(3);
    } finally {
      term.destroy();
    }
  });
});
