// tabs/model.ts — the session MODEL half of the tabs feature: the wire type,
// the per-tab record, the session REST client, the close-tombstone set, and the
// pinned-name helpers. No DOM, no chrome, no kernel context —
// everything here is factory/pure and unit-testable in isolation. The chrome
// halves are strip.ts (desktop) and switcher.ts (mobile); index.ts wires all
// three over the kernel context.

import type { LineStore } from "@cplieger/web-terminal-engine";
import type { SessionInfo } from "@cplieger/web-terminal-engine";
import type { ViewMemory } from "@cplieger/web-terminal-engine";
import type { TabHandle } from "../../kernel/types.js";

// One session's wire shape (SessionInfo) is the ENGINE's exported type — the
// same repo as the Go terminal.SessionInfo it mirrors, so the cross-language
// contract has one home. Type-only import: erases at compile, no runtime dep.
export type { SessionInfo };

/** A status record as the tabs feature consumes it: the session's REST wire
 *  shape plus the percentage that exists only on the status STREAM
 *  (SessionStatus.progressValue). Both status sources flow through one code path
 *  this way, and the optionality is meaningful: the polling fallback lists
 *  SessionInfo with no percentage at all, which means "no information" and must
 *  not be read as "the percentage was cleared". */
export type StatusRecord = SessionInfo & { readonly progressValue?: number };

// The status vocabulary, module-private on purpose: every consumer asks one of
// the predicates below (isEndedStatus / statusRevealsDot / isCueStatus /
// statusPhrase) instead of comparing strings itself, so a status's
// MEANING has exactly one home. Adding a status means adding it to the
// predicates that should include it, not to a comparison at each call site.
//
// The server-side status of a session whose process has exited (mirrors the
// engine's terminal.StatusExited). Such a session is viewable history — its
// final screen replays and the kernel shows "Session ended" — but it can never
// produce output again, so session selection prefers live sessions everywhere.
const STATUS_EXITED = "exited";

/** The other end-of-process status (engine terminal.StatusCrashed): a non-zero
 *  exit status, or a terminating signal the program was not asked for. A
 *  server-initiated end (a closed tab, the idle reaper, a server shutdown) is
 *  reported as "exited", so a routine restart never paints as a failure. Like
 *  "exited" it is terminal: nothing clears it, and it outranks every progress
 *  state. */
const STATUS_CRASHED = "crashed";

/** OSC 9;4 progress state 2, the error state (iTerm2 semantics). A STATE, not an
 *  event: it persists until the program reports another progress state, or the
 *  process dies (which outranks it). */
const STATUS_FAILED = "failed";

/** OSC 9;4 progress state 4, the warning state (iTerm2 semantics; ConEmu calls
 *  the same state paused). Same persistence rules as STATUS_FAILED. */
const STATUS_WARNING = "warning";

/** isEndedStatus reports whether a status means the session's process is GONE,
 *  whichever way it went. Session selection asks this — not `=== "exited"` —
 *  because a crashed session is exactly as dead as an exited one: reloading onto
 *  either is the stuck-loading wedge the bootstrap's live-session preference
 *  exists to avoid. */
export function isEndedStatus(status: string): boolean {
  return status === STATUS_EXITED || status === STATUS_CRASHED;
}

/** The statuses whose dot must be visible even if the server never set the
 *  session's sticky reportsActivity flag. `warning` and `failed` are OSC 9;4
 *  states, so the flag is set for them in practice and this only floors it;
 *  `crashed` is the case that needs it — a plain shell that dies badly has
 *  reported no activity in its life, and its red dot is the one thing the user
 *  most needs to see. An ordinary `exited` deliberately stays gated: a clean end
 *  is not news. */
export function statusRevealsDot(status: string): boolean {
  return status === STATUS_WARNING || status === STATUS_FAILED || status === STATUS_CRASHED;
}

/** statusPhrase is the human wording for a status, used for BOTH the dot's hover
 *  tooltip and the suffix in a tab's accessible name — one definition, so what a
 *  sighted user reads on hover and what a screen reader announces cannot
 *  disagree. An unknown status (a newer server: the wire is parsed, not
 *  validated) falls back to the raw value rather than being hidden. */
export function statusPhrase(status: string): string {
  switch (status) {
    case "working":
      return "working";
    case STATUS_WARNING:
      return "warning reported";
    case STATUS_FAILED:
      return "error reported";
    case "input":
      return "waiting for you";
    case "done":
      return "turn finished";
    case STATUS_EXITED:
      return "session ended";
    case STATUS_CRASHED:
      return "process crashed";
    case "idle":
    case "":
      return "idle";
    default:
      return status;
  }
}

/** PROGRESS_ABSENT is "no percentage" (the engine's own marker). Absence is -1,
 *  never 0: a session that reported nothing is not a session at 0%, and the two
 *  must render differently (no bar at all vs an empty bar). */
export const PROGRESS_ABSENT = -1;

/** normalizeProgress cleans a percentage off the wire into PROGRESS_ABSENT or
 *  0-100. The engine already clamps, so this is the untrusted-JSON guard: a
 *  string, a NaN, an Infinity or a negative all mean "absent" rather than
 *  throwing or rendering a nonsense bar, and an out-of-range high value clamps
 *  rather than overflowing the chip. */
export function normalizeProgress(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return PROGRESS_ABSENT;
  }
  return Math.min(100, Math.round(value));
}

/** statusOwnsProgress reports whether a status is one the program's OSC 9;4
 *  progress channel is currently speaking through. Only these may show a bar.
 *
 *  The tab keeps the last percentage the server reported, and the server keeps
 *  sending it (correctly — a progress state persists until the program changes
 *  it), so this predicate is what stops that value from being painted underneath a
 *  status that came from somewhere else entirely. `input` and `done` come from the
 *  NOTIFICATION channel; `idle` is the absence of a progress state; `exited` and
 *  `crashed` are process facts. A percentage under any of those is a claim about
 *  a different channel than the one the reader is looking at. */
export function statusOwnsProgress(status: string): boolean {
  return status === "working" || status === STATUS_FAILED || status === STATUS_WARNING;
}

/** renderedProgress is the percentage a status may actually SHOW. The tab keeps
 *  the last value the server reported; this is the one place that decides whether
 *  it is still meaningful, so the clearing rule has a single home.
 *
 *  Two things clear it, and both are honest — neither invents a state change the
 *  program never made:
 *
 *   1. The program's own clear: OSC 9;4;0, or the abbreviated OSC 9;4, which the
 *      engine reports as percentage -1. That is the spec path, and the value
 *      arriving as PROGRESS_ABSENT is all it takes.
 *   2. The status is not one the progress channel owns (statusOwnsProgress) —
 *      checked here. That covers a dead process, whose progress is meaningless
 *      and which nothing will ever clear, and equally a `done` or `input` latch,
 *      which is the notification channel talking. Measured: kiro-cli parks
 *      progress state 4 at its context-usage percentage when idle, so a finished
 *      turn used to paint a green done dot beside a 72% bar — a number about the
 *      context window, rendered as how far along the work was.
 *
 *  There is deliberately NO third clear. 100% is not special: state 1 at 100 is a
 *  STATE that persists, and the progress channel carries no "done" signal at all,
 *  so a program that pins 100 and goes quiet keeps its bar — the same "persists
 *  until the program says otherwise" property the indeterminate state already has.
 *  There is also no TIMEOUT: a timer would assert a change the program never
 *  reported (Ghostty's ~15s one does, which is why it also asks emitters to
 *  refresh once a second; nothing here requires a keep-alive). */
export function renderedProgress(status: string, progress: number): number {
  return statusOwnsProgress(status) ? progress : PROGRESS_ABSENT;
}

/** tabAccessibleName is a tab's announced name: its rendered label plus the
 *  session's state, and the percentage when one is showing.
 *
 *  The percentage is announced but never DRAWN as text. No terminal emulator puts
 *  a number next to a tab label — Windows Terminal draws a ring over the tab icon,
 *  Ghostty and kitty a bar on a window edge, ConEmu a percentage in the WINDOW
 *  title — and the visible number cost label width in a chip that already shrinks
 *  to a 100px floor. The bar answers "how far" for the eye; this answers it for a
 *  screen reader, which cannot see the bar at all (it is decoration with no text).
 *
 *  Pass PROGRESS_ABSENT for progress to announce the state alone. Callers hand in
 *  renderedProgress's output, so a percentage the tab is not showing is not
 *  announced either. */
export function tabAccessibleName(
  renderedLabel: string,
  status: string,
  progress: number = PROGRESS_ABSENT,
): string {
  const state = statusPhrase(status);
  return progress < 0
    ? `${renderedLabel} — ${state}`
    : `${renderedLabel} — ${state}, ${String(progress)}%`;
}

// localStorage key for the last active session id, so a page reload reopens the
// tab the user left on rather than always defaulting to the oldest one.
export const ACTIVE_TAB_KEY = "wt-active-session";

// One-time "swipe to switch" hint, remembered across loads.
export const SWIPE_HINT_KEY = "wt-swipe-hint-seen";

/** The session statuses that raise the mobile switcher's aggregate attention
 *  cue. The rule is "only states that want the user — it's like a notification":
 *  a background terminal blocked on the user ("input"), one whose turn finished
 *  ("done"), and one whose process died badly ("crashed"). The three animated
 *  progress states are deliberately excluded — working / warning / failed are
 *  ongoing and informational, and an animated dot pinned to the switch button
 *  would nag with nothing to act on. Declared once here so the raise test and
 *  the acknowledgement store cannot disagree about which statuses are
 *  cue-worthy. */
export type CueStatus = "input" | "done" | "crashed";

/** isCueStatus narrows a raw server status to a cue-worthy one. */
export function isCueStatus(status: string): status is CueStatus {
  return status === "input" || status === "done" || status === STATUS_CRASHED;
}

/** localStorage key for the cues this viewer has already SEEN: session id -> the
 *  latched status that was acknowledged.
 *
 *  It has to be remembered, because dismissing the cue does not change the
 *  session: `input` and `done` are LATCHED server-side (the engine clears them
 *  only on the session's next working phase) and the status stream re-delivers
 *  the latch in the snapshot it pushes on every open. So a dismissed dot came
 *  back on the next page load — and, since the snapshot is re-pushed on every
 *  SSE reconnect, on a phone simply returning to a backgrounded page.
 *
 *  Client-side for the same reason as ACTIVE_TAB_KEY: "I have seen this" is a
 *  property of the VIEWER, not of the session. A phone acknowledging a finished
 *  turn must not blank the dot on the desktop watching the same server, so this
 *  needs no engine API. Contrast the tab ARRANGEMENT, which is a property of the
 *  session set and so is the server's (see compareTabOrder): a reorder is meant
 *  to reach the other device, and an acknowledgement is not.
 *
 *  Keyed per session rather than as one latest-wins slot: several background tabs
 *  can hold a latched status at once while the cue only ever shows the newest, so
 *  a single-slot acknowledgement would let every other one re-raise the dot on
 *  the next load. */
export const CUE_SEEN_KEY = "wt-cue-seen";

/** Bound on the acknowledgement map: every key is a live session server-side, so
 *  a real one is nowhere near this, and a corrupted or hostile stored value
 *  cannot make the restore path do unbounded work. */
export const MAX_PERSISTED_CUE_SEEN = 200;

/** parseCueSeen reads stored acknowledgements into a clean map. Anything it
 *  cannot trust is dropped (or, for a broken document, all of it): a lost
 *  acknowledgement only re-lights a dot the user can dismiss again, so degrading
 *  to "nothing acknowledged" is always safe. Pure, so it is testable without a
 *  storage backend; the caller owns the localStorage read and its try/catch. */
export function parseCueSeen(raw: string | null): Map<string, CueStatus> {
  const out = new Map<string, CueStatus>();
  if (raw === null || raw === "") {
    return out;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  // Arrays and null are typeof "object" too, and neither is a cue map.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return out;
  }
  for (const [id, status] of Object.entries(data)) {
    if (id === "" || typeof status !== "string" || !isCueStatus(status)) {
      continue;
    }
    out.set(id, status);
    if (out.size >= MAX_PERSISTED_CUE_SEEN) {
      break;
    }
  }
  return out;
}

/** serializeCueSeen encodes acknowledgements for storage. The caller keeps the
 *  live map within the cap (see markCueSeen), so this does not truncate: a silent
 *  truncation here would drop whichever entries the parser happened to read last,
 *  which is the opposite of what an eviction should discard. */
export function serializeCueSeen(seen: ReadonlyMap<string, CueStatus>): string {
  return JSON.stringify(Object.fromEntries(seen));
}

/** TabOrderKey is what the strip's order is decided by: the server's shared
 *  position for the session, its creation timestamp, and its id. Both `Tab` and
 *  the wire `SessionInfo` carry these three fields, so either can be passed
 *  without a projection. */
export interface TabOrderKey {
  readonly id: string;
  readonly createdAt: string;
  /** the server's shared position, absent when the server keeps no order (an
   *  engine before 3.9.0). Explicitly `| undefined` so a Tab, whose field is
   *  always present and sometimes undefined, satisfies this under
   *  exactOptionalPropertyTypes. */
  readonly order?: number | undefined;
}

/** ORDER_ABSENT is the position given to a session the server did not place, so
 *  it sorts after every session the server did. Absent must not read as 0, which
 *  is a real position at the front of the strip. */
const ORDER_ABSENT = Number.MAX_SAFE_INTEGER;

/** createdMillis reads a wire createdAt as a number for comparison. An
 *  unparseable value sorts LAST rather than first: the caller's question is where
 *  a tab belongs in a strip, and the end is the answer that reads as "new" —
 *  putting a tab the client cannot date at the head would rewrite the top of the
 *  strip on the strength of a value it failed to read.
 *
 *  Milliseconds, deliberately, against a wire value carrying nanoseconds: the
 *  server's own tiebreak is the id, this one's is too, and the pair therefore
 *  agree on every input a human can produce. Comparing the STRINGS instead would
 *  be wrong, not merely coarse — Go's RFC 3339 encoding drops trailing zeros
 *  from the fraction, so ".15" sorts before ".1" lexically. */
function createdMillis(raw: string): number {
  const when = Date.parse(raw);
  return Number.isNaN(when) ? Number.MAX_SAFE_INTEGER : when;
}

/** compareTabOrder is the total order the strip is built in: the server's shared
 *  position, then age, then id.
 *
 *  The server owns the arrangement (engine 3.9.0, `PUT /api/sessions/order`), so
 *  a drag on one device moves the tab on every device, and a browser with no
 *  history of this server still opens on the arrangement its owner chose. This
 *  replaced a per-browser `localStorage` arrangement, which by construction could
 *  not travel and which left a second device with no arrangement at all.
 *
 *  Age and id remain, and each answers a case the position cannot: age orders
 *  every session when the server keeps no order (an older engine sends no field,
 *  so all positions are absent and creation order is the honest fallback), and
 *  the id makes the order TOTAL, so two sessions created inside one millisecond
 *  cannot swap places between two runs.
 *
 *  Age is read from the `createdAt` field rather than from the wire SEQUENCE on
 *  purpose. Sessions arrive from two racing sources — the status stream's
 *  snapshot on open, and the bootstrap's GET /api/sessions — so a client that
 *  merges them sees neither source's order, however well each source sorted. */
export function compareTabOrder(a: TabOrderKey, b: TabOrderKey): number {
  const posA = a.order ?? ORDER_ABSENT;
  const posB = b.order ?? ORDER_ABSENT;
  if (posA !== posB) {
    return posA < posB ? -1 : 1;
  }
  const bornA = createdMillis(a.createdAt);
  const bornB = createdMillis(b.createdAt);
  if (bornA !== bornB) {
    return bornA < bornB ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/** orderedInsertIndex returns where `incoming` belongs in `current` (the tabs
 *  already on the strip, in display order) under compareTabOrder: the index of
 *  the first tab that sorts after it, else the end.
 *
 *  This is what makes the strip independent of the order tabs ARRIVE in. Each
 *  insertion goes before the first tab that outranks the new one, which keeps a
 *  list built from an empty strip sorted at every step, so all arrival orders of
 *  one session set converge on the same strip. */
export function orderedInsertIndex(current: readonly TabOrderKey[], incoming: TabOrderKey): number {
  for (let i = 0; i < current.length; i++) {
    const other = current[i];
    if (other !== undefined && compareTabOrder(other, incoming) > 0) {
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
  /** The server's shared position for this session, or undefined against a server
   *  that keeps no order. Updated from every status event, so a reorder made on
   *  another device reaches this strip (see compareTabOrder). */
  order: number | undefined;
  store: LineStore;
  el: HTMLElement;
  label: HTMLElement;
  dot: HTMLElement;
  /** The chip's determinate progress bar (the 2px line on its bottom edge).
   *  Present on every chip, hidden until a percentage exists. */
  progressEl: HTMLElement;
  /** The last OSC 9;4 percentage the server reported for this session, or
   *  PROGRESS_ABSENT. Held raw: whether it is currently SHOWN is a render-time
   *  question (renderedProgress), and the prefix it produces is never stored on
   *  any title field. */
  progress: number;
  aria: TabHandle;
  /** This tab's saved reading position: the absolute LINE at the viewport top
   *  plus its on-screen offset and the follow state, as captureViewMemory()
   *  returned it when the tab was last left. Null for a tab never viewed (and
   *  for one left on the alternate screen, which has no absolute indices worth
   *  remembering) — restoring null means "follow the tail", which is the right
   *  default for a first visit.
   *
   *  NOT a pixel scrollTop, which is what this was until 2026-08: a rebuild has
   *  built only ~301 of up to 5000 rows when the restore lands, so the browser
   *  clamped the offset away, and it stopped meaning the same line as soon as
   *  the tab's session produced output while backgrounded
   *  (engine docs/scroll-position-fidelity.md §1.1). In memory only, like
   *  before: a reload starts every tab following. */
  view: ViewMemory | null;
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
  /** Replace the display order every viewer of this server shares, by sending
   *  every live session id in the wanted order.
   *
   *  THROWS on failure, and the status is the point. A 409 means the server's
   *  session set is not the one the caller listed, so this client has not yet
   *  seen a session created or closed elsewhere; the caller answers it by
   *  re-listing and sending again, not by telling the user. Any other status is a
   *  genuine failure of a reorder the user performed.
   *
   *  Absent from a server before engine 3.9.0, where it answers 404. */
  setOrder(ids: readonly string[]): Promise<void>;
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
    // The shared display order. The path is a literal segment rather than an id,
    // so nothing is interpolated into it.
    async setOrder(ids: readonly string[]): Promise<void> {
      const r = await fetch(`${apiBase}/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: ids }),
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw await sessionError("set order", r);
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
