// A test double of the engine's sessions surface, shared by every page a test
// mounts: occurrence numbering, the seen route's max-and-clamp, the list and a
// broadcast of every change to each page's status stream. Each page is its own
// same-origin iframe, because the session API, the badge and the banners all
// bind to the mounted document's window.

import type { SessionStatus } from "@cplieger/web-terminal-engine";
import { tabs } from "../index.js";
import { mountTerminal } from "../../../test-helpers/mount.js";
import type { TerminalFeature, TerminalHandle } from "../../../kernel/types.js";
import type { ActivityMonitorApi } from "../../activity-monitor.js";

interface ServerSession {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  status: string;
  activity: string;
  statusSeq: number;
  seenSeq: number;
  notificationSeq: number;
}

/** How the server answers one seen PUT: a status it applies first when 204, or
 *  `apply-then-500`, where the ack lands and its response is lost. */
type PutAnswer = 204 | 404 | 500 | "apply-then-500";

interface Banner {
  readonly tag: string | undefined;
  closed: boolean;
}

export interface Page {
  readonly win: Window & typeof globalThis;
  readonly doc: Document;
  readonly root: HTMLElement;
  /** Every badge write, oldest first. */
  readonly badgeWrites: number[];
  readonly banners: Banner[];
  /** Every seen PUT this page sent, oldest first. */
  readonly puts: { readonly id: string; readonly seq: number }[];
  /** The answer an unheld seen PUT gets. */
  putAnswer: PutAnswer;
  badge(): number;
  /** Queue stream deliveries until releaseStream. */
  holdStream(): void;
  releaseStream(): void;
  /** Hold each list request; releaseList answers the oldest with the records
   *  as they stood when it was requested. */
  holdLists(): void;
  releaseList(): Promise<void>;
  /** Hold each seen PUT until releasePut answers the oldest. */
  holdPuts(): void;
  releasePut(answer: PutAnswer): Promise<void>;
  /** Deliver one raw record to this page's stream (subject to the hold). */
  deliver(rec: SessionStatus): void;
  /** Fire a stream (re)open on this page. */
  reopen(): void;
  setVisible(visible: boolean): void;
  /** Click the chip at index, which switches to it. */
  show(index: number): void;
  switchDot(): string;
}

export interface SessionsServer {
  add(id: string, title?: string): void;
  setStatus(id: string, status: string): void;
  /** A fresh OSC 9 notification; a classified one latches `status`, which is a
   *  new occurrence even when the status string repeats. */
  notify(id: string, text: string, status?: string): void;
  setActivity(id: string, activity: string): void;
  /** Another device's ack. */
  ack(id: string, seq: number): void;
  session(id: string): ServerSession;
  open(opts?: { readonly holdStream?: boolean }): Promise<Page>;
  destroy(): void;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function nextTask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export async function until(pred: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await nextTask();
  }
}

export function createSessionsServer(): SessionsServer {
  const sessions = new Map<string, ServerSession>();
  const pages: { deliver: (rec: SessionStatus) => void }[] = [];
  const terms: TerminalHandle[] = [];

  const record = (s: ServerSession): SessionStatus => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    status: s.status,
    activity: s.activity,
    activityCount: s.activity === "" ? 0 : 1,
    reportsActivity: true,
    ...(s.statusSeq > 0 ? { statusSeq: s.statusSeq } : {}),
    ...(s.seenSeq > 0 ? { seenSeq: s.seenSeq } : {}),
  });
  const get = (id: string): ServerSession => {
    const s = sessions.get(id);
    if (!s) {
      throw new Error(`no session ${id}`);
    }
    return s;
  };
  const push = (s: ServerSession, extra: Partial<SessionStatus> = {}): void => {
    const rec = { ...record(s), ...extra };
    for (const p of pages) {
      p.deliver(rec);
    }
  };
  const applyAck = (id: string, seq: number): boolean => {
    const s = sessions.get(id);
    if (!s) {
      return false;
    }
    const next = Math.max(s.seenSeq, Math.min(seq, s.statusSeq));
    if (next !== s.seenSeq) {
      s.seenSeq = next;
      push(s);
    }
    return true;
  };

  async function open(opts: { readonly holdStream?: boolean } = {}): Promise<Page> {
    const frame = document.createElement("iframe");
    frame.style.width = "800px";
    frame.style.height = "400px";
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!doc || !win) {
      throw new Error("no frame document");
    }
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const badgeWrites: number[] = [];
    const write = (n: number): Promise<void> => {
      badgeWrites.push(n);
      return Promise.resolve();
    };
    Object.defineProperty(win.navigator, "setAppBadge", { value: write, configurable: true });
    Object.defineProperty(win.navigator, "clearAppBadge", {
      value: () => write(0),
      configurable: true,
    });
    const banners: Banner[] = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission(): Promise<string> {
        return Promise.resolve("granted");
      }
      readonly banner: Banner;
      onclick: ((event: Event) => void) | null = null;
      constructor(_title: string, options?: { tag?: string }) {
        this.banner = { tag: options?.tag, closed: false };
        banners.push(this.banner);
      }
      close(): void {
        this.banner.closed = true;
      }
    }
    Object.defineProperty(win, "Notification", { value: FakeNotification, configurable: true });

    let streamHeld = opts.holdStream === true;
    const queued: SessionStatus[] = [];
    const subs = new Set<(s: SessionStatus) => void>();
    const openSubs = new Set<() => void>();
    const send = (rec: SessionStatus): void => {
      for (const cb of [...subs]) {
        cb(rec);
      }
    };
    const deliver = (rec: SessionStatus): void => {
      if (streamHeld) {
        queued.push(rec);
      } else {
        send(rec);
      }
    };
    pages.push({ deliver });
    const monitor: TerminalFeature<ActivityMonitorApi> = {
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

    let listsHeld = false;
    const heldLists: { body: unknown; resolve: (r: Response) => void }[] = [];
    let putsHeld = false;
    const heldPuts: { id: string; seq: number; resolve: (r: Response) => void }[] = [];
    const puts: { id: string; seq: number }[] = [];
    const answer = (id: string, seq: number, a: PutAnswer): Response => {
      if (a === 404) {
        return jsonResponse({ error: "unknown session" }, 404);
      }
      if (a === 500) {
        return jsonResponse({ error: "boom" }, 500);
      }
      if (!applyAck(id, seq)) {
        return jsonResponse({ error: "unknown session" }, 404);
      }
      return a === 204 ? jsonResponse(null, 204) : jsonResponse({ error: "lost" }, 500);
    };
    const page: Page = {
      win,
      doc,
      root,
      badgeWrites,
      banners,
      puts,
      putAnswer: 204,
      badge: () => badgeWrites.at(-1) ?? 0,
      holdStream() {
        streamHeld = true;
      },
      releaseStream() {
        streamHeld = false;
        for (const rec of queued.splice(0)) {
          send(rec);
        }
      },
      holdLists() {
        listsHeld = true;
      },
      async releaseList() {
        const held = heldLists.shift();
        held?.resolve(jsonResponse(held.body, 200));
        await until(() => false, 5);
      },
      holdPuts() {
        putsHeld = true;
      },
      async releasePut(a) {
        const held = heldPuts.shift();
        if (held) {
          held.resolve(answer(held.id, held.seq, a));
        }
        await until(() => false, 5);
      },
      deliver,
      reopen() {
        for (const cb of [...openSubs]) {
          cb();
        }
      },
      setVisible(visible) {
        Object.defineProperty(doc, "visibilityState", {
          value: visible ? "visible" : "hidden",
          configurable: true,
        });
        doc.dispatchEvent(new win.Event("visibilitychange"));
      },
      show(index) {
        root.querySelectorAll<HTMLElement>(".wt-tab")[index]?.click();
      },
      switchDot: () =>
        root.querySelector<HTMLElement>(".wt-switcher-switch-dot")?.dataset["status"] ?? "",
    };
    win.fetch = ((url: string | URL, init?: RequestInit): Promise<Response> => {
      const path = String(url);
      const method = init?.method ?? "GET";
      if (path.endsWith("/layout")) {
        return Promise.resolve(
          method === "PUT"
            ? jsonResponse(null, 204)
            : jsonResponse(
                { left: null, right: null, handle: 0.5, selected: "left", open: false },
                200,
              ),
        );
      }
      const seen = /^\/api\/sessions\/([^/]+)\/seen$/.exec(path);
      if (seen?.[1] !== undefined && method === "PUT") {
        const id = decodeURIComponent(seen[1]);
        const { seq } = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
          seq: number;
        };
        puts.push({ id, seq });
        if (putsHeld) {
          return new Promise((resolve) => heldPuts.push({ id, seq, resolve }));
        }
        return Promise.resolve(answer(id, seq, page.putAnswer));
      }
      if (path === "/api/sessions" && method === "GET") {
        const body = [...sessions.values()].map(record);
        if (listsHeld) {
          return new Promise((resolve) => heldLists.push({ body, resolve }));
        }
        return Promise.resolve(jsonResponse(body, 200));
      }
      return Promise.resolve(jsonResponse(null, 204));
    }) as typeof fetch;

    Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
    terms.push(
      await mountTerminal(root, {
        features: () => [monitor, tabs({ activityMonitor: monitor })],
      }),
    );
    await until(() => root.querySelectorAll(".wt-tab").length === sessions.size);
    return page;
  }

  return {
    add(id, title = id) {
      sessions.set(id, {
        id,
        title,
        createdAt: String(sessions.size + 1),
        status: "idle",
        activity: "",
        statusSeq: 0,
        seenSeq: 0,
        notificationSeq: 0,
      });
    },
    setStatus(id, status) {
      const s = get(id);
      if (s.status !== status) {
        s.status = status;
        s.statusSeq++;
      }
      push(s);
    },
    notify(id, text, status) {
      const s = get(id);
      s.notificationSeq++;
      if (status !== undefined) {
        s.status = status;
        s.statusSeq++;
      }
      push(s, { notification: text, notificationSeq: s.notificationSeq });
    },
    setActivity(id, activity) {
      const s = get(id);
      s.activity = activity;
      push(s);
    },
    ack(id, seq) {
      applyAck(id, seq);
    },
    session: get,
    open,
    destroy() {
      for (const t of terms.splice(0)) {
        t.destroy();
      }
      for (const frame of document.querySelectorAll("iframe")) {
        frame.remove();
      }
      pages.length = 0;
      sessions.clear();
    },
  };
}

/** Stamps `statusSeq` on a record that carries none, by the engine's rule: a
 *  status change, or a fresh notification latching input or done, is a new
 *  occurrence. Lets a test that emits bare records keep reading as a stream. */
export function engineNumbering(): (s: SessionStatus) => SessionStatus {
  const last = new Map<string, { status: string; seq: number; notif: number }>();
  return (s) => {
    const prev = last.get(s.id) ?? { status: "", seq: 0, notif: 0 };
    if (s.removed === true) {
      return s;
    }
    if (s.statusSeq !== undefined) {
      last.set(s.id, {
        status: s.status,
        seq: s.statusSeq,
        notif: s.notificationSeq ?? prev.notif,
      });
      return s;
    }
    const notif = s.notificationSeq ?? 0;
    const fresh = notif > prev.notif && (s.status === "input" || s.status === "done");
    const seq = s.status !== prev.status || fresh ? prev.seq + 1 : prev.seq;
    last.set(s.id, { status: s.status, seq, notif: Math.max(notif, prev.notif) });
    return { ...s, statusSeq: seq };
  };
}

/** The highest occurrence each session was acknowledged at, from a fetch mock's
 *  calls to the seen route. */
export function seenAcks(
  calls: readonly (readonly [string | URL, (RequestInit | undefined)?])[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [url, init] of calls) {
    const m = /\/api\/sessions\/([^/]+)\/seen$/.exec(String(url));
    if (m?.[1] !== undefined && init?.method === "PUT") {
      const id = decodeURIComponent(m[1]);
      const { seq } = JSON.parse(typeof init.body === "string" ? init.body : "") as { seq: number };
      out[id] = Math.max(out[id] ?? 0, seq);
    }
  }
  return out;
}
