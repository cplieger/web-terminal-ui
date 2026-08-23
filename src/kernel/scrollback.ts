// Scrollback persistence: the kernel's half of CreateTerminalOptions.
// persistScrollback.
//
// The split is mechanism here, storage in the consumer. The engine supplies the
// data (LineStore.snapshot / LineStore.fromSnapshot, plain structuredClone-safe
// objects) and the identity of the server process it belongs to
// (connection.serverEpochOf / adoptPersistedEpoch); this module owns WHEN a
// snapshot is taken, WHETHER a stored one may be trusted, and the age bound. The
// consumer owns where the bytes live, because a library that opened its own
// IndexedDB would hold a connection that costs bfcache eligibility — which this
// kernel depends on — and because how long a terminal's output may sit on disk
// is an application decision.
//
// It serves both compositions through one object: the kernel hydrates its
// implicit store for a single unmanaged terminal, and a session-owning feature
// gets a hydrated store per session from ctx.newLineStore(sessionId). Anything
// tracked here is saved; nothing else is.

import { LineStore, connection } from "@cplieger/web-terminal-engine";
import { positiveIntOption } from "./options.js";
import type { ScrollbackPersistence } from "./types.js";

/**
 * Newest lines persisted per session when the consumer names no bound.
 *
 * 200, not the store's own cap. The closest precedent is VS Code's
 * `terminal.integrated.persistentSessionScrollback`, which restores 100 lines by
 * default — evidence that the screen plus recent history is what a returning user
 * needs, and that a full buffer is not. 200 gives headroom over that while keeping
 * the cost honest: measured on the real stored envelope, 200 lines is ~24 K
 * characters plain and ~60 K coloured, serialising in under a millisecond, against
 * ~122 K / ~298 K and up to 4 ms at 1000. Since a write happens on every
 * backgrounding and on a timer while output advances, that difference is paid
 * repeatedly on the device this feature exists for.
 */
const DEFAULT_PERSIST_LINES = 200;
/** How long a stored entry may be used. A week covers "back to it on Monday"
 *  while keeping an abandoned session's output from living indefinitely.
 *
 *  Exported within the kernel so a storage implementation that must SWEEP its own
 *  orphans (scrollback-storage.ts) bounds them by the same number the keeper
 *  refuses to load past. Two constants here would drift into a store that keeps
 *  entries nothing will ever read, or deletes ones still in use. */
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
   *  process.
   *
   *  Stricter than "a finite number", because this value is adopted as a
   *  session's IDENTITY: the server reports a process-start timestamp in
   *  nanoseconds, so a negative or fractional value cannot have come from one
   *  and is a corrupt or hand-edited entry wearing the shape of a real one.
   *
   *  NOT 0-for-unknown. The engine spells "unknown" as 0 on its own surface and
   *  that is its contract, but inheriting the spelling here put the rejection
   *  value inside the range of accepted values, so `epoch > 0` and `epoch >= 0`
   *  could not differ: at `epoch === 0` both yielded 0 and both were rejected
   *  downstream. Out-of-band restores the distinction, and 0 goes back to being
   *  a value the boundary refuses rather than the way it says no. */
  readonly serverEpoch: number | null;
  /** Still the engine's to parse. `LineStore.fromSnapshot` takes `unknown` and
   *  is the authority on a snapshot's contents (engine store.ts:1584), so a
   *  shape check here would be a second owner of one obligation. */
  readonly snapshot: unknown;
}

/**
 * Read a stored entry, or null when it cannot be used.
 *
 * `unknown` in, because the value has been outside this program's memory and
 * `ScrollbackPersistence.load`'s declared return type is an assumption about a
 * consumer's storage rather than a fact about its contents — the library's own
 * implementation produces one by `JSON.parse`. A `StoredEntry` out, so every
 * later line reads fields instead of re-establishing them.
 *
 * The parameter type carries the caller's proof: `hydrate` must separate "no
 * entry" from "bad entry" before calling, because those two have different
 * handling, so non-nullishness is already established. That is why there is no
 * object test here and why there must not be one — a property read on any other
 * primitive yields undefined and the field checks below reject it, so a `typeof
 * entry !== "object"` test would be a second statement of a thing the signature
 * already guarantees. This function had two of them, one per field it read, and
 * neither could be observed: 15 of the file's 19 surviving mutants were those
 * two guards and their bodies.
 */
function readStoredEntry(entry: NonNullable<unknown>): StoredEntry | null {
  const rec = entry as Record<string, unknown>;
  const savedAt = rec["savedAt"];
  // Finite, not merely a number: the age comparison below is a subtraction, and
  // `Math.abs(Date.now() - NaN) > maxAgeMs` is false, so a NaN timestamp would
  // read as freshly written forever.
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) {
    return null;
  }
  // Read through a nullable cast rather than a typeof test: `?.` is safe on a
  // primitive as well as on null, so one operator covers every shape a stored
  // value can have, and `fromSnapshot` owns what a usable snapshot contains.
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

  /** Load and validate a stored entry, dropping it when it cannot be used.
   *  Returns the hydrated store, or null to start empty and take a full resume.
   *
   *  Every rejection below has that same correct handling, which is why none of
   *  them throws or reports: the worst outcome of starting empty is one slow
   *  restore, and the worst outcome of hydrating something unsound is a terminal
   *  that shows content from a session that no longer exists.
   *
   *  This function owns exactly two decisions and delegates the rest, which is
   *  the point of its shape. It decides whether there is an entry at all, and
   *  whether an entry that parsed may be USED (age, and verifiability). What an
   *  entry's envelope must look like is `readStoredEntry`'s; what a snapshot must
   *  contain is `LineStore.fromSnapshot`'s. Three owners, three depths, no
   *  overlap — the arrangement this module did not have when its two readers each
   *  re-established that the entry was an object. */
  function hydrate(sessionId: string): LineStore | null {
    let raw: unknown;
    try {
      raw = cfg.load(sessionId);
    } catch {
      // Deliberately empty: a seam that threw has told us there is no entry, and
      // `raw` is still undefined, which is exactly what the check below concludes.
      // A `return null` here would be a second owner of "there is no entry".
    }
    // "No entry" is silent and is not a rejection: nothing is dropped, because
    // there is nothing to drop. Every path below this line has an entry to
    // account for. This is also what lets `readStoredEntry` take a non-nullish
    // parameter and therefore need no object test.
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
    if (Math.abs(Date.now() - entry.savedAt) > maxAgeMs) {
      drop(sessionId);
      return null;
    }

    const store = LineStore.fromSnapshot(entry.snapshot, storeCap);
    if (store === null) {
      drop(sessionId);
      return null;
    }

    // Structure checked; now the one rejection that is a real decision rather
    // than a validation, and the reason the epoch is read at the boundary but
    // JUDGED here. An entry with no server epoch cannot be verified against the
    // server it is about to be shown next to, and absolute line indices only
    // mean anything within one server process: a restarted server begins again
    // near 0, so a hydrated store whose epoch cannot be compared would present
    // old content as live AND then refuse the new session's output, because
    // those low indices fall below what the hydrated store believes it evicted.
    // A terminal that fills in slowly is a far better failure than one that is
    // wrong and then permanently blank, so an unverifiable entry is discarded.
    // In practice this never fires: an epoch is missing only from a server that
    // reports none at all, in which case restart detection was never available
    // to anyone.
    //
    // AFTER fromSnapshot, deliberately: reading it earlier would fire the warning
    // below for a snapshot the engine was going to reject anyway.
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
    connection.adoptPersistedEpoch(sessionId, entry.serverEpoch);
    return store;
  }

  function saveOne(sessionId: string, store: LineStore): void {
    // Save under the epoch this session is CURRENTLY known to belong to. A
    // session that has not resumed yet reports 0, and a snapshot that cannot be
    // verified on the way back in is not worth writing on the way out.
    const epoch = connection.serverEpochOf(sessionId);
    if (epoch === 0) {
      return;
    }
    const snapshot = store.snapshot(epoch, lines);
    // null means the store holds nothing. Skipping rather than writing an empty
    // entry is the engine's contract, and it matters here: it is what stops a
    // just-reset store from erasing a good snapshot. The stale entry that
    // survives instead is self-invalidating, because its epoch no longer
    // matches — which is the whole reason the epoch is persisted.
    if (snapshot === null) {
      return;
    }
    try {
      cfg.save(sessionId, { savedAt: Date.now(), snapshot });
    } catch {
      // Nothing was persisted (over quota, storage revoked, an entry too large).
      // Do NOT record a watermark: the whole point of the watermark is "this is on
      // disk", and recording one here made the background pass skip the session
      // until its output advanced again, which is how a full store stopped
      // persisting silently. Warned once, because a feature that quietly does
      // nothing is worse than one that says why.
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

  /** Save a session whose content has advanced since its last recorded save.
   *
   *  Absent from `savedThrough` means never saved, which always counts as
   *  advanced. */
  function saveIfAdvanced(sessionId: string, store: LineStore): void {
    if (store.highestIndex() !== savedThrough.get(sessionId)) {
      saveOne(sessionId, store);
    }
  }

  /** The background pass.
   *
   *  "Advanced" is the highest absolute index, so it misses a redraw that rewrote
   *  rows already on screen without printing new ones. That is a deliberate trade,
   *  not a free one, and the residue is worth naming: usually the re-sent window
   *  corrects a stale row on the next resume, but not when the session kept
   *  printing while the page was gone — the window has moved past that row by then,
   *  and the replay only covers lines above `haveThrough`, so a stale in-place
   *  rewrite (a spinner, a progress line) can sit in restored scrollback until it is
   *  evicted. Bounded by one screen height, and it needs the discard path where no
   *  lifecycle callback ran. Closing it would mean re-serialising the tail on every
   *  screen update, a continuous cost on the device least able to afford it, to fix
   *  at most a screenful of cosmetically stale history. */
  function saveAdvanced(): void {
    for (const [sessionId, store] of tracked) {
      saveIfAdvanced(sessionId, store);
    }
  }

  const timer = setInterval(saveAdvanced, saveIntervalMs);

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
      // Same predicate as the background pass, and NOT an unconditional write.
      // Under the tabs feature every tab gets a store and every one is hydrated at
      // load, but only the ACTIVE session's store advances, because there is one
      // socket. So a page holding another session's store frozen at its load-time
      // content would, on being backgrounded, write that frozen content over a
      // second page's newer entry — with a fresh timestamp, which also made the
      // stale copy the one the sweep preferred. The next discard then restored the
      // rolled-back entry and replayed thousands of lines, which is the exact
      // symptom this feature exists to remove.
      //
      // A store that has not advanced since its last recorded save has nothing new
      // to write, so skipping it loses nothing. What it gives up is refreshing
      // `savedAt` on a long-idle open session, costing one full replay after the
      // age bound expires — the right trade against silently discarding another
      // page's history.
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
      clearInterval(timer);
      tracked.clear();
      savedThrough.clear();
    },
  };
}
