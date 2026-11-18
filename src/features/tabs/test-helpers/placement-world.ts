// A page over the pure placement model: reducers in, commits out, with the
// commit's own dispatches (folded, ackSent, resyncRequested, the record write)
// done as index.ts does them, so a test reads what a mounted page would paint.

import type { PaneSide } from "../../../kernel/types.js";
import type { PaneLayout, StatusRecord } from "../model.js";
import {
  EMPTY_LAYOUT,
  bootSettled,
  commitStep,
  createModel,
  mergeList,
  mergeRecord,
  ownReleased,
  removed,
  resyncBegan,
  resyncSettled,
  syncBegan,
  syncEnded,
  type Effects,
  type Layout,
  type TabsModel,
} from "../placement.js";
import type { TabRoute } from "../route.js";

const BASE_MS = Date.UTC(2026, 0, 1);
const FIXED: Readonly<Record<string, number>> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  X: 5,
  Y: 6,
  W: 7,
  V: 8,
  Z: 10,
  N: 20,
};

/** A stable creation time per id, so the strip order is the id table's. */
export function createdAt(id: string): string {
  const fixed = FIXED[id];
  if (fixed !== undefined) {
    return new Date(BASE_MS + fixed * 1000).toISOString();
  }
  const m = /^([A-Z])(\d+)$/.exec(id);
  const n = m === null ? 999 : (m[1] ?? "A").charCodeAt(0) * 1000 + Number(m[2]);
  return new Date(BASE_MS + n * 1000).toISOString();
}

export function rec(id: string, over: Partial<StatusRecord> = {}): StatusRecord {
  return {
    id,
    createdAt: createdAt(id),
    status: "",
    title: id,
    alias: id,
    statusSeq: 0,
    seenSeq: 0,
    ...over,
  };
}

/** A start failure as the server lists and streams it. */
export function endedRec(id: string, seq = 1): StatusRecord {
  return rec(id, { status: "ended", endReason: "spawn failed", statusSeq: seq });
}

export function splitRecord(
  left: string | null,
  right: string | null,
  selected: PaneSide = "left",
  handle = 0.5,
): PaneLayout {
  return { left, right, handle, selected, open: true };
}

export function singleRecord(id: string): PaneLayout {
  return { left: id, right: null, handle: 0.5, selected: "left", open: false };
}

export interface ListToken {
  readonly listedAt: number;
  readonly epochAtList: number;
}

export class Page {
  m: TabsModel;
  lay: Layout = EMPTY_LAYOUT;
  now = 0;
  readonly acks: { id: string; seq: number }[] = [];
  readonly writes: { record: PaneLayout; owed: TabsModel["writeOwed"] }[] = [];
  /** The ids of each resync the commits requested, in order. */
  readonly resyncs: (readonly string[])[] = [];
  /** How many resyncs the commits requested in all. */
  requested = 0;
  readonly log: Effects[] = [];

  constructor(opts: { readonly presumeReports?: boolean } = {}) {
    this.m = createModel(opts);
  }

  apply(f: (m: TabsModel) => TabsModel): this {
    this.m = f(this.m);
    return this;
  }

  commit(): Effects {
    const step = commitStep(this.m, this.lay);
    this.lay = step.layout;
    this.acks.push(...step.effects.acks);
    if (step.resync !== null) {
      this.resyncs.push(step.resync);
      this.requested += 1;
    }
    if (step.write !== null) {
      this.writes.push({ record: step.write, owed: this.m.writeOwed });
    }
    this.m = step.model;
    this.log.push(step.effects);
    return step.effects;
  }

  get panes(): [string | null, string | null] {
    return [this.lay.panes.left, this.lay.panes.right];
  }

  stream(r: StatusRecord): this {
    return this.apply((m) => mergeRecord(m, r, { stream: true }, this.now));
  }

  gone(...ids: string[]): this {
    return this.apply((m) => removed(m, ids, { by: "server" }, this.now));
  }

  /** A list requested now; answer it with `answer`. */
  request(): ListToken {
    return { listedAt: this.m.streamEpoch, epochAtList: this.m.clock };
  }

  answer(token: ListToken, rows: readonly StatusRecord[]): this {
    return this.apply((m) => mergeList(m, rows, token, this.now));
  }

  /** A poll requested and answered at once. */
  list(rows: readonly StatusRecord[]): this {
    return this.answer(this.request(), rows);
  }

  /** A stream open: the hold begins and the open's list is requested. */
  open(): ListToken {
    this.apply(syncBegan);
    return this.request();
  }

  /** The open's list answered with `rows`, or failed when rows is null. */
  opened(token: ListToken, rows: readonly StatusRecord[] | null): this {
    if (rows !== null) {
      this.answer(token, rows);
    }
    return this.apply(syncEnded);
  }

  /** Runs the oldest requested resync to its settle onto `rows` and `record`. */
  resync(
    rows: readonly StatusRecord[],
    record: PaneLayout | null,
    route: TabRoute | null = null,
  ): this {
    const ids = this.resyncs.shift() ?? [];
    this.apply((m) => resyncBegan(m, ids, false, this.now));
    this.apply((m) =>
      resyncSettled(m, { sessions: rows, record, route, toastStale: false, now: this.now }),
    );
    return this.apply(ownReleased);
  }
}

/** A started page whose boot settled `ids` onto `record`, committed. */
export function bootPage(
  rows: readonly (string | StatusRecord)[],
  record: PaneLayout | null,
  opts: { readonly route?: TabRoute | null; readonly canOpen?: boolean } = {},
): Page {
  const page = new Page();
  page.apply((m) =>
    bootSettled(m, {
      sessions: rows.map((r) => (typeof r === "string" ? rec(r) : r)),
      record,
      route: opts.route ?? null,
      toastStale: false,
      now: 0,
      canOpen: opts.canOpen ?? true,
      splitEnabled: true,
    }),
  );
  page.commit();
  return page;
}
