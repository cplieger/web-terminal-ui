// No DOM and no kernel context in this module; index.ts wires it over the chrome.

import type { LineStore } from "@cplieger/web-terminal-engine";
import type { SessionInfo } from "@cplieger/web-terminal-engine";
import type { ViewMemory } from "@cplieger/web-terminal-engine";
import type { PaneSide, TabHandle } from "../../kernel/types.js";
import type { TabAlias } from "./route.js";

export type { SessionInfo };

/** A status record as the tabs feature consumes it: the REST wire shape plus the
 *  percentage that exists only on the status STREAM. The polling fallback lists
 *  no percentage at all, which means "no information", not "cleared". `alias` is
 *  read as `unknown` because `parseTabAlias` validates it where it enters, and an
 *  engine before 6.2 sends none. */
export type StatusRecord = SessionInfo & {
  readonly progressValue?: number;
  readonly alias?: unknown;
};

// The status vocabulary is module-private so a status's MEANING has one home:
// every consumer asks a predicate below instead of comparing strings. The
// protocol states named below are the built-in sources; a classified OSC 9
// notification may set any status.
//
// An exited session is viewable history that can never produce output again, so
// session selection prefers live sessions everywhere.
const STATUS_EXITED = "exited";

/** A non-zero exit status or an unrequested signal. A server-initiated end (a
 *  closed tab, the reaper, a shutdown) is reported as "exited", so a routine
 *  restart never paints as a failure. Terminal, like "exited". */
const STATUS_CRASHED = "crashed";

/** An error the program reported: OSC 7501 state `error`, or OSC 9;4 progress
 *  state 2 (iTerm2 semantics). A STATE that persists until the program reports
 *  another, or the process dies. */
const STATUS_FAILED = "failed";

/** OSC 9;4 progress state 4, the warning state (iTerm2 semantics). OSC 9;4
 *  cannot set it once the session has sent an OSC 7501 report, until a
 *  terminal reset (RIS): OSC 7501 outranks OSC 9;4 until a RIS forgets it. */
const STATUS_WARNING = "warning";

/** Whether the session's process is GONE, whichever way it went: reloading onto
 *  a crashed session is the same stuck-loading wedge as onto an exited one. */
export function isEndedStatus(status: string): boolean {
  return status === STATUS_EXITED || status === STATUS_CRASHED;
}

/** The statuses whose dot shows even without the sticky reportsActivity flag: a
 *  plain shell that dies badly has reported no activity in its life, and its red
 *  dot is the one thing the user most needs to see. A clean exit is not news. */
export function statusRevealsDot(status: string): boolean {
  return status === STATUS_WARNING || status === STATUS_FAILED || status === STATUS_CRASHED;
}

/** The human wording for a status, for BOTH the dot's tooltip and the tab's
 *  accessible name, so they cannot disagree. A status outside the built-in
 *  vocabulary (a host classifier's, or a newer server's) falls back to the raw
 *  value rather than being hidden. */
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

/** The percentage a status may SHOW. Under any live status it is the server's
 *  value, because the status and the percentage can come from different
 *  channels: OSC 7501 or a notification can set the status while OSC 9;4
 *  supplies the percentage. Two things clear it: the server's PROGRESS_ABSENT
 *  (the program cleared or never reported a percentage, e.g. OSC 9;4;0) and an
 *  ended process, whose percentage nothing will ever clear. No timeout clears
 *  it: 100% is a STATE that persists, and a timeout would assert a change the
 *  program never reported. */
export function renderedProgress(status: string, progress: number): number {
  return isEndedStatus(status) ? PROGRESS_ABSENT : progress;
}

// The secondary-activity vocabulary: a host-reported background activity that
// OUTLIVES the turn, orthogonal to the status above.
const ACTIVITY_WORKING = "working";
// Stopped and resumable; nobody is being asked for anything.
const ACTIVITY_WAITING = "waiting";
const ACTIVITY_INPUT = "input";

/** The wire value in the closed set, or "" for no mark: an unrecognised state
 *  must fail toward NO mark rather than a lit one this build cannot name. */
export function normalizeActivity(value: unknown): string {
  if (value === ACTIVITY_WORKING || value === ACTIVITY_WAITING || value === ACTIVITY_INPUT) {
    return value;
  }
  return "";
}

/** The count off the wire; a non-integer, a negative or an absent value is 0,
 *  which activityPhrase reads as one beside a live state. */
export function normalizeActivityCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

/** The human wording for the mark, for BOTH its tooltip and the tab's accessible
 *  name; "" for no mark. It cannot say "workflow": the channel is generic. */
export function activityPhrase(state: string, count: number): string {
  const normalized = normalizeActivity(state);
  if (normalized === "") {
    return "";
  }
  const n = Math.max(1, normalizeActivityCount(count));
  const subject = `${String(n)} background task${n === 1 ? "" : "s"}`;
  if (normalized === ACTIVITY_WORKING) {
    return `${subject} running`;
  }
  if (normalized === ACTIVITY_WAITING) {
    return `${subject} paused`;
  }
  return `${subject} waiting for you`;
}

/** A tab's announced name: its label, the session's state, and the percentage
 *  when one is showing. The percentage is announced but never DRAWN as text (no
 *  emulator puts a number beside a tab label, and it costs width in a chip that
 *  shrinks to a 100px floor); the bar is decoration a screen reader cannot see.
 *  Pass renderedProgress's output, so an unshown percentage is not announced. A
 *  record rather than positional arguments, because `label` and `status` are
 *  adjacent same-typed strings. */
export function tabAccessibleName(v: {
  readonly label: string;
  readonly status: string;
  readonly progress?: number;
  readonly activity?: string;
  readonly activityCount?: number;
}): string {
  const state = statusPhrase(v.status);
  const progress = v.progress ?? PROGRESS_ABSENT;
  const head = progress < 0 ? `${v.label}, ${state}` : `${v.label}, ${state}, ${String(progress)}%`;
  const activity = activityPhrase(v.activity ?? "", v.activityCount ?? 0);
  return activity === "" ? head : `${head}, ${activity}`;
}

// One-time "swipe to switch" hint, remembered across loads.
export const SWIPE_HINT_KEY = "wt-swipe-hint-seen";

/** The statuses that raise an attention cue: only states that WANT the user, like
 *  a notification. `working` and `warning` are ongoing and informational, so a
 *  dot for them would nag with nothing to act on; `failed` is a parked result the
 *  program does not revisit, so it belongs. Declared once so the raise test, the
 *  acknowledgement and every attention sink cannot disagree. */
export type CueStatus = "input" | "done" | "crashed" | "failed";

/** Severity order, most severe first, AND the complete set isCueStatus tests
 *  against. The browser tab icon can show one state and paints the most severe
 *  unseen cue: a dead process outranks a reported error, which outranks a request
 *  for input, and a finished turn is the mildest thing worth a cue. */
export const CUE_SEVERITY: readonly CueStatus[] = [STATUS_CRASHED, STATUS_FAILED, "input", "done"];

/** isCueStatus narrows a raw server status to a cue-worthy one. */
export function isCueStatus(status: string): status is CueStatus {
  return (CUE_SEVERITY as readonly string[]).includes(status);
}

/** worseCue returns whichever of two cues is more severe; "" means no cue. */
function worseCue(a: CueStatus | "", b: CueStatus | ""): CueStatus | "" {
  if (a === "") {
    return b;
  }
  if (b === "") {
    return a;
  }
  return CUE_SEVERITY.indexOf(a) <= CUE_SEVERITY.indexOf(b) ? a : b;
}

/** The icon variant a cue paints, which is NOT one per status: `crashed` and
 *  `failed` both render --status-failed, so they share one asset. An app ships
 *  one icon per name returned here (see TabsOptions.attentionIcons for the
 *  naming contract those files must satisfy). */
export function cueIconName(status: CueStatus): "input" | "done" | "alert" {
  if (status === "input" || status === "done") {
    return status;
  }
  return "alert";
}

/** The cue statuses meaning the turn is OVER WITHOUT INCIDENT, the only ones a
 *  live background task may blank. `done` is the whole set: every other cue must
 *  reach the viewer AT ONCE, and `failed` is an error the program reported,
 *  not a clean end of the turn. */
const SETTLED_CUES: ReadonlySet<string> = new Set<CueStatus>(["done"]);

/** The status the CUE surfaces see: the session's own, unless a settled turn's
 *  background task is still running, in which case "" (no cue). The status DOT
 *  keeps rendering the real state. */
export function foldedCueStatus(status: string, activity: string): string {
  if (!SETTLED_CUES.has(status) || normalizeActivity(activity) === "") {
    return status;
  }
  return "";
}

/** What the cue fold reads per tab; structural, so a caller passes its own tab
 *  objects. `status` is the FOLDED status (foldedCueStatus). */
interface CueCandidate {
  readonly status: string;
  /** the server's number for that status's occurrence */
  readonly statusSeq: number;
  /** the server-confirmed seen floor */
  readonly seenSeq: number;
  /** this page's optimistic read floor, 0 when none */
  readonly ackSeq: number;
}

/** Whether a session's CURRENT status is a cue no reader has acknowledged; the
 *  one predicate behind the raise and the attention count. The floor is the
 *  higher of what the server confirmed and what this page has already sent, so
 *  a read paints at once and a lagging record cannot relight it. */
export function isUnread<T extends CueCandidate>(
  tab: T,
): tab is T & { readonly status: CueStatus } {
  return isCueStatus(tab.status) && tab.statusSeq > Math.max(tab.seenSeq, tab.ackSeq);
}

/** The unread cues over the tab list: a COUNT for the title and the badge, one
 *  WORST for the icon. A count is set-valued and needs no rule for choosing among
 *  sessions; severity is a total order, so the icon's choice is not arbitrary.
 *  Neither names a session, the standing constraint on a page-wide surface. */
interface CueSummary {
  readonly count: number;
  readonly worst: CueStatus | "";
}

/** Fold the tab list into the one summary every attention surface renders. */
export function summarizeCues(tabs: readonly CueCandidate[]): CueSummary {
  let count = 0;
  let worst: CueStatus | "" = "";
  for (const tab of tabs) {
    if (!isUnread(tab)) {
      continue;
    }
    count += 1;
    worst = worseCue(worst, tab.status);
  }
  return { count, worst };
}

/** A status-occurrence number off the wire: a non-negative safe integer, or null
 *  for anything else, which leaves the tab's value unchanged. */
export function normalizeSeq(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
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

/** A wire createdAt as a number. An unparseable value sorts LAST: the end reads
 *  as "new", where the head would rewrite the top of the strip on a value the
 *  client failed to read. Milliseconds against a nanosecond wire value, because
 *  the id is the tiebreak on both sides; comparing the STRINGS would be wrong,
 *  since Go's RFC 3339 encoding drops trailing zeros and ".15" sorts before ".1". */
function createdMillis(raw: string): number {
  const when = Date.parse(raw);
  return Number.isNaN(when) ? Number.MAX_SAFE_INTEGER : when;
}

/** The total order the strip is built in: the server's shared position, then
 *  age, then id. Age covers a server that keeps no order, and the id makes the
 *  order TOTAL. Age is read from `createdAt` rather than the wire SEQUENCE
 *  because sessions arrive from two racing sources (the stream's snapshot and
 *  the bootstrap's list), so a merged client sees neither source's order. */
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

/** Where `incoming` belongs in `current` under compareTabOrder: before the first
 *  tab that outranks it, else the end, so every arrival order of one session set
 *  converges on the same strip. */
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
  /** The session's public URL name from the server, or undefined when it sent
   *  none (a server before engine 6.2) or one outside the alias grammar; such a
   *  tab has no address of its own. */
  alias: TabAlias | undefined;
  /** The local mutation epoch at which this tab was adopted. The list reconcile
   *  snapshots the counter BEFORE its GET and drops an unlisted tab only when
   *  the tab predates the snapshot: a tab born while the list was in flight is
   *  invisible to that stale listing, and dropping it cascaded into a duplicate
   *  replacement session. */
  born: number;
  /** The title the SERVER resolved: the pinned name, else the program's OSC 0/2
   *  title, else a host-pushed title, else the engine's own inference. The
   *  displayed label adds a numbered fallback and de-duplication. */
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
  /** The last percentage the server reported for this session, or
   *  PROGRESS_ABSENT. Held raw: whether it is currently SHOWN is a render-time
   *  question (renderedProgress). */
  progress: number;
  /** The chip's secondary activity mark (the rounded-square ring beside the
   *  status dot). Present on every chip, and costing no layout until a state
   *  arrives. */
  activityEl: HTMLElement;
  /** The host's secondary activity state for this session, normalised to the
   *  closed set ("" for none). Independent of `status` and of `reports`: a
   *  background task can be running while the turn that launched it is finished. */
  activity: string;
  /** How many sources produced that state, 0 when the server does not count. */
  activityCount: number;
  aria: TabHandle;
  /** This tab's saved reading position as captureViewMemory() returned it when
   *  the tab was last left; null (follow the tail) for a tab never viewed or left
   *  on the alternate screen. NOT a pixel scrollTop: a rebuild has built only
   *  ~301 of up to 5000 rows when the restore lands, so the browser clamped the
   *  offset away, and it stopped meaning the same line once the session produced
   *  output while backgrounded. In memory only. */
  view: ViewMemory | null;
  /** Sticky: true once this session emitted a genuine activity signal (OSC 7501
   *  status, OSC 9;4 progress or a classified OSC 9 notification). Its activity
   *  dot is shown only while true; a session that never reports activity (a
   *  plain shell) keeps a clean, dot-less tab. Fed from the server's
   *  reportsActivity via applyStatus. */
  reports: boolean;
  /** The user's pinned name (the server's `pinnedTitle` wire field). Outranks
   *  every automatic source in `baseLabel`, and its presence is what enables the
   *  tab menu's "use the automatic name" action. Undefined or empty means the tab
   *  has no user-set name. */
  pinnedTitle?: string | undefined;
  /** The server's number for the status this tab holds (0: none yet). */
  statusSeq: number;
  /** The server-confirmed seen floor. Only rises: a record carrying a lower one
   *  is older, never a retraction. */
  seenSeq: number;
  /** This page's optimistic read floor: the occurrence its latest ack sent, 0
   *  when none. A 204 clears it once seenSeq covers it, and a non-404 failure
   *  only while it still holds the failed number; a 404 keeps it until the
   *  vanished tab is removed. */
  ackSeq: number;
  /** The occurrence whose ack last failed with a non-404, 0 when none; the
   *  automatic ack skips it so a failing server sees one PUT per occurrence. */
  failedSeq: number;
  /** The occurrence a banner this page posted for the session belongs to, 0
   *  when none. */
  bannerSeq: number;
  /** The stream epoch at which a status-stream record last updated this tab, 0
   *  when none: a list requested before it is older. */
  streamAt: number;
  /** Monotonic per-tab rename counter. A rename or clear increments it and
   *  captures the value; the response is applied only if it is still current when
   *  it lands, so a slow failure cannot roll back a newer rename, a later clear,
   *  or a status-stream update from another client. */
  nameSeq: number;
}

/** A tab's label before de-duplication: the pinned name, else the title the
 *  SERVER resolved. Only two rungs, because the engine folds every automatic
 *  source into `title` and a client re-implementing that ladder could only
 *  disagree with it. The pin is still read here so a rename paints before the
 *  round trip. fallback=true marks "New tab" so relabelAll leaves it unnumbered. */
export function baseLabel(tab: Tab): { text: string; fallback: boolean } {
  const real = pinnedNameOf(tab) || tab.title.trim();
  return real ? { text: real, fallback: false } : { text: "New tab", fallback: true };
}

/** A tab's pin, trimmed, with a whitespace-only value reading as absent; one
 *  definition so baseLabel and the menu's enabled state cannot disagree. */
function pinnedNameOf(tab: Tab): string {
  return tab.pinnedTitle?.trim() ?? "";
}

/** Whether a tab carries a user-set name, which gates the tab menu's "use the
 *  automatic name" item. */
export function hasPinnedName(tab: Tab): boolean {
  return pinnedNameOf(tab) !== "";
}

/** The realm a session API runs in: the mounted window's `fetch`, its abort
 *  signals and its clock, never the importing page's. */
interface SessionAPIRealm {
  readonly fetch: typeof fetch;
  readonly AbortSignal: typeof AbortSignal;
  readonly Date: typeof Date;
}

/** The session REST client, bound to an apiBase. Every call is timeout-bounded:
 *  fetch has no default timeout, and a stalled-but-open server would leave a
 *  bootstrap await pending forever. */
interface SessionAPI {
  list(): Promise<SessionInfo[]>;
  create(): Promise<SessionInfo>;
  close(id: string): Promise<void>;
  /** Set the user's pinned name. THROWS on failure: a rename that silently did
   *  not persist looks correct until the next reload. */
  setPinnedTitle(id: string, title: string): Promise<void>;
  /** Remove a session's pinned name. Throws on failure, as setPinnedTitle does. */
  clearPinnedTitle(id: string): Promise<void>;
  /** Replace the display order every viewer of this server shares. THROWS on
   *  failure, and the status is the point: a 409 means the caller's session set
   *  is stale, answered by re-listing and sending again, not by telling the user.
   *  A server before the route answers 404. */
  setOrder(ids: readonly string[]): Promise<void>;
  /** The pane layout every viewer of this server shares. Null on 404, a server
   *  before the route, against which the layout runs unpersisted; a throw on any
   *  other non-2xx. */
  getLayout(): Promise<PaneLayout | null>;
  /** Replace the shared pane layout. Throws on non-2xx as `setOrder` does: a 409
   *  means a side names a session that is not live. */
  setLayout(layout: PaneLayout): Promise<void>;
  /** Acknowledge `seq` for every reader. The server keeps the higher floor and
   *  caps it at its own statusSeq, so a resolve confirms the floor reached `seq`
   *  only for a `seq` this page received. Throws a SessionAPIError on non-2xx; a
   *  404 means the session is gone. Sent with `keepalive`, so a read just before
   *  the page goes away still lands. */
  markSeen(id: string, seq: number): Promise<void>;
}

/** The server's pane-layout record: which session each pane shows, the handle's
 *  left share, the pane that receives typing (its session is the active tab), and
 *  whether the split is open. When `open` is false `left` is the one shown session. */
export interface PaneLayout {
  readonly left: string | null;
  readonly right: string | null;
  readonly handle: number;
  readonly selected: PaneSide;
  readonly open: boolean;
}

/** A record read from the wire is a claim until its shape is checked. */
function readPaneLayout(body: unknown): PaneLayout | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const rec = body as Record<string, unknown>;
  const side = (v: unknown): string | null | undefined =>
    v === null ? null : typeof v === "string" ? v : undefined;
  const left = side(rec["left"]);
  const right = side(rec["right"]);
  const handle = rec["handle"];
  const selected = rec["selected"];
  const open = rec["open"];
  if (
    left === undefined ||
    right === undefined ||
    typeof handle !== "number" ||
    !Number.isFinite(handle) ||
    handle < 0 ||
    handle > 1 ||
    (selected !== "left" && selected !== "right") ||
    typeof open !== "boolean"
  ) {
    return null;
  }
  return isConsistentLayout({ left, right, handle, selected, open })
    ? { left, right, handle, selected, open }
    : null;
}

/** The server's own rules for a well-formed record: a closed split shows only its
 *  left side and selects it, one session is never on both sides, and an open split
 *  with one shown side selects that side. */
function isConsistentLayout(l: PaneLayout): boolean {
  if (!l.open) {
    return l.right === null && l.selected === "left";
  }
  if (l.left !== null && l.right !== null) {
    return l.left !== l.right;
  }
  if (l.left !== null) {
    return l.selected === "left";
  }
  if (l.right !== null) {
    return l.selected === "right";
  }
  return true;
}

const SESSION_API_TIMEOUT_MS = 15000;

/** A non-2xx response from the session API, carrying what the server said. A
 *  host may TEMPORARILY refuse session creation (a 503 with `Retry-After` and a
 *  body message while it starts up), and a caller that only saw an `Error`
 *  read that as a broken page. */
export class SessionAPIError extends Error {
  /** HTTP status, so a caller can branch on 503 (retry) vs 429 vs 5xx. */
  readonly status: number;
  /** Retry-After in milliseconds, or undefined without a usable hint. */
  readonly retryAfterMs: number | undefined;
  /** The error envelope's human-readable message, length-capped because it is
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
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const raw = header.trim();
  if (/^\d+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, RETRY_AFTER_MAX_MS);
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) {
    return undefined;
  }
  return Math.min(Math.max(when - now, 0), RETRY_AFTER_MAX_MS);
}

/** The error envelope's human-readable message, or undefined on any failure: the
 *  status and retry hint matter more than the prose. `error` is the first-party
 *  envelope's field and is preferred; `message` is the common alternative. */
async function readServerMessage(r: Response): Promise<string | undefined> {
  try {
    const body: unknown = await r.json();
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
async function failedResponse(
  operation: string,
  r: Response,
  now: number,
): Promise<SessionAPIError> {
  return new SessionAPIError(
    operation,
    r.status,
    parseRetryAfter(r.headers.get("Retry-After"), now),
    await readServerMessage(r),
  );
}

export function createSessionAPI(apiBase: string, realm: SessionAPIRealm): SessionAPI {
  const request = (url: string, init: RequestInit): Promise<Response> =>
    realm.fetch(url, { ...init, signal: realm.AbortSignal.timeout(SESSION_API_TIMEOUT_MS) });
  const sessionError = (operation: string, r: Response): Promise<SessionAPIError> =>
    failedResponse(operation, r, realm.Date.now());
  return {
    async list(): Promise<SessionInfo[]> {
      const r = await request(apiBase, {
        headers: { Accept: "application/json" },
      });
      if (!r.ok) {
        throw await sessionError("list", r);
      }
      const data: unknown = await r.json();
      // A 200 with a non-array body (a proxy error object, a nil slice marshaled
      // as `null`) is a throw the callers' catch paths already recover from.
      if (!Array.isArray(data)) {
        throw new Error("web-terminal-ui: session list returned a non-array body");
      }
      return data as SessionInfo[];
    },
    async create(): Promise<SessionInfo> {
      const r = await request(apiBase, {
        method: "POST",
      });
      if (!r.ok) {
        throw await sessionError("create", r);
      }
      return (await r.json()) as SessionInfo;
    },
    async close(id: string): Promise<void> {
      const r = await request(`${apiBase}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        throw await sessionError("close", r);
      }
    },
    // The user's pinned name. Not best-effort: the caller shows a failure and
    // rolls the optimistic label back, so both of these propagate.
    async setPinnedTitle(id: string, title: string): Promise<void> {
      const r = await request(`${apiBase}/${encodeURIComponent(id)}/pinned-title`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!r.ok) {
        throw await sessionError("set pinned title", r);
      }
    },
    async clearPinnedTitle(id: string): Promise<void> {
      const r = await request(`${apiBase}/${encodeURIComponent(id)}/pinned-title`, {
        method: "DELETE",
      });
      if (!r.ok) {
        throw await sessionError("clear pinned title", r);
      }
    },
    // The shared display order. The path is a literal segment rather than an id,
    // so nothing is interpolated into it.
    async setOrder(ids: readonly string[]): Promise<void> {
      const r = await request(`${apiBase}/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: ids }),
      });
      if (!r.ok) {
        throw await sessionError("set order", r);
      }
    },
    async getLayout(): Promise<PaneLayout | null> {
      const r = await request(`${apiBase}/layout`, {
        headers: { Accept: "application/json" },
      });
      if (r.status === 404) {
        return null;
      }
      if (!r.ok) {
        throw await sessionError("get layout", r);
      }
      const layout = readPaneLayout(await r.json());
      if (layout === null) {
        throw new Error("web-terminal-ui: session layout returned a malformed body");
      }
      return layout;
    },
    async setLayout(layout: PaneLayout): Promise<void> {
      const r = await request(`${apiBase}/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
      });
      if (!r.ok) {
        throw await sessionError("set layout", r);
      }
    },
    async markSeen(id: string, seq: number): Promise<void> {
      const r = await request(`${apiBase}/${encodeURIComponent(id)}/seen`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq }),
        keepalive: true,
      });
      if (!r.ok) {
        throw await sessionError("mark seen", r);
      }
    },
  };
}

/** Close tombstones: ids the user closed within the TTL, so a stale server
 *  listing (the SSE re-open snapshot, or the poll's GET /api/sessions) that
 *  predates the server reaping the session does not re-adopt (flash back) the
 *  closed tab. */
interface Tombstones {
  add(id: string): void;
  /** True while `id` is tombstoned (within the TTL). A hit past the TTL clears
   *  the entry and reports false (the adopt may proceed). */
  active(id: string): boolean;
}

const CLOSE_TOMBSTONE_MS = 15000;

export function createTombstones(
  clock: () => number,
  ttlMs: number = CLOSE_TOMBSTONE_MS,
): Tombstones {
  const recentlyClosed = new Map<string, number>();
  return {
    add(id: string): void {
      const now = clock();
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
      if (clock() - closedAt < ttlMs) {
        return true;
      }
      recentlyClosed.delete(id);
      return false;
    },
  };
}

/** The bound on a user-typed tab name, mirroring the engine's pinned-title cap so
 *  the field cannot accept text the server would silently truncate. Counted in
 *  CODE POINTS, matching the server's runes: a naive `slice` counts UTF-16 units
 *  and could send a lone surrogate. */
export const MAX_PINNED_NAME = 128;

/** A user-typed tab name cleaned before display and send: control characters and
 *  DEL out (CWE-117), trimmed, bounded by code point. Client-side, so the
 *  optimistic label matches what the server will store. */
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
