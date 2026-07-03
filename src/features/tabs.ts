// tabs feature: multiple independent terminals over the one kernel (design
// sections 5, 6, 12, 22.5). It owns the session set (GET/POST/DELETE
// /api/sessions), a per-tab LineStore switching cache, the reconnect-on-switch
// swap, and the tab chrome on both form factors: the desktop top-bar strip and
// the mobile bottom-switcher + modal overview sheet. The kernel drives one
// active session; switching re-points the renderer at the next tab's cached
// store (ctx.render.bind) and asks the kernel to reconnect the terminal WS to it
// (ctx.notifySwitch), so the last-known screen paints instantly and the
// background delta arrives after.

import { LineStore, modes } from "@cplieger/web-terminal-engine";
import type { TerminalContext, TerminalFeature, TabHandle } from "../kernel/types.js";
import type { ActivityMonitorApi } from "./activity-monitor.js";
import { fromHTML } from "./dom.js";

const DEFAULT_API_BASE = "/api/sessions";
// Swipe recognition on the mobile switcher bar: a mostly-horizontal drag past
// this distance switches; a near-stationary release is a tap (opens overview).
const SWIPE_MIN_PX = 40;
// One-time "swipe to switch" hint, remembered across loads.
const SWIPE_HINT_KEY = "wt-swipe-hint-seen";
// Default cadence for the no-activityMonitor polling fallback.
const DEFAULT_POLL_MS = 4000;

/** One session's client-side wire shape (matches terminal.SessionInfo). */
interface SessionInfo {
  id: string;
  title: string;
  createdAt: string;
  status: string;
}

interface Tab {
  id: string;
  /** The raw server title (the OSC 0/2 window title the process set), possibly
   *  empty before the process sets one. The displayed label is derived from it
   *  with a numbered fallback and de-duplication (see relabelAll). */
  title: string;
  /** A stable per-session number for the "Tab N" fallback when the process has
   *  set no title. Monotonic across the page so a tab's number never changes
   *  under it when a sibling closes. */
  num: number;
  /** The computed, de-duplicated label actually shown in the chrome. */
  display: string;
  createdAt: string;
  store: LineStore;
  el: HTMLElement;
  label: HTMLElement;
  dot: HTMLElement;
  aria: TabHandle;
  scrollTop: number;
  following: boolean;
  /** A title derived from the first line the user submitted into this tab, used
   *  in preference to the process window title (kiro-cli's OSC 0 title is only
   *  the cwd for a live session, so it never reflects the conversation).
   *  Undefined until the first non-empty, non-slash submission. */
  derived?: string;
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
   *  drops exited/removed tabs (ctx.use). Without it, dots stay neutral and tabs
   *  falls back to polling the session list (see pollMs). */
  activityMonitor?: TerminalFeature<ActivityMonitorApi>;
  /** Poll interval in ms for the no-activityMonitor fallback: without the status
   *  SSE, tabs re-lists GET /api/sessions on this cadence to refresh dots and
   *  titles and drop reaped tabs (section 22.5). Ignored when activityMonitor is
   *  present. Default 4000. */
  pollMs?: number;
}

const TAB_HTML = `
<div class="wt-tab">
  <span class="wt-tab-dot wt-status-dot" aria-hidden="true"></span>
  <span class="wt-tab-label"></span>
  <button type="button" class="wt-tab-close" aria-label="Close terminal" tabindex="-1">\u00d7</button>
</div>`;

const NEW_HTML = `<button type="button" class="wt-tab-new" aria-label="New terminal">+</button>`;

// Mobile bottom-switcher: the active tab (dot + label + position) as a tap/swipe
// surface, plus a >=44px overview control that carries the aggregate badge.
const SWITCHER_HTML = `
<div class="wt-switcher" role="group" aria-label="Terminal tabs">
  <button type="button" class="wt-switcher-current" aria-haspopup="dialog">
    <span class="wt-switcher-dot wt-status-dot" aria-hidden="true"></span>
    <span class="wt-switcher-label"></span>
    <span class="wt-switcher-pos" aria-hidden="true"></span>
  </button>
  <button type="button" class="wt-switcher-overview wt-btn" aria-haspopup="dialog" aria-label="All terminals">
    <span class="wt-switcher-count" aria-hidden="true"></span>
  </button>
</div>`;

// Modal overview sheet (kernel `sheet` region): every tab with title + dot +
// close, plus create. Starts hidden; opened from the switcher.
const SHEET_HTML = `
<div class="wt-sheet" role="dialog" aria-modal="true" aria-label="Terminals" hidden>
  <div class="wt-sheet-header">
    <span class="wt-sheet-title">Terminals</span>
    <button type="button" class="wt-sheet-new wt-btn">+ New terminal</button>
  </div>
  <ul class="wt-sheet-list" role="list"></ul>
</div>`;

const SHEET_ROW_HTML = `
<li class="wt-sheet-row">
  <button type="button" class="wt-sheet-select">
    <span class="wt-sheet-row-dot wt-status-dot" aria-hidden="true"></span>
    <span class="wt-sheet-row-label"></span>
  </button>
  <button type="button" class="wt-sheet-close wt-btn" aria-label="Close terminal">\u00d7</button>
</li>`;

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

      // --- Desktop tab strip (top-bar region) ---
      const slot = ctx.region("top-bar", "tabs");
      const bar = document.createElement("div");
      bar.className = "wt-tab-bar";
      bar.setAttribute("role", "tablist");
      slot.appendChild(bar);
      // The "+" button is the last flex item INSIDE the strip. Appending it to
      // the slot (a sibling of the fixed .wt-tab-bar) flowed it out of the strip
      // to the root, so it never appeared; inside the flex bar it renders at the
      // end of the tabs (addTabChrome inserts each tab before it).
      const newBtn = fromHTML(NEW_HTML);
      bar.appendChild(newBtn);

      // Push the terminal surface below the fixed strip on desktop so the bar
      // does not overlap the first rows. The surface is position:fixed inset:0,
      // so a top offset (gated to a fine pointer in CSS, since the strip is
      // hidden on a coarse pointer where the switcher docks to the bottom
      // instead) is what clears it. A ResizeObserver keeps the offset in step
      // with the real strip height rather than a hard-coded guess.
      const surface = ctx.surface();
      surface.classList.add("wt-with-topbar");
      const barResize = new ResizeObserver(() => {
        surface.style.setProperty("--wt-tabbar-h", `${String(bar.offsetHeight)}px`);
      });
      barResize.observe(bar);

      // --- Mobile bottom-switcher (bottom-switcher region) ---
      const switcher = fromHTML(SWITCHER_HTML);
      const swCurrent = pick(switcher, ".wt-switcher-current");
      const swDot = pick(switcher, ".wt-switcher-dot");
      const swLabel = pick(switcher, ".wt-switcher-label");
      const swPos = pick(switcher, ".wt-switcher-pos");
      const overviewBtn = pick(switcher, ".wt-switcher-overview");
      const swCount = pick(switcher, ".wt-switcher-count");
      ctx.region("bottom-switcher", "switcher").appendChild(switcher);

      // --- Overview sheet + scrim (sheet region) ---
      const sheetSlot = ctx.region("sheet", "overview");
      const scrim = document.createElement("div");
      scrim.className = "wt-sheet-scrim";
      const sheet = fromHTML(SHEET_HTML);
      const sheetList = pick(sheet, ".wt-sheet-list");
      const sheetNewBtn = pick(sheet, ".wt-sheet-new");
      sheetSlot.append(scrim, sheet);

      // Catching-up cue: a switched-into tab's cached screen is stale until its
      // resume delta lands, so it must not read as live (sections 12/13). Shown
      // only if the delta has not arrived shortly after a switch; cleared on the
      // first screen frame.
      const catchup = document.createElement("div");
      catchup.className = "wt-catchup";
      catchup.setAttribute("role", "status");
      catchup.textContent = "Catching up\u2026";
      ctx.region("banner", "catchup").appendChild(catchup);
      let catchupTimer: ReturnType<typeof setTimeout> | null = null;

      const tabList: Tab[] = [];
      let activeId: string | null = null;
      let overviewOpen = false;
      let lastFocus: HTMLElement | null = null;
      let hintShown = false;
      let tabSeq = 0; // monotonic source for the "Tab N" fallback number

      // labelFor is a tab's base label before de-duplication. Preference order:
      // the title derived from the user's first submitted line (best for a chat
      // like kiro-cli, whose OSC 0 title only ever reflects the cwd for a live
      // session), then the process window title (OSC 0/2, e.g. a shell's), then
      // a stable "Tab N". This fixes both the generic "terminal" label and the
      // static "kiro: /workspace" one: a tab now names itself from what you type.
      function labelFor(tab: Tab): string {
        // derived is only ever set to a non-empty value, so ?? and || agree on
        // it; the || on the (possibly empty) window title falls through to "Tab N".
        return (tab.derived?.trim() ?? tab.title.trim()) || `Tab ${String(tab.num)}`;
      }

      // relabelAll recomputes every tab's display label with de-duplication:
      // when two tabs resolve to the same base label (e.g. two tabs whose first
      // submitted line was identical, or two shells with the same window title),
      // the second and later get a " (k)" suffix in creation order, so the strip
      // never shows two identical labels.
      function relabelAll(): void {
        const counts = new Map<string, number>();
        for (const t of tabList) {
          const base = labelFor(t);
          counts.set(base, (counts.get(base) ?? 0) + 1);
        }
        const seen = new Map<string, number>();
        for (const t of tabList) {
          const base = labelFor(t);
          let display = base;
          if ((counts.get(base) ?? 0) > 1) {
            const k = (seen.get(base) ?? 0) + 1;
            seen.set(base, k);
            if (k > 1) {
              display = `${base} (${String(k)})`;
            }
          }
          t.display = display;
          t.label.textContent = display;
          t.aria.setLabel(display);
        }
      }

      // --- Title derivation from the user's first submitted line ---
      // kiro-cli's OSC 0 title is only the cwd for a live session (it reloads its
      // session title just when the session id changes, not per turn), so the
      // useful, updating title for a chat is the user's first message. The kernel
      // routes input to the active session, so an input observer's bytes belong
      // to activeId. A tiny line editor tracks the current input line (handling
      // backspace and skipping the escape sequences arrow keys and bracketed
      // paste emit) and locks the tab's title on the first non-empty, non-slash
      // submission. Best-effort: an odd editing sequence just yields no derived
      // title, falling back to the window title or "Tab N".
      const MAX_DERIVED = 60;
      let lineBytes: number[] = [];
      let escState = 0; // 0 normal, 1 saw ESC, 2 in CSI, 3 in SS3 (one more byte)
      function resetInputLine(): void {
        lineBytes = [];
        escState = 0;
      }
      function deriveTitleFromInput(bytes: Uint8Array): void {
        const t = tabList.find((x) => x.id === activeId);
        if (!t || t.derived !== undefined) {
          return; // no active tab, or its first submission is already captured
        }
        for (const b of bytes) {
          if (escState === 1) {
            escState = b === 0x5b ? 2 : b === 0x4f ? 3 : 0; // ESC [ = CSI, ESC O = SS3
            continue;
          }
          if (escState === 2) {
            if (b >= 0x40 && b <= 0x7e) {
              escState = 0; // CSI final byte
            }
            continue;
          }
          if (escState === 3) {
            escState = 0; // SS3 final byte
            continue;
          }
          if (b === 0x1b) {
            escState = 1; // ESC: start of an escape sequence
          } else if (b === 0x0d || b === 0x0a) {
            const line = new TextDecoder().decode(new Uint8Array(lineBytes)).trim();
            lineBytes = [];
            if (line && !line.startsWith("/")) {
              t.derived = line.slice(0, MAX_DERIVED);
              syncChrome();
              return;
            }
          } else if (b === 0x7f || b === 0x08) {
            // Backspace: drop one codepoint (pop UTF-8 continuation bytes + lead).
            while (lineBytes.length > 0) {
              const last = lineBytes[lineBytes.length - 1];
              if (last === undefined || (last & 0xc0) !== 0x80) {
                break;
              }
              lineBytes.pop();
            }
            lineBytes.pop();
          } else if (b === 0x03) {
            lineBytes = []; // Ctrl-C: cancel the current line
          } else if (b >= 0x20) {
            lineBytes.push(b); // printable ASCII or a UTF-8 byte
          }
        }
      }

      function focusInput(): void {
        ctx.surface().querySelector<HTMLElement>(".term-input")?.focus({ preventScroll: true });
      }

      // paintActive updates the desktop strip's active state.
      function paintActive(): void {
        for (const t of tabList) {
          const on = t.id === activeId;
          t.el.classList.toggle("wt-tab-active", on);
          t.aria.setSelected(on);
        }
      }

      // syncMobile updates the bottom switcher: active label + position, the tab
      // count, and the aggregate needs-input badge (so a background tab blocked
      // on input is glanceable on mobile without opening the sheet, section 12).
      function syncMobile(): void {
        const idx = tabList.findIndex((t) => t.id === activeId);
        const active = idx >= 0 ? tabList[idx] : undefined;
        swLabel.textContent = active ? active.display : "";
        swDot.dataset["status"] = active?.dot.dataset["status"] ?? "idle";
        swPos.textContent =
          tabList.length > 1 ? `${String(idx + 1)} / ${String(tabList.length)}` : "";
        swCount.textContent = String(tabList.length);
        const bgInput = tabList.some(
          (t) => t.id !== activeId && t.dot.dataset["status"] === "input",
        );
        if (bgInput) {
          overviewBtn.dataset["attention"] = "input";
          overviewBtn.setAttribute(
            "aria-label",
            "All terminals; a background terminal needs input",
          );
        } else {
          delete overviewBtn.dataset["attention"];
          overviewBtn.setAttribute("aria-label", "All terminals");
        }
      }

      // renderOverview rebuilds the sheet's tab rows from the current tabList.
      function renderOverview(): void {
        sheetList.replaceChildren();
        for (const t of tabList) {
          const row = fromHTML(SHEET_ROW_HTML);
          const rdot = pick(row, ".wt-sheet-row-dot");
          const rlabel = pick(row, ".wt-sheet-row-label");
          const rselect = pick(row, ".wt-sheet-select");
          const rclose = pick(row, ".wt-sheet-close");
          rdot.dataset["status"] = t.dot.dataset["status"] ?? "idle";
          rlabel.textContent = t.display;
          if (t.id === activeId) {
            row.classList.add("wt-sheet-row-active");
            rselect.setAttribute("aria-current", "true");
          }
          rselect.addEventListener("click", () => {
            // Close first so focus restores off the sheet, then switch (which
            // focuses the terminal) so focus lands in the terminal, not the bar.
            closeOverview();
            switchTo(t.id);
          });
          rclose.addEventListener("click", (e) => {
            e.stopPropagation();
            void close_(t.id);
          });
          sheetList.appendChild(row);
        }
      }

      // syncChrome refreshes every surface after any state change. Idempotent.
      function syncChrome(): void {
        relabelAll();
        paintActive();
        syncMobile();
        if (overviewOpen) {
          renderOverview();
        }
        maybeSwipeHint();
      }

      function openOverview(): void {
        if (overviewOpen) {
          return;
        }
        overviewOpen = true;
        lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        renderOverview();
        scrim.classList.add("visible");
        sheet.hidden = false;
        sheet.classList.add("visible");
        sheet.querySelector<HTMLElement>("button")?.focus();
        ctx.announce("Terminals list opened");
      }

      function closeOverview(): void {
        if (!overviewOpen) {
          return;
        }
        overviewOpen = false;
        scrim.classList.remove("visible");
        sheet.classList.remove("visible");
        sheet.hidden = true;
        lastFocus?.focus();
        lastFocus = null;
      }

      function addTabChrome(info: SessionInfo): Tab {
        const el = fromHTML(TAB_HTML);
        const label = el.querySelector<HTMLElement>(".wt-tab-label");
        const dot = el.querySelector<HTMLElement>(".wt-tab-dot");
        const close = el.querySelector<HTMLButtonElement>(".wt-tab-close");
        if (!label || !dot || !close) {
          throw new Error("web-terminal-ui: tab chrome missing parts");
        }
        dot.dataset["status"] = info.status || "idle";
        const aria = tablist.registerTab(el);
        // Insert before the "+" button so it stays the last item in the strip.
        bar.insertBefore(el, newBtn);

        const tab: Tab = {
          id: info.id,
          title: info.title,
          num: ++tabSeq,
          display: "",
          createdAt: info.createdAt,
          store: new LineStore(),
          el,
          label,
          dot,
          aria,
          scrollTop: 0,
          following: true,
        };
        // Set an initial label immediately (relabelAll refines it with de-dup
        // once the tab is in tabList and syncChrome runs).
        tab.display = labelFor(tab);
        label.textContent = tab.display;
        aria.setLabel(tab.display);
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
        resetInputLine(); // a partial line typed in the old tab does not carry over
        ctx.render.bind(next.store);
        ctx.notifySwitch({ id: next.id });
        armCatchup();
        flashSwitch();
        syncChrome();
        // Restore scroll memory best-effort after the async rebuild; a
        // following tab sticks to the bottom on its own.
        const savedTop = next.scrollTop;
        const following = next.following;
        requestAnimationFrame(() => {
          if (!following) {
            surface.scrollTop = savedTop;
          }
        });
        ctx.announce(`Switched to ${next.display}`);
        focusInput();
      }

      // armCatchup shows the "catching up" cue only if the resume delta has not
      // landed shortly after a switch; clearCatchup hides it when a screen frame
      // arrives (subscribed below).
      function armCatchup(): void {
        if (catchupTimer !== null) {
          clearTimeout(catchupTimer);
        }
        catchup.classList.remove("visible");
        catchupTimer = setTimeout(() => {
          catchupTimer = null;
          catchup.classList.add("visible");
        }, 150);
      }
      function clearCatchup(): void {
        if (catchupTimer !== null) {
          clearTimeout(catchupTimer);
          catchupTimer = null;
        }
        catchup.classList.remove("visible");
      }
      // flashSwitch adds a class the animations feature keys a brief content fade
      // off (a no-op when animations are absent or reduced-motion is set).
      function flashSwitch(): void {
        const surface = ctx.surface();
        surface.classList.add("wt-switching");
        setTimeout(() => {
          surface.classList.remove("wt-switching");
        }, 300);
      }

      // The first screen frame after a switch is the resume delta landing.
      ctx.on("wire:screen", () => {
        clearCatchup();
      });

      // switchRelative moves delta tabs from the active one (swipe left = next).
      function switchRelative(delta: number): void {
        const idx = tabList.findIndex((t) => t.id === activeId);
        if (idx < 0) {
          return;
        }
        const next = tabList[idx + delta];
        if (next) {
          switchTo(next.id);
        }
      }

      async function create(): Promise<void> {
        const info = await apiCreate();
        const tab = addTabChrome(info);
        tabList.push(tab);
        switchTo(tab.id);
      }

      // dropTab removes a tab's chrome + cache and re-homes the active session.
      // remote=true also DELETEs the server session (a user close); remote=false
      // is a local drop for a session the server already ended (an SSE removed
      // event or a poll that no longer lists it), so no redundant DELETE is sent.
      async function dropTab(id: string, remote: boolean): Promise<void> {
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
        syncChrome(); // reflect the drop immediately (count, position, sheet)
        if (remote) {
          await apiClose(id);
        }
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

      async function close_(id: string): Promise<void> {
        await dropTab(id, true);
      }

      // One-time "swipe to switch" hint on first multi-tab state, mobile only.
      function maybeSwipeHint(): void {
        if (hintShown || tabList.length < 2) {
          return;
        }
        hintShown = true;
        if (!window.matchMedia("(pointer: coarse)").matches) {
          return; // desktop: swipe is irrelevant
        }
        let seen = false;
        try {
          seen = localStorage.getItem(SWIPE_HINT_KEY) === "1";
        } catch {
          /* storage unavailable; show once per session via hintShown */
        }
        if (seen) {
          return;
        }
        try {
          localStorage.setItem(SWIPE_HINT_KEY, "1");
        } catch {
          /* ignore */
        }
        ctx.toast("Swipe the bar to switch terminals");
      }

      // applyStatus updates one tab's dot + title from a status record (shared by
      // the SSE monitor and the polling fallback).
      function applyStatus(id: string, status: string, title: string | undefined): void {
        const t = tabList.find((tab) => tab.id === id);
        if (!t) {
          return;
        }
        t.dot.dataset["status"] = status || "idle";
        // Record the raw server title; the displayed label (fallback + de-dup)
        // is recomputed by relabelAll via syncChrome, which the callers run
        // right after applyStatus.
        if (title !== undefined) {
          t.title = title;
        }
      }

      // Live status: the activity monitor (SSE push) when present, else a poll of
      // GET /api/sessions. Either way, dots + titles update and vanished sessions
      // drop; the poll additionally learns of a background exit the SSE would
      // have pushed (section 22.5).
      let offStatus: (() => void) | undefined;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      if (monitor) {
        offStatus = monitor.onStatus((s) => {
          if (s.removed) {
            void dropTab(s.id, false); // already gone server-side; no DELETE
            return;
          }
          applyStatus(s.id, s.status, s.title);
          syncChrome();
        });
      } else {
        const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
        const pollOnce = async (): Promise<void> => {
          let list: SessionInfo[];
          try {
            list = await apiList();
          } catch {
            return; // transient; try again next tick
          }
          const seen = new Set(list.map((s) => s.id));
          for (const info of list) {
            applyStatus(info.id, info.status, info.title);
          }
          // A tab the server no longer lists was reaped/closed elsewhere: drop it
          // locally (no DELETE — it is already gone).
          const gone = tabList.filter((t) => !seen.has(t.id)).map((t) => t.id);
          for (const id of gone) {
            await dropTab(id, false);
          }
          syncChrome();
        };
        pollTimer = setInterval(() => {
          void pollOnce();
        }, pollMs);
      }

      // --- Event wiring ---
      // Derive each tab's title from the first line the user submits into it.
      const offInput = ctx.registerInputObserver(deriveTitleFromInput);
      newBtn.addEventListener("click", () => {
        void create();
      });
      overviewBtn.addEventListener("click", () => {
        openOverview();
      });
      sheetNewBtn.addEventListener("click", () => {
        closeOverview();
        void create();
      });
      scrim.addEventListener("click", () => {
        closeOverview();
      });
      sheet.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closeOverview();
          return;
        }
        if (e.key !== "Tab") {
          return;
        }
        const focusables = Array.from(sheet.querySelectorAll<HTMLElement>("button")).filter(
          (el) => !el.hasAttribute("disabled"),
        );
        const firstEl = focusables[0];
        const lastEl = focusables[focusables.length - 1];
        if (!firstEl || !lastEl) {
          return;
        }
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      });

      // Swipe/tap on the switcher bar: a horizontal swipe switches (gated off
      // under mouse tracking, since mouse-mode apps capture drags); a tap opens
      // the overview. click also covers keyboard/mouse activation.
      let downX = 0;
      let downY = 0;
      let swiped = false;
      swCurrent.addEventListener(
        "pointerdown",
        (e) => {
          downX = e.clientX;
          downY = e.clientY;
          swiped = false;
        },
        { passive: true },
      );
      swCurrent.addEventListener(
        "pointerup",
        (e) => {
          const dx = e.clientX - downX;
          const dy = e.clientY - downY;
          if (
            Math.abs(dx) >= SWIPE_MIN_PX &&
            Math.abs(dx) > Math.abs(dy) * 1.5 &&
            modes.getMouseMode() === 0
          ) {
            swiped = true;
            switchRelative(dx < 0 ? 1 : -1);
          }
        },
        { passive: true },
      );
      swCurrent.addEventListener("click", () => {
        if (swiped) {
          swiped = false; // consumed by the swipe; do not also open the overview
          return;
        }
        openOverview();
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
        syncChrome();
        focusInput();
      }

      return {
        api: {
          create,
          close: close_,
          switchTo,
          list: () =>
            tabList.map((t) => ({ id: t.id, title: t.display, active: t.id === activeId })),
        },
        teardown() {
          offStatus?.();
          offInput();
          if (pollTimer !== null) {
            clearInterval(pollTimer);
          }
          barResize.disconnect();
          surface.classList.remove("wt-with-topbar");
          surface.style.removeProperty("--wt-tabbar-h");
          clearCatchup();
          closeOverview();
          for (const t of tabList) {
            t.aria.remove();
            t.el.remove();
          }
          tabList.length = 0;
          bar.remove();
          newBtn.remove();
          switcher.remove();
          sheet.remove();
          scrim.remove();
          catchup.remove();
        },
      };
    },
  };
}

// pick returns a required descendant element or throws (static chrome only).
function pick(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`web-terminal-ui: tabs chrome missing ${selector}`);
  }
  return el;
}
