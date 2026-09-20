// Scrollback persistence: the shell's half of CreateTerminalOptions.
// persistScrollback. The engine supplies the data (LineStore snapshots) and the
// shell supplies the identity of the server process it belongs to (the
// SessionEpochs port); this module owns WHEN a snapshot is taken, WHETHER a
// stored one may be trusted, and the age bound. The consumer owns where the
// bytes live, because a library that opened its own IndexedDB would hold a
// connection that costs bfcache eligibility, which this kernel depends on.

import { LineStore } from "@cplieger/web-terminal-engine";
import { positiveIntOption } from "./options.js";
import type { ScrollbackPersistence } from "./types.js";

/** The connection facts the keeper needs, answered by the shell over every pane's
 *  connection: a tab's store follows the tab into whichever pane shows it. */
export interface SessionEpochs {
  /** Seed the epoch a stored snapshot was taken under, before the session
   *  connects, so the first resumeAck has a value to compare against. */
  adoptPersistedEpoch(sessionId: string, epoch: number): void;
  /** The server epoch the session is currently known to belong to; 0 when it
   *  has not resumed yet. */
  serverEpochOf(sessionId: string): number;
}

/** The timers and clock the keeper runs on: the mounted window's, so the save
 *  cadence and the age check follow the terminal's own clock. */
export interface ScrollbackClock {
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
  readonly Date: Pick<DateConstructor, "now">;
}

/** Newest lines persisted per session when the consumer names no bound. Not the
 *  store's cap: a write happens on every backgrounding and on a timer while
 *  output advances, and 200 lines serialise in under a millisecond (~24 K
 *  characters plain, ~60 K coloured) against up to 4 ms at 1000. VS Code
 *  restores 100 by default. */
const DEFAULT_PERSIST_LINES = 200;
/** How long a stored entry may be used. Exported so a storage implementation
 *  that sweeps its own orphans bounds them by the same number the keeper refuses
 *  to load past. */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Background save cadence while content is advancing. */
const DEFAULT_SAVE_INTERVAL_MS = 10_000;

/** What the kernel drives. Every method is safe to call at any point in the
 *  terminal's life, including after stop(). */
export interface ScrollbackKeeper {
  /** The store for a session: hydrated from storage when a usable entry exists,
   *  otherwise a fresh one. Either way the store is tracked for saving. Seeds
   *  the persisted server epoch, so this MUST be called before that session
   *  connects. */
  storeFor(sessionId: string): LineStore;
  /** Track a store this module did not create (the kernel's implicit store when
   *  nothing was restored for it), so it is saved like any other. It reads as
   *  needing a save, whatever it already holds. */
  track(sessionId: string, store: LineStore): void;
  /** Stop tracking a session and delete its stored entry (a closed tab). */
  forget(sessionId: string): void;
  /** Save every tracked session whose content has advanced since its last
   *  recorded save. For the page-lifecycle callbacks, which are the last chance
   *  rather than an optimisation. */
  flush(): void;
  /** Report that a session withheld its id, so persistence could not apply. */
  noteMissingSessionId(): void;
  /** Release the background timer. */
  stop(): void;
}

/** A stored entry that has been read and proven: every field is what it says, so
 *  nothing downstream re-checks it. `readStoredEntry` is the only constructor,
 *  which is what makes that promise keepable. */
interface StoredEntry {
  /** `Date.now()` at the write. Finite. */
  readonly savedAt: number;
  /** The snapshot's server epoch, or null when the entry names no server
   *  process. A positive integer only: the value is adopted as a session's
   *  IDENTITY (a process-start timestamp in nanoseconds), so a negative or
   *  fractional one is a corrupt entry. Null rather than the engine's
   *  0-for-unknown, which would put the rejection value inside the accepted
   *  range. */
  readonly serverEpoch: number | null;
  /** Still the engine's to parse: `LineStore.fromSnapshot` takes `unknown` and
   *  owns what a snapshot contains. */
  readonly snapshot: unknown;
}

/** Read a stored entry, or null when it cannot be used. The value has been
 *  outside this program's memory, so the declared `load` return type is an
 *  assumption. The parameter type carries the caller's proof of non-nullishness,
 *  and a property read on any other primitive yields undefined and fails the
 *  field checks, so there is no object test here and must not be one. */
// `{}` rather than `NonNullable<unknown>`: the same type, but only the second is
// a type OPERATION, which `no-generated-empty-object-type` reports.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- "any non-nullish value" is the intended type
function readStoredEntry(entry: {}): StoredEntry | null {
  const rec = entry as Record<string, unknown>;
  const savedAt = rec["savedAt"];
  // `Math.abs(Date.now() - NaN) > maxAgeMs` is false, so a NaN timestamp would
  // read as freshly written forever.
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) {
    return null;
  }
  // `?.` is safe on a primitive as well as on null, so one operator covers every
  // shape a stored value can have.
  const snapshot = rec["snapshot"] as Record<string, unknown> | null | undefined;
  const epoch = snapshot?.["serverEpoch"];
  return {
    savedAt,
    serverEpoch:
      typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null,
    snapshot,
  };
}

export function createScrollbackKeeper(
  cfg: ScrollbackPersistence,
  storeCap: number | undefined,
  epochs: SessionEpochs,
  clock: ScrollbackClock,
): ScrollbackKeeper {
  const lines = positiveIntOption(cfg.lines, DEFAULT_PERSIST_LINES, "persistScrollback.lines");
  const maxAgeMs = positiveIntOption(
    cfg.maxAgeMs,
    DEFAULT_MAX_AGE_MS,
    "persistScrollback.maxAgeMs",
  );
  const saveIntervalMs = positiveIntOption(
    cfg.saveIntervalMs,
    DEFAULT_SAVE_INTERVAL_MS,
    "persistScrollback.saveIntervalMs",
  );

  /** Every store that should be saved, by session id. */
  const tracked = new Map<string, LineStore>();
  /** The highest absolute index each session's last save contained, so the
   *  background pass can skip a session whose content has not advanced. Absent
   *  means never saved, which always reads as needing a save. */
  const savedThrough = new Map<string, number>();
  let warnedMissingId = false;
  let warnedNoEpoch = false;
  let warnedSaveFailed = false;
  let stopped = false;

  function newStore(): LineStore {
    return new LineStore(storeCap);
  }

  function drop(sessionId: string): void {
    try {
      cfg.drop(sessionId);
    } catch {
      /* storage unavailable, or the consumer threw: nothing to do about it */
    }
  }

  /** Load a stored entry, dropping it when it cannot be used. Returns the
   *  hydrated store, or null to start empty and take a full resume. No rejection
   *  throws or reports: starting empty costs one slow restore, while hydrating
   *  something unsound shows content from a session that no longer exists. This
   *  decides whether an entry exists and whether it may be USED (age,
   *  verifiability); the envelope is `readStoredEntry`'s and the snapshot's
   *  contents are the engine's. */
  function hydrate(sessionId: string): LineStore | null {
    let raw: unknown;
    try {
      raw = cfg.load(sessionId);
    } catch {
      // A seam that threw has said there is no entry; `raw` is still undefined.
    }
    // No entry is not a rejection: nothing is dropped.
    if (raw === null || raw === undefined) {
      return null;
    }

    const entry = readStoredEntry(raw);
    if (entry === null) {
      drop(sessionId);
      return null;
    }

    // Distance in either direction: a clock that moved backwards would otherwise
    // leave an entry whose age never reaches the bound.
    if (Math.abs(clock.Date.now() - entry.savedAt) > maxAgeMs) {
      drop(sessionId);
      return null;
    }

    const store = LineStore.fromSnapshot(entry.snapshot, storeCap);
    if (store === null) {
      drop(sessionId);
      return null;
    }

    // Absolute line indices only mean anything within one server process: a
    // restarted server begins near 0, so a store whose epoch cannot be compared
    // would show old content as live AND refuse the new output as already
    // evicted. Judged AFTER fromSnapshot so the warning never fires for a
    // snapshot the engine was going to reject anyway.
    if (entry.serverEpoch === null) {
      if (!warnedNoEpoch) {
        warnedNoEpoch = true;
        console.warn(
          "web-terminal-ui: discarding persisted scrollback with no server epoch (this server does not report one, so a restart cannot be detected)",
        );
      }
      drop(sessionId);
      return null;
    }

    // The epoch must reach the connection layer BEFORE this session's resume, or
    // the first resumeAck records it with nothing to compare against and a
    // restart goes undetected for exactly the content that needed checking.
    epochs.adoptPersistedEpoch(sessionId, entry.serverEpoch);
    return store;
  }

  function saveOne(sessionId: string, store: LineStore): void {
    // Save under the epoch this session is CURRENTLY known to belong to. A
    // session that has not resumed yet reports 0, and a snapshot that cannot be
    // verified on the way back in is not worth writing on the way out.
    const epoch = epochs.serverEpochOf(sessionId);
    if (epoch === 0) {
      return;
    }
    const snapshot = store.snapshot(epoch, lines);
    // An empty store writes nothing, so a just-reset store cannot erase a good
    // snapshot; the stale entry's epoch no longer matches, which invalidates it.
    if (snapshot === null) {
      return;
    }
    try {
      cfg.save(sessionId, { savedAt: clock.Date.now(), snapshot });
    } catch {
      // No watermark: recording one here made the background pass skip a session
      // whose store never reached disk until its output advanced again.
      if (!warnedSaveFailed) {
        warnedSaveFailed = true;
        console.warn(
          "web-terminal-ui: could not persist scrollback (storage full or unavailable); the terminal is unaffected and will keep retrying",
        );
      }
      return;
    }
    savedThrough.set(sessionId, snapshot.highest);
  }

  /** Save a session whose content has advanced since its last recorded save;
   *  never saved always counts as advanced. */
  function saveIfAdvanced(sessionId: string, store: LineStore): void {
    if (store.highestIndex() !== savedThrough.get(sessionId)) {
      saveOne(sessionId, store);
    }
  }

  /** The background pass. "Advanced" is the highest absolute index, so an
   *  in-place rewrite of rows already on screen (a spinner, a progress line) can
   *  sit stale in restored scrollback until evicted, bounded by one screen height.
   *  Closing that would re-serialise the tail on every screen update. */
  function saveAdvanced(): void {
    for (const [sessionId, store] of tracked) {
      saveIfAdvanced(sessionId, store);
    }
  }

  const timer = clock.setInterval(saveAdvanced, saveIntervalMs);

  return {
    storeFor(sessionId) {
      const restored = hydrate(sessionId);
      const store = restored ?? newStore();
      tracked.set(sessionId, store);
      if (restored !== null) {
        // A restored store's content IS the entry that was just read, so seed the
        // watermark to stop the first background pass from rewriting a
        // byte-identical entry. Nothing else may seed it: an unsaved store must
        // read as needing a save, whatever it already holds.
        savedThrough.set(sessionId, restored.highestIndex());
      }
      return store;
    },
    track(sessionId, store) {
      tracked.set(sessionId, store);
      savedThrough.delete(sessionId);
    },
    forget(sessionId) {
      tracked.delete(sessionId);
      savedThrough.delete(sessionId);
      drop(sessionId);
    },
    flush() {
      if (stopped) {
        return;
      }
      // NOT an unconditional write: only a shown session's store advances, and a
      // page writing another session's load-time content over a second page's
      // newer entry (with a fresh timestamp) rolled that entry back. The cost is
      // one full replay for a long-idle session after the age bound expires.
      for (const [sessionId, store] of tracked) {
        saveIfAdvanced(sessionId, store);
      }
    },
    noteMissingSessionId() {
      if (warnedMissingId) {
        return;
      }
      warnedMissingId = true;
      console.warn(
        "web-terminal-ui: persistScrollback is enabled but a feature called ctx.newLineStore() without a session id, so that session's scrollback is not persisted",
      );
    },
    stop() {
      stopped = true;
      clock.clearInterval(timer);
      tracked.clear();
      savedThrough.clear();
    },
  };
}
