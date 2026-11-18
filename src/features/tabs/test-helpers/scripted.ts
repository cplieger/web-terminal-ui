import { vi, type Mock } from "vitest";
import { tabs, type TabsApi, type TabsOptions } from "../index.js";
import type { PaneLayout } from "../model.js";
import { mountTerminal } from "../../../test-helpers/mount.js";
import type {
  CreateTerminalOptions,
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
} from "../../../kernel/types.js";

export interface ScriptedMount {
  readonly term: TerminalHandle;
  readonly api: TabsApi;
  /** The shell context, available once the features set up. */
  ctx(): TerminalContext;
}

/** A split-capable terminal with the tabs feature, NOT waiting for the boot:
 *  a settle test drives the boot's requests itself. */
export async function mountScripted(
  root: HTMLElement,
  spec: {
    readonly tabsOpts?: TabsOptions;
    readonly before?: readonly TerminalFeature<unknown>[];
    /** Pane features, built fresh for each pane, mounted after `before`. */
    readonly paneFeatures?: () => readonly TerminalFeature<unknown>[];
    readonly opts?: Partial<CreateTerminalOptions>;
  } = {},
): Promise<ScriptedMount> {
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
    features: () => [probe, ...(spec.before ?? []), ...(spec.paneFeatures?.() ?? []), feature],
    ...spec.opts,
  });
  for (let i = 0; i < 40 && (ctxRef === undefined || feature.api === undefined); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const api = feature.api;
  if (ctxRef === undefined || api === undefined) {
    throw new Error("tabs never set up");
  }
  const ctx = ctxRef;
  return { term, api, ctx: () => ctx };
}

/** One answer of the scripted session server. `hold` keeps it back until the
 *  test releases it; `then` runs once it has been answered. */
export interface Answer {
  readonly status: number;
  readonly body?: unknown;
  readonly retryAfter?: string;
  readonly hold?: Promise<void>;
  readonly then?: () => void;
}

/** A real Response, so Retry-After and the error envelope go through the
 *  production parser. */
function respond(a: Answer): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (a.retryAfter !== undefined) {
    headers["Retry-After"] = a.retryAfter;
  }
  return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? null), {
    status: a.status,
    headers,
  });
}

export const ok = (body: unknown): Answer => ({ status: 200, body });
export const created = (body: unknown): Answer => ({ status: 201, body });
/** A temporary refusal, as a restoring host answers. Retry-After 0 keeps the
 *  wait to one task, so no test sleeps. */
export const refuse = (message = "restoring tabs"): Answer => ({
  status: 503,
  body: { error: message },
  retryAfter: "0",
});
export const notFound: Answer = { status: 404, body: { error: "not found" } };

/** A held answer: `answer` goes out once `release` is called. */
export interface Held {
  readonly answer: Answer;
  release(): void;
}
export function held(answer: Answer): Held {
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  return { answer: { ...answer, hold }, release };
}

/** Each route answers from its own queue; the last answer repeats once the
 *  queue runs out. */
export interface ScriptedServer {
  list: Answer[];
  layout: Answer[];
  post: Answer[];
  /** `PUT /api/sessions/layout`. */
  putLayout: Answer[];
  /** `PUT /api/sessions/{id}/seen`. */
  seen: Answer[];
  /** Every request, in arrival order, with its body when it had one. */
  readonly log: { method: string; path: string; body?: unknown }[];
  /** Called as each request arrives, before it is answered. */
  onRequest: ((method: string, path: string) => void) | null;
  readonly fetch: Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>;
  count(method: string, path: string): number;
}

const SESSIONS = "/api/sessions";

export function scriptedServer(): ScriptedServer {
  const next = (queue: Answer[]): Answer => {
    const a = queue.length > 1 ? queue.shift() : queue[0];
    if (a === undefined) {
      throw new Error("scripted server: a route was called with no answer scripted");
    }
    return a;
  };
  const server: ScriptedServer = {
    list: [ok([])],
    layout: [notFound],
    post: [created({ id: "s-new", title: "", createdAt: "9", status: "idle" })],
    putLayout: [{ status: 204 }],
    seen: [{ status: 204 }],
    log: [],
    onRequest: null,
    fetch: vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      const path = new URL(String(url), location.href).pathname;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      server.log.push(body === undefined ? { method, path } : { method, path, body });
      server.onRequest?.(method, path);
      let a: Answer;
      if (path === SESSIONS && method === "GET") {
        a = next(server.list);
      } else if (path === SESSIONS && method === "POST") {
        a = next(server.post);
      } else if (path === `${SESSIONS}/layout` && method === "GET") {
        a = next(server.layout);
      } else if (path === `${SESSIONS}/layout` && method === "PUT") {
        a = next(server.putLayout);
      } else if (method === "PUT" && path.endsWith("/seen")) {
        a = next(server.seen);
      } else {
        // PUT order, DELETE: accepted.
        a = { status: 204 };
      }
      await a.hold;
      const r = respond(a);
      if (a.then) {
        setTimeout(a.then, 0);
      }
      return r;
    }),
    count: (method, path) =>
      server.log.filter((c) => c.method === method && c.path === path).length,
  };
  return server;
}

/** A session row as the server lists it. */
export const row = (id: string, alias: string, createdAt: string, status = "idle") => ({
  id,
  title: id,
  alias,
  createdAt,
  status,
});

export const splitRecord = (
  left: string | null,
  right: string | null,
  selected: "left" | "right" = "left",
  handle = 0.5,
): PaneLayout => ({ left, right, selected, handle, open: true });
