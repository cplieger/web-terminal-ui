import { vi, type Mock } from "vitest";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import { tabs } from "../index.js";
import type { TabsApi, TabsOptions } from "../index.js";
import type { PaneLayout } from "../model.js";
import { mountTerminal } from "../../../test-helpers/mount.js";
import type { EngineFake, FakeEngineRecord } from "../../../test-helpers/fake-engine.js";
import type {
  CreateTerminalOptions,
  PaneSide,
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
} from "../../../kernel/types.js";
import type { ActivityMonitorApi } from "../../activity-monitor.js";

/** The engine driving the pane on `side` right now: the one whose `.term` sits
 *  in that pane's root. Sides are assigned at every open, so this is read when
 *  needed rather than fixed to an engine index. */
export function engineOn(fake: EngineFake, root: HTMLElement, side: PaneSide): FakeEngineRecord {
  const pane = root.querySelector(`:scope > .wt-split-pane.wt-side-${side}`);
  const rec = fake.engines.find((e) => pane?.contains(e.options.termWrap) === true);
  if (!rec) {
    throw new Error(`no engine drives the ${side} pane`);
  }
  return rec;
}

/** A `fetch` answer with the shape the session API reads. */
export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A fake answer held back until the test releases it. */
export interface Gate {
  readonly promise: Promise<void>;
  resolve(): void;
}
export function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The REST API as the tabs feature sees it, every answer settable per test. */
export interface FakeSessionServer {
  /** `GET /api/sessions`. */
  list: unknown[];
  /** `GET /api/sessions/layout`; null answers 404. */
  layout: PaneLayout | null;
  /** The status of the next `GET /api/sessions/layout` when not 200. */
  layoutReadStatus: number;
  /** The status every `PUT /api/sessions/layout` answers. */
  putStatus: number;
  /** The status of the next `PUT` alone, consumed by it. */
  putOnce: number | null;
  /** The status `POST /api/sessions` answers; 201 creates `s-new`. */
  postStatus: number;
  /** When set, `POST` answers only once this settles. */
  postGate: Gate | null;
  /** When set, `DELETE` answers only once this settles. */
  deleteGate: Gate | null;
  /** When set, `PUT /api/sessions/layout` answers only once this settles; each
   *  PUT takes the gate that was set when it arrived. */
  putGate: Gate | null;
  /** The status `PUT /api/sessions/order` answers, and its gate. */
  orderStatus: number;
  orderGate: Gate | null;
  /** Every `PUT` body, in order. */
  writes: PaneLayout[];
  readonly fetch: Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>;
  posts(): number;
  deletes(): string[];
  lists(): number;
  layoutReads(): number;
}

export function fakeServer(): FakeSessionServer {
  const server: FakeSessionServer = {
    list: [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
    ],
    layout: { left: null, right: null, handle: 0.5, selected: "left", open: false },
    layoutReadStatus: 200,
    putStatus: 204,
    putOnce: null,
    postStatus: 201,
    postGate: null,
    deleteGate: null,
    putGate: null,
    orderStatus: 204,
    orderGate: null,
    writes: [],
    fetch: vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      if (String(url).endsWith("/layout")) {
        if (method === "PUT") {
          const body = init?.body;
          server.writes.push(JSON.parse(typeof body === "string" ? body : "") as PaneLayout);
          const status = server.putOnce ?? server.putStatus;
          server.putOnce = null;
          await server.putGate?.promise;
          return jsonResponse(status === 204 ? null : { error: "no" }, status);
        }
        if (server.layoutReadStatus !== 200) {
          return jsonResponse({ error: "no" }, server.layoutReadStatus);
        }
        return server.layout === null
          ? jsonResponse({ error: "not found" }, 404)
          : jsonResponse(server.layout, 200);
      }
      if (String(url).endsWith("/order")) {
        const gate = server.orderGate;
        await gate?.promise;
        return jsonResponse(
          server.orderStatus === 204 ? null : { error: "no" },
          server.orderStatus,
        );
      }
      if (method === "POST") {
        await server.postGate?.promise;
        return jsonResponse(
          server.postStatus === 201
            ? { id: "s-new", title: "", createdAt: "9", status: "idle" }
            : { error: "no" },
          server.postStatus,
        );
      }
      if (method === "DELETE") {
        await server.deleteGate?.promise;
        return jsonResponse(null, 204);
      }
      return jsonResponse(server.list, 200);
    }),
    posts: () => server.fetch.mock.calls.filter((c) => c[1]?.method === "POST").length,
    deletes: () =>
      server.fetch.mock.calls
        .filter((c) => c[1]?.method === "DELETE")
        .map((c) => String(c[0]).split("/").pop() ?? ""),
    lists: () =>
      server.fetch.mock.calls.filter(
        (c) => (c[1]?.method ?? "GET") === "GET" && String(c[0]).endsWith("/api/sessions"),
      ).length,
    layoutReads: () =>
      server.fetch.mock.calls.filter(
        (c) => (c[1]?.method ?? "GET") === "GET" && String(c[0]).endsWith("/layout"),
      ).length,
  };
  return server;
}

export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Two frames: a ResizeObserver delivers after layout, between them. */
export const settle = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(r, 0));
    });
  });
/** The announcer re-sets its live region on a 100 ms timer. */
export const announced = (): Promise<void> => new Promise((r) => setTimeout(r, 130));
export async function until(pred: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await tick();
  }
}

/** A root with real geometry; unstyled it would measure 0 by 0. */
export function rootIn(width = 1000, height = 600): HTMLElement {
  const root = document.createElement("div");
  root.style.width = `${String(width)}px`;
  root.style.height = `${String(height)}px`;
  document.body.appendChild(root);
  return root;
}

export interface FakeMonitor {
  readonly feature: TerminalFeature<ActivityMonitorApi>;
  emit(s: SessionStatus): void;
  /** The stream (re)opened, which is what makes tabs re-list. */
  open(): void;
}
/** A shell-scoped stand-in for the activity monitor, driven by `emit` and `open`. */
export function fakeMonitor(): FakeMonitor {
  const subs = new Set<(s: SessionStatus) => void>();
  const openSubs = new Set<() => void>();
  const feature: TerminalFeature<ActivityMonitorApi> = {
    name: "activityMonitor",
    scope: "shell",
    setup() {
      return {
        api: {
          onStatus(cb) {
            subs.add(cb);
            return () => subs.delete(cb);
          },
          current: () => undefined,
          onStreamOpen(cb) {
            openSubs.add(cb);
            return () => openSubs.delete(cb);
          },
        },
        teardown: () => undefined,
      };
    },
  };
  return {
    feature,
    emit: (s) => {
      for (const cb of [...subs]) {
        cb(s);
      }
    },
    open: () => {
      for (const cb of [...openSubs]) {
        cb();
      }
    },
  };
}

export interface LateRejecting {
  /** A fresh feature object per thunk invocation, as the fresh-objects rule asks. */
  readonly feature: () => TerminalFeature;
  /** Fail the second pane's setup now; throws when it never started. */
  reject(): void;
}
/** A pane feature whose SECOND setup (the second pane's) stays pending until
 *  `reject()` is called, so that pane can be shown and selected first. */
export function lateRejecting(): LateRejecting {
  let setups = 0;
  let rejectSecond: ((err: Error) => void) | undefined;
  return {
    feature: () => ({
      name: "late",
      setup() {
        setups += 1;
        if (setups === 2) {
          return new Promise((_, reject) => {
            rejectSecond = reject;
          });
        }
        return { api: undefined, teardown: () => undefined };
      },
    }),
    reject() {
      if (!rejectSecond) {
        throw new Error("the second setup never started");
      }
      rejectSecond(new Error("second pane, later"));
    },
  };
}

export interface Mounted {
  readonly root: HTMLElement;
  readonly term: TerminalHandle;
  readonly ctx: TerminalContext;
  readonly api: TabsApi;
}

export interface MountSpec {
  readonly opts?: Partial<CreateTerminalOptions>;
  readonly tabsOpts?: TabsOptions;
  /** Shell-scoped peers tabs reads through `ctx.use`, set up before it. */
  readonly before?: readonly TerminalFeature<unknown>[];
  /** Pane features, built fresh per invocation. */
  readonly panes?: () => readonly TerminalFeature<unknown>[];
  /** Do not wait for a pane to show a tab (a boot expected to show nothing). */
  readonly showsNothing?: boolean;
}

/** A split terminal with the tabs feature, a shell-scoped probe that captures its
 *  context, and the boot settled. */
export async function mountTabbed(
  root: HTMLElement,
  server: FakeSessionServer,
  spec: MountSpec = {},
): Promise<Mounted> {
  let ctxRef: TerminalContext | undefined;
  const probe: TerminalFeature = {
    name: "shell-probe",
    scope: "shell",
    setup(ctx) {
      ctxRef = ctx;
      return { api: undefined, teardown: () => undefined };
    },
  };
  const feature = tabs(spec.tabsOpts);
  const term = await mountTerminal(root, {
    split: true,
    features: () => [probe, ...(spec.before ?? []), feature, ...(spec.panes?.() ?? [])],
    ...spec.opts,
  });
  await until(() => root.querySelectorAll(".wt-tab").length >= server.list.length);
  if (spec.showsNothing !== true) {
    await until(() => ctxRef?.shell.panes().some((p) => p.state() === "shown") === true);
  }
  if (!ctxRef || !feature.api) {
    throw new Error("tabs never set up");
  }
  return { root, term, ctx: ctxRef, api: feature.api };
}

export const chips = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(".wt-tab-scroll .wt-tab"));
export const chipOf = (root: HTMLElement, label: string): HTMLElement => {
  const chip = chips(root).find((c) => c.querySelector(".wt-tab-label")?.textContent === label);
  if (!chip) {
    throw new Error(`no chip labelled ${label}`);
  }
  return chip;
};
export const activeLabels = (root: HTMLElement): string[] =>
  chips(root)
    .filter((c) => c.classList.contains("wt-tab-active"))
    .map((c) => c.querySelector(".wt-tab-label")?.textContent ?? "");
export const stripSplit = (root: HTMLElement): HTMLButtonElement => {
  const btn = root.querySelector<HTMLButtonElement>(".wt-tab-bar > .wt-tab-split");
  if (!btn) {
    throw new Error("no split button");
  }
  return btn;
};
export const paneRoot = (root: HTMLElement, side: PaneSide): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`:scope > .wt-split-pane.wt-side-${side}`);
  if (!el) {
    throw new Error(`no ${side} pane root`);
  }
  return el;
};
export const politeText = (root: HTMLElement): string =>
  root.querySelector(':scope > [aria-live="polite"]')?.textContent ?? "";
export const shown = (ctx: TerminalContext, side: PaneSide): string | null =>
  ctx.shell.pane(side)?.session.id ?? null;
export const textareaOf = (root: HTMLElement, side: PaneSide): HTMLTextAreaElement => {
  const el = paneRoot(root, side).querySelector<HTMLTextAreaElement>(".term-input");
  if (!el) {
    throw new Error(`no ${side} textarea`);
  }
  return el;
};
export const separatorOf = (root: HTMLElement): HTMLElement => {
  const el = root.querySelector<HTMLElement>(':scope > [role="separator"]');
  if (!el) {
    throw new Error("no separator");
  }
  return el;
};
export function openTabMenu(
  root: HTMLElement,
  label: string,
  init: MouseEventInit = {},
): HTMLElement[] {
  chipOf(root, label).dispatchEvent(
    new MouseEvent("contextmenu", { clientX: 10, clientY: 10, bubbles: true, ...init }),
  );
  const menu = root.querySelector(".wt-tab-menu");
  return menu ? (Array.from(menu.children) as HTMLElement[]) : [];
}
export function menuItem(items: HTMLElement[], label: string): HTMLButtonElement {
  const b = items.find((el) => el.textContent === label);
  if (!(b instanceof HTMLButtonElement)) {
    throw new Error(`no menu item ${label}`);
  }
  return b;
}
