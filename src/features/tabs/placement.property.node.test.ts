import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isEndedStatus, type StatusRecord } from "./model.js";
import {
  createBegan,
  layoutRecord,
  layoutStale,
  ownCreated,
  pageVisibility,
  paneStartFailed,
  removed,
  resyncBegan,
  route,
  ownReleased,
  resyncSettled,
  select,
  shellChanged,
  show,
  splitIntent,
  splitRatio,
  stepFor,
  switcherToggled,
  ackSettled,
  ackFailed,
  type Effects,
  type SplitOpening,
} from "./placement.js";
import {
  bootPage,
  chromeOf,
  createdAt,
  endedRec,
  rec,
  splitRecord,
  type ListToken,
  type Page,
} from "./test-helpers/placement-world.js";
import type { TabAlias } from "./route.js";

const ORDERS = { numRuns: 4000 } as const;
const SLOW = { timeout: 60_000 } as const;

type Ev = { readonly rec: StatusRecord } | { readonly removed: string };

/** The server the page talks to: its sessions now, and the stream's queue. */
class Server {
  readonly rows = new Map<string, StatusRecord>();
  queue: Ev[] = [];
  private n = 0;
  constructor(
    ids: readonly string[],
    private readonly keep: string | null = null,
  ) {
    for (const id of ids) {
      this.rows.set(id, rec(id));
    }
  }
  create(prefix: string): string {
    this.n += 1;
    const id = `${prefix}${String(this.n)}`;
    const r = rec(id);
    this.rows.set(id, r);
    this.queue.push({ rec: r });
    return id;
  }
  pick(who: number, except: readonly (string | null)[] = []): string | undefined {
    const ids = [...this.rows.keys()].filter((id) => !except.includes(id));
    return ids.length === 0 ? undefined : ids[who % ids.length];
  }
  private update(id: string, f: (r: StatusRecord) => StatusRecord | null): void {
    const r = this.rows.get(id);
    const next = r === undefined ? null : f(r);
    if (next !== null) {
      this.rows.set(id, next);
      this.queue.push({ rec: next });
    }
  }
  status(id: string, status: string): void {
    this.update(id, (r) =>
      isEndedStatus(r.status) ? null : { ...r, status, statusSeq: (r.statusSeq ?? 0) + 1 },
    );
  }
  fail(id: string): void {
    this.update(id, (r) =>
      (r.statusSeq ?? 0) !== 0
        ? null
        : { ...r, status: "ended", endReason: "spawn failed", statusSeq: 1 },
    );
  }
  read(id: string): void {
    this.update(id, (r) =>
      (r.statusSeq ?? 0) <= (r.seenSeq ?? 0) ? null : { ...r, seenSeq: r.statusSeq ?? 0 },
    );
  }
  remove(id: string): void {
    if (id !== this.keep && this.rows.delete(id)) {
      this.queue.push({ removed: id });
    }
  }
  list(): StatusRecord[] {
    return [...this.rows.values()];
  }
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

const byAge = (ids: Iterable<string>): string[] =>
  [...ids].sort((a, b) =>
    createdAt(a) === createdAt(b) ? (a < b ? -1 : 1) : createdAt(a) < createdAt(b) ? -1 : 1,
  );

const who = fc.nat({ max: 9 });
const cueArb = fc.constantFrom("", "input", "done", "failed", "crashed");
const cmdArb = fc.oneof(
  fc.record({ k: fc.constant("create" as const), cue: cueArb }),
  fc.record({
    k: fc.constant("status" as const),
    who,
    status: fc.constantFrom("working", "input", "done", "failed", "crashed", "exited", "idle"),
  }),
  fc.record({ k: fc.constant("fail" as const), who }),
  fc.record({ k: fc.constant("pane4001" as const), who }),
  fc.record({ k: fc.constant("read" as const), who }),
  fc.record({ k: fc.constant("remove" as const), who }),
  fc.record({ k: fc.constant("deliver" as const), n: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ k: fc.constant("pollReq" as const) }),
  fc.record({ k: fc.constant("pollAns" as const) }),
  fc.record({ k: fc.constant("reopen" as const), seed: fc.nat(), early: fc.nat({ max: 4 }) }),
  fc.record({ k: fc.constant("openAns" as const), fail: fc.boolean() }),
  fc.record({ k: fc.constant("ack" as const), answer: fc.constantFrom("ok", "gone", "fail") }),
  fc.record({ k: fc.constant("visible" as const) }),
  fc.record({ k: fc.constant("resyncRun" as const) }),
  fc.record({ k: fc.constant("show" as const), who }),
  fc.record({
    k: fc.constant("select" as const),
    side: fc.constantFrom("left" as const, "right" as const),
  }),
  fc.record({ k: fc.constant("close" as const), who, many: fc.boolean(), held: fc.boolean() }),
  fc.record({
    k: fc.constant("route" as const),
    who,
    shape: fc.constantFrom("single" as const, "split" as const, "stale" as const),
  }),
  fc.record({ k: fc.constant("ownBegin" as const), button: fc.boolean() }),
  fc.record({ k: fc.constant("ownAns" as const) }),
  fc.record({ k: fc.constant("split" as const) }),
  fc.record({ k: fc.constant("tray" as const) }),
  fc.record({ k: fc.constant("narrow" as const) }),
  fc.record({ k: fc.constant("hostOpen" as const) }),
);
type Cmd = typeof cmdArb extends fc.Arbitrary<infer T> ? T : never;
const SERVER_KINDS: ReadonlySet<Cmd["k"]> = new Set([
  "create",
  "status",
  "fail",
  "pane4001",
  "read",
  "remove",
  "deliver",
  "pollReq",
  "pollAns",
  "reopen",
  "openAns",
  "ack",
  "resyncRun",
]);
// A user step commits at once; a kernel step and an answer read the screen or
// what a commit sent, so every run commits before them.
const USER: ReadonlySet<Cmd["k"]> = new Set([
  "show",
  "select",
  "close",
  "route",
  "ownAns",
  "split",
  "tray",
  "narrow",
  "hostOpen",
]);
const COMMIT_BEFORE: ReadonlySet<Cmd["k"]> = new Set([
  "split",
  "narrow",
  "hostOpen",
  "resyncRun",
  "ack",
]);

// The steps that fold an intent or a sync point, after which a failed ack is
// sent again (design 2.1 `retry`). No other step may re-send one.
const RETRIES: ReadonlySet<Log["step"]> = new Set([
  "show",
  "close",
  "route",
  "ownAns",
  "split",
  "visible",
  "tray",
  "openAns",
  "resyncRun",
]);

// The steps that meet an arrival covering a session whose start then fails.
const REFOLD_KINDS: ReadonlySet<Cmd["k"]> = new Set([
  "create",
  "deliver",
  "fail",
  "pane4001",
  "status",
  "read",
  "route",
  "close",
  "ack",
  "visible",
  "tray",
  "select",
  "show",
]);

// The steps that land several arrivals in one input: a list, a hold's release.
const BURST_KINDS: ReadonlySet<Cmd["k"]> = new Set([
  "create",
  "status",
  "read",
  "deliver",
  "pollReq",
  "pollAns",
  "reopen",
  "openAns",
  "ownBegin",
  "ownAns",
  "ack",
  "visible",
  "tray",
  "split",
  "show",
]);

interface Step {
  readonly cmd: Cmd;
  readonly commit: boolean;
}
const stepsArb = (max: number, kinds?: ReadonlySet<Cmd["k"]>): fc.Arbitrary<Step[]> =>
  fc.array(
    fc.record({
      cmd: kinds === undefined ? cmdArb : cmdArb.filter((c) => kinds.has(c.k)),
      commit: fc.boolean(),
    }),
    { minLength: 1, maxLength: max },
  );

interface World {
  readonly page: Page;
  readonly server: Server;
  readonly polls: { token: ListToken; epoch: number; rows: StatusRecord[] }[];
  readonly opens: {
    token: ListToken;
    epoch: number;
    rows: StatusRecord[];
    pending: StatusRecord[];
  }[];
  own: { id: string; opening: SplitOpening | null } | null;
  readonly answered: boolean[];
  /** What the steps since the last commit owe the next commit's edge effects. */
  since: { stale: number; held: boolean; retry: boolean };
  /** The occurrences whose last ack failed with a non-404, as `id:seq`. */
  readonly failedAcks: Set<string>;
  readonly log: Log;
}

interface Sides {
  left: string | null;
  right: string | null;
}

/** What the test's own steps say the page learned and showed: the oracle of
 *  design 7.3.1, 7.3.4 and 7.3.5, never read off a field the fold derives. */
interface Log {
  /** Each session's freshest delivered occurrence, and its read floor. */
  readonly occ: Map<string, { readonly status: string; readonly seq: number }>;
  readonly floor: Map<string, number>;
  /** The occurrence the session's last sent ack names; 0 once that ack failed. */
  readonly acked: Map<string, number>;
  /** The freshest occurrence delivered while a commit showed the session on screen. */
  readonly viewed: Map<string, number>;
  readonly failed: Set<string>;
  /** Stream records delivered so far, and the count when each session's last one came. */
  epoch: number;
  readonly streamAt: Map<string, number>;
  visible: boolean;
  tray: boolean;
  /** Per side, the session the last user, kernel, settle or removal step gave it. */
  base: Sides;
  screen: Sides & { readonly open: boolean; readonly strip: readonly string[] };
  step: Cmd["k"] | "list";
}

function world(keep: string | null = null): World {
  const page = bootPage(["X", "Y", "W"], splitRecord("X", "Y"));
  const log: Log = {
    occ: new Map(),
    floor: new Map(),
    acked: new Map(),
    viewed: new Map(),
    failed: new Set(),
    epoch: 0,
    streamAt: new Map(),
    visible: page.m.page.visible,
    tray: false,
    base: { left: "X", right: "Y" },
    screen: { left: "X", right: "Y", open: true, strip: ["X", "Y", "W"] },
    step: "list",
  };
  return {
    page,
    server: new Server(["X", "Y", "W"], keep),
    polls: [],
    opens: [],
    own: null,
    answered: [],
    since: { stale: 0, held: false, retry: false },
    failedAcks: new Set(),
    log,
  };
}

/** Records what a stream record (`listedAt` null) or the rows of a list
 *  requested after `listedAt` stream records tell the page. A list row is older
 *  than a stream record of its session delivered after the list was requested. */
function learn(w: World, rows: readonly StatusRecord[], listedAt: number | null): void {
  const { log } = w;
  for (const r of rows) {
    if (listedAt === null) {
      log.epoch += 1;
      log.streamAt.set(r.id, log.epoch);
    }
    log.floor.set(r.id, Math.max(log.floor.get(r.id) ?? 0, r.seenSeq ?? 0));
    const seq = r.statusSeq ?? 0;
    if (listedAt !== null && (log.streamAt.get(r.id) ?? 0) > listedAt) {
      continue;
    }
    if (seq >= (log.occ.get(r.id)?.seq ?? 0)) {
      log.occ.set(r.id, { status: r.status, seq });
    }
    if (r.status === "ended" && (r.endReason ?? "") !== "") {
      log.failed.add(r.id);
    }
  }
}

function deliver(w: World, n: number): void {
  for (let i = 0; i < n; i++) {
    const ev = w.server.queue.shift();
    if (ev === undefined) {
      return;
    }
    if ("removed" in ev) {
      w.page.gone(ev.removed);
    } else {
      learn(w, [ev.rec], null);
      w.page.stream(ev.rec);
    }
  }
}

function present(w: World): string[] {
  return byAge(w.page.m.sessions.keys());
}

function resyncRun(w: World): void {
  const ids = w.page.resyncs.shift();
  if (ids === undefined) {
    return;
  }
  const rows = w.server.list();
  learn(w, rows, w.log.epoch);
  w.page.apply((m) => resyncBegan(m, ids, false, 0));
  w.page.apply((m) =>
    resyncSettled(m, { sessions: rows, record: null, route: null, toastStale: false, now: 0 }),
  );
  w.page.apply(ownReleased);
}

/** Runs one command; returns the id a user step must show in its own commit. */
function exec(w: World, cmd: Cmd): string | null {
  const { page, server } = w;
  w.since.retry ||= RETRIES.has(cmd.k);
  switch (cmd.k) {
    case "create": {
      const id = server.create("Z");
      if (cmd.cue !== "") {
        server.status(id, cmd.cue);
      }
      return null;
    }
    case "status":
    case "fail":
    case "read":
    case "remove": {
      const id = server.pick(cmd.who, [w.own?.id ?? null]);
      if (id === undefined) {
        return null;
      }
      if (cmd.k === "status") {
        server.status(id, cmd.status);
      } else if (cmd.k === "fail") {
        server.fail(id);
      } else if (cmd.k === "read") {
        server.read(id);
      } else {
        server.remove(id);
      }
      return null;
    }
    case "pane4001": {
      const failed = present(w).filter((id) => server.rows.get(id)?.status === "ended");
      const id = failed[cmd.who % Math.max(1, failed.length)];
      if (id !== undefined) {
        w.log.failed.add(id);
        page.apply((m) => paneStartFailed(m, id, "spawn failed"));
      }
      return null;
    }
    case "deliver":
      deliver(w, cmd.n);
      return null;
    case "pollReq":
      w.polls.push({ token: page.request(), epoch: w.log.epoch, rows: server.list() });
      return null;
    case "pollAns": {
      const poll = w.polls.shift();
      if (poll !== undefined) {
        learn(w, poll.rows, poll.epoch);
        page.answer(poll.token, poll.rows);
      }
      return null;
    }
    case "reopen": {
      for (const o of w.opens) {
        o.pending = [];
      }
      server.queue = [];
      const token = page.open();
      const epoch = w.log.epoch;
      const rows = shuffled(server.list(), cmd.seed);
      for (const r of rows.slice(0, cmd.early)) {
        learn(w, [r], null);
        page.stream(r);
      }
      w.opens.push({ token, epoch, rows: server.list(), pending: rows.slice(cmd.early) });
      return null;
    }
    case "openAns": {
      const o = w.opens.shift();
      if (o !== undefined) {
        for (const r of o.pending) {
          learn(w, [r], null);
          page.stream(r);
        }
        if (!cmd.fail) {
          learn(w, o.rows, o.epoch);
        }
        page.opened(o.token, cmd.fail ? null : o.rows);
      }
      return null;
    }
    case "ack": {
      const order = page.acks
        .map((a, i) => ({ a, i }))
        .filter(({ i }) => w.answered[i] !== true)
        .sort((x, y) => (x.a.id === y.a.id ? x.a.seq - y.a.seq : x.a.id < y.a.id ? -1 : 1));
      const first = order[0];
      if (first !== undefined) {
        w.answered[first.i] = true;
        const key = `${first.a.id}:${String(first.a.seq)}`;
        if (cmd.answer === "fail") {
          w.failedAcks.add(key);
          if (w.log.acked.get(first.a.id) === first.a.seq) {
            w.log.acked.set(first.a.id, 0);
          }
        } else {
          w.failedAcks.delete(key);
        }
        if (cmd.answer === "ok") {
          w.log.floor.set(first.a.id, Math.max(w.log.floor.get(first.a.id) ?? 0, first.a.seq));
        }
        page.apply((m) =>
          cmd.answer === "ok"
            ? ackSettled(m, first.a.id, first.a.seq)
            : ackFailed(m, first.a.id, first.a.seq, cmd.answer === "gone"),
        );
      }
      return null;
    }
    case "visible":
      w.log.visible = !w.log.visible;
      page.apply((m) => pageVisibility(m, w.log.visible));
      return null;
    case "resyncRun":
      resyncRun(w);
      return null;
    case "show": {
      const ids = present(w);
      const id = ids[cmd.who % Math.max(1, ids.length)];
      if (id === undefined) {
        return null;
      }
      page.apply((m) => show(m, id));
      return id;
    }
    case "select":
      page.apply((m) => select(m, cmd.side));
      return null;
    case "close": {
      const ids = present(w).filter((id) => id !== w.own?.id);
      const at = cmd.who % Math.max(1, ids.length);
      const victims = cmd.many ? ids.slice(at + 1) : ids.slice(at, at + 1);
      if (victims.length === 0 || victims.length >= present(w).length) {
        return null;
      }
      for (const id of victims) {
        server.remove(id);
      }
      w.since.held ||= cmd.held;
      page.apply((m) => removed(m, victims, { by: "user", keyboardHeld: cmd.held }, 0));
      return null;
    }
    case "route": {
      const ids = present(w);
      const id = ids[cmd.who % Math.max(1, ids.length)];
      if (cmd.shape === "stale" || id === undefined) {
        w.since.stale += 1;
        page.apply((m) => route(m, { kind: "single", tab: "Q9" as TabAlias }, true));
        return null;
      }
      if (cmd.shape === "single") {
        page.apply((m) => route(m, { kind: "single", tab: id as TabAlias }, true));
        return id;
      }
      const other = ids[(cmd.who + 1) % ids.length] ?? null;
      const right = other === id ? null : (other as TabAlias | null);
      page.apply((m) => route(m, { kind: "split", left: id as TabAlias, right }, true));
      return null;
    }
    case "ownBegin":
      if (w.own === null) {
        w.own = { id: server.create("N"), opening: cmd.button ? { by: "button" } : null };
        page.apply(createBegan);
      }
      return null;
    case "ownAns": {
      const o = w.own;
      if (o === null) {
        return null;
      }
      w.own = null;
      const r = server.rows.get(o.id) ?? rec(o.id);
      learn(w, [r], w.log.epoch);
      page.apply((m) => ownCreated(m, r, o.opening, false));
      return page.m.holds.resync === 0 ? o.id : null;
    }
    case "split": {
      const open = page.lay.split.open;
      if (open || present(w).length >= 2) {
        page.apply((m) => splitIntent(m, !open));
      }
      return null;
    }
    case "tray":
      w.log.tray = !w.log.tray;
      page.apply((m) => switcherToggled(m, w.log.tray));
      return null;
    case "narrow": {
      const l = page.lay;
      if (l.split.open) {
        const keptId = l.panes[l.split.selected] ?? l.panes.left ?? l.panes.right;
        page.apply((m) => shellChanged(m, { kind: "splitClosed", keptId }));
      }
      return null;
    }
    case "hostOpen": {
      const l = page.lay;
      if (!l.split.open && l.fit) {
        page.apply((m) => shellChanged(m, { kind: "splitOpened", selected: l.split.selected }));
      }
      return null;
    }
  }
}

/** The worse of two cues, written out per pair from the severity the tab icon documents. */
const WORSE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "": { "": "", crashed: "crashed", failed: "failed", input: "input", done: "done" },
  crashed: {
    "": "crashed",
    crashed: "crashed",
    failed: "crashed",
    input: "crashed",
    done: "crashed",
  },
  failed: { "": "failed", crashed: "crashed", failed: "failed", input: "failed", done: "failed" },
  input: { "": "input", crashed: "crashed", failed: "failed", input: "input", done: "input" },
  done: { "": "done", crashed: "crashed", failed: "failed", input: "input", done: "done" },
};

const CUES: ReadonlySet<string> = new Set(["crashed", "failed", "input", "done"]);
const PLACING: ReadonlySet<Log["step"]> = new Set([
  "show",
  "route",
  "ownAns",
  "split",
  "narrow",
  "hostOpen",
]);

/** No cue is lost and the switch dot is the worst unread cue off screen: the
 *  count covers every unread occurrence the log shows unacknowledged, the dot
 *  those the screen does not show, and an ack names only a session the log
 *  showed on screen since that occurrence was delivered. */
function checkCues(w: World, fx: Effects, acksSeen: boolean): void {
  const { log } = w;
  const l = w.page.lay;
  for (const a of fx.acks) {
    log.acked.set(a.id, a.seq);
  }
  const onScreen = (id: string): boolean =>
    log.visible && (log.tray || id === l.panes.left || id === l.panes.right);
  const unread = l.strip.filter((id) => {
    const o = log.occ.get(id);
    return (
      o !== undefined &&
      CUES.has(o.status) &&
      o.seq > Math.max(log.floor.get(id) ?? 0, log.acked.get(id) ?? 0)
    );
  });
  let dot = "";
  for (const id of unread.filter((x) => !onScreen(x))) {
    dot = WORSE[dot]?.[log.occ.get(id)?.status ?? ""] ?? "?";
  }
  expect(l.indicators.attention.count, "unread cues").toBe(unread.length);
  expect(l.indicators.switchDot, "switch dot").toBe(dot);
  for (const id of l.strip.filter(onScreen)) {
    log.viewed.set(id, log.occ.get(id)?.seq ?? 0);
  }
  if (acksSeen) {
    for (const a of fx.acks) {
      expect(log.viewed.get(a.id) ?? 0, `ack ${a.id}:${String(a.seq)}`).toBeGreaterThanOrEqual(
        a.seq,
      );
    }
  }
}

/** A failed start keeps its pane: a side's base, given by the last user,
 *  kernel, settle or removal step that changed it, shows the base once it has
 *  failed. A removal collapsing the split carries the survivor's side's base. */
function checkEnded(w: World): void {
  const { log } = w;
  const l = w.page.lay;
  const was = log.screen;
  const gone = was.strip.some((id) => !l.strip.includes(id));
  if (log.step === "resyncRun") {
    log.base = { ...l.panes };
  } else if (gone && was.open && !l.split.open) {
    const left = l.panes.left;
    log.base = {
      left: left === was.left ? log.base.left : left === was.right ? log.base.right : left,
      right: null,
    };
  } else if (gone || PLACING.has(log.step)) {
    for (const side of ["left", "right"] as const) {
      if (l.panes[side] !== was[side]) {
        log.base[side] = l.panes[side];
      }
    }
  }
  for (const side of l.split.open ? (["left", "right"] as const) : (["left"] as const)) {
    const id = log.base[side];
    if (id !== null && l.strip.includes(id) && log.failed.has(id)) {
      expect(l.panes[side], `${side} keeps the failed start ${id}`).toBe(id);
    }
  }
}

/** What every commit holds: the strip in order, each session in one pane, a
 *  closed split's right pane empty with the left selected, and a second fold
 *  that changes nothing and owes no edge effect. */
function checkCommit(page: Page): void {
  const l = page.lay;
  expect(l.strip).toEqual(byAge(page.m.sessions.keys()));
  const shown = [l.panes.left, l.panes.right].filter((id) => id !== null);
  expect(new Set(shown).size).toBe(shown.length);
  for (const id of shown) {
    expect(page.m.sessions.has(id)).toBe(true);
  }
  if (!l.split.open) {
    expect(l.panes.right).toBeNull();
    expect(l.split.selected).toBe("left");
  }
  const again = stepFor(page.m, l);
  expect([
    again.layout.panes,
    again.layout.split,
    again.layout.covered,
    again.layout.recent,
  ]).toEqual([l.panes, l.split, l.covered, l.recent]);
  const fx = again.effects;
  expect([fx.acks, fx.moved, fx.persist, fx.focus, fx.toasts, fx.settle, fx.resync]).toEqual([
    [],
    "none",
    false,
    null,
    [],
    false,
    null,
  ]);
}

/** Each edge effect fires in the commit that first folds its input, and only
 *  there: a stale address toasts once, a keyboard close owes its focus once,
 *  and a failed ack is sent again only after an intent or a sync point. */
function checkEdges(w: World, fx: Effects): void {
  expect(fx.toasts.filter((t) => t === "stale")).toHaveLength(w.since.stale);
  expect(fx.focus?.keyboardHeld ?? false).toBe(w.since.held);
  if (!w.since.retry) {
    const resent = fx.acks.filter((a) => w.failedAcks.has(`${a.id}:${String(a.seq)}`));
    expect(resent).toEqual([]);
  }
}

function snapOf(page: Page): unknown {
  const l = page.lay;
  return {
    panes: l.panes,
    split: l.split,
    strip: l.strip,
    recent: l.recent,
    dot: l.indicators.switchDot,
    attention: l.indicators.attention,
  };
}

function drain(w: World, after: () => void): void {
  w.log.step = "openAns";
  while (w.opens.length > 0) {
    exec(w, { k: "openAns", fail: false });
  }
  w.log.step = "pollAns";
  while (w.polls.length > 0) {
    exec(w, { k: "pollAns" });
  }
  if (w.own !== null) {
    w.log.step = "ownAns";
    exec(w, { k: "ownAns" });
    after();
  }
  w.log.step = "deliver";
  deliver(w, Number.MAX_SAFE_INTEGER);
  after();
  w.log.step = "list";
  const rows = w.server.list();
  learn(w, rows, w.log.epoch);
  w.page.list(rows);
  after();
  w.log.step = "resyncRun";
  for (let i = 0; i < 4 && w.page.resyncs.length > 0; i++) {
    resyncRun(w);
    after();
  }
}

/** Runs `steps`, committing after every step (`every`) or only where a step
 *  asks or must; returns what the screen showed at each user step and at the end. */
function run(
  steps: readonly Step[],
  every: boolean,
  opts: {
    readonly keep?: string;
    readonly observe?: (w: World) => unknown;
    /** Reducers only: no layout is folded, so the run checks the model alone. */
    readonly reducersOnly?: boolean;
    /** Skip checkCommit, which the first property runs on every commit. */
    readonly unchecked?: boolean;
  } = {},
): { readonly seen: unknown[]; readonly w: World } {
  const w = world(opts.keep ?? null);
  const observe = opts.observe ?? ((x: World) => snapOf(x.page));
  const commit = (): void => {
    if (opts.reducersOnly !== true) {
      const fx = w.page.commit();
      if (opts.unchecked !== true) {
        checkCommit(w.page);
        checkEdges(w, fx);
        checkCues(w, fx, every);
        if (every) {
          checkEnded(w);
        }
        const l = w.page.lay;
        w.log.screen = { ...l.panes, open: l.split.open, strip: l.strip };
      }
      w.since = { stale: 0, held: false, retry: false };
    }
  };
  if (every) {
    w.page.afterApply = (): void => {
      w.since.retry ||= RETRIES.has(w.log.step);
      commit();
    };
  }
  const seen: unknown[] = [observe(w)];
  for (const { cmd, commit: asked } of steps) {
    if (COMMIT_BEFORE.has(cmd.k)) {
      commit();
    }
    w.log.step = cmd.k;
    const mustShow = exec(w, cmd);
    const user = USER.has(cmd.k);
    if (user || asked || every) {
      commit();
    }
    if (mustShow !== null && w.page.m.sessions.has(mustShow)) {
      expect([w.page.lay.panes.left, w.page.lay.panes.right]).toContain(mustShow);
    }
    if (user) {
      seen.push(observe(w));
    }
  }
  drain(w, commit);
  seen.push(observe(w));
  return { seen, w };
}

describe("placement over generated input orders", () => {
  it(
    "gives the same screens whichever frames the commits ran in, and shows a user's tab at once",
    SLOW,
    () => {
      fc.assert(
        fc.property(stepsArb(24), (steps) => {
          const ref = run(steps, true);
          const sparse = run(steps, false);
          expect(sparse.seen).toEqual(ref.seen);
          expect(ref.seen[0]).toMatchObject({ panes: { left: "X", right: "Y" } });
        }),
      );
    },
  );

  it("raises each edge effect once while start failures re-fold a covering arrival", SLOW, () => {
    const covering: Step[] = [
      { cmd: { k: "create", cue: "" }, commit: false },
      { cmd: { k: "deliver", n: 1 }, commit: true },
    ];
    fc.assert(
      fc.property(stepsArb(24, REFOLD_KINDS), (steps) => {
        const { w } = run([...covering, ...steps], false);
        expect(w.page.log.length).toBeGreaterThan(covering.length);
      }),
    );
  });

  it("acknowledges only cues the screen showed while bursts of arrivals land", SLOW, () => {
    fc.assert(
      fc.property(
        fc.array(cueArb, { minLength: 3, maxLength: 3 }),
        stepsArb(16, BURST_KINDS),
        (cues, steps) => {
          const creates = cues.map((cue) => ({
            cmd: { k: "create" as const, cue },
            commit: false,
          }));
          run([...creates, ...steps], true);
        },
      ),
    );
  });

  it(
    "converges every session's facts on the server's state once every delivery lands",
    SLOW,
    () => {
      fc.assert(
        fc.property(stepsArb(24, SERVER_KINDS), (steps) => {
          const { w } = run(steps, false, { keep: "X", reducersOnly: true });
          const m = w.page.m;
          expect(byAge(m.sessions.keys())).toEqual(byAge(w.server.rows.keys()));
          for (const r of w.server.list()) {
            const f = m.sessions.get(r.id);
            expect({
              status: f?.status,
              statusSeq: f?.statusSeq,
              seenSeq: f?.seenSeq,
              startFailure: f?.failAt == null ? "" : f.startFailure,
            }).toEqual({
              status: r.status,
              statusSeq: r.statusSeq ?? 0,
              seenSeq: r.seenSeq ?? 0,
              startFailure: r.status === "ended" ? r.endReason : "",
            });
          }
          expect([m.holds, m.restartPending]).toEqual([
            { sync: 0, create: false, resync: 0 },
            null,
          ]);
        }),
      );
    },
  );

  it("paints the same selection chrome whichever frames the commits ran in", SLOW, () => {
    fc.assert(
      fc.property(stepsArb(16), (steps) => {
        const observe = (w: World): unknown => chromeOf(w.page.m, w.page.lay);
        const ref = run(steps, true, { observe, unchecked: true });
        const sparse = run(steps, false, { observe, unchecked: true });
        expect(sparse.seen).toEqual(ref.seen);
        expect(ref.seen[0]).toMatchObject({ active: "X" });
      }),
      ORDERS,
    );
  });
});

describe("cues over generated delivery orders", () => {
  const HIDDEN = ["W", "V", "U"] as const;
  const ALL = ["X", "Y", ...HIDDEN] as const;
  const histArb = fc.array(
    fc.oneof(
      fc.constantFrom("working", "input", "done", "failed", "crashed", "idle"),
      fc.constant("read"),
    ),
    { maxLength: 5 },
  );
  const histories = fc.record({ X: histArb, Y: histArb, W: histArb, V: histArb, U: histArb });
  const schedule = fc.array(fc.constantFrom(...ALL), { maxLength: 30 });

  function records(
    h: Readonly<Record<(typeof ALL)[number], readonly string[]>>,
  ): Map<string, StatusRecord[]> {
    const out = new Map<string, StatusRecord[]>();
    for (const id of ALL) {
      let r = rec(id);
      const list: StatusRecord[] = [];
      for (const step of h[id]) {
        if (step === "read") {
          r = { ...r, seenSeq: r.statusSeq ?? 0 };
        } else if (!isEndedStatus(r.status)) {
          r = { ...r, status: step, statusSeq: (r.statusSeq ?? 0) + 1 };
        }
        list.push(r);
      }
      out.set(id, list);
    }
    return out;
  }

  function deliverInOrder(
    per: Map<string, StatusRecord[]>,
    order: readonly string[],
    commits: readonly boolean[],
  ): Page {
    const p = bootPage([...ALL], splitRecord("X", "Y"));
    const queues = new Map([...per].map(([id, list]) => [id, [...list]]));
    const seq = [
      ...order,
      ...ALL.flatMap((id) => Array<string>(queues.get(id)?.length ?? 0).fill(id)),
    ];
    seq.forEach((id, i) => {
      const r = queues.get(id)?.shift();
      if (r !== undefined) {
        p.stream(r);
        if (commits[i % commits.length] === true) {
          p.commit();
        }
      }
    });
    p.commit();
    return p;
  }

  it(
    "shows the most urgent unread cue out of view and loses none, in any delivery order",
    SLOW,
    () => {
      fc.assert(
        fc.property(
          histories,
          schedule,
          schedule,
          fc.array(fc.boolean(), { minLength: 1 }),
          (h, a, b, commits) => {
            const per = records(h);
            const one = deliverInOrder(per, a, commits);
            const two = deliverInOrder(per, b, [true]);
            let dot = "";
            let count = 0;
            for (const id of HIDDEN) {
              const last = per.get(id)?.at(-1);
              const status = last?.status ?? "";
              if (
                ["crashed", "failed", "input", "done"].includes(status) &&
                (last?.statusSeq ?? 0) > (last?.seenSeq ?? 0)
              ) {
                dot = WORSE[dot]?.[status] ?? "?";
                count += 1;
              }
            }
            for (const p of [one, two]) {
              expect(p.lay.indicators.switchDot).toBe(dot);
              expect(p.lay.indicators.attention.count).toBe(count);
              expect(p.acks.every((x) => x.id === "X" || x.id === "Y")).toBe(true);
            }
          },
        ),
      );
    },
  );
});

describe("placement whatever order start failures, restarts, collapses and 409s arrive in", () => {
  const panesKey = (p: Page): unknown => ({ panes: p.lay.panes, split: p.lay.split });

  it(
    "restores a failed start's pane and the selection wherever the failure falls among later arrivals",
    SLOW,
    () => {
      const spec = fc.record({
        xFailed: fc.boolean(),
        k: fc.integer({ min: 1, max: 4 }),
        pos: fc.nat({ max: 4 }),
        source: fc.constantFrom("stream" as const, "4001" as const, "list" as const),
        commits: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      });
      type Spec = typeof spec extends fc.Arbitrary<infer T> ? T : never;
      const runIt = (s: Spec, pos: number, commits: readonly boolean[]): Page => {
        const p = bootPage(["X", "Y"], splitRecord("X", "Y"));
        if (s.xFailed) {
          p.stream(endedRec("X")).commit();
        }
        const arrivals = Array.from({ length: s.k }, (_, i) => `Z${String(i + 1)}`);
        const at = Math.min(pos, s.k);
        let failed = false;
        const steps: (() => void)[] = arrivals.map((id) => () => p.stream(rec(id)));
        steps.splice(at, 0, () => {
          failed = true;
          if (s.source === "stream") {
            p.stream(endedRec("Y"));
          } else if (s.source === "4001") {
            p.apply((m) => paneStartFailed(m, "Y", "spawn failed"));
          } else {
            p.list([
              s.xFailed ? endedRec("X") : rec("X"),
              endedRec("Y"),
              ...arrivals.slice(0, at).map((id) => rec(id)),
            ]);
          }
        });
        steps.forEach((step, i) => {
          step();
          if (commits[i] === true) {
            p.commit();
            if (failed) {
              expect([p.lay.panes.left, p.lay.panes.right], "Y once failed").toContain("Y");
            }
          }
        });
        p.stream(endedRec("Y")).commit();
        return p;
      };
      fc.assert(
        fc.property(spec, (s) => {
          const all = Array<boolean>(8).fill(true);
          const generated = runIt(s, s.pos, s.commits);
          const late = runIt(s, s.k, all);
          const first = runIt(s, 0, all);
          expect(panesKey(generated)).toEqual(panesKey(late));
          expect(panesKey(late)).toEqual(panesKey(first));
          expect([generated.lay.panes.left, generated.lay.panes.right]).toContain("Y");
        }),
        ORDERS,
      );
    },
  );

  it(
    "places a restarted server's set only by its settle, with one resync, however the restart was seen",
    SLOW,
    () => {
      const spec = fc.record({
        path: fc.constantFrom("poll" as const, "reopen" as const, "conflict" as const),
        k: fc.integer({ min: 2, max: 4 }),
        seed: fc.nat(),
        listAt: fc.nat({ max: 4 }),
        before: fc.nat({ max: 2 }),
        during: fc.nat({ max: 2 }),
        commits: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
      });
      type Spec = typeof spec extends fc.Arbitrary<infer T> ? T : never;
      const runIt = (s: Spec, commits: readonly boolean[]): Page => {
        const p = bootPage(["X", "Y"], splitRecord("X", "Y"));
        let i = 0;
        const maybe = (): void => {
          if (commits[i++ % commits.length] === true) {
            p.commit();
            expect(
              [p.lay.panes.left, p.lay.panes.right].every(
                (id) => id === null || id === "X" || id === "Y",
              ),
            ).toBe(true);
          }
        };
        const fresh = Array.from({ length: s.k }, (_, j) => rec(`R${String(j + 1)}`));
        if (s.path === "reopen") {
          const token = p.open();
          const order = shuffled(fresh, s.seed);
          order.forEach((r, j) => {
            if (j === Math.min(s.listAt, s.k)) {
              p.opened(token, fresh);
            }
            p.stream(r);
            maybe();
          });
          if (s.listAt >= s.k) {
            p.opened(token, fresh);
          }
        } else {
          p.list(fresh);
          if (s.path === "conflict") {
            p.apply(layoutStale);
          }
        }
        maybe();
        const extra = (n: number, from: number): StatusRecord[] =>
          Array.from({ length: n }, (_, j) => rec(`R${String(from + j)}`));
        for (const r of extra(s.before, 10)) {
          p.stream(r);
          maybe();
        }
        p.commit();
        const ids = p.resyncs.shift() ?? [];
        p.apply((m) => resyncBegan(m, ids, false, 0));
        for (const r of extra(s.during, 20)) {
          p.stream(r);
          maybe();
        }
        const settled = [...fresh, ...extra(s.before, 10), ...extra(s.during, 20)];
        p.apply((m) =>
          resyncSettled(m, {
            sessions: settled,
            record: splitRecord("R1", "R2"),
            route: null,
            toastStale: false,
            now: 0,
          }),
        );
        p.commit();
        return p;
      };
      fc.assert(
        fc.property(spec, (s) => {
          const generated = runIt(s, s.commits);
          const every = runIt(s, [true]);
          expect(generated.requested).toBe(1);
          expect(panesKey(generated)).toEqual({
            panes: { left: "R1", right: "R2" },
            split: { open: true, selected: "left" },
          });
          expect(panesKey(generated)).toEqual(panesKey(every));
        }),
        ORDERS,
      );
    },
  );

  it(
    "keeps a failed start on screen after the split collapsed onto the arrival that covered it",
    SLOW,
    () => {
      const perms = [
        ["arrive", "remove", "fail"],
        ["arrive", "fail", "remove"],
        ["remove", "arrive", "fail"],
        ["remove", "fail", "arrive"],
        ["fail", "arrive", "remove"],
        ["fail", "remove", "arrive"],
      ] as const;
      const spec = fc.record({
        order: fc.constantFrom(...perms),
        second: fc.nat({ max: 3 }),
        source: fc.constantFrom("stream" as const, "4001" as const),
        commits: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      });
      type Spec = typeof spec extends fc.Arbitrary<infer T> ? T : never;
      const runIt = (s: Spec, commits: readonly boolean[]): Page => {
        const p = bootPage(["X", "Y"], splitRecord("X", "Y"));
        const steps: string[] = [...s.order];
        if (s.second < 3) {
          steps.splice(s.second + 1, 0, "second");
        }
        let failed = false;
        steps.forEach((step, i) => {
          if (step === "arrive") {
            p.stream(rec("Z"));
          } else if (step === "second") {
            p.stream(rec("Z2"));
          } else if (step === "remove") {
            p.gone("X");
          } else if (s.source === "stream") {
            p.stream(endedRec("Y"));
            failed = true;
          } else {
            p.apply((m) => paneStartFailed(m, "Y", "spawn failed"));
            failed = true;
          }
          if (commits[i % commits.length] === true) {
            p.commit();
            if (failed) {
              expect([p.lay.panes.left, p.lay.panes.right]).toContain("Y");
            }
          }
        });
        p.commit();
        return p;
      };
      fc.assert(
        fc.property(spec, (s) => {
          const generated = runIt(s, s.commits);
          const every = runIt(s, [true]);
          expect([generated.lay.panes.left, generated.lay.panes.right]).toContain("Y");
          expect(panesKey(generated)).toEqual(panesKey(every));
        }),
        ORDERS,
      );
    },
  );

  it("writes the reconciled record once after a 409, after a restart the settled set", SLOW, () => {
    const spec = fc.record({
      restart: fc.boolean(),
      ratio: fc.constantFrom(0.3, 0.5, 0.7),
      extra: fc.nat({ max: 3 }),
      held: fc.nat({ max: 2 }),
      commits: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
    });
    type Spec = typeof spec extends fc.Arbitrary<infer T> ? T : never;
    const runIt = (s: Spec, commits: readonly boolean[]): { p: Page; after: number } => {
      const p = bootPage(["X", "Y", "W"], splitRecord("X", "Y"));
      p.apply((m) => splitRatio(m, s.ratio, false));
      p.apply((m) => show(m, "W")).commit();
      const after = p.writes.length;
      let i = 0;
      const maybe = (): void => {
        if (commits[i++ % commits.length] === true) {
          p.commit();
        }
      };
      p.list(s.restart ? [rec("R1"), rec("R2")] : [rec("X"), rec("W")]);
      p.apply(layoutStale);
      maybe();
      for (let j = 0; j < s.extra; j++) {
        p.stream(
          s.restart ? rec(`R${String(3 + j)}`) : rec("W", { status: "working", statusSeq: j + 1 }),
        );
        maybe();
      }
      if (s.restart) {
        p.commit();
        const ids = p.resyncs.shift() ?? [];
        p.apply((m) => resyncBegan(m, ids, false, 0));
        for (let j = 0; j < s.held; j++) {
          p.stream(rec(`R${String(10 + j)}`));
          maybe();
        }
        const rows = p.lay.strip.filter((id) => id.startsWith("R")).map((id) => rec(id));
        p.apply((m) =>
          resyncSettled(m, {
            sessions: [rec("R1"), rec("R2"), ...rows],
            record: splitRecord("R1", "R2", "left", s.ratio),
            route: null,
            toastStale: false,
            now: 0,
          }),
        );
      }
      p.commit();
      p.commit();
      return { p, after };
    };
    fc.assert(
      fc.property(spec, (s) => {
        const generated = runIt(s, s.commits);
        const every = runIt(s, [true]);
        const written = generated.p.writes.slice(generated.after).map((w) => w.record);
        expect(written).toEqual([layoutRecord(generated.p.lay, s.ratio)]);
        expect(generated.p.lay.panes).toEqual(
          s.restart ? { left: "R1", right: "R2" } : { left: "W", right: null },
        );
        expect(written).toEqual(every.p.writes.slice(every.after).map((w) => w.record));
      }),
      ORDERS,
    );
  });
});
