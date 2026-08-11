// @vitest-environment happy-dom
//
// The supplied localStorage store. Its own job is narrow — keys, JSON, and the
// orphan collection the kernel cannot do — so that is what is tested here;
// scrollback.test.ts owns whether an entry may be USED.
//
// The sweep is the part worth testing hardest, because it is the part a consumer
// writing its own store would omit and not notice: nothing breaks when orphans
// accumulate until the origin quota fills, at which point the symptom is "saving
// silently stopped working" in an app that never touched this code.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { LineStore } from "@cplieger/web-terminal-engine";
import { localScrollbackStorage } from "./scrollback-storage.js";
import type { PersistedScrollback } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;

function entryFor(epoch: number, savedAt: number, lines = 3): PersistedScrollback {
  const store = new LineStore();
  store.applyScroll({
    type: "scroll",
    firstIndex: 0,
    lines: Array.from({ length: lines }, (_, i) => [
      { t: `L${String(i)}`, f: -1, b: -1, a: 0, uc: -1 },
    ]),
  });
  const snapshot = store.snapshot(epoch);
  if (snapshot === null) {
    throw new Error("test fixture: the store was empty");
  }
  return { savedAt, snapshot };
}

/** Write an entry the way the store itself does — timestamp line, then snapshot
 *  JSON — so the sweep's bounded head read runs against real stored bytes. */
function seed(sessionId: string, entry: PersistedScrollback): void {
  localStorage.setItem(
    `wt.scrollback.${sessionId}`,
    `${String(entry.savedAt)}\n${JSON.stringify(entry.snapshot)}`,
  );
}

const ownKeys = (): string[] =>
  Object.keys(localStorage)
    .filter((k) => k.startsWith("wt.scrollback."))
    .sort();

beforeEach(() => {
  localStorage.clear();
});

describe("localScrollbackStorage: round trip", () => {
  it("stores and returns an entry under a prefixed, session-keyed name", () => {
    const store = localScrollbackStorage();
    const entry = entryFor(777, Date.now());

    store.save("sess-1", entry);

    expect(ownKeys()).toEqual(["wt.scrollback.sess-1"]);
    expect(store.load("sess-1")).toEqual(entry);
    // The prefix matters: a consumer that already persists UI state in
    // localStorage must not have its own keys collide with these.
    expect(localStorage.getItem("sess-1")).toBeNull();
  });

  it("survives a structured round trip through JSON, runs and all", () => {
    // JSON is the actual serializer here (not structuredClone), so the engine's
    // "plain data only" contract has to hold through it: a -1 colour and an OSC 8
    // URL must come back unchanged.
    const store = localScrollbackStorage();
    const line = new LineStore();
    line.applyScroll({
      type: "scroll",
      firstIndex: 5,
      lines: [[{ t: "x", f: -1, b: 4, uc: -1, a: 5, u: "https://example.test/a" }]],
    });
    const snapshot = line.snapshot(777);
    store.save("sess-1", { savedAt: Date.now(), snapshot: snapshot! });

    expect(store.load("sess-1")?.snapshot.lines).toEqual(snapshot!.lines);
  });

  it("honors a custom prefix", () => {
    const store = localScrollbackStorage({ prefix: "myapp/sb/" });
    store.save("sess-1", entryFor(777, Date.now()));
    expect(localStorage.getItem("myapp/sb/sess-1")).not.toBeNull();
  });

  it("returns null for a session it has never stored", () => {
    expect(localScrollbackStorage().load("nope")).toBeNull();
  });

  it("deletes an entry on drop", () => {
    const store = localScrollbackStorage();
    store.save("sess-1", entryFor(777, Date.now()));
    store.drop("sess-1");
    expect(store.load("sess-1")).toBeNull();
    expect(ownKeys()).toEqual([]);
  });

  it("discards a truncated value rather than throwing at the kernel", () => {
    // Two shapes fail differently and both must be handled: a value with no
    // timestamp line at all, and one whose snapshot half is not JSON.
    for (const bad of ["{ truncated", `${String(Date.now())}\n{ truncated`]) {
      localStorage.setItem("wt.scrollback.sess-1", bad);
      const store = localScrollbackStorage();
      expect(store.load("sess-1")).toBeNull();
      // And removes it, so a corrupt value is not re-read on every load.
      expect(ownKeys()).toEqual([]);
    }
  });

  it("keeps the timestamp out of the payload, so the two cannot disagree", () => {
    // One source of truth per field. The sweep reads the head and the kernel reads
    // the parsed entry; if savedAt lived in both, a rewrite could desync them.
    const store = localScrollbackStorage();
    const at = Date.now();
    store.save("sess-1", entryFor(777, at));
    const raw = localStorage.getItem("wt.scrollback.sess-1") ?? "";
    expect(raw.startsWith(`${String(at)}\n`)).toBe(true);
    expect(raw.slice(raw.indexOf("\n") + 1)).not.toContain("savedAt");
    expect(store.load("sess-1")?.savedAt).toBe(at);
  });

  it("hands the age bound to the kernel, so the sweep and the load agree", () => {
    // One number, two users. Two constants here would drift into a store that
    // keeps entries nothing will read, or deletes ones still in use.
    expect(localScrollbackStorage().maxAgeMs).toBe(7 * DAY);
    expect(localScrollbackStorage({ maxAgeMs: 1234 }).maxAgeMs).toBe(1234);
  });

  it("keeps the whole store inside a fifth of the smallest origin quota", () => {
    // The number is a measurement, not a taste: Safari's ~5 MiB per origin is the
    // floor to design against, localStorage is accounted in UTF-16 so characters
    // cost about two bytes each, and the host application keeps the rest. Pinned
    // so a future `lines` change cannot quietly move it.
    const store = localScrollbackStorage();
    const budgetChars = 512 * 1024;
    for (let i = 0; i < 30; i++) {
      store.save(`s${String(i)}`, entryFor(777, Date.now() + i, 200));
    }
    const chars = Object.keys(localStorage)
      .filter((k) => k.startsWith("wt.scrollback."))
      .reduce((n, k) => n + (localStorage.getItem(k) ?? "").length + k.length, 0);
    expect(chars).toBeLessThanOrEqual(budgetChars);
    expect(chars * 2).toBeLessThanOrEqual((5 * 1024 * 1024) / 4);
  });

  it("passes the kernel's other knobs through untouched", () => {
    const store = localScrollbackStorage({ lines: 250, saveIntervalMs: 5000 });
    expect(store.lines).toBe(250);
    expect(store.saveIntervalMs).toBe(5000);
    // Absent rather than undefined, so the kernel's own defaults apply.
    expect(Object.keys(localScrollbackStorage()).includes("lines")).toBe(false);
  });
});

describe("localScrollbackStorage: orphan collection", () => {
  it("deletes entries past the age bound at construction", () => {
    // The case this feature exists for — a browser discarding a tab — is exactly
    // the case where no close handler ran to drop the entry, so a store that only
    // ever writes accumulates sessions that stopped existing weeks ago.
    seed("old", entryFor(777, Date.now() - 9 * DAY));
    seed("fresh", entryFor(777, Date.now() - 60_000));

    localScrollbackStorage();

    expect(ownKeys()).toEqual(["wt.scrollback.fresh"]);
  });

  it("deletes an entry dated in the future, which a moved clock produces", () => {
    seed("ahead", entryFor(777, Date.now() + 30 * DAY));
    localScrollbackStorage();
    expect(ownKeys()).toEqual([]);
  });

  it("deletes an entry whose timestamp it cannot read", () => {
    // Unreadable reads as expired: the kernel would refuse it anyway, so keeping
    // it only consumes quota. Covers an older release's shape and a value with no
    // head at all.
    localStorage.setItem("wt.scrollback.legacy", JSON.stringify({ snapshot: {} }));
    localStorage.setItem("wt.scrollback.headless", "\nnope");
    localStorage.setItem("wt.scrollback.words", "yesterday\n{}");
    localScrollbackStorage();
    expect(ownKeys()).toEqual([]);
  });

  it("caps total BYTES, not entry count, because bytes are what the quota bounds", () => {
    // A count cap was the first answer and it did not bound what runs out: at the
    // 200-line default a coloured session is ~60 K characters and a wide one
    // ~112 K, and localStorage is accounted in UTF-16, so 20 entries could be over
    // 4 MiB of a ~5 MiB origin quota — the cap guaranteeing the refusal it existed
    // to prevent.
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      seed(`s${String(i)}`, entryFor(777, now - i * 1000, 40));
    }
    const each = (localStorage.getItem("wt.scrollback.s0") ?? "").length;
    expect(each).toBeGreaterThan(100);

    // Room for three entries and change.
    localScrollbackStorage({ maxBytes: each * 3 + 200 });

    // The NEWEST survive: an entry the user last saw a minute ago is worth more
    // than one from this morning.
    const kept = ownKeys();
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.length).toBeLessThanOrEqual(3);
    expect(kept).toContain("wt.scrollback.s0");
    expect(kept).not.toContain("wt.scrollback.s5");
  });

  it("enforces the budget after a WRITE, not only at construction", () => {
    // The sweep used to run once, at construction, so a page that stayed open and
    // opened new sessions blew past its budget with nothing auditing it — and the
    // long-lived page is exactly the case this store exists for.
    const store = localScrollbackStorage({ maxBytes: 4096 });
    for (let i = 0; i < 40; i++) {
      store.save(`s${String(i)}`, entryFor(777, Date.now() + i, 20));
    }
    const total = ownKeys().reduce(
      (n, k) => n + (localStorage.getItem(k) ?? "").length + k.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(4096);
    // And the most recent write survived the eviction it triggered.
    expect(ownKeys()).toContain("wt.scrollback.s39");
  });

  it("refuses a single entry larger than the whole budget instead of evicting everything", () => {
    // An eviction spiral for an entry that still would not fit restores nothing;
    // keeping the smaller entry already stored restores something.
    seed("sess-1", entryFor(777, Date.now(), 3));
    const store = localScrollbackStorage({ maxBytes: 512 });
    expect(() => {
      store.save("sess-1", entryFor(777, Date.now(), 400));
    }).toThrow();
    expect(store.load("sess-1")?.snapshot.lines.length).toBe(3);
  });

  it("leaves other applications' keys alone", () => {
    localStorage.setItem("vibekit.ui-state", "{}");
    localStorage.setItem("unrelated", "x");
    seed("old", entryFor(777, Date.now() - 9 * DAY));

    localScrollbackStorage();

    expect(localStorage.getItem("vibekit.ui-state")).toBe("{}");
    expect(localStorage.getItem("unrelated")).toBe("x");
  });
});

describe("localScrollbackStorage: when storage is unavailable", () => {
  /** Two distinct failures, and they are not the same one. A browser set to block
   *  site data throws on ACCESS to `window.localStorage` (Chrome and Firefox);
   *  Safari historically threw on WRITE in private browsing while access
   *  succeeded. An origin's storage can also be revoked mid-session, so this is
   *  never a one-time capability check. */
  function withLocalStorage(get: () => Storage, body: () => void): void {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get });
    try {
      body();
    } finally {
      if (real) {
        Object.defineProperty(window, "localStorage", real);
      }
    }
  }

  it("constructs, loads and drops without throwing when access throws", () => {
    // The read side must be TOTAL: a browser blocking site data must read as
    // "nothing restored", never as a startup failure. The write side reports
    // instead, so the keeper does not record a save that did not happen — the
    // kernel catches it, which is what keeps the terminal unaffected.
    withLocalStorage(
      () => {
        throw new Error("SecurityError");
      },
      () => {
        const store = localScrollbackStorage();
        expect(store.load("sess-1")).toBeNull();
        expect(() => {
          store.drop("sess-1");
        }).not.toThrow();
      },
    );
  });

  it("reports a refused write and KEEPS the entry already stored", () => {
    // Two bugs in one line, previously. Deleting the good entry turned a transient
    // quota refusal into permanent loss of that session's history; returning
    // normally made the keeper record a watermark for a write that never landed,
    // after which its background pass skipped the session entirely.
    seed("sess-1", entryFor(777, Date.now(), 5));
    const store = localScrollbackStorage();
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      expect(() => {
        store.save("sess-1", entryFor(777, Date.now(), 9));
      }).toThrow();
    } finally {
      setItem.mockRestore();
    }
    // The previous entry is intact and still loadable.
    expect(store.load("sess-1")?.snapshot.lines.length).toBe(5);
  });

  it("throws rather than pretending to save when storage is unavailable", () => {
    withLocalStorage(
      () => {
        throw new Error("SecurityError");
      },
      () => {
        const store = localScrollbackStorage();
        expect(() => {
          store.save("sess-1", entryFor(777, Date.now()));
        }).toThrow();
      },
    );
  });
});
