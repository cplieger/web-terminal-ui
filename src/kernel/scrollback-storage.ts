// A ready-made localStorage implementation of the scrollback-persistence seam.
//
// `persistScrollback` takes the storage rather than a switch, for reasons that
// belong to the library (see ScrollbackPersistence). That is the right boundary
// and it stays. But every consumer that wants the feature then writes the same
// forty lines, and four of them writing it four times is four places for the
// orphan sweep to be forgotten — which is the one part a consumer is most likely
// to skip, because nothing breaks when it is missing until the quota fills.
//
// So this is a supplied implementation, never a default: a consumer still has to
// pass it, which is what keeps the feature off unless someone decided it should
// be on.
//
// The stored value is NOT bare JSON: it is the timestamp on its own line, then
// the snapshot JSON. That is what lets the orphan sweep read one number per entry
// without parsing hundreds of kilobytes of payload on the boot path, and it keeps
// one source of truth per field. This module writes and reads that format and
// nothing else touches it; an unrecognised value is treated as expired, which is
// the same handling an entry from an older release would get anyway.
//
// localStorage rather than IndexedDB, deliberately. It is SYNCHRONOUS, which is
// exactly what the seam needs — hydration has to complete before the resume
// announces what the client holds — so a consumer using this needs no async
// bootstrap at all, and the kernel's boot path is unchanged. It also holds no
// connection open, so it costs nothing in bfcache eligibility, which is the
// reason the library declined to own a database in the first place. The cost is
// the origin quota (~5 MB in Safari), which is why this implementation sweeps and
// caps rather than only writing.

import type { ScrollbackPersistence } from "./types.js";
import type { StoreSnapshot } from "@cplieger/web-terminal-engine";
import { DEFAULT_MAX_AGE_MS } from "./scrollback.js";
import { positiveIntOption } from "./options.js";

/** Key prefix, so a snapshot cannot collide with the host application's own
 *  localStorage keys (a consumer that already persists UI state has some). */
const DEFAULT_PREFIX = "wt.scrollback.";

/**
 * Total budget for everything this store owns, in CHARACTERS.
 *
 * A count cap was the first answer and it was wrong, because it does not bound
 * what actually runs out. Measured on the real stored envelope at the 200-line
 * default: a plain 80-column session is ~24 K characters, a coloured one (a
 * prompt, `ls`, any TUI — several runs per line) ~60 K, and a wide coloured one
 * ~112 K. Both WebKit and Blink account localStorage in UTF-16 code units, so the
 * quota cost is roughly double the character count, and the floor to design
 * against is Safari's ~5 MiB per origin (Chrome and Firefox are commonly ~10 MB).
 *
 * 512 KiB of characters is therefore about 1 MiB of quota, a fifth of that floor,
 * which leaves the host application the rest — and holds roughly eight typical
 * coloured sessions or four wide ones. The earlier 20-entry cap allowed 20 x 112 K
 * = 2.2 M characters, over 4 MiB of quota, so the cap itself guaranteed the
 * refusal it was meant to prevent.
 */
const DEFAULT_MAX_BYTES = 512 * 1024;

export interface LocalScrollbackStorageOptions {
  /** Key prefix (default `"wt.scrollback."`). */
  prefix?: string;
  /** Maximum age of a stored entry. Applied BOTH by this store's sweep and,
   *  because it is passed straight through on the returned object, by the kernel
   *  when it decides whether to load one — so the two cannot disagree. */
  maxAgeMs?: number;
  /** Total budget for everything this store owns, in CHARACTERS (default 512 KiB,
   *  about 1 MiB of localStorage quota since it is accounted in UTF-16). Enforced
   *  by the construction-time sweep AND after every write, oldest entry first. */
  maxBytes?: number;
  /** Newest lines persisted per session; passed through to the kernel. */
  lines?: number;
  /** Background save cadence; passed through to the kernel. */
  saveIntervalMs?: number;
}

/** Read localStorage, or null when it is unavailable.
 *
 *  Not a one-time capability check, and the two failures are not the same one: a
 *  browser set to block site data throws on ACCESS to `window.localStorage`
 *  (Chrome and Firefox), while Safari historically let access succeed in private
 *  browsing and threw on the WRITE instead. Storage can also be revoked
 *  mid-session (a user clearing site data, an ITP eviction), so every operation
 *  asks again and a refusal on the READ side degrades to "nothing stored" rather
 *  than to an exception crossing back into the kernel. */
function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The `savedAt` of a stored value, without parsing the payload.
 *
 *  The sweep needs one number from each entry and the payloads are hundreds of
 *  kilobytes, so parsing every one of them would put tens of milliseconds on the
 *  boot path to produce a timestamp comparison. Hence the stored format below:
 *  the timestamp on its own line, then the snapshot JSON. Reading it is a scan to
 *  the first newline whatever the payload's size or shape.
 *
 *  An unreadable head reads as expired, which is the safe direction: an entry
 *  this module cannot recognise is one the kernel would reject anyway. */
function savedAtOf(value: string): number | null {
  const nl = value.indexOf("\n");
  if (nl <= 0) {
    return null;
  }
  const at = Number(value.slice(0, nl));
  return Number.isFinite(at) ? at : null;
}

/**
 * A `ScrollbackPersistence` backed by `localStorage`, complete with the orphan
 * collection the kernel cannot do for itself.
 *
 * The kernel enforces the age bound on the entries it LOADS, which collects a
 * session the user comes back to. It can do nothing about a session nobody ever
 * opens again — and the case this feature exists for, a browser discarding a tab,
 * is precisely the case where no close handler ran to drop it. Only the store can
 * enumerate, so only the store can sweep, and it does so once at construction:
 * anything past the age bound goes, then the oldest go until the count fits.
 *
 * Pass it straight through:
 *
 * ```ts
 * createTerminal("#terminal", {
 *   features: presetTabbed,
 *   persistScrollback: localScrollbackStorage(),
 * });
 * ```
 */
export function localScrollbackStorage(
  options: LocalScrollbackStorageOptions = {},
): ScrollbackPersistence {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  // Resolved once and used for BOTH the sweep below and the kernel's load-time
  // check, by handing the same number back on the returned object.
  // Through the shared validator, so an invalid value is REPORTED here exactly as
  // it is on the keeper's own options. These two inline ternaries used to swallow
  // it, which made the same typo loud or silent depending only on which of the two
  // option bags the consumer happened to write it in.
  const maxAgeMs = positiveIntOption(
    options.maxAgeMs,
    DEFAULT_MAX_AGE_MS,
    "localScrollbackStorage.maxAgeMs",
  );
  const maxBytes = positiveIntOption(
    options.maxBytes,
    DEFAULT_MAX_BYTES,
    "localScrollbackStorage.maxBytes",
  );

  const keyFor = (sessionId: string): string => prefix + sessionId;

  function remove(key: string): void {
    const ls = store();
    if (!ls) {
      return;
    }
    try {
      ls.removeItem(key);
    } catch {
      /* storage refused the write; nothing useful to do about it */
    }
  }

  /** Every key this store owns, with its timestamp and its size in characters.
   *  Collected by index rather than by `Object.keys`, because localStorage's own
   *  keys are the only authoritative list and an entry written by an older release
   *  may not parse. */
  function ownEntries(): { key: string; savedAt: number | null; chars: number }[] {
    const ls = store();
    if (!ls) {
      return [];
    }
    const found: { key: string; savedAt: number | null; chars: number }[] = [];
    try {
      for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (!key?.startsWith(prefix)) {
          continue;
        }
        const value = ls.getItem(key);
        found.push({
          key,
          savedAt: value === null ? null : savedAtOf(value),
          chars: (value?.length ?? 0) + key.length,
        });
      }
    } catch {
      return found;
    }
    return found;
  }

  /** Bring the store within its budgets: expired entries go first (they are dead
   *  weight whatever the total), then the oldest survivors until the character
   *  budget fits.
   *
   *  Run at construction AND after every successful write, because a sweep that
   *  only runs at construction bounds nothing on a long-lived page: a session
   *  opened after boot is a new key nothing has audited, and the case this store
   *  exists for is precisely the page that stays open for days. */
  function sweep(): void {
    const now = Date.now();
    const live: { key: string; savedAt: number; chars: number }[] = [];
    let total = 0;
    for (const entry of ownEntries()) {
      // An unreadable timestamp is treated as expired: the kernel would refuse
      // the entry anyway, so keeping it only consumes quota.
      if (entry.savedAt === null || Math.abs(now - entry.savedAt) > maxAgeMs) {
        remove(entry.key);
        continue;
      }
      live.push({ key: entry.key, savedAt: entry.savedAt, chars: entry.chars });
      total += entry.chars;
    }
    if (total <= maxBytes) {
      return;
    }
    // Newest first, then keep entries while they fit and drop the rest: an entry
    // the user last saw a minute ago is worth more than one from this morning.
    // Written as "keep what fits" rather than "remove until it fits" because the
    // latter, walking a newest-first list, evicts the newest — which is what the
    // first version did.
    live.sort((a, b) => b.savedAt - a.savedAt);
    let kept = 0;
    for (const entry of live) {
      if (kept + entry.chars <= maxBytes) {
        kept += entry.chars;
        continue;
      }
      remove(entry.key);
    }
  }

  sweep();

  return {
    maxAgeMs,
    ...(options.lines !== undefined ? { lines: options.lines } : {}),
    ...(options.saveIntervalMs !== undefined ? { saveIntervalMs: options.saveIntervalMs } : {}),
    load(sessionId) {
      const ls = store();
      if (!ls) {
        return null;
      }
      let raw: string | null;
      try {
        raw = ls.getItem(keyFor(sessionId));
      } catch {
        return null;
      }
      if (raw === null) {
        return null;
      }
      const savedAt = savedAtOf(raw);
      if (savedAt === null) {
        remove(keyFor(sessionId));
        return null;
      }
      try {
        // The snapshot is returned unvalidated on purpose: the kernel validates
        // every field against the engine's snapshot contract, and duplicating that
        // here would give two places to disagree about what a usable entry is. A
        // parse failure is the one thing this layer must handle, since it throws.
        return { savedAt, snapshot: JSON.parse(raw.slice(raw.indexOf("\n") + 1)) as StoreSnapshot };
      } catch {
        remove(keyFor(sessionId));
        return null;
      }
    },
    save(sessionId, entry) {
      const ls = store();
      if (!ls) {
        // Storage is unavailable, not merely full. Throwing lets the keeper see
        // that nothing was persisted; returning normally made it record a
        // watermark for a write that never happened, after which its background
        // pass skipped the session until output advanced again.
        throw new Error("web-terminal-ui: localStorage is unavailable");
      }
      // The timestamp on its own line, then the snapshot: one source of truth per
      // field, and the sweep above reads the head without parsing the payload.
      const key = keyFor(sessionId);
      const value = `${String(entry.savedAt)}\n${JSON.stringify(entry.snapshot)}`;
      if (value.length + key.length > maxBytes) {
        // One entry larger than the whole budget cannot be stored without evicting
        // everything, and would still not fit. Refuse it and KEEP whatever is
        // already there: a smaller, older snapshot of this session restores
        // something, where an eviction spiral restores nothing.
        throw new Error("web-terminal-ui: scrollback snapshot exceeds the storage budget");
      }
      try {
        ls.setItem(key, value);
      } catch (err) {
        // Over quota, or storage revoked mid-session. Deliberately does NOT delete
        // the previous value: a refused replacement does not invalidate what is
        // already stored, and deleting it turned a transient quota failure into
        // permanent loss of this session's history. Sweep (an expired neighbour may
        // be all that is in the way), retry once, and rethrow if it still will not
        // land, so the keeper does not record a phantom save.
        sweep();
        try {
          ls.setItem(key, value);
        } catch {
          throw err instanceof Error ? err : new Error(String(err));
        }
        return;
      }
      // Enforce the budget against what is now stored, including this write.
      sweep();
    },
    drop(sessionId) {
      remove(keyFor(sessionId));
    },
  };
}
