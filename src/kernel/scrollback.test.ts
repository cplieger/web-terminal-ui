// @vitest-environment happy-dom
//
// Scrollback persistence (CreateTerminalOptions.persistScrollback): the rules
// this module owns, which are all rules about TRUST and TIMING. The engine owns
// the data shape; the consumer owns the bytes. What is tested here is that a
// stored entry is only ever hydrated when it can be verified against the server
// it is about to be shown next to, that every failure of the consumer's storage
// degrades to "nothing was restored" rather than to a broken terminal, and that
// a snapshot exists to restore in the first place after a discard that ran no
// close handler.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { LineStore } from "@cplieger/web-terminal-engine";
import type * as ScrollbackModule from "./scrollback.js";
import type { PersistedScrollback, ScrollbackPersistence } from "./types.js";

const { adoptPersistedEpoch, serverEpochOf } = vi.hoisted(() => ({
  adoptPersistedEpoch: vi.fn<(sessionId: string, epoch: number) => void>(),
  serverEpochOf: vi.fn<(sessionId: string) => number>(() => 0),
}));

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    connection: {
      ...actual.connection,
      adoptPersistedEpoch,
      serverEpochOf,
    },
  };
});

let createScrollbackKeeper: (typeof ScrollbackModule)["createScrollbackKeeper"];

/** A store holding `n` lines starting at `from`, so absolute indices are
 *  observable (they are the whole reason the epoch matters). */
function seeded(n: number, from = 0): LineStore {
  const store = new LineStore();
  store.applyScroll({
    type: "scroll",
    firstIndex: from,
    lines: Array.from({ length: n }, (_, i) => [
      { t: `L${String(from + i)}`, f: -1, b: -1, a: 0, uc: -1 },
    ]),
  });
  return store;
}

/** A stored entry as the consumer would have written it. */
function entryFor(store: LineStore, epoch: number, savedAt = Date.now()): PersistedScrollback {
  const snapshot = store.snapshot(epoch);
  if (snapshot === null) {
    throw new Error("test fixture: the store was empty");
  }
  return { savedAt, snapshot };
}

/** An in-memory stand-in for the consumer's storage, with the calls recorded. */
function fakeStorage(seed: Record<string, PersistedScrollback> = {}): ScrollbackPersistence & {
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

beforeEach(async () => {
  vi.resetModules();
  adoptPersistedEpoch.mockClear();
  serverEpochOf.mockReset();
  serverEpochOf.mockReturnValue(0);
  ({ createScrollbackKeeper } = await import("./scrollback.js"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scrollback persistence: hydrating", () => {
  it("restores the lines at their absolute indices and adopts the epoch before connecting", () => {
    // The whole point of the feature: a discarded-and-reloaded page comes back
    // holding what it held, so its resume asks for a delta instead of the
    // server's whole ring. Adopting the epoch is what makes the restore legal —
    // it gives the first resumeAck something to compare against, so a server
    // that restarted while the tab was away is DETECTED rather than silently
    // contradicting the restored indices.
    const storage = fakeStorage({ "sess-1": entryFor(seeded(5, 200), 777) });
    const keeper = createScrollbackKeeper(storage, undefined);

    const store = keeper.storeFor("sess-1");
    expect(store.oldestIndex()).toBe(200);
    expect(store.highestIndex()).toBe(204);
    expect(adoptPersistedEpoch).toHaveBeenCalledWith("sess-1", 777);
    keeper.stop();
  });

  it("reports the depth it does not have, so the trim marker is honest", () => {
    // A bounded tail is not a complete buffer, and pretending otherwise would
    // make the terminal claim there is nothing above what it shows.
    const storage = fakeStorage({ "sess-1": entryFor(seeded(5, 200), 777) });
    const keeper = createScrollbackKeeper(storage, undefined);

    expect(keeper.storeFor("sess-1").hasTrimmedHistory()).toBe(true);
    keeper.stop();
  });

  it("honors the consumer's retained-line cap on the restored store", () => {
    // scrollbackLines is the page's memory dial; a store that came back from
    // storage must not be the one place it does not apply.
    const storage = fakeStorage({ "sess-1": entryFor(seeded(12, 0), 777) });
    const keeper = createScrollbackKeeper(storage, 8);

    const store = keeper.storeFor("sess-1");
    store.applyScroll({
      type: "scroll",
      firstIndex: 12,
      lines: [[{ t: "next", f: -1, b: -1, a: 0, uc: -1 }]],
    });
    expect(store.highestIndex()).toBe(12);
    expect(store.oldestIndex()).toBe(5); // cap 8 applied to the RESTORED store
    keeper.stop();
  });

  it("starts empty for a session with nothing stored", () => {
    const keeper = createScrollbackKeeper(fakeStorage(), undefined);
    expect(keeper.storeFor("sess-new").highestIndex()).toBe(-1);
    expect(adoptPersistedEpoch).not.toHaveBeenCalled();
    keeper.stop();
  });
});

describe("scrollback persistence: rejecting what cannot be trusted", () => {
  it("discards an entry with no server epoch, because it can never be verified", () => {
    // The sharpest case, and the reason this is a discard rather than a
    // best-effort restore. Absolute indices mean nothing across a server
    // restart: a hydrated store whose epoch cannot be compared would show old
    // content as live and then REFUSE the new session's output, whose low
    // indices fall below what that store believes it evicted. A slow restore is
    // a far better failure than a terminal that is wrong and then stays blank.
    const storage = fakeStorage({ "sess-1": entryFor(seeded(5, 200), 0) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const keeper = createScrollbackKeeper(storage, undefined);
    try {
      expect(keeper.storeFor("sess-1").highestIndex()).toBe(-1);
      expect(adoptPersistedEpoch).not.toHaveBeenCalled();
      // And it is deleted, so the same unusable entry is not re-read forever.
      expect(storage.dropped).toEqual(["sess-1"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no server epoch"));
    } finally {
      warn.mockRestore();
      keeper.stop();
    }
  });

  it("discards an epoch that could not have come from a server", () => {
    // The epoch is adopted as a session's IDENTITY, and it arrives from storage, so
    // a value merely being a finite number is not enough: the server reports a
    // process-start timestamp, so negative, fractional and absurd values are a
    // corrupt entry wearing the shape of a real one. Each lands on the same
    // "unknown" the epoch-0 rule already refuses.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const good = entryFor(seeded(5, 200), 777);
        const storage = fakeStorage();
        storage.entries.set("sess-1", {
          ...good,
          snapshot: { ...good.snapshot, serverEpoch: bad },
        });
        const keeper = createScrollbackKeeper(storage, undefined);
        expect(keeper.storeFor("sess-1").highestIndex()).toBe(-1);
        expect(storage.dropped).toEqual(["sess-1"]);
        keeper.stop();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("discards an entry older than the age bound and deletes it", () => {
    // The case the feature exists for — an iOS discard — is exactly the case
    // where no close handler runs, so without an age bound the consumer's
    // storage accumulates sessions that stopped existing weeks ago. Rejecting
    // on access is also what makes collection automatic.
    const old = entryFor(seeded(5, 200), 777, Date.now() - 9 * 24 * 60 * 60 * 1000);
    const storage = fakeStorage({ "sess-1": old });
    const keeper = createScrollbackKeeper(storage, undefined);

    expect(keeper.storeFor("sess-1").highestIndex()).toBe(-1);
    expect(storage.dropped).toEqual(["sess-1"]);
    keeper.stop();
  });

  it("honors a consumer-set age bound", () => {
    const entry = entryFor(seeded(5, 200), 777, Date.now() - 5000);
    const fresh = fakeStorage({ "sess-1": entry });
    const strict = createScrollbackKeeper({ ...fresh, maxAgeMs: 1000 }, undefined);
    expect(strict.storeFor("sess-1").highestIndex()).toBe(-1);
    strict.stop();

    const lenient = createScrollbackKeeper(
      { ...fakeStorage({ "sess-1": entry }), maxAgeMs: 60_000 },
      undefined,
    );
    expect(lenient.storeFor("sess-1").highestIndex()).toBe(204);
    lenient.stop();
  });

  it("expires an entry dated in the FUTURE, which a moved clock produces", () => {
    // Age measured as a signed difference would make a future timestamp never
    // expire, so a phone whose clock jumped would keep one entry forever.
    const ahead = entryFor(seeded(5, 200), 777, Date.now() + 30 * 24 * 60 * 60 * 1000);
    const storage = fakeStorage({ "sess-1": ahead });
    const keeper = createScrollbackKeeper(storage, undefined);

    expect(keeper.storeFor("sess-1").highestIndex()).toBe(-1);
    expect(storage.dropped).toEqual(["sess-1"]);
    keeper.stop();
  });

  it("discards an entry whose timestamp is missing or not a number", () => {
    // The value has been outside this program's memory, so its type is an
    // assumption until checked; an unstamped entry has no age to bound.
    const good = entryFor(seeded(5, 200), 777);
    for (const savedAt of [undefined, "yesterday", Number.NaN]) {
      const storage = fakeStorage();
      storage.entries.set("sess-1", { ...good, savedAt } as unknown as PersistedScrollback);
      const keeper = createScrollbackKeeper(storage, undefined);
      expect(keeper.storeFor("sess-1").highestIndex()).toBe(-1);
      expect(storage.dropped).toEqual(["sess-1"]);
      keeper.stop();
    }
  });

  it("starts empty when the stored snapshot is malformed, rather than half-restoring", () => {
    const good = entryFor(seeded(5, 200), 777);
    const broken: unknown[] = [
      { savedAt: Date.now(), snapshot: { ...good.snapshot, v: good.snapshot.v + 1 } },
      { savedAt: Date.now(), snapshot: { ...good.snapshot, lines: "nope" } },
      { savedAt: Date.now(), snapshot: { ...good.snapshot, lines: [] } },
      { savedAt: Date.now(), snapshot: null },
      { savedAt: Date.now() },
      "not an entry at all",
    ];
    for (const entry of broken) {
      const storage = fakeStorage();
      storage.entries.set("sess-1", entry as PersistedScrollback);
      const keeper = createScrollbackKeeper(storage, undefined);
      expect(keeper.storeFor("sess-1").highestIndex()).toBe(-1);
      expect(storage.dropped).toEqual(["sess-1"]);
      keeper.stop();
    }
  });

  it("survives a load that throws, exactly as if persistence were off", () => {
    // The consumer's storage is someone else's code running in a browser that may
    // have disabled it. A startup must not fail because a cache read did.
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper(
      {
        ...storage,
        load: () => {
          throw new Error("storage unavailable");
        },
      },
      undefined,
    );
    expect(keeper.storeFor("sess-1").highestIndex()).toBe(-1);
    keeper.stop();
  });
});

describe("scrollback persistence: saving", () => {
  it("does NOT re-write a store that has not advanced, so a second page cannot roll it back", () => {
    // The cross-tab case, and the reason flush shares the background pass's
    // predicate. Under the tabs feature every tab gets a store and all of them are
    // hydrated at load, but only the ACTIVE session's advances — there is one
    // socket. An unconditional flush therefore let a page holding another session's
    // store frozen at load-time content write that content over a second page's
    // newer entry, with a fresh timestamp that also made the stale copy the one the
    // sweep preferred.
    serverEpochOf.mockReturnValue(777);
    const fresh = entryFor(seeded(9, 100), 777);
    const storage = fakeStorage({ "sess-a": fresh });
    const keeper = createScrollbackKeeper(storage, undefined);
    // Hydrate, then never advance: exactly a background page's copy.
    const store = keeper.storeFor("sess-a");
    expect(store.highestIndex()).toBe(108);

    // Meanwhile the other page moved the stored entry on.
    storage.entries.set("sess-a", entryFor(seeded(9, 500), 777));

    keeper.flush();

    // Untouched: the frozen copy did not overwrite the newer one.
    expect(storage.entries.get("sess-a")?.snapshot.oldest).toBe(500);
    keeper.stop();
  });

  it("writes the tracked stores on flush, stamped with the session's live epoch", () => {
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper(storage, undefined);
    keeper.track("sess-a", seeded(3, 10));
    keeper.track("sess-b", seeded(3, 50));

    keeper.flush();

    expect(storage.entries.get("sess-a")?.snapshot.oldest).toBe(10);
    expect(storage.entries.get("sess-b")?.snapshot.oldest).toBe(50);
    expect(storage.entries.get("sess-a")?.snapshot.serverEpoch).toBe(999);
    keeper.stop();
  });

  it("persists only the newest `lines` of a long store", () => {
    // A bound rather than the whole store: the cost is a repeated serialize on a
    // device that may already be under memory pressure, and the screen plus
    // recent history is what a returning user needs.
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper({ ...storage, lines: 4 }, undefined);
    keeper.track("sess-a", seeded(20, 0));

    keeper.flush();

    const snap = storage.entries.get("sess-a")?.snapshot;
    expect(snap?.lines.length).toBe(4);
    expect(snap?.oldest).toBe(16);
    expect(snap?.highest).toBe(19);
    keeper.stop();
  });

  it("refuses to write a session whose epoch is unknown", () => {
    // A snapshot that could not be verified on the way back in is not worth
    // writing on the way out; this is the same decision as the hydrate-side
    // discard, made one step earlier so the bad entry never exists.
    serverEpochOf.mockReturnValue(0);
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper(storage, undefined);
    keeper.track("sess-a", seeded(3, 10));

    keeper.flush();

    expect(storage.entries.size).toBe(0);
    keeper.stop();
  });

  it("does not overwrite a good entry with an empty store", () => {
    // A store that was just reset (a server restart) must not erase the entry.
    // The stale entry that survives instead is self-invalidating, because its
    // epoch no longer matches — which is why the epoch is persisted at all.
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage({ "sess-a": entryFor(seeded(5, 200), 777) });
    const keeper = createScrollbackKeeper(storage, undefined);
    keeper.track("sess-a", new LineStore());

    keeper.flush();

    expect(storage.entries.get("sess-a")?.snapshot.oldest).toBe(200);
    keeper.stop();
  });

  it("survives a save that throws (quota, private mode) and retries later", () => {
    // The watermark means "this is on disk". Recording one for a failed write is
    // how persistence stopped silently: the background pass then skipped the
    // session until its output advanced again.
    serverEpochOf.mockReturnValue(999);
    let attempts = 0;
    const storage = fakeStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const keeper = createScrollbackKeeper(
      {
        ...storage,
        save: (id, entry) => {
          attempts++;
          if (attempts === 1) {
            throw new Error("quota exceeded");
          }
          storage.entries.set(id, entry);
        },
      },
      undefined,
    );
    keeper.track("sess-a", seeded(3, 10));

    keeper.flush();
    expect(storage.entries.size).toBe(0);
    // Said so, rather than failing mutely.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not persist scrollback"));
    warn.mockRestore();
    // No watermark was recorded, so the SAME unchanged store is retried rather
    // than the session being treated as already saved.
    keeper.flush();
    expect(storage.entries.get("sess-a")?.snapshot.oldest).toBe(10);
    keeper.stop();
  });

  it("retries an unchanged store on the TIMER after a failed save", () => {
    // The stronger half of the same property: `flush` is unconditional-ish (the
    // lifecycle path), but the background pass keys on the watermark, and it is
    // the pass that runs while a page sits open. A failed write must leave the
    // session eligible for it with no further output at all.
    vi.useFakeTimers();
    serverEpochOf.mockReturnValue(999);
    let attempts = 0;
    const storage = fakeStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const keeper = createScrollbackKeeper(
      {
        ...storage,
        saveIntervalMs: 1000,
        save: (id, entry) => {
          attempts++;
          if (attempts < 3) {
            throw new Error("quota exceeded");
          }
          storage.entries.set(id, entry);
        },
      },
      undefined,
    );
    keeper.track("sess-a", seeded(3, 10));

    vi.advanceTimersByTime(3000);

    expect(attempts).toBe(3);
    expect(storage.entries.get("sess-a")?.snapshot.oldest).toBe(10);
    warn.mockRestore();
    keeper.stop();
  });

  it("saves on its own timer, so a killed tab has a recent snapshot", () => {
    // pagehide is documented as not guaranteed, and a tab the browser kills runs
    // nothing at all. The timer is the only thing standing between that and no
    // snapshot whatsoever.
    vi.useFakeTimers();
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper({ ...storage, saveIntervalMs: 1000 }, undefined);
    const store = seeded(3, 10);
    keeper.track("sess-a", store);

    vi.advanceTimersByTime(1000);
    expect(storage.entries.get("sess-a")?.snapshot.highest).toBe(12);

    store.applyScroll({
      type: "scroll",
      firstIndex: 13,
      lines: [[{ t: "more", f: -1, b: -1, a: 0, uc: -1 }]],
    });
    vi.advanceTimersByTime(1000);
    expect(storage.entries.get("sess-a")?.snapshot.highest).toBe(13);
    keeper.stop();
  });

  it("skips a session on the timer when its content did not advance", () => {
    // The background pass runs forever; re-serialising an unchanged tail on
    // every tick would be a continuous cost on the device least able to afford
    // it. The lifecycle flush is the unconditional one.
    vi.useFakeTimers();
    serverEpochOf.mockReturnValue(999);
    let writes = 0;
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper(
      {
        ...storage,
        saveIntervalMs: 1000,
        save: (id, entry) => {
          writes++;
          storage.entries.set(id, entry);
        },
      },
      undefined,
    );
    keeper.track("sess-a", seeded(3, 10));

    vi.advanceTimersByTime(5000);

    expect(writes).toBe(1);
    keeper.stop();
  });

  it("does not re-write a restored store the timer has nothing new for", () => {
    // A hydrated store is already at its snapshot's watermark, so the first
    // background tick after a restore must be free.
    vi.useFakeTimers();
    serverEpochOf.mockReturnValue(777);
    let writes = 0;
    const storage = fakeStorage({ "sess-1": entryFor(seeded(5, 200), 777) });
    const keeper = createScrollbackKeeper(
      {
        ...storage,
        saveIntervalMs: 1000,
        save: (id, entry) => {
          writes++;
          storage.entries.set(id, entry);
        },
      },
      undefined,
    );
    keeper.storeFor("sess-1");

    vi.advanceTimersByTime(3000);

    expect(writes).toBe(0);
    keeper.stop();
  });

  it("stops writing after stop(), so a timer cannot outlive the terminal", () => {
    vi.useFakeTimers();
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper({ ...storage, saveIntervalMs: 1000 }, undefined);
    keeper.track("sess-a", seeded(3, 10));

    keeper.stop();
    vi.advanceTimersByTime(10_000);
    keeper.flush();

    expect(storage.entries.size).toBe(0);
  });
});

describe("scrollback persistence: forgetting", () => {
  it("deletes a closed session's entry and stops saving it", () => {
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage({ "sess-a": entryFor(seeded(5, 200), 777) });
    const keeper = createScrollbackKeeper(storage, undefined);
    keeper.track("sess-a", seeded(3, 10));

    keeper.forget("sess-a");
    keeper.flush();

    expect(storage.dropped).toEqual(["sess-a"]);
    expect(storage.entries.has("sess-a")).toBe(false);
    keeper.stop();
  });

  it("survives a drop that throws", () => {
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper(
      {
        ...storage,
        drop: () => {
          throw new Error("storage unavailable");
        },
      },
      undefined,
    );
    expect(() => {
      keeper.forget("sess-a");
    }).not.toThrow();
    keeper.stop();
  });
});

describe("scrollback persistence: option validation", () => {
  it("ignores an invalid knob with a warning rather than clamping it", () => {
    // Same posture as scrollbackLines. A zero `lines` would persist nothing and a
    // zero `maxAgeMs` would expire everything instantly, so a typo must be
    // reported, not quietly reinterpreted as a durability policy.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    try {
      const keeper = createScrollbackKeeper(
        { ...storage, lines: 0, maxAgeMs: -1, saveIntervalMs: 1.5 },
        undefined,
      );
      keeper.track("sess-a", seeded(3, 10));
      keeper.flush();

      // The default bound applied, so content was still persisted.
      expect(storage.entries.get("sess-a")?.snapshot.lines.length).toBe(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("persistScrollback.lines"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("persistScrollback.maxAgeMs"));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("persistScrollback.saveIntervalMs"),
      );
      keeper.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once when a feature withholds the session id", () => {
    // A session-owning feature that does not pass an id gets a correct but
    // always-empty store, which is a silent opt-out; say so, and say it once
    // rather than per tab.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const keeper = createScrollbackKeeper(fakeStorage(), undefined);
    try {
      keeper.noteMissingSessionId();
      keeper.noteMissingSessionId();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("without a session id"));
    } finally {
      warn.mockRestore();
      keeper.stop();
    }
  });
});

describe("scrollback persistence: the keeper composed with the real store", () => {
  // The tests above drive the keeper against a fake, and the storage tests drive
  // the store against real localStorage. Both passed while the composition was
  // broken: the shipped store swallowed a refused write and returned normally, so
  // the keeper recorded a watermark for a write that never landed and its
  // background pass skipped that session for good. A layer-by-layer suite cannot
  // see that, because the bug lives only where the two meet.
  beforeEach(() => {
    localStorage.clear();
  });

  it("does not record a save the real store refused", async () => {
    const { localScrollbackStorage } = await import("./scrollback-storage.js");
    vi.useFakeTimers();
    serverEpochOf.mockReturnValue(999);
    const keeper = createScrollbackKeeper(
      localScrollbackStorage({ saveIntervalMs: 1000 }),
      undefined,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const store = seeded(3, 10);
    keeper.track("sess-a", store);
    try {
      vi.advanceTimersByTime(1000);
      expect(localStorage.getItem("wt.scrollback.sess-a")).toBeNull();
    } finally {
      setItem.mockRestore();
    }

    // Storage recovers and NO further output arrives. The next background pass has
    // to write anyway, which is only true if the failed attempt recorded nothing.
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem("wt.scrollback.sess-a")).not.toBeNull();
    warn.mockRestore();
    keeper.stop();
  });

  it("round-trips a session through the real store", async () => {
    const { localScrollbackStorage } = await import("./scrollback-storage.js");
    serverEpochOf.mockReturnValue(999);
    const cfg = localScrollbackStorage();
    const writer = createScrollbackKeeper(cfg, undefined);
    writer.track("sess-a", seeded(5, 300));
    writer.flush();
    writer.stop();

    const reader = createScrollbackKeeper(localScrollbackStorage(), undefined);
    const restored = reader.storeFor("sess-a");
    expect(restored.oldestIndex()).toBe(300);
    expect(restored.highestIndex()).toBe(304);
    expect(adoptPersistedEpoch).toHaveBeenCalledWith("sess-a", 999);
    reader.stop();
  });

  it("drops a closed session's entry from the real store", async () => {
    const { localScrollbackStorage } = await import("./scrollback-storage.js");
    serverEpochOf.mockReturnValue(999);
    const keeper = createScrollbackKeeper(localScrollbackStorage(), undefined);
    keeper.track("sess-a", seeded(3, 10));
    keeper.flush();
    expect(localStorage.getItem("wt.scrollback.sess-a")).not.toBeNull();

    keeper.forget("sess-a");

    expect(localStorage.getItem("wt.scrollback.sess-a")).toBeNull();
    keeper.stop();
  });
});

describe("scrollback persistence: the boundaries and the tracking contract", () => {
  it("keeps an entry for a week by default", () => {
    // The library's own durability promise, and the number a storage
    // implementation sweeps its orphans by (scrollback-storage.ts imports this
    // constant so the two cannot drift). A consumer that names no bound gets
    // "back to it on Monday", which is only true at this magnitude.
    vi.useFakeTimers();
    const sixDays = 6 * 24 * 60 * 60 * 1000;
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const recent = createScrollbackKeeper(
      fakeStorage({ "sess-1": entryFor(seeded(5, 200), 777, Date.now() - sixDays) }),
      undefined,
    );
    expect(recent.storeFor("sess-1").highestIndex()).toBe(204);
    recent.stop();

    const stale = createScrollbackKeeper(
      fakeStorage({ "sess-1": entryFor(seeded(5, 200), 777, Date.now() - eightDays) }),
      undefined,
    );
    expect(stale.storeFor("sess-1").highestIndex()).toBe(-1);
    stale.stop();
  });

  it("uses an entry whose age is exactly the bound", () => {
    // A week is the documented promise ("back to it on Monday"), so the entry
    // that is exactly a week old is the one the promise is about. Rejecting at
    // the bound shortens every consumer's stated window by one tick.
    vi.useFakeTimers();
    const entry = entryFor(seeded(5, 200), 777, Date.now() - 1000);
    const keeper = createScrollbackKeeper(
      { ...fakeStorage({ "sess-1": entry }), maxAgeMs: 1000 },
      undefined,
    );

    expect(keeper.storeFor("sess-1").highestIndex()).toBe(204);
    keeper.stop();
  });

  it("says once, not per session, that entries had no server epoch", () => {
    // A tabbed page hydrates one store per tab, so a server that reports no epoch
    // at all produces this for every one of them. A console line per tab is how a
    // real explanation turns into noise nobody reads.
    const storage = fakeStorage({
      "sess-1": entryFor(seeded(5, 200), 0),
      "sess-2": entryFor(seeded(5, 300), 0),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const keeper = createScrollbackKeeper(storage, undefined);
    try {
      keeper.storeFor("sess-1");
      keeper.storeFor("sess-2");

      expect(warn).toHaveBeenCalledTimes(1);
      expect(storage.dropped).toEqual(["sess-1", "sess-2"]);
    } finally {
      warn.mockRestore();
      keeper.stop();
    }
  });

  it("says once, not per attempt, that it could not persist", () => {
    // Storage that is full stays full, and the keeper deliberately keeps retrying
    // on every background pass. One line per retry for the rest of the page's
    // life would bury the one that matters.
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const keeper = createScrollbackKeeper(
      {
        ...storage,
        save: () => {
          throw new Error("quota exceeded");
        },
      },
      undefined,
    );
    try {
      keeper.track("sess-a", seeded(3, 10));
      keeper.flush();
      keeper.flush();
      keeper.flush();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(storage.entries.size).toBe(0);
    } finally {
      warn.mockRestore();
      keeper.stop();
    }
  });

  it("saves a store it created for a session that had nothing stored", () => {
    // storeFor tracks either way: a session whose first run produced no entry is
    // exactly the session whose FIRST snapshot matters most, and a store the
    // keeper handed out but forgot to track would never be written at all.
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper(storage, undefined);
    const store = keeper.storeFor("sess-new");
    store.applyScroll({
      type: "scroll",
      firstIndex: 0,
      lines: [[{ t: "first output", f: -1, b: -1, a: 0, uc: -1 }]],
    });

    keeper.flush();

    expect(storage.entries.get("sess-new")?.snapshot.highest).toBe(0);
    keeper.stop();
  });

  it("treats a store handed to track() as unsaved, even at the watermark it just restored", () => {
    // The kernel calls track() for the store it built itself, which can be a
    // different object holding the same content as the entry storeFor read. The
    // watermark means "this exact store is on disk", so adopting a new store has
    // to clear it or the first background pass skips a session whose store the
    // keeper has never actually written.
    vi.useFakeTimers();
    serverEpochOf.mockReturnValue(777);
    let writes = 0;
    const storage = fakeStorage({ "sess-1": entryFor(seeded(5, 200), 777) });
    const keeper = createScrollbackKeeper(
      {
        ...storage,
        save: (id, entry) => {
          writes++;
          storage.entries.set(id, entry);
        },
      },
      undefined,
    );
    keeper.storeFor("sess-1"); // seeds the watermark at 204
    keeper.track("sess-1", seeded(5, 200)); // same content, a store never written

    keeper.flush();

    expect(writes).toBe(1);
    keeper.stop();
  });

  it("writes nothing for a session tracked after stop()", () => {
    // Every method is documented as safe after stop(), and the kernel's teardown
    // order is not guaranteed against a feature that is still creating stores. A
    // write here would land after the terminal it belongs to stopped existing.
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper(storage, undefined);

    keeper.stop();
    const store = keeper.storeFor("sess-late");
    store.applyScroll({
      type: "scroll",
      firstIndex: 0,
      lines: [[{ t: "too late", f: -1, b: -1, a: 0, uc: -1 }]],
    });
    keeper.flush();

    expect(storage.entries.size).toBe(0);
  });

  it("releases the background timer on stop", () => {
    // stop()'s documented job. A live interval holds its closure — and through it
    // every tracked store — for the rest of the page's life.
    vi.useFakeTimers();
    const keeper = createScrollbackKeeper({ ...fakeStorage(), saveIntervalMs: 1000 }, undefined);
    expect(vi.getTimerCount()).toBe(1);

    keeper.stop();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("scrollback persistence: forgetting a session forgets the watermark too", () => {
  it("saves a session that comes back after a forget, rather than trusting the deleted entry's watermark", () => {
    // The watermark means "these bytes are on disk", and forget() deletes the
    // entry -- so the claim is false the moment it does. A session id can come
    // back: a consumer that names its sessions and restarts one reuses the name,
    // and the unmanaged terminal's id is a stable per-tab id by design. A
    // watermark that outlived its entry then matches the returning store's
    // highest index, the background pass skips the session, and it persists
    // nothing at all while believing it already has -- the same failure shape the
    // module documents for a failed save.
    serverEpochOf.mockReturnValue(999);
    const storage = fakeStorage();
    const keeper = createScrollbackKeeper(storage, undefined);

    keeper.track("sess-a", seeded(3, 10));
    keeper.flush();
    expect(storage.entries.get("sess-a")?.snapshot.highest).toBe(12);

    keeper.forget("sess-a");
    expect(storage.entries.has("sess-a")).toBe(false);

    // The id comes back, and its store reaches the same absolute index the
    // deleted entry had recorded (a restarted server begins again near 0, so the
    // indices a new session prints are the ones an old entry already claimed).
    const returned = keeper.storeFor("sess-a");
    returned.applyScroll({
      type: "scroll",
      firstIndex: 10,
      lines: Array.from({ length: 3 }, (_, i) => [
        { t: `L${String(10 + i)}`, f: -1, b: -1, a: 0, uc: -1 },
      ]),
    });
    expect(returned.highestIndex()).toBe(12);

    keeper.flush();

    expect(storage.entries.get("sess-a")?.snapshot.highest).toBe(12);
    keeper.stop();
  });
});
