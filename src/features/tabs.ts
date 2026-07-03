// tabs feature: multiple independent terminals over the one kernel (design
// sections 5, 6, 22.5). It owns the session set (GET/POST/DELETE
// /api/sessions), a per-tab LineStore switching cache, the reconnect-on-switch
// swap, and the tab-bar chrome. The kernel drives one active session; switching
// re-points the renderer at the next tab's cached store (ctx.render.bind) and
// asks the kernel to reconnect the terminal WS to it (ctx.notifySwitch), so the
// last-known screen paints instantly and the background delta arrives after.
//
// Scope note (first cut): the desktop tab bar, create/close/switch, the
// per-tab cache, ARIA tablist wiring, and activityMonitor dots are implemented.
// The mobile bottom-switcher + overview sheet (section 12), swipe-to-switch
// (mouse-mode gated), and the section 5.1 IME-finalize-on-switch refinement are
// tracked follow-ups; the switch itself is synchronous so the input funnel does
// not interleave sends across sessions mid-switch.

import { LineStore } from "@cplieger/web-terminal-engine";
import type { TerminalContext, TerminalFeature, TabHandle } from "../kernel/types.js";
import type { ActivityMonitorApi } from "./activity-monitor.js";
import { fromHTML } from "./dom.js";

const DEFAULT_API_BASE = "/api/sessions";

/** One session's client-side wire shape (matches terminal.SessionInfo). */
interface SessionInfo {
  id: string;
  title: string;
  createdAt: string;
  status: string;
}

interface Tab {
  id: string;
  title: string;
  createdAt: string;
  store: LineStore;
  el: HTMLElement;
  label: HTMLElement;
  dot: HTMLElement;
  aria: TabHandle;
  scrollTop: number;
  following: boolean;
}

export interface TabsApi {
  /** Spawn a fresh session and switch to it. */
  create(): Promise<void>;
  /** Close a session (kills its process) and drop its tab + cache. */
  close(id: string): Promise<void>;
  /** Switch the active tab. */
  switchTo(id: string): void;
  /** The current tabs, active first-to-last by creation. */
  list(): readonly { id: string; title: string; active: boolean }[];
}

export interface TabsOptions {
  /** REST base for the session API (default "/api/sessions"). */
  apiBase?: string;
  /** The activityMonitor feature value, so tabs renders live status dots and
   *  drops exited/removed tabs (ctx.use). Without it, dots stay neutral. */
  activityMonitor?: TerminalFeature<ActivityMonitorApi>;
}

const TAB_HTML = `
<div class="wt-tab">
  <span class="wt-tab-dot" aria-hidden="true"></span>
  <span class="wt-tab-label"></span>
  <button type="button" class="wt-tab-close" aria-label="Close terminal" tabindex="-1">\u00d7</button>
</div>`;

const NEW_HTML = `<button type="button" class="wt-tab-new" aria-label="New terminal">+</button>`;

export function tabs(opts: TabsOptions = {}): TerminalFeature<TabsApi> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;

  async function apiList(): Promise<SessionInfo[]> {
    const r = await fetch(apiBase, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      throw new Error(`web-terminal-ui: session list failed (${String(r.status)})`);
    }
    return (await r.json()) as SessionInfo[];
  }
  async function apiCreate(): Promise<SessionInfo> {
    const r = await fetch(apiBase, { method: "POST" });
    if (r.status === 429) {
      throw new Error("web-terminal-ui: too many sessions");
    }
    if (!r.ok) {
      throw new Error(`web-terminal-ui: session create failed (${String(r.status)})`);
    }
    return (await r.json()) as SessionInfo;
  }
  async function apiClose(id: string): Promise<void> {
    await fetch(`${apiBase}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  return {
    name: "tabs",
    // tabs owns session selection: it resolves the first session id from
    // GET/POST /api/sessions during setup and drives the first connect via
    // ctx.notifySwitch. This tells the kernel not to open a bare /ws at startup
    // (which a SessionManager would 404 for lack of ?session=).
    managesSessions: true,
    async setup(ctx: TerminalContext) {
      const tablist = ctx.tablist();
      const monitor = opts.activityMonitor ? ctx.use(opts.activityMonitor) : undefined;

      const slot = ctx.region("top-bar", "tabs");
      const bar = document.createElement("div");
      bar.className = "wt-tab-bar";
      bar.setAttribute("role", "tablist");
      slot.appendChild(bar);
      const newBtn = fromHTML(NEW_HTML);
      slot.appendChild(newBtn);

      const tabList: Tab[] = [];
      let activeId: string | null = null;

      function focusInput(): void {
        ctx.surface().querySelector<HTMLElement>(".term-input")?.focus({ preventScroll: true });
      }

      function paintActive(): void {
        for (const t of tabList) {
          const on = t.id === activeId;
          t.el.classList.toggle("wt-tab-active", on);
          t.aria.setSelected(on);
        }
      }

      function addTabChrome(info: SessionInfo): Tab {
        const el = fromHTML(TAB_HTML);
        const label = el.querySelector<HTMLElement>(".wt-tab-label");
        const dot = el.querySelector<HTMLElement>(".wt-tab-dot");
        const close = el.querySelector<HTMLButtonElement>(".wt-tab-close");
        if (!label || !dot || !close) {
          throw new Error("web-terminal-ui: tab chrome missing parts");
        }
        const title = info.title || "terminal";
        label.textContent = title;
        dot.dataset["status"] = info.status || "idle";
        const aria = tablist.registerTab(el);
        aria.setLabel(title);
        bar.appendChild(el);

        const tab: Tab = {
          id: info.id,
          title,
          createdAt: info.createdAt,
          store: new LineStore(),
          el,
          label,
          dot,
          aria,
          scrollTop: 0,
          following: true,
        };
        el.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".wt-tab-close")) {
            return; // handled by the close button
          }
          switchTo(tab.id);
        });
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          void close_(tab.id);
        });
        return tab;
      }

      function switchTo(id: string): void {
        if (id === activeId) {
          return;
        }
        const next = tabList.find((t) => t.id === id);
        if (!next) {
          return;
        }
        const surface = ctx.surface();
        // Detach the current tab: save its scroll memory (keep its cache).
        const cur = tabList.find((t) => t.id === activeId);
        if (cur) {
          cur.scrollTop = surface.scrollTop;
          cur.following = !ctx.scroll.isUserScrolledUp();
        }
        // Attach the next tab: point the renderer at its cached store and
        // rebuild viewport-first, so the last-known screen paints with no
        // round-trip. Then let the kernel reconnect the WS to it (resume delta).
        activeId = next.id;
        ctx.render.bind(next.store);
        ctx.notifySwitch({ id: next.id });
        paintActive();
        // Restore scroll memory best-effort after the async rebuild; a
        // following tab sticks to the bottom on its own.
        const savedTop = next.scrollTop;
        const following = next.following;
        requestAnimationFrame(() => {
          if (!following) {
            surface.scrollTop = savedTop;
          }
        });
        ctx.announce(`Switched to ${next.title}`);
        focusInput();
      }

      async function create(): Promise<void> {
        const info = await apiCreate();
        const tab = addTabChrome(info);
        tabList.push(tab);
        switchTo(tab.id);
      }

      async function close_(id: string): Promise<void> {
        const idx = tabList.findIndex((t) => t.id === id);
        if (idx < 0) {
          return;
        }
        const [tab] = tabList.splice(idx, 1);
        if (!tab) {
          return;
        }
        tab.aria.remove();
        tab.el.remove();
        ctx.dropSession(id);
        await apiClose(id);
        if (activeId === id) {
          // Switch to a neighbor, or spawn a fresh session if this was the last.
          const neighbor = tabList[idx] ?? tabList[idx - 1];
          activeId = null;
          if (neighbor) {
            switchTo(neighbor.id);
          } else {
            await create();
          }
        }
      }

      // Live status from the activity monitor: update dots + titles, drop
      // exited/removed tabs.
      let offStatus: (() => void) | undefined;
      if (monitor) {
        offStatus = monitor.onStatus((s) => {
          const t = tabList.find((tab) => tab.id === s.id);
          if (!t) {
            return;
          }
          if (s.removed) {
            void close_(s.id);
            return;
          }
          t.dot.dataset["status"] = s.status;
          if (s.title && s.title !== t.title) {
            t.title = s.title;
            t.label.textContent = s.title;
            t.aria.setLabel(s.title);
          }
        });
      }

      newBtn.addEventListener("click", () => {
        void create();
      });

      // Initial population: list existing sessions, or create the first one.
      let sessions: SessionInfo[];
      try {
        sessions = await apiList();
      } catch {
        sessions = [];
      }
      if (sessions.length === 0) {
        sessions = [await apiCreate()];
      }
      for (const info of sessions) {
        tabList.push(addTabChrome(info));
      }
      // Activate the first (oldest) session.
      const first = tabList[0];
      if (first) {
        activeId = first.id;
        ctx.render.bind(first.store);
        ctx.notifySwitch({ id: first.id });
        paintActive();
        focusInput();
      }

      return {
        api: {
          create,
          close: close_,
          switchTo,
          list: () => tabList.map((t) => ({ id: t.id, title: t.title, active: t.id === activeId })),
        },
        teardown() {
          offStatus?.();
          for (const t of tabList) {
            t.aria.remove();
            t.el.remove();
          }
          tabList.length = 0;
          bar.remove();
          newBtn.remove();
        },
      };
    },
  };
}
