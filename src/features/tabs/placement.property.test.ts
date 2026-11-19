// The mounted feature against the pure model: every generated command goes to
// a real terminal (fake engines, a scripted server, a fake status stream) and
// to a reference page over the reducers, and after each one the screen, the
// chrome and the requests must be what the reference's committed layout says.

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import type { PaneSide } from "../../kernel/types.js";
import { titleMarkFor } from "../../kernel/attention.js";
import { isEndedStatus, type PaneLayout, type StatusRecord } from "./model.js";
import {
  ackSettled,
  createBegan,
  layoutFor,
  ownCreated,
  pageVisibility,
  paneStartFailed,
  select,
  shellChanged,
  show,
  splitIntent,
  splitPartner,
  switcherToggled,
  windowFocused,
} from "./placement.js";
import {
  type Page,
  bootPage,
  rec,
  splitRecord,
  singleRecord,
} from "./test-helpers/placement-world.js";
import {
  created,
  held,
  mountScripted,
  notFound,
  ok,
  scriptedServer,
  type ScriptedMount,
  type ScriptedServer,
} from "./test-helpers/scripted.js";
import {
  chips,
  engineOn,
  fakeMonitor,
  rootIn,
  shown,
  stripSplit,
  type FakeMonitor,
} from "./test-helpers/split.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const RUNS = { numRuns: 60 } as const;
const SLOW = { timeout: 120_000 } as const;
const REASON = "the process failed to start";
const basePath = location.pathname + location.search;
const SIDES = ["left", "right"] as const;

// Frames run when the test pumps them, so a command costs no real frame time
// and a run fits the global time limit; a callback queued during a pump waits
// for the next one, as a frame requested inside a frame does.
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function stubFrames(): void {
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    frames.delete(id);
  });
}
function frame(): void {
  const due = [...frames.values()];
  frames.clear();
  const now = performance.now();
  for (const cb of due) {
    cb(now);
  }
}
/** One task, then one zero timer, neither clamped: a message task resets the
 *  timer nesting level that clamps a chain of zero timers to 4 ms. */
const task = (): Promise<void> =>
  new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      setTimeout(resolve, 0);
    };
    ch.port2.postMessage(null);
  });
async function until(pred: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await task();
    frame();
  }
}
/** Every commit, ack answer and list the last command started has landed. */
async function rest(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await task();
    frame();
  }
  await task();
}

/** One mounted page, its reference, and the server both talk to. */
class World {
  readonly rows = new Map<string, StatusRecord>();
  readonly ref: Page;
  readonly server: ScriptedServer;
  readonly monitor: FakeMonitor;
  readonly root: HTMLElement;
  m!: ScriptedMount;
  /** Each seen PUT with what the screen showed when it was sent. */
  readonly puts: { id: string; panes: (string | null)[]; visible: boolean; tray: boolean }[] = [];
  visible = true;
  private made = 0;
  private owned = 0;

  constructor(ids: readonly string[], record: PaneLayout | null) {
    for (const id of ids) {
      this.rows.set(id, rec(id));
    }
    this.server = scriptedServer();
    this.server.list = [ok(this.list())];
    this.server.layout = record === null ? [notFound] : [ok(record)];
    this.server.onRequest = (method, path) => {
      const m = /^\/api\/sessions\/([^/]+)\/seen$/.exec(path);
      if (method === "PUT" && m?.[1] !== undefined) {
        this.puts.push({
          id: decodeURIComponent(m[1]),
          panes: this.panes(),
          visible: this.visible,
          tray: this.trayOpen(),
        });
      }
    };
    this.monitor = fakeMonitor();
    this.root = rootIn(1000);
    this.ref = bootPage([...this.rows.values()], record);
  }

  async mount(): Promise<void> {
    vi.stubGlobal("fetch", this.server.fetch);
    stubFrames();
    this.m = await mountScripted(this.root, {
      before: [this.monitor.feature],
      tabsOpts: { activityMonitor: this.monitor.feature },
    });
    await until(() => this.panes().some((id) => id !== null), 120);
    await this.reopen(0);
  }

  list(): StatusRecord[] {
    return [...this.rows.values()];
  }
  ids(): string[] {
    return [...this.rows.keys()];
  }
  pick(who: number): string | undefined {
    const ids = this.ids();
    return ids.length === 0 ? undefined : ids[who % ids.length];
  }
  panes(): (string | null)[] {
    const ctx = this.m.ctx();
    return [shown(ctx, "left"), shown(ctx, "right")];
  }
  trayOpen(): boolean {
    return this.root.querySelector(".wt-switcher-expanded") !== null;
  }
  sideShowing(id: string): PaneSide | null {
    const p = this.panes();
    return p[0] === id ? "left" : p[1] === id ? "right" : null;
  }

  /** Both pages reach rest: every commit, ack answer and list landed. */
  async quiet(): Promise<void> {
    await rest();
    for (let i = 0; i < 4; i++) {
      const before = this.ref.acks.length;
      this.ref.commit();
      const sent = this.ref.acks.slice(before);
      if (sent.length === 0) {
        break;
      }
      for (const a of sent) {
        this.ref.apply((m) => ackSettled(m, a.id, a.seq));
      }
    }
  }

  emit(r: StatusRecord | { readonly id: string; readonly removed: true }): void {
    this.monitor.emit(r as unknown as SessionStatus);
  }

  stream(r: StatusRecord): void {
    this.rows.set(r.id, r);
    this.emit(r);
    this.ref.stream(r);
  }

  arrive(cue: string): void {
    if (this.made >= 3) {
      return;
    }
    this.made += 1;
    const id = `Z${String(this.made)}`;
    this.stream(cue === "" ? rec(id) : rec(id, { status: cue, statusSeq: 1 }));
  }

  async reopen(seed: number): Promise<void> {
    const rows = this.list();
    this.server.list = [ok(rows)];
    const lists = this.server.count("GET", "/api/sessions");
    const token = this.ref.open();
    this.monitor.open();
    for (const r of shuffled(rows, seed)) {
      this.emit(r);
      this.ref.stream(r);
    }
    await until(() => this.server.count("GET", "/api/sessions") > lists);
    await task();
    this.ref.opened(token, rows);
    await this.quiet();
  }

  async own(streamFirst: boolean): Promise<void> {
    if (this.owned >= 2) {
      return;
    }
    this.owned += 1;
    const r = rec(`N${String(this.owned)}`);
    const answer = held(created(r));
    this.server.post = [answer.answer];
    const posts = this.server.count("POST", "/api/sessions");
    this.root.querySelector<HTMLElement>(".wt-tab-new")?.click();
    await until(() => this.server.count("POST", "/api/sessions") > posts);
    this.ref.apply(createBegan);
    this.rows.set(r.id, r);
    if (streamFirst) {
      this.emit(r);
      this.ref.stream(r);
      await rest();
      this.ref.commit();
    }
    const typing = document.activeElement?.classList.contains("term-input") === true;
    answer.release();
    await until(() => this.panes().includes(r.id));
    this.ref.apply((m) => ownCreated(m, r, null, typing));
    this.ref.commit();
    if (!streamFirst) {
      this.emit(r);
      this.ref.stream(r);
    }
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

const label = (chip: HTMLElement): string => chip.querySelector(".wt-tab-label")?.textContent ?? "";

/** Per engine, the session its pane shows and how many binds it has had. */
function binds(w: World): Map<object, { shows: string | null; calls: string[] }> {
  const out = new Map<object, { shows: string | null; calls: string[] }>();
  for (const e of fake.engines) {
    let shows: string | null = null;
    for (const side of SIDES) {
      try {
        if (engineOn(fake, w.root, side) === e) {
          shows = shown(w.m.ctx(), side);
        }
      } catch {
        // no engine drives that pane
      }
    }
    out.set(e, { shows, calls: e.connection.setSession.mock.calls.map(([id]) => id) });
  }
  return out;
}

/** The screen, the chrome and the requests equal the reference's layout. */
function expectProjection(
  w: World,
  before: ReturnType<typeof binds>,
  putsBefore: number,
  served: string,
): void {
  const lay = w.ref.lay;
  const ctx = w.m.ctx();
  const open = ctx.shell.split.isOpen();
  const screen = {
    panes: w.panes(),
    open,
    selected: ctx.shell.selected(),
    strip: chips(w.root).map(label),
    active: chips(w.root)
      .filter((c) => c.classList.contains("wt-tab-active"))
      .map(label),
    selectedChip: chips(w.root)
      .filter((c) => c.classList.contains("wt-tab-selected"))
      .map(label),
    dot: w.root.querySelector<HTMLElement>(".wt-switcher-switch-dot")?.dataset["status"] ?? "",
    mobile: w.root.querySelector(".wt-switcher-label")?.textContent ?? "",
    title: document.title,
  };
  const pick = lay.panes[lay.split.selected];
  const shownIds = [lay.panes.left, lay.panes.right].filter((id): id is string => id !== null);
  const base = pick === null ? served : served === "" ? pick : `${pick} · ${served}`;
  expect(screen).toEqual({
    panes: [lay.panes.left, lay.panes.right],
    open: lay.split.open,
    selected: lay.split.selected,
    strip: [...lay.strip],
    active: lay.strip.filter((id) => shownIds.includes(id)),
    selectedChip: lay.split.open && pick !== null ? [pick] : [],
    dot: lay.indicators.switchDot,
    mobile: pick ?? "",
    title: titleMarkFor(lay.indicators.attention.count) + base,
  });
  for (const p of ctx.shell.panes()) {
    expect(p.surface().classList.contains("wt-with-tabbar")).toBe(true);
  }
  const after = binds(w);
  for (const [e, now] of after) {
    const was = before.get(e);
    const fresh = now.calls.slice(was?.calls.length ?? 0);
    const changed = now.shows !== null && now.shows !== (was?.shows ?? null);
    expect({ fresh, changed }).toEqual({
      fresh: changed && now.shows !== null ? [now.shows] : [],
      changed,
    });
  }
  for (const put of w.puts.slice(putsBefore)) {
    expect(put.tray || (put.visible && put.panes.includes(put.id))).toBe(true);
  }
}

type Cmd = fc.AsyncCommand<World, World>;

/** A command acts on both pages, then the projection is compared at rest. */
function command(
  name: string,
  applies: (w: World) => boolean,
  act: (w: World) => Promise<void> | void,
): Cmd {
  return {
    check: applies,
    async run(_m, w) {
      const before = binds(w);
      const puts = w.puts.length;
      const served = servedTitle;
      await act(w);
      await w.quiet();
      expectProjection(w, before, puts, served);
    },
    toString: () => name,
  };
}

const who = fc.nat({ max: 9 });
const cue = fc.constantFrom("", "input", "done", "failed", "crashed");
const commands = [
  cue.map((c) =>
    command(
      `arrive(${c})`,
      () => true,
      (w) => {
        w.arrive(c);
      },
    ),
  ),
  fc
    .tuple(who, fc.constantFrom("working", "input", "done", "failed", "crashed", "exited", "idle"))
    .map(([n, s]) =>
      command(
        `status(${String(n)}, ${s})`,
        () => true,
        (w) => {
          const id = w.pick(n);
          const r = id === undefined ? undefined : w.rows.get(id);
          if (r !== undefined && !isEndedStatus(r.status)) {
            w.stream({ ...r, status: s, statusSeq: (r.statusSeq ?? 0) + 1 });
          }
        },
      ),
    ),
  fc.tuple(who, fc.boolean()).map(([n, closeFirst]) =>
    command(
      `fail(${String(n)}, ${closeFirst ? "4001 first" : "status first"})`,
      () => true,
      (w) => {
        const id = w.pick(n);
        const r = id === undefined ? undefined : w.rows.get(id);
        if (id === undefined || r === undefined || (r.statusSeq ?? 0) !== 0) {
          return;
        }
        const side = w.sideShowing(id);
        const close = (): void => {
          if (side !== null) {
            engineOn(fake, w.root, side).callbacks.onProcessExit?.({ code: 4001, reason: REASON });
            w.ref.apply((m) => paneStartFailed(m, id, REASON));
          }
        };
        if (closeFirst) {
          close();
        }
        w.stream({ ...r, status: "ended", endReason: REASON, statusSeq: 1 });
        if (!closeFirst) {
          close();
        }
      },
    ),
  ),
  who.map((n) =>
    command(
      `remove(${String(n)})`,
      (w) => w.rows.size > 1,
      (w) => {
        const id = w.pick(n);
        if (id !== undefined) {
          w.rows.delete(id);
          w.emit({ id, removed: true });
          w.ref.gone(id);
        }
      },
    ),
  ),
  who.map((n) =>
    command(
      `readElsewhere(${String(n)})`,
      () => true,
      (w) => {
        const id = w.pick(n);
        const r = id === undefined ? undefined : w.rows.get(id);
        if (r !== undefined && (r.statusSeq ?? 0) > (r.seenSeq ?? 0)) {
          w.stream({ ...r, seenSeq: r.statusSeq ?? 0 });
        }
      },
    ),
  ),
  fc.nat().map((seed) =>
    command(
      `reopen(${String(seed)})`,
      () => true,
      (w) => w.reopen(seed),
    ),
  ),
  who.map((n) =>
    command(
      `click(${String(n)})`,
      () => true,
      (w) => {
        const id = w.ref.lay.strip[n % Math.max(1, w.ref.lay.strip.length)];
        const chip = chips(w.root).find((c) => label(c) === id);
        if (id !== undefined && chip !== undefined) {
          chip.click();
          w.ref.apply((m) => show(m, id));
          w.ref.commit();
        }
      },
    ),
  ),
  fc.constantFrom(...SIDES).map((side) =>
    command(
      `pointerdown(${side})`,
      (w) => w.ref.lay.split.open,
      (w) => {
        const pane = w.m.ctx().shell.pane(side);
        if (pane === null) {
          return;
        }
        const moves = side !== w.m.ctx().shell.selected();
        pane.root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        if (moves) {
          w.ref.apply((m) => select(m, side));
          w.ref.commit();
        }
      },
    ),
  ),
  fc.constant(
    command(
      "splitButton",
      (w) =>
        w.ref.lay.split.open ||
        splitPartner(w.ref.m, layoutFor(w.ref.m, w.ref.lay), w.ref.lay.panes.left) !== null,
      (w) => {
        const open = !w.ref.lay.split.open;
        stripSplit(w.root).click();
        w.ref.apply((m) => splitIntent(m, open));
        w.ref.commit();
      },
    ),
  ),
  fc.boolean().map((streamFirst) =>
    command(
      `plus(${streamFirst ? "stream first" : "POST first"})`,
      () => true,
      (w) => w.own(streamFirst),
    ),
  ),
  fc.boolean().map((visible) =>
    command(
      `visible(${String(visible)})`,
      (w) => w.visible !== visible,
      (w) => {
        w.visible = visible;
        Object.defineProperty(document, "visibilityState", {
          value: visible ? "visible" : "hidden",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
        w.ref.apply((m) => pageVisibility(m, visible));
        w.ref.commit();
      },
    ),
  ),
  fc.constant(
    command(
      "tray",
      (w) => w.trayOpen() || w.ref.lay.strip.length >= 2,
      (w) => {
        const opening = !w.trayOpen();
        w.root.querySelector<HTMLElement>(".wt-switcher-current")?.click();
        w.ref.apply((m) => switcherToggled(m, opening));
        if (opening) {
          w.ref.commit();
        }
      },
    ),
  ),
  fc.constant(
    command(
      "windowFocus",
      (w) => w.visible,
      (w) => {
        window.dispatchEvent(new Event("focus"));
        w.ref.apply(windowFocused);
      },
    ),
  ),
  fc.constant(
    command(
      "kernelOpen",
      (w) => !w.ref.lay.split.open,
      (w) => {
        const selected = w.m.ctx().shell.selected();
        w.m.ctx().shell.split.open();
        w.ref.apply((m) => shellChanged(m, { kind: "splitOpened", selected }));
        w.ref.commit();
      },
    ),
  ),
  fc.constant(
    command(
      "kernelClose",
      (w) =>
        w.ref.lay.split.open && w.ref.lay.panes.left !== null && w.ref.lay.panes.right !== null,
      (w) => {
        const keptId = w.ref.lay.panes[w.ref.lay.split.selected];
        w.m.ctx().shell.split.close();
        w.ref.apply((m) => shellChanged(m, { kind: "splitClosed", keptId }));
        w.ref.commit();
      },
    ),
  ),
];

let servedTitle = "";

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
  history.replaceState(null, "", basePath);
  servedTitle = document.title;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
  history.replaceState(null, "", basePath);
});

const bootRecord = fc.constantFrom<PaneLayout | null>(
  null,
  splitRecord("X", "Y"),
  splitRecord("Y", "W", "right"),
  singleRecord("Y"),
);

describe("the mounted tabs feature against the placement model", () => {
  it(
    "paints, binds and acknowledges exactly what the model's layout says after every command, and nothing after teardown",
    SLOW,
    async () => {
      await fc.assert(
        fc.asyncProperty(
          bootRecord,
          fc.commands(commands, { maxCommands: 8 }),
          async (record, cmds) => {
            fake.reset();
            document.body.replaceChildren();
            history.replaceState(null, "", basePath);
            Reflect.deleteProperty(document, "visibilityState");
            const w = new World(["X", "Y", "W"], record);
            try {
              await w.mount();
              expectProjection(w, binds(w), w.puts.length, servedTitle);
              await fc.asyncModelRun(() => ({ model: w, real: w }), cmds);
              const requests = w.server.log.length;
              w.m.term.destroy();
              const html = w.root.innerHTML;
              w.emit(rec("Z9", { status: "input", statusSeq: 1 }));
              window.dispatchEvent(new Event("focus"));
              await rest();
              expect(w.server.log.slice(requests).filter((r) => r.method !== "DELETE")).toEqual([]);
              expect(w.root.innerHTML).toBe(html);
            } finally {
              w.m.term.destroy();
              w.root.remove();
              vi.unstubAllGlobals();
              Reflect.deleteProperty(document, "visibilityState");
            }
          },
        ),
        RUNS,
      );
    },
  );
});
