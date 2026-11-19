// The tabs feature's session model and its pure placement. Inputs only write the
// model through the reducers below; layoutFor decides the strip, the panes, the
// split, the selection and every indicator from the whole model. No DOM, no
// wall clock, no kernel object: the node test project runs it.

import type { PaneSide } from "../../kernel/types.js";
import {
  CLOSE_TOMBSTONE_MS,
  compareTabOrder,
  foldedCueStatus,
  isEndedStatus,
  isStartFailureStatus,
  isUnread,
  normalizeActivity,
  normalizeActivityCount,
  normalizeProgress,
  normalizeSeq,
  summarizeCues,
  type CueStatus,
  type PaneLayout,
  type StatusRecord,
} from "./model.js";
import { parseTabAlias, type TabAlias, type TabRoute } from "./route.js";

/** How the page first learned a session: from the boot's set, a resync's set,
 *  this page's own create, or another device after the page started. Only an
 *  `elsewhere` session is placed as an arrival. */
export type Origin = "boot" | "settle" | "own" | "elsewhere";

/** One known session. Every `...At` field is a model clock stamp, which is what
 *  lets layoutFor read a fact as it was at an earlier event. */
export interface SessionFact {
  readonly id: string;
  readonly createdAt: string;
  /** The server's shared position, undefined against a server that keeps none.
   *  Every status record carries it, so another device's reorder reaches this strip. */
  readonly order: number | undefined;
  /** The session's URL name, undefined when the server sent none (before engine
   *  6.2) or one outside the alias grammar; such a tab has no address of its own. */
  readonly alias: TabAlias | undefined;
  /** The title the SERVER resolved (pinned name, OSC 0/2, host push, inference);
   *  the label adds the fallback and de-duplication. A blank record never overwrites it. */
  readonly title: string;
  /** The user's pinned name; "" or undefined is none. Outranks every automatic
   *  source in `baseLabel` and enables the menu's "use the automatic name". */
  readonly pinnedTitle: string | undefined;
  /** The raw server status ("" for none). */
  readonly status: string;
  /** The server's number for that status, 0 when none yet. */
  readonly statusSeq: number;
  /** When the status or its occurrence last changed. */
  readonly statusAt: number;
  /** Sticky: the session emitted a genuine activity signal (OSC 7501, OSC 9;4 or
   *  a classified OSC 9); its dot shows only while true, so a plain shell has none. */
  readonly reports: boolean;
  /** The last reported percentage, or PROGRESS_ABSENT; whether it is shown is
   *  renderedProgress's question. */
  readonly progress: number;
  /** The host's secondary activity state ("" for none), independent of `status`
   *  and `reports`: a background job can run after its turn finished. */
  readonly activity: string;
  /** How many sources produced that state, 0 when the server does not count. */
  readonly activityCount: number;
  /** The stream epoch of the last stream record, 0 when none: a list requested
   *  before it is older. */
  readonly streamAt: number;
  readonly endReason: string;
  /** The reason the session ended before its process started ("" when unknown);
   *  meaningful only while failAt is set. Never cleared. */
  readonly startFailure: string;
  readonly failAt: number | null;
  /** The server-confirmed read floor; only rises, since a lower one is an older
   *  record, never a retraction. */
  readonly seenSeq: number;
  /** This page's optimistic read floor, 0 when none. A 204 clears it once seenSeq
   *  covers it, a non-404 failure only while it holds the failed number, and a 404
   *  keeps it until the session is removed. */
  readonly ackSeq: number;
  /** The occurrence whose ack last failed with a non-404, 0 when none; the
   *  automatic ack skips it, so a failing server sees one PUT per occurrence. */
  readonly failedSeq: number;
  readonly origin: Origin;
  readonly born: number;
  /** From when the session counts as an arrival; null while a hold keeps it. */
  readonly placeableAt: number | null;
  readonly removedAt: number | null;
  /** When the status first became an ended one; an ended status never returns. */
  readonly endedAt: number | null;
}

/** How a create opens the split once its session exists. */
export type SplitOpening =
  { readonly by: "button" } | { readonly by: "snap"; readonly id: string; readonly side: PaneSide };

/** A route with its aliases resolved to the session ids present when it was read. */
export type ResolvedRoute =
  | { readonly kind: "single"; readonly tab: string }
  | { readonly kind: "split"; readonly left: string | null; readonly right: string | null };

export type ShellChange =
  | { readonly kind: "splitOpened"; readonly selected: PaneSide }
  | { readonly kind: "splitClosed"; readonly keptId: string | null }
  | { readonly kind: "paneDropped"; readonly side: PaneSide; readonly id: string }
  | { readonly kind: "rehome"; readonly side: PaneSide; readonly id: string };

export type SyncPointKind = "visible" | "focus" | "tray" | "list";

export type Toast = "stale" | "narrow";

interface OwnIntent {
  readonly kind: "own";
  readonly id: string;
  readonly opening: SplitOpening | null;
  readonly typing: boolean;
}

/** One stamped event of the fold besides the session facts' own stamps. */
export type TimelineEntry = { readonly at: number } & (
  | {
      readonly kind: "removal";
      readonly ids: readonly string[];
      readonly by: "server" | "user";
      readonly neighbour: ReadonlyMap<string, string | null>;
      readonly keyboardHeld: boolean;
      readonly typing: boolean;
    }
  | { readonly kind: "show"; readonly id: string; readonly dir: "next" | "prev" | undefined }
  | OwnIntent
  | {
      readonly kind: "snap";
      readonly id: string;
      readonly side: PaneSide;
      readonly typing: boolean;
    }
  | { readonly kind: "split"; readonly open: boolean }
  | { readonly kind: "route"; readonly route: ResolvedRoute | null; readonly stale: boolean }
  | {
      readonly kind: "settle";
      readonly settle: "boot" | "resync";
      readonly ids: readonly string[];
      readonly live: ReadonlySet<string>;
      readonly record: PaneLayout | null;
      readonly route: ResolvedRoute | null;
      readonly stale: boolean;
    }
  | { readonly kind: "resyncBegan"; readonly ids: readonly string[]; readonly typing: boolean }
  | { readonly kind: "select"; readonly side: PaneSide }
  | { readonly kind: "shell"; readonly change: ShellChange }
  | { readonly kind: "paneFailed"; readonly side: PaneSide }
  | { readonly kind: "splitFit"; readonly canOpen: boolean }
  | { readonly kind: "syncPoint"; readonly point: SyncPointKind }
  | { readonly kind: "view"; readonly visible: boolean; readonly tray: boolean }
  | { readonly kind: "holdsChanged"; readonly active: boolean }
);

/** Requests out that keep new sessions unplaceable. Each begin has exactly one end. */
export interface Holds {
  /** Stream opens whose list has not answered or failed. */
  readonly sync: number;
  readonly create: boolean;
  /** Resyncs from their request to their settle. */
  readonly resync: number;
}

export interface PageFacts {
  readonly visible: boolean;
  readonly switcherOpen: boolean;
  readonly started: boolean;
  readonly dragging: boolean;
  /** The terminal was built with a split, so a settle may restore one. */
  readonly splitEnabled: boolean;
  /** The split controller's committed share, the record's `handle`. */
  readonly ratio: number;
}

export interface TabsModel {
  readonly clock: number;
  /** Counts stream records; a list carries the value read when it was requested. */
  readonly streamEpoch: number;
  readonly presumeReports: boolean;
  readonly sessions: ReadonlyMap<string, SessionFact>;
  /** Removed sessions kept until a commit folds past their removal. */
  readonly gone: readonly SessionFact[];
  /** Ids closed or removed, with the wall-clock ms of the removal, so a stale
   *  list cannot re-add them within CLOSE_TOMBSTONE_MS. */
  readonly tombstones: ReadonlyMap<string, number>;
  readonly timeline: readonly TimelineEntry[];
  readonly holds: Holds;
  /** An own create answered during a resync, folded right after its settle. */
  readonly pendingOwn: OwnIntent | null;
  /** The ids a list showed all missing (a server restart), until its resync is requested. */
  readonly restartPending: { readonly at: number; readonly ids: readonly string[] } | null;
  readonly writeOwed: null | "write" | "rewrite";
  readonly page: PageFacts;
}

export interface Panes {
  readonly left: string | null;
  readonly right: string | null;
}

export interface SplitView {
  readonly open: boolean;
  readonly selected: PaneSide;
}

/** The session an arrival took a side from, what the other side showed then,
 *  and the side selected before the arrival. Read only by the start-failure rule. */
export interface Covered {
  readonly id: string;
  readonly other: string | null;
  readonly selected: PaneSide;
}

export interface Indicators {
  /** The most severe unread cue among sessions out of view, "" for none. */
  readonly switchDot: CueStatus | "";
  readonly attention: { readonly count: number; readonly worst: CueStatus | "" };
}

/** The pane state a fold carries between events, less `recent`. */
export interface PaneState {
  readonly left: string | null;
  readonly right: string | null;
  readonly open: boolean;
  readonly selected: PaneSide;
  readonly covered: Partial<Record<PaneSide, Covered>>;
  readonly failed: Partial<Record<PaneSide, true>>;
  readonly repairArmed: boolean;
  readonly fit: boolean;
  readonly held: boolean;
  readonly visible: boolean;
  readonly tray: boolean;
}

/** The server-only events folded since an arrival covered a session, from the
 *  pane state before it, so a start failure of a covered session can re-fold
 *  them as if the failure had been known first. A user, kernel or settle event,
 *  or a removal that moves a pane, ends it. */
export interface Segment {
  readonly base: PaneState;
  readonly events: readonly FoldEvent[];
  readonly covers: readonly string[];
}

/** The folded state, and the memo the next layoutFor call starts from. */
export interface Layout {
  readonly strip: readonly string[];
  /** The model clock folded up to. */
  readonly through: number;
  readonly panes: Panes;
  readonly split: SplitView;
  readonly covered: Partial<Record<PaneSide, Covered>>;
  /** The selected pane's sessions, newest first. */
  readonly recent: readonly string[];
  /** Sides whose pane failed and has not been torn down. */
  readonly failed: Partial<Record<PaneSide, true>>;
  /** The last settle placed nothing, so the repair rule may show a session. */
  readonly repairArmed: boolean;
  /** The latest folded splitFit and holdsChanged values: the timeline entries
   *  that carried them are pruned once folded. */
  readonly fit: boolean;
  readonly held: boolean;
  /** The page's visibility and the open tray as of `through`. */
  readonly visible: boolean;
  readonly tray: boolean;
  readonly segment: Segment | null;
  readonly inView: ReadonlySet<string>;
  readonly indicators: Indicators;
}

export type FocusForm = "announce" | "focus";

/** What the commit does for the events one stepFor call folded. */
export interface Effects {
  /** Occurrences to acknowledge; a level read off the current facts. */
  readonly acks: readonly { readonly id: string; readonly seq: number }[];
  /** An intent or a sync point was folded, so a failed ack is re-sent. */
  readonly retry: boolean;
  readonly moved: "settle" | "user" | "server" | "none";
  readonly persist: boolean;
  readonly focus: {
    readonly form: FocusForm | null;
    readonly typing: boolean;
    readonly keyboardHeld: boolean;
  } | null;
  readonly toasts: readonly Toast[];
  /** A folded removal left no session present. */
  readonly settle: boolean;
  /** A restart is pending while no resync is held; a level. */
  readonly resync: { readonly ids: readonly string[] } | null;
  /** A resync's settle placed something, so the address is rewritten. */
  readonly address: "push" | "replace" | null;
}

export const EMPTY_LAYOUT: Layout = {
  strip: [],
  through: 0,
  panes: { left: null, right: null },
  split: { open: false, selected: "left" },
  covered: {},
  recent: [],
  failed: {},
  repairArmed: false,
  fit: true,
  held: false,
  visible: true,
  tray: false,
  segment: null,
  inView: new Set(),
  indicators: { switchDot: "", attention: { count: 0, worst: "" } },
};

export function createModel(opts: { readonly presumeReports?: boolean } = {}): TabsModel {
  return {
    clock: 0,
    streamEpoch: 0,
    presumeReports: opts.presumeReports === true,
    sessions: new Map(),
    gone: [],
    tombstones: new Map(),
    timeline: [],
    holds: { sync: 0, create: false, resync: 0 },
    pendingOwn: null,
    restartPending: null,
    writeOwed: null,
    page: {
      visible: true,
      switcherOpen: false,
      started: false,
      dragging: false,
      splitEnabled: true,
      ratio: 0.5,
    },
  };
}

/** Whether new sessions are unplaceable now: a sync, create or resync is out,
 *  or a restart is pending its resync. */
export function anyHold(m: TabsModel): boolean {
  return m.holds.sync > 0 || m.holds.create || m.holds.resync > 0 || m.restartPending !== null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Draft {
  clock: number;
  streamEpoch: number;
  readonly presumeReports: boolean;
  readonly sessions: Map<string, SessionFact>;
  gone: SessionFact[];
  readonly tombstones: Map<string, number>;
  readonly timeline: TimelineEntry[];
  holds: Mutable<Holds>;
  pendingOwn: OwnIntent | null;
  restartPending: { readonly at: number; readonly ids: readonly string[] } | null;
  writeOwed: null | "write" | "rewrite";
  page: Mutable<PageFacts>;
  heldBefore: boolean;
}

function draft(m: TabsModel): Draft {
  return {
    clock: m.clock,
    streamEpoch: m.streamEpoch,
    presumeReports: m.presumeReports,
    sessions: new Map(m.sessions),
    gone: [...m.gone],
    tombstones: new Map(m.tombstones),
    timeline: [...m.timeline],
    holds: { ...m.holds },
    pendingOwn: m.pendingOwn,
    restartPending: m.restartPending,
    writeOwed: m.writeOwed,
    page: { ...m.page },
    heldBefore: anyHold(m),
  };
}

function tick(d: Draft): number {
  d.clock += 1;
  return d.clock;
}

// A flip of "any hold is set" is a stamped event, and a release stamps each
// held session placeable in compareTabOrder order, so a burst's arrivals are
// placed as one sorted run whatever order they came in.
function settleHolds(d: Draft): void {
  const held = anyHoldDraft(d);
  if (held === d.heldBefore) {
    return;
  }
  d.heldBefore = held;
  d.timeline.push({ kind: "holdsChanged", at: tick(d), active: held });
  if (!held) {
    const waiting = [...d.sessions.values()]
      .filter((f) => f.placeableAt === null)
      .sort(compareTabOrder);
    for (const f of waiting) {
      d.sessions.set(f.id, { ...f, placeableAt: tick(d) });
    }
  }
}

// Every reducer ends here.
function finish(d: Draft): TabsModel {
  settleHolds(d);
  return {
    clock: d.clock,
    streamEpoch: d.streamEpoch,
    presumeReports: d.presumeReports,
    sessions: d.sessions,
    gone: d.gone,
    tombstones: d.tombstones,
    timeline: d.timeline,
    holds: d.holds,
    pendingOwn: d.pendingOwn,
    restartPending: d.restartPending,
    writeOwed: d.writeOwed,
    page: d.page,
  };
}

function tombstoned(d: Draft, id: string, now: number): boolean {
  const at = d.tombstones.get(id);
  return at !== undefined && now - at < CLOSE_TOMBSTONE_MS;
}

function tombstone(d: Draft, id: string, now: number): void {
  for (const [k, at] of d.tombstones) {
    if (now - at >= CLOSE_TOMBSTONE_MS) {
      d.tombstones.delete(k);
    }
  }
  d.tombstones.set(id, now);
}

function reportsOf(d: Draft, raw: unknown): boolean {
  return d.presumeReports || raw === true;
}

function statusOfRecord(rec: StatusRecord): string {
  return typeof rec.status === "string" ? rec.status : "";
}

/** Where a record came from: the stream, or a list requested at stream epoch `listedAt`. */
export type RecordSource = { readonly stream: true } | { readonly listedAt: number };

function addFact(d: Draft, rec: StatusRecord, origin: Origin, source: RecordSource): void {
  const born = tick(d);
  const status = statusOfRecord(rec);
  const fact: Mutable<SessionFact> = {
    id: rec.id,
    createdAt: rec.createdAt,
    order: rec.order,
    alias: parseTabAlias(rec.alias) ?? undefined,
    title: typeof rec.title === "string" ? rec.title : "",
    pinnedTitle: rec.pinnedTitle,
    status,
    statusSeq: normalizeSeq(rec.statusSeq) ?? 0,
    statusAt: born,
    reports: reportsOf(d, rec.reportsActivity),
    progress: normalizeProgress(rec.progressValue),
    activity: normalizeActivity(rec.activity),
    activityCount: normalizeActivityCount(rec.activityCount),
    streamAt: "stream" in source ? d.streamEpoch : 0,
    endReason: isEndedStatus(status) ? (rec.endReason ?? "") : "",
    startFailure: "",
    failAt: null,
    seenSeq: normalizeSeq(rec.seenSeq) ?? 0,
    ackSeq: 0,
    failedSeq: 0,
    origin,
    born,
    placeableAt: anyHoldDraft(d) ? null : born,
    removedAt: null,
    endedAt: isEndedStatus(status) ? born : null,
  };
  if (isStartFailureStatus(status)) {
    fact.failAt = tick(d);
    fact.startFailure = rec.endReason ?? "";
  }
  d.sessions.set(fact.id, fact);
}

function anyHoldDraft(d: Draft): boolean {
  return d.holds.sync > 0 || d.holds.create || d.holds.resync > 0 || d.restartPending !== null;
}

// The staleness rules of the stream-owned tuple: a list requested before the
// stream's last record for the session, or a lower statusSeq, is older, and
// applying it can hide a cue no later record restores.
function mergeInto(d: Draft, f: SessionFact, rec: StatusRecord, source: RecordSource): void {
  const next: Mutable<SessionFact> = { ...f };
  if ("stream" in source) {
    next.streamAt = d.streamEpoch;
  }
  const seq = normalizeSeq(rec.statusSeq);
  const stale =
    ("listedAt" in source && f.streamAt > source.listedAt) || (seq !== null && seq < f.statusSeq);
  if (!stale) {
    const status = statusOfRecord(rec);
    next.reports = reportsOf(d, rec.reportsActivity);
    if (seq !== null) {
      next.statusSeq = seq;
    }
    next.status = status;
    if (status !== f.status || next.statusSeq !== f.statusSeq) {
      next.statusAt = tick(d);
    }
    if (rec.progressValue !== undefined) {
      next.progress = normalizeProgress(rec.progressValue);
    }
    if (rec.activity !== undefined) {
      next.activity = normalizeActivity(rec.activity);
    }
    if (rec.activityCount !== undefined) {
      next.activityCount = normalizeActivityCount(rec.activityCount);
    }
    if (isEndedStatus(status)) {
      next.endReason = rec.endReason ?? next.endReason;
      next.endedAt ??= tick(d);
    }
    if (isStartFailureStatus(status) && next.failAt === null) {
      next.failAt = tick(d);
      next.startFailure = rec.endReason ?? "";
    }
  }
  if (rec.order !== undefined) {
    next.order = rec.order;
  }
  if (rec.alias !== undefined) {
    next.alias = parseTabAlias(rec.alias) ?? undefined;
  }
  const seen = normalizeSeq(rec.seenSeq);
  if (seen !== null && seen > next.seenSeq) {
    next.seenSeq = seen;
  }
  if (typeof rec.title === "string" && rec.title.trim() !== "") {
    next.title = rec.title;
  }
  if (rec.pinnedTitle !== undefined) {
    next.pinnedTitle = rec.pinnedTitle;
  }
  d.sessions.set(f.id, next);
}

function mergeRow(
  d: Draft,
  rec: StatusRecord,
  source: RecordSource,
  now: number,
  origin?: Origin,
): void {
  const f = d.sessions.get(rec.id);
  if (f !== undefined) {
    mergeInto(d, f, rec, source);
    return;
  }
  if (tombstoned(d, rec.id, now)) {
    return;
  }
  addFact(d, rec, origin ?? (d.page.started ? "elsewhere" : "boot"), source);
}

/** A status-stream record (`source` the stream) or one row of a list. */
export function mergeRecord(
  m: TabsModel,
  rec: StatusRecord,
  source: RecordSource,
  now: number,
): TabsModel {
  const d = draft(m);
  if ("stream" in source) {
    d.streamEpoch += 1;
  }
  mergeRow(d, rec, source, now);
  return finish(d);
}

// One removal entry for the whole set; each removed id's neighbour is the next
// session in strip order among those the removal leaves, else the previous one.
function removeIds(
  d: Draft,
  ids: readonly string[],
  how: { readonly by: "server" | "user"; readonly keyboardHeld: boolean; readonly typing: boolean },
  now: number,
): void {
  const leaving = new Set(ids.filter((id) => d.sessions.has(id)));
  for (const id of ids) {
    tombstone(d, id, now);
  }
  if (leaving.size === 0) {
    return;
  }
  const strip = [...d.sessions.values()].sort(compareTabOrder).map((f) => f.id);
  const neighbour = new Map<string, string | null>();
  for (const id of leaving) {
    const at = strip.indexOf(id);
    const after = strip.slice(at + 1).find((x) => !leaving.has(x));
    const before = strip
      .slice(0, at)
      .reverse()
      .find((x) => !leaving.has(x));
    neighbour.set(id, after ?? before ?? null);
  }
  const at = tick(d);
  for (const id of leaving) {
    const f = d.sessions.get(id);
    if (f !== undefined) {
      d.sessions.delete(id);
      d.gone.push({ ...f, removedAt: at });
    }
  }
  d.timeline.push({
    kind: "removal",
    at,
    ids: strip.filter((id) => leaving.has(id)),
    by: how.by,
    neighbour,
    keyboardHeld: how.keyboardHeld,
    typing: how.typing,
  });
}

/** Sessions the server removed, or the user's close of `ids` (one entry for a multi-close). */
export function removed(
  m: TabsModel,
  ids: readonly string[],
  how: {
    readonly by: "server" | "user";
    readonly keyboardHeld?: boolean;
    readonly typing?: boolean;
  },
  now: number,
): TabsModel {
  const d = draft(m);
  removeIds(
    d,
    ids,
    { by: how.by, keyboardHeld: how.keyboardHeld === true, typing: how.typing === true },
    now,
  );
  return finish(d);
}

/** A list reconcile's answer. `epochAtList` is the model clock when the list was
 *  requested (for a stream open, at the open), `listedAt` the stream epoch then.
 *  A list missing every session born by then is a server restart: it merges
 *  nothing and sets restartPending, which holds placement until the resync settles. */
export function mergeList(
  m: TabsModel,
  list: readonly StatusRecord[],
  at: { readonly listedAt: number; readonly epochAtList: number },
  now: number,
): TabsModel {
  const d = draft(m);
  const named = new Set(list.map((s) => s.id));
  const known = [...d.sessions.values()].filter((f) => f.born <= at.epochAtList).map((f) => f.id);
  if (known.length > 0 && known.every((id) => !named.has(id))) {
    // A resync already requested replaces the whole set, so a second restart
    // list during it requests nothing more.
    if (d.restartPending === null && d.holds.resync === 0) {
      d.restartPending = { at: tick(d), ids: known };
    }
    return finish(d);
  }
  for (const rec of [...list].sort(compareTabOrder)) {
    mergeRow(d, rec, { listedAt: at.listedAt }, now);
  }
  removeIds(
    d,
    known.filter((id) => !named.has(id)),
    { by: "server", keyboardHeld: false, typing: false },
    now,
  );
  return finish(d);
}

/** A stream open: its list is out until syncEnded. */
export function syncBegan(m: TabsModel): TabsModel {
  const d = draft(m);
  tick(d);
  d.holds.sync += 1;
  return finish(d);
}

/** The stream open's list answered, failed or was coalesced; once per syncBegan. */
export function syncEnded(m: TabsModel): TabsModel {
  const d = draft(m);
  d.holds.sync = Math.max(0, d.holds.sync - 1);
  d.timeline.push({ kind: "syncPoint", at: tick(d), point: "list" });
  return finish(d);
}

export function createBegan(m: TabsModel): TabsModel {
  const d = draft(m);
  tick(d);
  d.holds.create = true;
  return finish(d);
}

/** This page's POST answered with `info`. Its intent is folded now, or right
 *  after the settle while a resync is held. The sessions the create held are
 *  released before the intent, so the user's new terminal is placed last. */
export function ownCreated(
  m: TabsModel,
  info: StatusRecord,
  opening: SplitOpening | null,
  typing: boolean,
): TabsModel {
  const d = draft(m);
  const f = d.sessions.get(info.id);
  if (f === undefined) {
    addFact(d, info, "own", { listedAt: d.streamEpoch });
  } else {
    d.sessions.set(info.id, { ...f, origin: "own" });
  }
  const intent: OwnIntent = { kind: "own", id: info.id, opening, typing };
  d.holds.create = false;
  settleHolds(d);
  if (d.holds.resync > 0) {
    d.pendingOwn = intent;
  } else {
    d.timeline.push({ ...intent, at: tick(d) });
  }
  return finish(d);
}

export function createFailed(m: TabsModel): TabsModel {
  const d = draft(m);
  tick(d);
  d.holds.create = false;
  return finish(d);
}

/** The commit's request of a resync; a pending restart becomes the resync's own hold. */
export function resyncRequested(m: TabsModel): TabsModel {
  const d = draft(m);
  tick(d);
  d.holds.resync += 1;
  d.restartPending = null;
  return finish(d);
}

/** A resync starts in its slot: `ids` leave the model, their panes empty and the
 *  split closes, unpersisted. */
export function resyncBegan(
  m: TabsModel,
  ids: readonly string[],
  typing: boolean,
  now: number,
): TabsModel {
  const d = draft(m);
  const at = tick(d);
  const dropping = ids.filter((id) => d.sessions.has(id));
  for (const id of ids) {
    tombstone(d, id, now);
  }
  for (const id of dropping) {
    const f = d.sessions.get(id);
    if (f !== undefined) {
      d.sessions.delete(id);
      d.gone.push({ ...f, removedAt: at });
    }
  }
  d.timeline.push({ kind: "resyncBegan", at, ids: dropping, typing });
  return finish(d);
}

/** What a settle read: the sessions, the record, whether the list succeeded,
 *  and the route parsed off the address then (null when not read). */
export interface SettleInput {
  readonly sessions: readonly StatusRecord[];
  readonly record: PaneLayout | null;
  readonly route: TabRoute | null;
  readonly toastStale: boolean;
  /** Wall-clock ms, for the close tombstones. */
  readonly now: number;
}

function resolveRoute(
  d: Draft,
  route: TabRoute,
): { readonly route: ResolvedRoute | null; readonly stale: boolean } {
  const byAlias = (alias: TabAlias | null): string | null | undefined => {
    if (alias === null) {
      return null;
    }
    for (const f of [...d.sessions.values()].sort(compareTabOrder)) {
      if (f.alias === alias) {
        return f.id;
      }
    }
    return undefined;
  };
  if (route.kind === "single") {
    const tab = byAlias(route.tab);
    return tab == null
      ? { route: null, stale: true }
      : { route: { kind: "single", tab }, stale: false };
  }
  const left = byAlias(route.left);
  const right = byAlias(route.right);
  const stale = left === undefined || right === undefined;
  const l = left ?? null;
  const r = right ?? null;
  if (l === null && r === null) {
    return { route: null, stale };
  }
  return { route: { kind: "split", left: l, right: r }, stale };
}

function pushSettle(d: Draft, kind: "boot" | "resync", input: SettleInput): void {
  if (input.record !== null) {
    d.page.ratio = input.record.handle;
  }
  for (const rec of [...input.sessions].sort(compareTabOrder)) {
    mergeRow(d, rec, { listedAt: d.streamEpoch }, input.now, kind === "boot" ? "boot" : "settle");
  }
  const resolved =
    input.route === null ? { route: null, stale: false } : resolveRoute(d, input.route);
  d.timeline.push({
    kind: "settle",
    at: tick(d),
    settle: kind,
    ids: input.sessions.map((s) => s.id),
    live: new Set(input.sessions.filter((s) => !isEndedStatus(statusOfRecord(s))).map((s) => s.id)),
    record: input.record,
    route: resolved.route,
    stale: resolved.stale && input.toastStale,
  });
}

/** The boot's settled set: merged as boot sessions, the page started, the split's
 *  fit recorded, then placed by the address, the record or the oldest live tab. */
export function bootSettled(
  m: TabsModel,
  input: SettleInput & { readonly canOpen: boolean; readonly splitEnabled: boolean },
): TabsModel {
  const d = draft(m);
  d.page.started = true;
  d.page.splitEnabled = input.splitEnabled;
  d.timeline.push({ kind: "splitFit", at: tick(d), canOpen: input.canOpen });
  pushSettle(d, "boot", input);
  return finish(d);
}

/** A resync's settle (a failed one settles what it listed, or nothing). Every
 *  session still unplaceable is relabelled a settle session, so none of the set
 *  held across it is placed as an arrival. A create that answered during it
 *  waits for ownReleased. */
export function resyncSettled(m: TabsModel, input: SettleInput): TabsModel {
  const d = draft(m);
  pushSettle(d, "resync", { ...input, toastStale: false });
  for (const f of d.sessions.values()) {
    if (f.placeableAt === null && f.origin === "elsewhere") {
      d.sessions.set(f.id, { ...f, origin: "settle" });
    }
  }
  d.holds.resync = Math.max(0, d.holds.resync - 1);
  return finish(d);
}

/** The create that answered during a resync, folded once the settle is
 *  committed: the settled session is bound first, so its process starts at a
 *  client's size even when the new terminal then takes its pane. */
export function ownReleased(m: TabsModel): TabsModel {
  if (m.pendingOwn === null || m.holds.resync > 0) {
    return m;
  }
  const d = draft(m);
  d.timeline.push({ ...m.pendingOwn, at: tick(d) });
  d.pendingOwn = null;
  return finish(d);
}

/** The pane's 4001 close carried a start-failure reason. */
export function paneStartFailed(m: TabsModel, id: string, reason: string): TabsModel {
  const f = m.sessions.get(id);
  if (f?.failAt !== null) {
    return m;
  }
  const d = draft(m);
  const at = tick(d);
  d.sessions.set(id, { ...f, failAt: at, startFailure: reason, endedAt: f.endedAt ?? at });
  return finish(d);
}

function stamp(m: TabsModel, entry: (at: number) => TimelineEntry): TabsModel {
  const d = draft(m);
  d.timeline.push(entry(tick(d)));
  return finish(d);
}

/** A tab click, a switcher row, a key, a swipe or a notification's activate. */
export function show(m: TabsModel, id: string, dir?: "next" | "prev"): TabsModel {
  return stamp(m, (at) => ({ kind: "show", at, id, dir }));
}

/** A snap of `id` onto `side` that has a partner (one with none is a create). */
export function snap(m: TabsModel, id: string, side: PaneSide, typing: boolean): TabsModel {
  return stamp(m, (at) => ({ kind: "snap", at, id, side, typing }));
}

/** The split button with a partner, or the split's close. */
export function splitIntent(m: TabsModel, open: boolean): TabsModel {
  return stamp(m, (at) => ({ kind: "split", at, open }));
}

/** An address the user navigated to; its aliases resolve among the present sessions. */
export function route(m: TabsModel, r: TabRoute, toastStale: boolean): TabsModel {
  const d = draft(m);
  const resolved = resolveRoute(d, r);
  d.timeline.push({
    kind: "route",
    at: tick(d),
    route: resolved.route,
    stale: resolved.stale && toastStale,
  });
  return finish(d);
}

/** The kernel moved selection (a pointer or focus on a pane, or its own move). */
export function select(m: TabsModel, side: PaneSide): TabsModel {
  return stamp(m, (at) => ({ kind: "select", at, side }));
}

/** A pane change the kernel made on the committed screen. */
export function shellChanged(m: TabsModel, change: ShellChange): TabsModel {
  return stamp(m, (at) => ({ kind: "shell", at, change }));
}

export function paneFailed(m: TabsModel, side: PaneSide): TabsModel {
  return stamp(m, (at) => ({ kind: "paneFailed", at, side }));
}

export function splitFit(m: TabsModel, canOpen: boolean): TabsModel {
  return stamp(m, (at) => ({ kind: "splitFit", at, canOpen }));
}

export function pageVisibility(m: TabsModel, visible: boolean): TabsModel {
  const d = draft(m);
  const changed = visible !== d.page.visible;
  d.page.visible = visible;
  const at = tick(d);
  if (changed) {
    d.timeline.push({ kind: "view", at, visible, tray: d.page.switcherOpen });
  }
  if (changed && visible) {
    d.timeline.push({ kind: "syncPoint", at: tick(d), point: "visible" });
  }
  return finish(d);
}

/** The window regained focus; a sync point only while the page is visible. */
export function windowFocused(m: TabsModel): TabsModel {
  if (!m.page.visible) {
    return m;
  }
  return stamp(m, (at) => ({ kind: "syncPoint", at, point: "focus" }));
}

export function switcherToggled(m: TabsModel, open: boolean): TabsModel {
  const d = draft(m);
  const changed = open !== d.page.switcherOpen;
  d.page.switcherOpen = open;
  const at = tick(d);
  if (changed) {
    d.timeline.push({ kind: "view", at, visible: d.page.visible, tray: open });
  }
  if (changed && open) {
    d.timeline.push({ kind: "syncPoint", at: tick(d), point: "tray" });
  }
  return finish(d);
}

function withFact(
  m: TabsModel,
  id: string,
  change: (f: SessionFact) => Partial<SessionFact> | null,
): TabsModel {
  const f = m.sessions.get(id);
  const patch = f === undefined ? null : change(f);
  if (f === undefined || patch === null) {
    return m;
  }
  const d = draft(m);
  tick(d);
  d.sessions.set(id, { ...f, ...patch });
  return finish(d);
}

/** The commit sent an ack of `seq`. */
export function ackSent(m: TabsModel, id: string, seq: number): TabsModel {
  return withFact(m, id, () => ({ ackSeq: seq }));
}

/** A 204: seq came from the server, so its floor is at least seq. */
export function ackSettled(m: TabsModel, id: string, seq: number): TabsModel {
  return withFact(m, id, (f) => {
    const seenSeq = Math.max(f.seenSeq, seq);
    return {
      seenSeq,
      ackSeq: f.ackSeq <= seenSeq ? 0 : f.ackSeq,
      failedSeq: f.failedSeq <= seq ? 0 : f.failedSeq,
    };
  });
}

/** A failed ack. A 404 changes nothing: the session's removal follows. A later
 *  ack owns ackSeq, and seenSeq is never written here. */
export function ackFailed(m: TabsModel, id: string, seq: number, notFound: boolean): TabsModel {
  if (notFound) {
    return m;
  }
  return withFact(m, id, (f) => ({
    ackSeq: f.ackSeq === seq ? 0 : f.ackSeq,
    failedSeq: Math.max(f.failedSeq, seq),
  }));
}

export function dragChanged(m: TabsModel, dragging: boolean): TabsModel {
  const d = draft(m);
  tick(d);
  d.page.dragging = dragging;
  return finish(d);
}

/** This page's committed drag or move: the local renumber before the order PUT. */
export function reorder(m: TabsModel, ids: readonly string[]): TabsModel {
  const d = draft(m);
  tick(d);
  ids.forEach((id, i) => {
    const f = d.sessions.get(id);
    if (f !== undefined) {
      d.sessions.set(id, { ...f, order: i });
    }
  });
  return finish(d);
}

/** This page's rename, or its rollback to `pinnedTitle`. */
export function renamed(m: TabsModel, id: string, pinnedTitle: string): TabsModel {
  return withFact(m, id, () => ({ pinnedTitle }));
}

/** A shown session's OSC 0/2 title off its socket; a blank one is ignored. */
export function wireTitle(m: TabsModel, id: string, title: string): TabsModel {
  return withFact(m, id, (f) => (title.trim() === "" || title === f.title ? null : { title }));
}

/** The split's committed share changed; `dragged` when the user moved the handle. */
export function splitRatio(m: TabsModel, ratio: number, dragged: boolean): TabsModel {
  const d = draft(m);
  tick(d);
  d.page.ratio = ratio;
  if (dragged && d.writeOwed !== "rewrite") {
    d.writeOwed = "write";
  }
  return finish(d);
}

/** The layout PUT answered 409 and its re-list is merged: one rewrite is owed. */
export function layoutStale(m: TabsModel): TabsModel {
  const d = draft(m);
  tick(d);
  d.writeOwed = "rewrite";
  return finish(d);
}

/** A write the commit owed is deferred until no resync is held. */
export function layoutOwed(m: TabsModel): TabsModel {
  if (m.writeOwed !== null) {
    return m;
  }
  const d = draft(m);
  d.writeOwed = "write";
  return finish(d);
}

export function layoutWritten(m: TabsModel): TabsModel {
  if (m.writeOwed === null) {
    return m;
  }
  const d = draft(m);
  d.writeOwed = null;
  return finish(d);
}

/** A commit folded through `through`: its events and removed sessions are dropped. */
export function folded(m: TabsModel, through: number): TabsModel {
  const d = draft(m);
  d.gone = d.gone.filter((f) => f.removedAt === null || f.removedAt > through);
  const kept = d.timeline.filter((e) => e.at > through);
  d.timeline.length = 0;
  d.timeline.push(...kept);
  return finish(d);
}

/** The shared record for a layout, or null while no pane shows a session. */
export function layoutRecord(l: Layout, ratio: number): PaneLayout | null {
  if (l.panes.left === null && l.panes.right === null) {
    return null;
  }
  return {
    left: l.panes.left,
    right: l.panes.right,
    handle: ratio,
    selected: l.split.selected,
    open: l.split.open,
  };
}

/** Whether a commit from `prev` to `next` writes the record, on the model after
 *  the commit's own dispatches: the record to write, "owe" when a pane change
 *  meets a resync or a pending restart (the write waits for the commit that
 *  clears them), or null. */
export function recordWrite(
  m: TabsModel,
  prev: Layout,
  next: Layout,
  effects: Effects,
): PaneLayout | "owe" | null {
  const changed =
    effects.persist &&
    (prev.panes.left !== next.panes.left ||
      prev.panes.right !== next.panes.right ||
      prev.split.open !== next.split.open ||
      prev.split.selected !== next.split.selected);
  if (!changed && m.writeOwed === null) {
    return null;
  }
  if (m.holds.resync > 0 || m.restartPending !== null) {
    return changed ? "owe" : null;
  }
  return layoutRecord(next, m.page.ratio);
}

/** One commit's model half: the next layout and its effects, and the model after
 *  the commit's own dispatches (folded, ackSent, resyncRequested, the record
 *  write's bookkeeping), so no later commit repeats an ack, a resync or a write. */
export interface CommitStep {
  readonly model: TabsModel;
  readonly layout: Layout;
  readonly effects: Effects;
  /** The resync to queue in the reconcile slot, or null. */
  readonly resync: readonly string[] | null;
  /** The record to write now, or null. */
  readonly write: PaneLayout | null;
  /** The write discharges a 409's owed rewrite, sent without a further retry. */
  readonly rewrite: boolean;
}

export function commitStep(m: TabsModel, prev: Layout): CommitStep {
  const { layout, effects } = stepFor(m, prev);
  let next = folded(m, layout.through);
  for (const a of effects.acks) {
    next = ackSent(next, a.id, a.seq);
  }
  const resync = effects.resync !== null || effects.settle ? (effects.resync?.ids ?? []) : null;
  if (resync !== null) {
    next = resyncRequested(next);
  }
  const owed = recordWrite(next, prev, layout, effects);
  const rewrite = next.writeOwed === "rewrite";
  let write: PaneLayout | null = null;
  if (owed === "owe") {
    next = layoutOwed(next);
  } else if (owed !== null) {
    write = owed;
    next = layoutWritten(next);
  }
  return { model: next, layout, effects, resync, write, rewrite: write !== null && rewrite };
}

/** What the selection chrome paints (the active chip, the bottom bar, the
 *  switcher's multi-tab state, the page title), read from a layout and the model. */
export interface Chrome {
  readonly active: string | null;
  readonly strip: readonly string[];
  readonly shown: readonly {
    readonly id: string;
    readonly status: string;
    readonly title: string;
    readonly pinnedTitle: string;
    readonly progress: number;
    readonly activity: string;
    readonly activityCount: number;
  }[];
}

export function chromeOf(m: TabsModel, l: Layout): Chrome {
  const selected = l.panes[l.split.selected];
  const active = selected ?? l.panes.left ?? l.panes.right;
  const shown = [l.panes.left, l.panes.right].flatMap((id) => {
    const f = id === null ? undefined : m.sessions.get(id);
    return f === undefined
      ? []
      : [
          {
            id: f.id,
            status: f.status,
            title: f.title,
            pinnedTitle: f.pinnedTitle ?? "",
            progress: f.progress,
            activity: f.activity,
            activityCount: f.activityCount,
          },
        ];
  });
  return { active, strip: l.strip, shown };
}

/** The session a split opened from `of` pairs with: the selected pane's most
 *  recent other session, else its strip neighbour. Null when there is none, which
 *  makes a snap or the split button a create. */
export function splitPartner(m: TabsModel, l: Layout, of: string | null): string | null {
  const used = l.recent.find((id) => id !== of && m.sessions.has(id));
  if (used !== undefined) {
    return used;
  }
  const strip = [...m.sessions.values()].sort(compareTabOrder).map((f) => f.id);
  const at = of === null ? -1 : strip.indexOf(of);
  return strip[at + 1] ?? strip[at - 1] ?? null;
}

export function layoutFor(m: TabsModel, prev: Layout): Layout {
  return stepFor(m, prev).layout;
}

export type FoldEvent =
  | { readonly at: number; readonly kind: "arrival"; readonly id: string }
  | { readonly at: number; readonly kind: "failure"; readonly id: string }
  | TimelineEntry;

type FoldState = Mutable<Omit<PaneState, "covered" | "failed">> & {
  covered: Partial<Record<PaneSide, Covered>>;
  failed: Partial<Record<PaneSide, true>>;
  recent: string[];
  segment: Segment | null;
};

// Events a covering arrival's segment carries on through: they move no pane by
// a user's or the kernel's hand, so re-folding them is what the server order
// would have given had a start failure been known first.
const SEGMENT_KEEPS: ReadonlySet<FoldEvent["kind"]> = new Set([
  "arrival",
  "failure",
  "holdsChanged",
  "syncPoint",
  "splitFit",
  "paneFailed",
  "view",
]);

interface Rule {
  /** Whether a change this rule made is written to the shared record. */
  readonly persist: boolean;
  readonly moved: "settle" | "user" | "server" | null;
  readonly form: FocusForm | null;
}

const NOOP: Rule = { persist: false, moved: null, form: null };
const SIDES = ["left", "right"] as const;
const otherSide = (side: PaneSide): PaneSide => (side === "left" ? "right" : "left");

function sameShown(a: PaneLayout, b: PaneLayout | null): boolean {
  return (
    b !== null &&
    a.left === b.left &&
    a.right === b.right &&
    a.open === b.open &&
    a.selected === b.selected
  );
}

// The fold of one stepFor call. Every rule reads a fact as it was at the event's
// own stamp (presentAt, failedAt, liveAt), never its current value: that is what
// makes folding a run in one call or across many give the same layout.
class Folder {
  readonly s: FoldState;
  /** While a segment is re-folded, the stamp whose start failures count as known. */
  private replayAt: number | null = null;
  private lastCovered: string | null = null;
  private readonly facts = new Map<string, SessionFact[]>();
  readonly toasts: Toast[] = [];
  settle = false;
  retry = false;
  typing = false;
  keyboardHeld = false;
  private readonly splitEnabled: boolean;

  constructor(m: TabsModel, prev: Layout) {
    this.splitEnabled = m.page.splitEnabled;
    this.s = {
      left: prev.panes.left,
      right: prev.panes.right,
      open: prev.split.open,
      selected: prev.split.selected,
      covered: { ...prev.covered },
      recent: [...prev.recent],
      failed: { ...prev.failed },
      repairArmed: prev.repairArmed,
      fit: prev.fit,
      held: prev.held,
      visible: prev.visible,
      tray: prev.tray,
      segment: prev.segment,
    };
    for (const f of [...m.gone, ...m.sessions.values()]) {
      const list = this.facts.get(f.id);
      if (list === undefined) {
        this.facts.set(f.id, [f]);
      } else {
        list.push(f);
      }
    }
  }

  factAt(id: string, t: number): SessionFact | undefined {
    return this.facts
      .get(id)
      ?.find((f) => f.born <= t && (f.removedAt === null || f.removedAt > t));
  }

  presentAt(id: string | null, t: number): id is string {
    return id !== null && this.factAt(id, t) !== undefined;
  }

  failedAt(id: string, t: number): boolean {
    const f = this.factAt(id, t);
    const asOf = this.replayAt ?? t;
    return f !== undefined && f.failAt !== null && f.failAt <= asOf;
  }

  /** The sessions present at `t`, in strip order. */
  stripAt(t: number): SessionFact[] {
    const out: SessionFact[] = [];
    for (const id of this.facts.keys()) {
      const f = this.factAt(id, t);
      if (f !== undefined) {
        out.push(f);
      }
    }
    return out.sort(compareTabOrder);
  }

  usable(side: PaneSide): boolean {
    return (side === "left" || this.s.open) && this.s.failed[side] !== true;
  }

  sideOf(id: string): PaneSide | null {
    return this.s.left === id ? "left" : this.s.right === id ? "right" : null;
  }

  /** The sessions in front of the user at `t`: on a pane or in the open tray, on a visible page. */
  inViewAt(t: number): string[] {
    if (!this.s.visible) {
      return [];
    }
    const ids = this.s.tray ? [...this.facts.keys()] : [this.s.left, this.s.right];
    return ids.filter((id) => this.presentAt(id, t));
  }

  anyShown(): boolean {
    return this.s.left !== null || this.s.right !== null;
  }

  // The kernel's targetFor: the first built pane that is empty, else the selected one.
  target(): PaneSide {
    const built: PaneSide[] = this.s.open ? ["left", "right"] : ["left"];
    return built.find((side) => this.usable(side) && this.s[side] === null) ?? this.s.selected;
  }

  newTabSide(): PaneSide {
    const side = this.target();
    const o = otherSide(side);
    return this.s[side] !== null && this.s[o] !== null ? o : side;
  }

  uncover(side: PaneSide): void {
    const out: Partial<Record<PaneSide, Covered>> = {};
    for (const k of SIDES) {
      const c = this.s.covered[k];
      if (k !== side && c !== undefined) {
        out[k] = c;
      }
    }
    this.s.covered = out;
  }

  /** The session the last folded arrival took a side from, or null. */
  private takeCovered(): string | null {
    const id = this.lastCovered;
    this.lastCovered = null;
    return id;
  }

  /** Shows `id` on `side`, emptying the other side if it showed `id`. Every rule
   *  but an arrival and the restore drops the side's covered entry. */
  put(side: PaneSide, id: string, keepCovered = false): void {
    const o = otherSide(side);
    if (this.s[o] === id) {
      this.s[o] = null;
      this.uncover(o);
    }
    if (!keepCovered) {
      this.uncover(side);
    }
    this.s[side] = id;
  }

  /** Closes the split onto `kept` as the single view, carrying `covered` with it. */
  closeTo(kept: string | null, covered?: Covered): void {
    this.s.left = kept;
    this.s.right = null;
    this.s.open = false;
    this.s.selected = "left";
    this.s.failed = {};
    this.s.covered = covered === undefined ? {} : { left: covered };
  }

  /** The split's close keeps the selected pane's session (the kernel's close). */
  closeKeepingSelected(): void {
    const side = this.s[this.s.selected] !== null ? this.s.selected : otherSide(this.s.selected);
    this.closeTo(this.s[side], this.s.covered[side]);
  }

  splitPartner(of: string | null, t: number): string | null {
    const used = this.s.recent.find((id) => id !== of && this.presentAt(id, t));
    if (used !== undefined) {
      return used;
    }
    const strip = this.stripAt(t).map((f) => f.id);
    const at = of === null ? -1 : strip.indexOf(of);
    return strip[at + 1] ?? strip[at - 1] ?? null;
  }

  paneState(): PaneState {
    const { recent: _recent, segment: _segment, ...rest } = this.s;
    return { ...rest, covered: { ...rest.covered }, failed: { ...rest.failed } };
  }

  private load(p: PaneState): void {
    Object.assign(this.s, p, { covered: { ...p.covered }, failed: { ...p.failed } });
  }

  /** Folds one event, keeping the covering arrivals' segment. */
  event(ev: FoldEvent): Rule {
    const seg = this.s.segment;
    if (ev.kind === "failure" && seg?.covers.includes(ev.id) === true) {
      return this.refold(seg, ev);
    }
    const before = this.paneState();
    this.takeCovered();
    const rule = this.apply(ev);
    const covered = this.takeCovered();
    if (ev.kind === "arrival" && covered !== null) {
      const from = seg ?? { base: before, events: [], covers: [] };
      this.s.segment = {
        base: from.base,
        events: [...from.events, ev],
        covers: [...from.covers, covered],
      };
    } else if (seg !== null && (SEGMENT_KEEPS.has(ev.kind) || rule === NOOP)) {
      this.s.segment = { ...seg, events: [...seg.events, ev] };
    } else if (!SEGMENT_KEEPS.has(ev.kind)) {
      this.s.segment = null;
    }
    return rule;
  }

  // A start failure of a session an arrival in the segment covered: the
  // segment's events are folded again from its base with every start failure
  // known by now counted from the start, then the failure itself, so the panes
  // are what the failure learned first would have given.
  private refold(seg: Segment, ev: FoldEvent & { readonly kind: "failure" }): Rule {
    const selectedBefore = this.s[this.s.selected];
    const recent = this.s.recent;
    this.load(seg.base);
    this.replayAt = ev.at;
    const covers: string[] = [];
    for (const e of seg.events) {
      this.takeCovered();
      this.apply(e);
      const covered = this.takeCovered();
      if (e.kind === "arrival" && covered !== null) {
        covers.push(covered);
      }
    }
    this.replayAt = null;
    this.apply(ev);
    this.s.recent = recent;
    this.s.segment = { base: seg.base, events: [...seg.events, ev], covers };
    const selected = this.s[this.s.selected];
    const moved = selected !== selectedBefore && selected !== ev.id;
    return { persist: true, moved: "server", form: moved ? "announce" : null };
  }

  private apply(ev: FoldEvent): Rule {
    switch (ev.kind) {
      case "arrival":
        return this.arrival(ev.id, ev.at);
      case "failure":
        return this.restore(ev.id, ev.at);
      case "removal":
        return this.removal(ev);
      case "show":
        this.retry = true;
        return this.show(ev.id, ev.at);
      case "own":
        this.retry = true;
        this.typing ||= ev.typing;
        return this.own(ev);
      case "snap":
        this.retry = true;
        return this.snap(ev);
      case "split":
        this.retry = true;
        return ev.open ? this.openSplit(ev.at) : this.closeSplit();
      case "route":
        this.retry = true;
        return this.route(ev);
      case "settle":
        return this.settleRule(ev);
      case "resyncBegan":
        return this.resyncBegan(ev);
      case "select":
        return this.select(ev.side);
      case "shell":
        return this.shell(ev.change, ev.at);
      case "paneFailed":
        if (this.s.open) {
          this.s.failed[ev.side] = true;
        }
        return NOOP;
      case "splitFit":
        this.s.fit = ev.canOpen;
        return NOOP;
      case "syncPoint":
        this.retry = true;
        return NOOP;
      case "holdsChanged":
        this.s.held = ev.active;
        return NOOP;
      case "view":
        this.s.visible = ev.visible;
        this.s.tray = ev.tray;
        return NOOP;
    }
  }

  private arrival(id: string, t: number): Rule {
    if (!this.presentAt(id, t) || this.sideOf(id) !== null || !this.s.open) {
      return NOOP;
    }
    const first = this.newTabSide();
    for (const side of [first, otherSide(first)]) {
      const cur = this.s[side];
      if (!this.usable(side) || (cur !== null && this.failedAt(cur, t))) {
        continue;
      }
      const entry: Covered | undefined =
        this.s.covered[side] ??
        (cur === null
          ? undefined
          : { id: cur, other: this.s[otherSide(side)], selected: this.s.selected });
      this.put(side, id, true);
      if (entry !== undefined) {
        this.s.covered[side] = entry;
      }
      this.lastCovered = cur;
      this.s.selected = side;
      return { persist: true, moved: "server", form: "announce" };
    }
    return NOOP;
  }

  // A start failure gives back every side an arrival took from the failed
  // session, and puts the arrival where it would have gone had the failure been
  // known at its arrival: the other side when that still shows what it showed
  // then, else only its chip, with the selection it would have left.
  private restore(id: string, t: number): Rule {
    let rule = NOOP;
    for (const side of SIDES) {
      const e = this.s.covered[side];
      if (e?.id !== id) {
        continue;
      }
      const arrival = this.s[side];
      this.uncover(side);
      this.put(side, id, true);
      rule = { persist: true, moved: "server", form: rule.form };
      const o = otherSide(side);
      if (
        arrival !== null &&
        arrival !== id &&
        this.s.open &&
        e.other !== null &&
        this.s[o] === e.other &&
        !this.failedAt(e.other, t)
      ) {
        this.s[o] = arrival;
        this.s.covered[o] = { id: e.other, other: id, selected: e.selected };
        this.s.selected = o;
        rule = { ...rule, form: "announce" };
      } else if (this.s.selected === side) {
        this.s.selected = this.s.open ? e.selected : "left";
      }
    }
    return rule;
  }

  private removal(ev: Extract<TimelineEntry, { kind: "removal" }>): Rule {
    const gone = new Set(ev.ids);
    for (const side of SIDES) {
      const c = this.s.covered[side];
      if (c !== undefined && gone.has(c.id)) {
        this.uncover(side);
      }
    }
    this.s.recent = this.s.recent.filter((id) => !gone.has(id));
    if (ev.by === "user") {
      this.retry = true;
      this.typing ||= ev.typing;
      this.keyboardHeld ||= ev.keyboardHeld;
    }
    if (this.stripAt(ev.at).length === 0) {
      this.settle = true;
    }
    const isGone = (id: string | null): id is string => id !== null && gone.has(id);
    if (!isGone(this.s.left) && !isGone(this.s.right)) {
      return NOOP;
    }
    const moved = ev.by === "user" ? "user" : "server";
    if (this.s.open) {
      const keep = SIDES.find((side) => this.s[side] !== null && !isGone(this.s[side]));
      if (keep !== undefined) {
        this.closeTo(this.s[keep], this.s.covered[keep]);
        return { persist: true, moved, form: "focus" };
      }
    }
    const sel = this.s[this.s.selected];
    const x = isGone(sel) ? sel : this.s[otherSide(this.s.selected)];
    const next = x === null ? null : (ev.neighbour.get(x) ?? null);
    this.closeTo(this.presentAt(next, ev.at) ? next : null);
    return { persist: true, moved, form: next === null ? null : "announce" };
  }

  private show(id: string, t: number): Rule {
    if (!this.presentAt(id, t)) {
      return NOOP;
    }
    const on = this.sideOf(id);
    if (on !== null) {
      this.s.selected = on;
      return { persist: true, moved: "user", form: "focus" };
    }
    const side = this.target();
    if (!this.usable(side)) {
      return NOOP;
    }
    this.put(side, id);
    this.s.selected = side;
    return { persist: true, moved: "user", form: "announce" };
  }

  private own(ev: OwnIntent & { readonly at: number }): Rule {
    if (!this.presentAt(ev.id, ev.at)) {
      return NOOP;
    }
    const on = this.sideOf(ev.id);
    if (on !== null) {
      this.s.selected = on;
      return { persist: true, moved: "user", form: "focus" };
    }
    const opening = ev.opening;
    if (opening?.by === "button" && !this.s.open && this.s.fit) {
      this.s.open = true;
    } else if (
      opening?.by === "snap" &&
      !this.s.open &&
      this.s.fit &&
      this.presentAt(opening.id, ev.at)
    ) {
      this.s.open = true;
      this.put(opening.side, opening.id);
      this.s.selected = opening.side;
      this.put(otherSide(opening.side), ev.id);
      return { persist: true, moved: "user", form: "announce" };
    }
    const side = this.newTabSide();
    if (!this.usable(side)) {
      return { persist: true, moved: "user", form: null };
    }
    this.put(side, ev.id);
    this.s.selected = side;
    return { persist: true, moved: "user", form: "announce" };
  }

  private snap(ev: Extract<TimelineEntry, { kind: "snap" }>): Rule {
    const { id, side, at } = ev;
    if (!this.presentAt(id, at)) {
      return NOOP;
    }
    const opening = !this.s.open;
    const from = this.sideOf(id);
    if ((from === side && !opening) || (opening && !this.s.fit)) {
      return NOOP;
    }
    if (!opening && !this.usable(side)) {
      return NOOP;
    }
    const partner = this.splitPartner(id, at);
    if (opening && partner === null) {
      return NOOP;
    }
    this.typing ||= ev.typing;
    this.s.open = true;
    const displaced = this.s[side];
    this.put(side, id);
    this.s.selected = side;
    const kept = displaced === id ? null : displaced;
    const back = kept ?? (opening ? partner : null);
    const o = otherSide(side);
    if ((from !== null || opening) && back !== null && this.s[o] === null && this.usable(o)) {
      this.put(o, back);
    }
    return { persist: true, moved: "user", form: displaced === id ? "focus" : "announce" };
  }

  private openSplit(t: number): Rule {
    if (this.s.open || !this.s.fit) {
      return NOOP;
    }
    const partner = this.splitPartner(this.s[this.s.selected], t);
    if (partner === null) {
      return NOOP;
    }
    this.s.open = true;
    this.put("right", partner);
    if (this.s[this.s.selected] === null) {
      this.s.selected = "right";
    }
    return { persist: true, moved: "user", form: null };
  }

  private closeSplit(): Rule {
    if (!this.s.open) {
      return NOOP;
    }
    this.closeKeepingSelected();
    return { persist: true, moved: "user", form: null };
  }

  private route(ev: Extract<TimelineEntry, { kind: "route" }>): Rule {
    if (ev.stale) {
      this.toasts.push("stale");
    }
    const r = ev.route;
    if (r === null) {
      return NOOP;
    }
    const before = this.s[this.s.selected];
    const first = r.kind === "single" ? r.tab : (r.left ?? r.right);
    if (first === null || !this.presentAt(first, ev.at)) {
      return NOOP;
    }
    let wantSplit = r.kind === "split";
    if (wantSplit && !this.s.open && !this.s.fit) {
      wantSplit = false;
      this.toasts.push("narrow");
    }
    if (!wantSplit || r.kind === "single") {
      if (this.s.open) {
        const at = this.sideOf(first);
        if (at !== null) {
          this.s.selected = at;
        }
        this.closeKeepingSelected();
      }
      if (this.sideOf(first) === null && this.usable(this.s.selected)) {
        this.put(this.s.selected, first);
      }
      return { persist: true, moved: "user", form: before === null ? "announce" : null };
    }
    this.s.open = true;
    const want: Record<PaneSide, string | null> = { left: r.left, right: r.right };
    const kept = this.s.selected;
    for (const side of [kept, otherSide(kept)]) {
      const id = want[side];
      if (id !== null && this.s[side] !== id && this.usable(side) && this.presentAt(id, ev.at)) {
        this.put(side, id);
      }
    }
    for (const side of SIDES) {
      if (want[side] === null && this.s[side] !== null) {
        this.s[side] = null;
        this.uncover(side);
      }
    }
    const sel = this.s.selected;
    if (this.s[sel] === null && this.s[otherSide(sel)] !== null) {
      this.s.selected = otherSide(sel);
    }
    const announce = before === null && this.s[this.s.selected] !== null;
    return { persist: true, moved: "user", form: announce ? "announce" : null };
  }

  private settleRule(ev: Extract<TimelineEntry, { kind: "settle" }>): Rule {
    if (this.anyShown()) {
      this.s.repairArmed = false;
      return NOOP;
    }
    if (ev.stale) {
      this.toasts.push("stale");
    }
    const t = ev.at;
    const strip = this.stripAt(t).map((f) => f.id);
    const oldestLive = strip.find((id) => ev.live.has(id));
    const saved = (id: string | null): string | null =>
      this.presentAt(id, t) && (ev.live.has(id) || oldestLive === undefined) ? id : null;
    const record = ev.record;
    const restore = (sides: Record<PaneSide, string | null>, selected: PaneSide): boolean => {
      // The kernel restores a split onto a row too narrow for two panes as a
      // collapsed one, so only a terminal built without a split refuses.
      if ((sides.left === null && sides.right === null) || !this.splitEnabled) {
        return false;
      }
      this.s.open = true;
      this.s.covered = {};
      this.s.left = sides.left;
      this.s.right = sides.right;
      this.s.selected = selected;
      return true;
    };
    let shown = false;
    const r = ev.route;
    if (r !== null) {
      const sides: Record<PaneSide, string | null> =
        r.kind === "single"
          ? { left: saved(r.tab), right: null }
          : { left: saved(r.left), right: saved(r.right) };
      if (r.kind === "split") {
        const fromRecord =
          record?.open === true && record.left === sides.left && record.right === sides.right
            ? record.selected
            : null;
        const selected: PaneSide =
          fromRecord !== null && sides[fromRecord] !== null
            ? fromRecord
            : sides.left !== null
              ? "left"
              : "right";
        shown = restore(sides, selected);
      }
      const only = sides.left ?? sides.right;
      if (!shown && only !== null) {
        this.put(this.target(), only);
        shown = true;
      }
    }
    const byRoute = shown;
    if (!shown && record?.open === true) {
      const sides = { left: saved(record.left), right: saved(record.right) };
      const selected: PaneSide =
        sides[record.selected] !== null ? record.selected : sides.left !== null ? "left" : "right";
      shown = restore(sides, selected);
    }
    if (!shown) {
      const start =
        saved(record === null ? null : record.selected === "right" ? record.right : record.left) ??
        oldestLive ??
        strip[0] ??
        null;
      if (start !== null) {
        this.put(this.target(), start);
        shown = true;
      }
    }
    this.s.repairArmed = !shown;
    if (!shown) {
      return NOOP;
    }
    const now: PaneLayout = {
      left: this.s.left,
      right: this.s.right,
      handle: 0,
      selected: this.s.selected,
      open: this.s.open,
    };
    // Only the address rewrites the shared record: a settle from the record, or
    // from the oldest tab with no record, has nothing newer to say.
    return {
      persist: byRoute && record !== null && !sameShown(now, record),
      moved: "settle",
      form: null,
    };
  }

  private resyncBegan(ev: Extract<TimelineEntry, { kind: "resyncBegan" }>): Rule {
    const dropped = new Set(ev.ids);
    this.typing ||= ev.typing;
    this.s.recent = this.s.recent.filter((id) => !dropped.has(id));
    for (const side of SIDES) {
      const id = this.s[side];
      if (id !== null && dropped.has(id)) {
        this.s[side] = null;
      }
    }
    const kept = this.s[this.s.selected] ?? this.s[otherSide(this.s.selected)];
    this.closeTo(kept);
    return { persist: false, moved: "server", form: null };
  }

  private select(side: PaneSide): Rule {
    if (side === "right" && !this.s.open) {
      return NOOP;
    }
    if (this.s[side] !== null || !this.anyShown()) {
      this.s.selected = side;
    }
    return { persist: true, moved: null, form: null };
  }

  private shell(change: ShellChange, t: number): Rule {
    switch (change.kind) {
      case "splitOpened":
        if (this.s.open) {
          return NOOP;
        }
        this.s.open = true;
        this.s.selected = change.selected;
        break;
      case "splitClosed":
        this.closeTo(this.presentAt(change.keptId, t) ? change.keptId : null);
        break;
      case "paneDropped":
        if (this.s[change.side] === change.id) {
          this.s[change.side] = null;
          this.uncover(change.side);
        }
        break;
      case "rehome": {
        if (!this.presentAt(change.id, t)) {
          return NOOP;
        }
        const o = otherSide(change.side);
        this.s[change.side] = change.id;
        this.s[o] = null;
        this.s.covered = {};
        this.s.selected = change.side;
        return { persist: true, moved: "user", form: "announce" };
      }
    }
    return { persist: true, moved: "user", form: null };
  }

  // The repair: after a settle that placed nothing, the first session present
  // while no hold is set is shown, a live one before an ended one.
  repair(t: number): Rule {
    if (this.anyShown()) {
      this.s.repairArmed = false;
      return NOOP;
    }
    if (!this.s.repairArmed || this.s.held) {
      return NOOP;
    }
    const byBirth = this.stripAt(t).sort((a, b) => a.born - b.born);
    const pick =
      byBirth.find((f) => f.endedAt === null || f.endedAt > t) ?? byBirth[0] ?? undefined;
    if (pick === undefined) {
      return NOOP;
    }
    this.closeTo(pick.id);
    this.s.repairArmed = false;
    return { persist: true, moved: "server", form: null };
  }
}

function eventsAfter(m: TabsModel, through: number): FoldEvent[] {
  const out: FoldEvent[] = [];
  const inRange = (at: number | null): at is number => at !== null && at > through;
  for (const f of [...m.gone, ...m.sessions.values()]) {
    if (f.origin === "elsewhere" && inRange(f.placeableAt)) {
      out.push({ kind: "arrival", at: f.placeableAt, id: f.id });
    }
    if (inRange(f.failAt)) {
      out.push({ kind: "failure", at: f.failAt, id: f.id });
    }
  }
  for (const e of m.timeline) {
    if (e.at > through) {
      out.push(e);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function stripFor(m: TabsModel, prev: Layout): string[] {
  const sorted = [...m.sessions.values()].sort(compareTabOrder).map((f) => f.id);
  if (!m.page.dragging) {
    return sorted;
  }
  const kept = prev.strip.filter((id) => m.sessions.has(id));
  return [...kept, ...sorted.filter((id) => !kept.includes(id))];
}

export function stepFor(m: TabsModel, prev: Layout): { layout: Layout; effects: Effects } {
  const fold = new Folder(m, prev);
  const s = fold.s;
  const acc: { persist: boolean; moved: Effects["moved"]; form: FocusForm | null } = {
    persist: false,
    moved: "none",
    form: null,
  };
  const track = (rule: Rule, before: Readonly<FoldState>): void => {
    const panesMoved = before.left !== s.left || before.right !== s.right || before.open !== s.open;
    if (rule.persist && (panesMoved || before.selected !== s.selected)) {
      acc.persist = true;
    }
    if (panesMoved && rule.moved !== null) {
      acc.moved = rule.moved;
    }
    if (rule.form !== null) {
      acc.form = rule.form;
    }
    const sel = s[s.selected];
    if (sel !== null && sel !== before[before.selected]) {
      s.recent = [sel, ...s.recent.filter((id) => id !== sel)];
    }
  };
  // An ack is owed for a cue whose session was in view at some stamp while that
  // status was current, so the acks a run sends do not depend on where its
  // commits fell. viewedUntil[id] is the first stamp after its last stretch in view.
  const viewedUntil = new Map<string, number>();
  const viewedBefore = (t: number): void => {
    for (const id of fold.inViewAt(t - 1)) {
      viewedUntil.set(id, t);
    }
  };
  const step = (t: number, run: () => Rule): void => {
    const before = { ...s };
    track(run(), before);
    const afterRule = { ...s };
    const repaired = fold.repair(t);
    if (repaired !== NOOP) {
      s.segment = null;
    }
    track(repaired, afterRule);
  };
  step(prev.through, () => NOOP);
  for (const ev of eventsAfter(m, prev.through)) {
    viewedBefore(ev.at);
    step(ev.at, () => fold.event(ev));
  }
  viewedBefore(m.clock + 1);
  const inView = new Set(
    m.page.visible
      ? [...m.sessions.keys()].filter(
          (id) => m.page.switcherOpen || id === s.left || id === s.right,
        )
      : [],
  );
  const acks = [...m.sessions.values()]
    .filter(
      (f) =>
        isUnread(f) &&
        (viewedUntil.get(f.id) ?? 0) > f.statusAt &&
        (fold.retry || f.failedSeq !== f.statusSeq),
    )
    .map((f) => ({ id: f.id, seq: f.statusSeq }));
  // Leaving out the sessions this call acks gives the value those acks produce.
  // An in-view session whose ack failed and is not retried stays unread, so it
  // counts, though the switch dot, which points away from the screen, skips it.
  const acked = new Set(acks.map((a) => a.id));
  const unacked = [...m.sessions.values()]
    .filter((f) => !acked.has(f.id))
    .map((f) => ({ ...f, status: foldedCueStatus(f.status, f.activity) }));
  const attention = summarizeCues(unacked);
  const switchDot = summarizeCues(unacked.filter((f) => !inView.has(f.id))).worst;
  const layout: Layout = {
    strip: stripFor(m, prev),
    through: m.clock,
    panes: { left: s.left, right: s.right },
    split: { open: s.open, selected: s.selected },
    covered: s.covered,
    recent: s.recent,
    failed: s.failed,
    repairArmed: s.repairArmed,
    fit: s.fit,
    held: s.held,
    visible: s.visible,
    tray: s.tray,
    segment: s.segment,
    inView,
    indicators: { switchDot, attention },
  };
  const { moved, persist, form } = acc;
  const focus =
    form !== null || fold.typing || fold.keyboardHeld
      ? { form, typing: fold.typing, keyboardHeld: fold.keyboardHeld }
      : null;
  const effects: Effects = {
    acks,
    retry: fold.retry,
    moved,
    persist,
    focus,
    toasts: fold.toasts,
    settle: fold.settle,
    resync:
      m.restartPending !== null && m.holds.resync === 0 ? { ids: m.restartPending.ids } : null,
    address: moved === "none" ? null : moved === "settle" ? "replace" : "push",
  };
  return { layout, effects };
}
