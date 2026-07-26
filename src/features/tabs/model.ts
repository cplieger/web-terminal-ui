// tabs/model.ts — the session MODEL half of the tabs feature: the wire type,
// the per-tab record, the session REST client, the close-tombstone set, and the
// pinned-name helpers. No DOM, no chrome, no kernel context —
// everything here is factory/pure and unit-testable in isolation. The chrome
// halves are strip.ts (desktop) and switcher.ts (mobile); index.ts wires all
// three over the kernel context.

import type { LineStore } from "@cplieger/web-terminal-engine";
import type { SessionInfo } from "@cplieger/web-terminal-engine";
import type { TabHandle } from "../../kernel/types.js";

// One session's wire shape (SessionInfo) is the ENGINE's exported type — the
// same repo as the Go terminal.SessionInfo it mirrors, so the cross-language
// contract has one home. Type-only import: erases at compile, no runtime dep.
export type { SessionInfo };

// The server-side status of a session whose process has exited (mirrors the
// engine's terminal.StatusExited). Such a session is viewable history — its
// final screen replays and the kernel shows "Session ended" — but it can never
// produce output again, so session selection prefers live sessions everywhere.
export const STATUS_EXITED = "exited";

// localStorage key for the last active session id, so a page reload reopens the
// tab the user left on rather than always defaulting to the oldest one.
export const ACTIVE_TAB_KEY = "wt-active-session";

// One-time "swipe to switch" hint, remembered across loads.
export const SWIPE_HINT_KEY = "wt-swipe-hint-seen";

/** localStorage key for the user's tab ARRANGEMENT: the strip's session ids in
 *  the order they are shown, so a drag-reorder (or a Move left/right) survives a
 *  reload instead of snapping back to the server's creation order.
 *
 *  Deliberately client-side, alongside ACTIVE_TAB_KEY: the arrangement is a
 *  per-viewer preference, not a property of the session. Keeping it here costs
 *  no engine API — the session REST surface is a fixed four routes, and adding a
 *  fifth for cosmetics would be a release-noted change to every consumer. The
 *  tradeoff is that two devices do not share an arrangement (each keeps its own),
 *  and that when several windows of the same browser are open the last order
 *  change written wins. */
export const TAB_ORDER_KEY = "wt-tab-order";

/** Bound on the persisted arrangement. Every id is a live PTY server-side, so a
 *  real strip is nowhere near this; the cap is there so a corrupted or hostile
 *  stored value cannot make the restore path do unbounded work. */
export const MAX_PERSISTED_TAB_ORDER = 200;

/** parseTabOrder reads a stored arrangement into a clean id list. Anything the
 *  restore path cannot trust yields [] (or is dropped), because falling back to
 *  the server's creation order is always a valid arrangement: a non-JSON or
 *  non-array value, a non-string or empty entry, and a duplicate id (which would
 *  make the insert position ambiguous) are all discarded rather than repaired.
 *  Pure, so it is testable without a storage backend; the caller owns the
 *  localStorage read and its try/catch. */
export function parseTabOrder(raw: string | null): string[] {
  if (raw === null || raw === "") {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "string" || entry === "" || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    out.push(entry);
    if (out.length >= MAX_PERSISTED_TAB_ORDER) {
      break;
    }
  }
  return out;
}

/** serializeTabOrder encodes an arrangement for storage, capped the same way the
 *  read is so a write can never produce a value its own parser would truncate
 *  differently. */
export function serializeTabOrder(ids: readonly string[]): string {
  return JSON.stringify(ids.slice(0, MAX_PERSISTED_TAB_ORDER));
}

/** orderedInsertIndex returns where `id` belongs in `current` (a list of tab ids
 *  in display order) to honour the stored arrangement `saved`.
 *
 *  This is what makes the restore independent of the order tabs ARRIVE in, which
 *  matters because they arrive from two racing sources: the status stream pushes
 *  a snapshot of the existing sessions on open, and the bootstrap's
 *  GET /api/sessions lands separately — whichever wins, each session is placed
 *  by the saved arrangement rather than by arrival.
 *
 *  An id absent from `saved` goes last: it is a session created after the
 *  arrangement was stored (here or in another browser), and a new tab belongs at
 *  the end. Ids in `current` that are absent from `saved` are transparent to the
 *  scan, so a saved tab can still slot ahead of them. */
export function orderedInsertIndex(
  current: readonly string[],
  saved: readonly string[],
  id: string,
): number {
  const rank = saved.indexOf(id);
  if (rank < 0) {
    return current.length;
  }
  for (let i = 0; i < current.length; i++) {
    const other = saved.indexOf(current[i] ?? "");
    if (other > rank) {
      return i;
    }
  }
  return current.length;
}

export interface Tab {
  id: string;
  /** Local mutation epoch at which this tab was adopted (a monotonic counter,
   *  not a timestamp). The list reconcile snapshots the counter BEFORE its GET
   *  /api/sessions and drops a server-unlisted tab only when the tab predates
   *  that snapshot — a tab born while the list was in flight (the bootstrap's
   *  create racing the SSE stream-open reconcile) is invisible to that stale
   *  listing, and dropping it would cascade into a duplicate replacement
   *  session (the boot double-create bug). */
  born: number;
  /** The title the SERVER resolved for this session: its pinned name, else the
   *  input-derived name, else the program's OSC 0/2 window title, else a
   *  client-pushed label, else the engine's own foreground-process/cwd inference.
   *  Possibly empty only against an engine that has none of those. The displayed
   *  label adds a numbered fallback and de-duplication (see relabelAll in
   *  index.ts). */
  title: string;
  /** The computed, de-duplicated label actually shown in the chrome. */
  display: string;
  createdAt: string;
  store: LineStore;
  el: HTMLElement;
  label: HTMLElement;
  dot: HTMLElement;
  aria: TabHandle;
  scrollTop: number;
  following: boolean;
  /** Sticky: true once this session emitted a genuine activity signal (OSC 9;4).
   *  Its activity dot is shown only while true; a session that never reports
   *  activity (a plain shell) keeps a clean, dot-less tab. Fed from the server's
   *  reportsActivity via applyStatus. */
  reports: boolean;
  /** The user's pinned name (the server's `pinnedTitle` wire field). Outranks
   *  every automatic source in `baseLabel`, and its presence is what enables the
   *  tab menu's "use the automatic name" action. Undefined or empty means the tab
   *  has no user-set name. */
  pinnedTitle?: string | undefined;
  /** Monotonic per-tab rename counter. A rename or clear increments it and
   *  captures the value; the response is applied only if it is still current when
   *  it lands, so a slow failure cannot roll back a newer rename, a later clear,
   *  or a status-stream update from another client. */
  nameSeq: number;
}

/** baseLabel is a tab's label before de-duplication: the user's pinned name if
 *  there is one, otherwise the title the SERVER resolved.
 *
 *  Only two rungs, because the engine now owns every automatic source and folds
 *  them into `title` in precedence order (pinned, input-derived, the program's OSC
 *  window title, a client-pushed label, then its own foreground-process/cwd
 *  inference). A client that re-implemented that ladder could only disagree with
 *  the server and with every other client.
 *
 *  The pin is still checked here, even though the server also folds it into
 *  `title`, so a rename paints immediately instead of waiting for the round trip.
 *
 *  fallback=true marks the "New tab" case so relabelAll leaves untitled tabs
 *  unnumbered. */
export function baseLabel(tab: Tab): { text: string; fallback: boolean } {
  const real = pinnedNameOf(tab) || tab.title.trim();
  return real ? { text: real, fallback: false } : { text: "New tab", fallback: true };
}

/** pinnedNameOf normalizes a tab's pin: trimmed, with a whitespace-only value
 *  reading as absent. One definition, so baseLabel's precedence and the menu's
 *  enabled state can never disagree about whether a tab is pinned. */
function pinnedNameOf(tab: Tab): string {
  return tab.pinnedTitle?.trim() ?? "";
}

/** hasPinnedName reports whether a tab carries a user-set name, which is what
 *  gates the tab menu's "use the automatic name" item. */
export function hasPinnedName(tab: Tab): boolean {
  return pinnedNameOf(tab) !== "";
}

/** The session REST client (GET/POST/DELETE /api/sessions + PUT .../title),
 *  bound to an apiBase. Every call is timeout-bounded: fetch has no default
 *  timeout, and a stalled-but-open server would otherwise leave a bootstrap
 *  list/create await pending forever (the old permanent-loading-overlay wedge;
 *  under the v4 session-owner contract the kernel would eventually see nothing,
 *  but a bounded call recovers into the retry chrome MUCH sooner). */
export interface SessionAPI {
  list(): Promise<SessionInfo[]>;
  create(): Promise<SessionInfo>;
  close(id: string): Promise<void>;
  /** Set the user's pinned name for a session. UNLIKE setTitle this THROWS on
   *  failure: a rename the user typed and that silently did not persist looks
   *  correct until the next reload, so the caller must be able to surface it. */
  setPinnedTitle(id: string, title: string): Promise<void>;
  /** Remove a session's pinned name so its label falls back to the automatic
   *  sources. Throws on failure, for the same reason as setPinnedTitle. */
  clearPinnedTitle(id: string): Promise<void>;
}

const SESSION_API_TIMEOUT_MS = 15000;

/** A non-2xx response from the session API, carrying what the server actually
 *  said instead of flattening it into a message string.
 *
 *  The motivating case is a host that legitimately and TEMPORARILY refuses
 *  session creation: web-terminal-kiro answers 503 with `Retry-After: 5` and a
 *  body message while its tool engine installs the manifest's tools on first
 *  boot. Callers that only saw an `Error` could not tell that apart from a 500,
 *  could not honour the retry hint, and could not repeat the server's
 *  explanation — so the page read as broken while the server was deliberately
 *  waiting. Everything needed to do better is on this error. */
export class SessionAPIError extends Error {
  /** HTTP status, so a caller can branch on 503 (retry) vs 429 vs 5xx. */
  readonly status: number;
  /** Retry-After in milliseconds, or undefined when the server sent no usable
   *  hint. */
  readonly retryAfterMs: number | undefined;
  /** The human-readable message from the error envelope, when the server sent
   *  one (webhttp's `error` field, or `message` elsewhere), so the host's own
   *  explanation can reach the user verbatim. Length-capped because it is
   *  server-controlled text destined for UI chrome. */
  readonly serverMessage: string | undefined;

  constructor(operation: string, status: number, retryAfterMs?: number, serverMessage?: string) {
    super(`web-terminal-ui: session ${operation} failed (${String(status)})`);
    this.name = "SessionAPIError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.serverMessage = serverMessage;
  }
}

const RETRY_AFTER_MAX_MS = 60000;
const SERVER_MESSAGE_MAX_CHARS = 120;

/** Parse Retry-After (RFC 9110): delta-seconds, or an HTTP-date. Undefined for a
 *  missing or unparseable value. Clamped so a buggy or hostile header cannot
 *  park the UI for hours, and floored at 0 so a date already in the past retries
 *  immediately rather than never. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const raw = header.trim();
  if (raw === "") {
    return undefined;
  }
  if (/^\d+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, RETRY_AFTER_MAX_MS);
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) {
    return undefined;
  }
  return Math.min(Math.max(when - Date.now(), 0), RETRY_AFTER_MAX_MS);
}

/** Pull the error envelope's human-readable message out of a failed response,
 *  without letting a non-JSON body, a hostile payload, or a slow read break the
 *  caller: the status and retry hint matter more than the prose, so every failure
 *  here is simply "no server message".
 *
 *  Two field names are accepted. `error` is the field the first-party Go envelope
 *  writes (webhttp's ErrorResponse, `json:"error"`), which is what every server in
 *  this family returns; `message` is the common alternative elsewhere. Preferring
 *  `error` keeps the family's own hosts authoritative. */
async function readServerMessage(r: Response): Promise<string | undefined> {
  try {
    const body: unknown = await r.json();
    if (typeof body !== "object" || body === null) {
      return undefined;
    }
    const fields = body as { error?: unknown; message?: unknown };
    for (const candidate of [fields.error, fields.message]) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return candidate.trim().slice(0, SERVER_MESSAGE_MAX_CHARS);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Build the error for a failed session-API response. */
async function sessionError(operation: string, r: Response): Promise<SessionAPIError> {
  return new SessionAPIError(
    operation,
    r.status,
    parseRetryAfter(r.headers.get("Retry-After")),
    await readServerMessage(r),
  );
}

export function createSessionAPI(apiBase: string): SessionAPI {
  return {
    async list(): Promise<SessionInfo[]> {
      const r = await fetch(apiBase, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw await sessionError("list", r);
      }
      const data: unknown = await r.json();
      // A 200 with a non-array body -- a proxy error object, or a Go server
      // marshaling a nil session slice as JSON `null` -- must not reach the
      // bootstrap's `sessions.length` / `for...of` (or the poll's `list.map`)
      // uncaught. Reject a non-array so the callers' existing catch paths
      // recover (bootstrap -> [], poll -> skip the tick).
      if (!Array.isArray(data)) {
        throw new Error("web-terminal-ui: session list returned a non-array body");
      }
      return data as SessionInfo[];
    },
    async create(): Promise<SessionInfo> {
      const r = await fetch(apiBase, {
        method: "POST",
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw await sessionError("create", r);
      }
      return (await r.json()) as SessionInfo;
    },
    async close(id: string): Promise<void> {
      const r = await fetch(`${apiBase}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw await sessionError("close", r);
      }
    },
    // The user's pinned name. Not best-effort: the caller shows a failure and
    // rolls the optimistic label back, so both of these propagate.
    async setPinnedTitle(id: string, title: string): Promise<void> {
      const r = await fetch(`${apiBase}/${encodeURIComponent(id)}/pinned-title`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw await sessionError("set pinned title", r);
      }
    },
    async clearPinnedTitle(id: string): Promise<void> {
      const r = await fetch(`${apiBase}/${encodeURIComponent(id)}/pinned-title`, {
        method: "DELETE",
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw await sessionError("clear pinned title", r);
      }
    },
  };
}

/** Close tombstones: ids the user closed within the TTL, so a stale server
 *  listing (the SSE re-open snapshot, or the poll's GET /api/sessions) that
 *  predates the server reaping the session does not re-adopt (flash back) the
 *  closed tab. */
export interface Tombstones {
  add(id: string): void;
  /** True while `id` is tombstoned (within the TTL). A hit past the TTL clears
   *  the entry and reports false (the adopt may proceed). */
  active(id: string): boolean;
}

const CLOSE_TOMBSTONE_MS = 15000;

export function createTombstones(ttlMs: number = CLOSE_TOMBSTONE_MS): Tombstones {
  const recentlyClosed = new Map<string, number>();
  return {
    add(id: string): void {
      const now = Date.now();
      // Sweep entries whose window already elapsed (active() treats them as
      // untombstoned anyway) so the map cannot grow without bound over a long
      // session of opens/closes; then record this close.
      for (const [k, t] of recentlyClosed) {
        if (now - t >= ttlMs) {
          recentlyClosed.delete(k);
        }
      }
      recentlyClosed.set(id, now);
    },
    active(id: string): boolean {
      const closedAt = recentlyClosed.get(id);
      if (closedAt === undefined) {
        return false;
      }
      if (Date.now() - closedAt < ttlMs) {
        return true;
      }
      recentlyClosed.delete(id);
      return false;
    },
  };
}

/** MAX_PINNED_NAME bounds a user-typed tab name, mirroring the engine's own
 *  pinned-title cap so the field cannot accept text the server would silently
 *  truncate. A hand-typed label past ~40 characters is never visible in a 300px
 *  chip; 128 is generous. Counted in CODE POINTS, matching the server's runes —
 *  a naive `slice` would count UTF-16 code units and could cut a surrogate pair in
 *  half, sending a lone surrogate to the server. Neither bound is a count of
 *  user-perceived characters (a grapheme cluster is neither, per UAX #29); both
 *  are defensive limits, not display promises. */
export const MAX_PINNED_NAME = 128;

/** sanitizePinnedName cleans a user-typed tab name before it is displayed or
 *  sent: control characters and DEL out (they would inject newlines or escape
 *  sequences into the label and into logs, CWE-117), trimmed, bounded by code
 *  point. Applied client-side rather than trusting the server's round-trip, so
 *  the optimistic label matches what the server will store. */
export function sanitizePinnedName(s: string): string {
  const kept: string[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    kept.push(ch);
  }
  // Trim first, then bound: leading whitespace must not consume the budget.
  return Array.from(kept.join("").trim()).slice(0, MAX_PINNED_NAME).join("");
}
