// The tabs feature's session model and its pure placement. Inputs only write the
// model through the reducers below; layoutFor decides the strip, the panes, the
// split, the selection and every indicator from the whole model. No DOM, no
// wall clock, no kernel object: the node test project runs it.

import type { PaneSide } from "../../kernel/types.js";
import {
  CLOSE_TOMBSTONE_MS,
  compareTabOrder,
  isEndedStatus,
  isStartFailureStatus,
  normalizeActivity,
  normalizeActivityCount,
  normalizeProgress,
  normalizeSeq,
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
  /** The server's shared position, undefined against a server that keeps none. */
  readonly order: number | undefined;
  /** The session's URL name, undefined when the server sent none or an invalid one. */
  readonly alias: TabAlias | undefined;
  /** The title the server resolved; a blank record never overwrites it. */
  readonly title: string;
  /** The user's pinned name; "" or undefined is none. */
  readonly pinnedTitle: string | undefined;
  /** The raw server status ("" for none). */
  readonly status: string;
  readonly statusSeq: number;
  /** Sticky: the session emitted a genuine activity signal. */
  readonly reports: boolean;
  /** The last reported percentage, or PROGRESS_ABSENT. */
  readonly progress: number;
  readonly activity: string;
  readonly activityCount: number;
  /** The stream epoch of the last stream record, 0 when none: a list requested
   *  before it is older. */
  readonly streamAt: number;
  readonly endReason: string;
  /** The reason the session ended before its process started ("" when unknown);
   *  meaningful only while failAt is set. Never cleared. */
  readonly startFailure: string;
  readonly failAt: number | null;
  /** The server-confirmed read floor; only rises. */
  readonly seenSeq: number;
  /** This page's optimistic read floor, 0 when none. */
  readonly ackSeq: number;
  /** The occurrence whose ack last failed with a non-404, 0 when none. */
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
  inView: new Set(),
  indicators: { switchDot: "", attention: { count: 0, worst: "" } },
};

export const NO_EFFECTS: Effects = {
  acks: [],
  retry: false,
  moved: "none",
  persist: false,
  focus: null,
  toasts: [],
  settle: false,
  resync: null,
  address: null,
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
    page: { visible: true, switcherOpen: false, started: false, dragging: false, ratio: 0.5 },
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
  readonly heldBefore: boolean;
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

// Every reducer ends here. A flip of "any hold is set" is a stamped event, and
// a release stamps each held session placeable in compareTabOrder order, so a
// burst's arrivals are placed as one sorted run whatever order they came in.
function finish(d: Draft): TabsModel {
  const out: TabsModel = {
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
  const held = anyHold(out);
  if (held === d.heldBefore) {
    return out;
  }
  d.timeline.push({ kind: "holdsChanged", at: tick(d), active: held });
  if (!held) {
    const waiting = [...d.sessions.values()]
      .filter((f) => f.placeableAt === null)
      .sort(compareTabOrder);
    for (const f of waiting) {
      d.sessions.set(f.id, { ...f, placeableAt: tick(d) });
    }
  }
  return { ...out, clock: d.clock };
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
 *  after the settle while a resync is held. */
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
  if (d.holds.resync > 0) {
    d.pendingOwn = intent;
  } else {
    d.timeline.push({ ...intent, at: tick(d) });
  }
  d.holds.create = false;
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
  input: SettleInput & { readonly canOpen: boolean },
): TabsModel {
  const d = draft(m);
  d.page.started = true;
  d.timeline.push({ kind: "splitFit", at: tick(d), canOpen: input.canOpen });
  pushSettle(d, "boot", input);
  return finish(d);
}

/** A resync's settle (a failed one settles what it listed, or nothing). Every
 *  session still unplaceable is relabelled a settle session, so none of the set
 *  held across it is placed as an arrival. */
export function resyncSettled(m: TabsModel, input: SettleInput): TabsModel {
  const d = draft(m);
  pushSettle(d, "resync", { ...input, toastStale: false });
  for (const f of d.sessions.values()) {
    if (f.placeableAt === null && f.origin === "elsewhere") {
      d.sessions.set(f.id, { ...f, origin: "settle" });
    }
  }
  if (d.pendingOwn !== null) {
    d.timeline.push({ ...d.pendingOwn, at: tick(d) });
    d.pendingOwn = null;
  }
  d.holds.resync = Math.max(0, d.holds.resync - 1);
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
  const became = visible && !d.page.visible;
  d.page.visible = visible;
  const at = tick(d);
  if (became) {
    d.timeline.push({ kind: "syncPoint", at, point: "visible" });
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
  const opened = open && !d.page.switcherOpen;
  d.page.switcherOpen = open;
  const at = tick(d);
  if (opened) {
    d.timeline.push({ kind: "syncPoint", at, point: "tray" });
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

export function layoutFor(m: TabsModel, prev: Layout): Layout {
  return stepFor(m, prev).layout;
}

export function stepFor(_m: TabsModel, prev: Layout): { layout: Layout; effects: Effects } {
  return { layout: prev, effects: NO_EFFECTS };
}
