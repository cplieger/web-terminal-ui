// A supplied localStorage implementation of the scrollback-persistence seam,
// never a default: a consumer passes it, so the feature stays off until someone
// turns it on. It owns the stored format (the timestamp on its own line, then the
// snapshot JSON, so the orphan sweep reads one number per entry without parsing
// the payload) and the sweep the kernel cannot do, since only the store can
// enumerate. localStorage is synchronous, which hydration before the resume
// needs, and holds no connection open, which keeps the page bfcache-eligible.

import type { ScrollbackPersistence } from "./types.js";
import { DEFAULT_MAX_AGE_MS } from "./scrollback.js";
import { positiveIntOption } from "./options.js";

/** Key prefix, so a snapshot cannot collide with the host application's own keys. */
const DEFAULT_PREFIX = "wt.scrollback.";

/**
 * Total budget for everything this store owns, in characters. WebKit and Blink
 * count localStorage in UTF-16 code units, so 512 Ki characters is about 1 MiB,
 * a fifth of Safari's ~5 MiB origin quota: about eight coloured 200-line sessions
 * (~60 K characters each), leaving the host application the rest.
 */
const DEFAULT_MAX_BYTES = 512 * 1024;

/** Options for `localScrollbackStorage`. `maxAgeMs`, `lines` and
 *  `saveIntervalMs` are handed back on the returned `ScrollbackPersistence`, so
 *  the store's sweep and the kernel's load-time check use one number; `maxBytes`
 *  is this store's alone. An invalid value falls back to its default. */
export interface LocalScrollbackStorageOptions {
  /** Key prefix (default `"wt.scrollback."`). */
  prefix?: string;
  /** Maximum age of a stored entry, for both this store's sweep and the kernel's load. */
  maxAgeMs?: number;
  /** Total budget for everything this store owns, in characters (default 512 KiB,
   *  about 1 MiB of quota). Enforced at construction and after every write, oldest first. */
  maxBytes?: number;
  /** Newest lines persisted per session; passed through to the kernel. */
  lines?: number;
  /** Background save cadence; passed through to the kernel. */
  saveIntervalMs?: number;
}

/** localStorage, or null when it is unavailable. Asked on every operation:
 *  blocked site data throws on access, Safari's private mode on the write, and
 *  storage can be revoked mid-session. */
function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The `savedAt` of a stored value read from its first line, or null (expired)
 *  when the head is unreadable. */
function savedAtOf(value: string): number | null {
  const nl = value.indexOf("\n");
  if (nl <= 0) {
    return null;
  }
  const at = Number(value.slice(0, nl));
  return Number.isFinite(at) ? at : null;
}

/** The prefix a store owns, or the default with a warning naming `path`: an
 *  empty prefix would own every key of the origin. */
function ownedPrefix(prefix: string | undefined, path: string): string {
  if (prefix === undefined) {
    return DEFAULT_PREFIX;
  }
  if (typeof prefix !== "string" || prefix === "") {
    console.warn(`web-terminal-ui: ignoring invalid ${path} ${JSON.stringify(prefix)}`);
    return DEFAULT_PREFIX;
  }
  return prefix;
}

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

/** Every key under `prefix`, with its timestamp and its size in characters,
 *  collected before any removal so a removal cannot shift the index walk. */
function ownEntries(prefix: string): { key: string; savedAt: number | null; chars: number }[] {
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

/**
 * Removes every scrollback entry `localScrollbackStorage` saved under the
 * prefix (default `"wt.scrollback."`). A page that turns persistence off calls
 * it at load, so history saved while it was on does not stay in the browser.
 */
export function clearLocalScrollback(options: { prefix?: string } = {}): void {
  for (const entry of ownEntries(ownedPrefix(options.prefix, "clearLocalScrollback.prefix"))) {
    remove(entry.key);
  }
}

/**
 * A `ScrollbackPersistence` backed by `localStorage`. The kernel ages out only
 * the entries it loads; a discarded tab nobody reopens is this store's to
 * collect, so it sweeps at construction and after every write: expired entries,
 * then the oldest until the character budget fits. Pass it as `persistScrollback`.
 */
export function localScrollbackStorage(
  options: LocalScrollbackStorageOptions = {},
): ScrollbackPersistence {
  const prefix = ownedPrefix(options.prefix, "localScrollbackStorage.prefix");
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

  function sweep(): void {
    const now = Date.now();
    const live: { key: string; savedAt: number; chars: number }[] = [];
    for (const entry of ownEntries(prefix)) {
      if (entry.savedAt === null || Math.abs(now - entry.savedAt) > maxAgeMs) {
        remove(entry.key);
        continue;
      }
      live.push({ key: entry.key, savedAt: entry.savedAt, chars: entry.chars });
    }
    // Keep what fits walking newest first, so an eviction takes the oldest.
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
        // Unparsed past JSON: the kernel checks the snapshot against the engine's contract.
        const snapshot: unknown = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
        return { savedAt, snapshot };
      } catch {
        remove(keyFor(sessionId));
        return null;
      }
    },
    save(sessionId, entry) {
      const ls = store();
      if (!ls) {
        // Thrown so the keeper records no save that never happened.
        throw new Error("web-terminal-ui: localStorage is unavailable");
      }
      const key = keyFor(sessionId);
      const value = `${String(entry.savedAt)}\n${JSON.stringify(entry.snapshot)}`;
      if (value.length + key.length > maxBytes) {
        // Refused, keeping the older, smaller snapshot already stored: evicting
        // everything would still not make room.
        throw new Error("web-terminal-ui: scrollback snapshot exceeds the storage budget");
      }
      try {
        ls.setItem(key, value);
      } catch (err) {
        // Over quota or revoked: the stored value stays, a sweep may make room
        // for one retry, and a second refusal is rethrown to the keeper.
        sweep();
        try {
          ls.setItem(key, value);
        } catch {
          throw err instanceof Error ? err : new Error(String(err));
        }
        return;
      }
      sweep();
    },
    drop(sessionId) {
      remove(keyFor(sessionId));
    },
  };
}
