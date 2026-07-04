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
import type { MobileToolbarApi } from "./mobile-toolbar.js";
import { fromHTML } from "./dom.js";

const DEFAULT_API_BASE = "/api/sessions";
// Swipe recognition on the mobile switcher bar: a mostly-horizontal drag past
// this distance switches; a near-stationary release is a tap (opens overview).
const SWIPE_MIN_PX = 40;
// Movement (px) before an in-progress bar drag commits to a horizontal
// (tab-switch preview) or vertical (expand/collapse) axis.
const AXIS_LOCK_PX = 8;
// Flick-to-commit thresholds (from @use-gesture's drag defaults, MIT): a release
// counts as a flick when the gesture was quick, fast, and travelled enough, so a
// short fast swipe commits the switch/expand even below the halfway distance.
const SWIPE_VELOCITY = 0.5; // px/ms at release
const SWIPE_DURATION = 250; // ms, whole-gesture cap for a flick
// If the finger paused longer than this before lifting, the release velocity is
// stale (pointerup usually repeats the last pointermove position -> reads ~0),
// so ignore it and commit by distance instead (@use-gesture issue #332).
const VELOCITY_STALE_MS = 32;
// Live drag preview: while an open list is being swiped, it peeks in the swipe
// direction by this fraction of the finger's horizontal travel, capped at this
// many pixels — a hint of the coming rotation, not the full shift (the incoming
// row only appears on release, so a large move looked wrong). The release reel
// continues from wherever the peek left the rows.
const PREVIEW_DRAG_RATIO = 0.1;
const PREVIEW_PEEK_MAX = 10;
// One-time "swipe to switch" hint, remembered across loads.
const SWIPE_HINT_KEY = "wt-swipe-hint-seen";
// Default cadence for the no-activityMonitor polling fallback.
const DEFAULT_POLL_MS = 4000;
// Tab context-menu viewport clamp (mirrors context-menu.ts): keep this margin
// from every viewport edge, and this gap above the pointer when the menu has to
// flip up (a right-click near the bottom edge) so it is neither clipped nor
// hidden under the cursor.
const TAB_MENU_EDGE = 8;
const TAB_MENU_GAP = 16;

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
  /** The mobileToolbar feature value, so the mobile switcher bar renders a
   *  keyboard button that opens the key grid (ctx.use at tap time). Without it
   *  the bar shows no keyboard button (e.g. a desktop-only consumer). The
   *  toolbar should be built with { externalToggle: true } so its own top-right
   *  toggle is hidden and the grid opens above the bar. */
  keyboardToggle?: TerminalFeature<MobileToolbarApi>;
}

// The +/x glyphs are inline SVG (not font glyphs) so they center exactly in
// their hover box and stay symmetric regardless of the UI font's metrics.
const TAB_HTML = `
<div class="wt-tab">
  <span class="wt-tab-dot wt-status-dot" aria-hidden="true"></span>
  <span class="wt-tab-label"></span>
  <button type="button" class="wt-tab-close" aria-label="Close terminal" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg></button>
</div>`;

const NEW_HTML = `<button type="button" class="wt-tab-new" aria-label="New terminal"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>`;

// Mobile bottom bar. One element, two parts stacked in a column: the always-
// visible bar row (active tab as a tap/swipe surface + keyboard + "+") on top,
// and a list of the OTHER tabs BELOW it. On swipe-up / tap the whole bar slides
// up and the list fills in beneath it (down to the safe area); swipe-down /
// tap collapses it back to the bottom. Selecting a listed tab swaps it into the
// active row. This replaces the old separate modal overview sheet ("one element"
// per the user): the bar itself lifts rather than opening a distinct surface.
// The bar is the FIRST child and the list the SECOND: the switcher is bottom-
// anchored, so a column with the list last grows the container upward, lifting
// the bar and revealing the list below it (DOM order = visual order top-to-bottom).
//   - .wt-switcher-current-wrap: the active-tab row — a select/swipe surface
//     (.wt-switcher-current with dot + label) plus a close (x) overlaid at the
//     right, mirroring the listed rows. No "n / m" counter: the list below is a
//     rotating circular queue, so an absolute position number is meaningless.
//   - .wt-switcher-kb: opens the key grid above the bar (only wired + shown when
//     a keyboardToggle feature is provided).
//   - .wt-switcher-new: the accent "+" that spawns a terminal.
const SWITCHER_HTML = `
<div class="wt-switcher" role="group" aria-label="Terminal tabs">
  <div class="wt-switcher-bar">
    <div class="wt-switcher-current-wrap">
      <button type="button" class="wt-switcher-current" aria-haspopup="true" aria-expanded="false">
        <span class="wt-switcher-current-inner">
          <span class="wt-switcher-dot wt-status-dot" aria-hidden="true"></span>
          <span class="wt-switcher-label"></span>
        </span>
      </button>
      <button type="button" class="wt-switcher-current-close wt-btn" aria-label="Close terminal"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg></button>
    </div>
    <button type="button" class="wt-switcher-kb wt-btn" aria-label="Keyboard keys" aria-expanded="false" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M15 15 9.5 9.5M9.5 13V9.5H13"/></svg></button>
    <button type="button" class="wt-switcher-new wt-btn wt-switcher-new-btn" aria-label="New terminal"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
  </div>
  <ul class="wt-switcher-list" role="list"></ul>
</div>`;

// One row per OTHER tab in the expanded list: a stretched select target (dot +
// label) with the close (x) laid inside it at the right (two buttons can't nest,
// so the x is a sibling overlapping the select's reserved right padding).
const SWITCHER_ROW_HTML = `
<li class="wt-switcher-row">
  <button type="button" class="wt-switcher-row-select">
    <span class="wt-switcher-row-dot wt-status-dot" aria-hidden="true"></span>
    <span class="wt-switcher-row-label"></span>
  </button>
  <button type="button" class="wt-switcher-row-close wt-btn" aria-label="Close terminal"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg></button>
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

      // Pull the terminal surface up off the fixed BOTTOM strip on desktop so
      // the bar does not overlap the last rows. The surface is position:fixed
      // inset:0, so a bottom offset (gated to a fine pointer in CSS, since the
      // strip is hidden on a coarse pointer where the mobile switcher applies its
      // own inset) clears it. A ResizeObserver keeps the offset in step with the
      // real strip height rather than a hard-coded guess. The measured height is
      // published on the document root (not the surface): the scroll-to-bottom
      // button sits in a sibling region, not inside .term, so a property set on
      // .term would not inherit to it and it would fall back to the 44px guess
      // and overlap the strip. Both .term and the button inherit it from :root.
      const surface = ctx.surface();
      surface.classList.add("wt-with-tabbar");
      const barResize = new ResizeObserver(() => {
        document.documentElement.style.setProperty(
          "--wt-tabbar-h",
          `${String(bar.offsetHeight)}px`,
        );
      });
      barResize.observe(bar);

      // --- Mobile bottom bar (bottom-switcher region) ---
      const switcher = fromHTML(SWITCHER_HTML);
      const swList = pick(switcher, ".wt-switcher-list");
      const swBar = pick(switcher, ".wt-switcher-bar");
      const swCurrent = pick(switcher, ".wt-switcher-current");
      // The row's content wrapper: it translates with the finger during a
      // horizontal swipe (the active tab area physically swiping) and slides the
      // incoming tab's label in on commit.
      const swInner = pick(switcher, ".wt-switcher-current-inner");
      const swDot = pick(switcher, ".wt-switcher-dot");
      const swLabel = pick(switcher, ".wt-switcher-label");
      const swClose = pick(switcher, ".wt-switcher-current-close");
      // The active-tab elements that translate together during a horizontal
      // swipe: the content (dot + label) and the close (x). Moving both keeps the
      // whole active-tab chip sliding as one, rather than the close staying put.
      const swipeEls = [swInner, swClose];
      const swKb = pick(switcher, ".wt-switcher-kb");
      const swNew = pick(switcher, ".wt-switcher-new");
      ctx.region("bottom-switcher", "switcher").appendChild(switcher);
      // The keyboard button opens the key grid; show it only when a toolbar is
      // wired to drive. Read the toolbar's API lazily at tap time (ctx.use), so
      // feature ordering does not matter.
      let offArmed: (() => void) | undefined;
      if (opts.keyboardToggle) {
        swKb.hidden = false;
        // Mirror sticky-Ctrl on the keyboard button: when a Ctrl press is armed,
        // invert the button (like the armed Ctrl key) so the pending modifier is
        // visible with the grid closed — the toolbar sets up before tabs, so its
        // API is available now (see the preset ordering note). Also clears on the
        // auto-disarm after a Ctrl byte and on a tab switch (onDetach disarms).
        const kbApi = ctx.use(opts.keyboardToggle);
        if (kbApi) {
          const reflectArmed = (armed: boolean): void => {
            swKb.classList.toggle("wt-armed", armed);
          };
          reflectArmed(kbApi.isCtrlArmed());
          offArmed = kbApi.onCtrlArmedChange(reflectArmed);
        }
      }
      // Mark the root so the CSS lifts the bottom-anchored chrome (banner, toast,
      // scroll-to-bottom, key grid) above the switcher bar on a coarse pointer.
      const root = ctx.surface().parentElement;
      root?.classList.add("wt-tabbed");
      // Reserve the collapsed bar row's height so terminal content stops above it
      // (mobile item 2): viewport.ts adds --wt-reserve-bottom to the surface's
      // bottom inset. Measure the bar row (not the expandable list, which just
      // overlays content). innerHeight - rect.top captures the row plus the
      // safe-area beneath it; the RO fires with the keyboard closed, so the value
      // excludes the keyboard lift (viewport.ts adds that separately). The
      // synthetic visualViewport resize makes viewport.ts recompute immediately.
      const swReserve = new ResizeObserver(() => {
        const rect = swBar.getBoundingClientRect();
        const px = rect.height > 0 ? Math.max(0, Math.round(window.innerHeight - rect.top)) : 0;
        document.documentElement.style.setProperty("--wt-reserve-bottom", `${String(px)}px`);
        window.visualViewport?.dispatchEvent(new Event("resize"));
      });
      swReserve.observe(swBar);

      // Activity dots are opt-in: shown only when a status source
      // (activityMonitor) is wired, so a generic bash/sh terminal gets clean,
      // label-only tabs. CSS hides .wt-status-dot unless its container carries
      // .wt-status; the agent consumer (vibecli) provides the monitor.
      if (monitor) {
        bar.classList.add("wt-status");
        switcher.classList.add("wt-status");
      }

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

      // --- Desktop right-click tab context menu (overlay region) ---
      // Replaces the old bar "Close all" button with a richer per-tab menu. Built
      // on demand (mirroring context-menu.ts) so each item targets the
      // right-clicked tab and its disabled state reflects that tab's position.
      const tabMenu = document.createElement("div");
      tabMenu.className = "wt-tab-menu";
      tabMenu.setAttribute("role", "menu");
      ctx.region("overlay", "tab-menu").appendChild(tabMenu);

      const tabList: Tab[] = [];
      // The expanded mobile list's row elements, keyed by tab id. Rows are
      // reused across re-renders (reconcile, not rebuild) so a swipe can FLIP the
      // same elements from their old slots to their new ones (the rotation).
      const rowEls = new Map<string, HTMLElement>();
      let activeId: string | null = null;
      let draggingEl: HTMLElement | null = null;
      // Gate the new-tab enter animation: tabs present at initial population
      // should not animate in (jarring on load); only tabs added at runtime do.
      let started = false;
      let expanded = false;
      // Interactive horizontal-swipe preview: while a swipe drags with the list
      // open, the rows peek a few pixels in the swipe direction (dragActive); the
      // release reel then continues from wherever they are.
      let dragActive = false;
      // True while a reel's reconcile runs (a swipe switch): renderSwitcherList
      // suppresses its add/remove row animation then, since the reel owns row
      // motion. creatingTab suppresses the reel for a create, so the new listed
      // row grows+fades in (animateRowIn) rather than rotating.
      let reelReconcile = false;
      let creatingTab = false;
      let collapseClearTimer: ReturnType<typeof setTimeout> | null = null;
      let hintShown = false;
      // On a touch device, focusing the hidden input opens the virtual keyboard.
      // A switch triggered by tapping/swiping the tab UI must not do that (it is
      // disruptive), so the input is focused on a switch only with a fine
      // pointer; on touch the user taps the terminal itself to open the keyboard.
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      // Motion opt-out (checked live: the OS setting can change). Gates the
      // interactive swipe/rotation animations, mirroring the CSS .wt-animate gate.
      const prefersReduce = (): boolean =>
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // baseLabel is a tab's label before de-duplication. Preference order: the
      // title derived from the user's first submitted line (best for a chat like
      // kiro-cli, whose OSC 0 title only ever reflects the cwd for a live
      // session), then the process window title (OSC 0/2, e.g. a shell's), then a
      // plain "New tab". fallback=true marks that last case so relabelAll leaves
      // untitled tabs as "New tab" with no numeric suffix.
      function baseLabel(tab: Tab): { text: string; fallback: boolean } {
        const real = tab.derived?.trim() ?? tab.title.trim();
        return real ? { text: real, fallback: false } : { text: "New tab", fallback: true };
      }

      // relabelAll recomputes every tab's display label with de-duplication:
      // when two tabs resolve to the same base label (e.g. two tabs whose first
      // submitted line was identical, or two shells with the same window title),
      // the second and later get a " (k)" suffix in creation order, so the strip
      // never shows two identical labels.
      function relabelAll(): void {
        // Count only real (non-fallback) labels, so multiple untitled tabs all
        // read "New tab" without a numeric suffix.
        const counts = new Map<string, number>();
        for (const t of tabList) {
          const { text, fallback } = baseLabel(t);
          if (!fallback) {
            counts.set(text, (counts.get(text) ?? 0) + 1);
          }
        }
        const seen = new Map<string, number>();
        for (const t of tabList) {
          const { text, fallback } = baseLabel(t);
          let display = text;
          if (!fallback && (counts.get(text) ?? 0) > 1) {
            const k = (seen.get(text) ?? 0) + 1;
            seen.set(text, k);
            if (k > 1) {
              display = `${text} (${String(k)})`;
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

      // syncMobile updates the bottom bar: active label + dot, and the aggregate
      // needs-input cue. The cue rides the active surface: a background tab
      // blocked on input is glanceable, and tapping/swiping opens the list to
      // resolve it (section 12).
      function syncMobile(): void {
        const idx = tabList.findIndex((t) => t.id === activeId);
        const active = idx >= 0 ? tabList[idx] : undefined;
        swLabel.textContent = active ? active.display : "";
        swDot.dataset["status"] = active?.dot.dataset["status"] ?? "idle";
        const bgInput = tabList.some(
          (t) => t.id !== activeId && t.dot.dataset["status"] === "input",
        );
        if (bgInput) {
          swCurrent.dataset["attention"] = "input";
          swCurrent.setAttribute("aria-label", "Terminals; a background terminal needs input");
        } else {
          delete swCurrent.dataset["attention"];
          swCurrent.removeAttribute("aria-label");
        }
      }

      // buildRow creates one expanded-list row for a tab and wires its handlers
      // (select = switch + collapse; x = close). Its dot/label are filled by
      // updateRow. The element is cached in rowEls and reused across renders.
      function buildRow(t: Tab): HTMLElement {
        const row = fromHTML(SWITCHER_ROW_HTML);
        pick(row, ".wt-switcher-row-select").addEventListener("click", () => {
          collapseSwitcher();
          switchTo(t.id);
        });
        pick(row, ".wt-switcher-row-close").addEventListener("click", (e) => {
          e.stopPropagation();
          void close_(t.id);
        });
        return row;
      }
      // updateRow refreshes a reused row's live bits (status dot + label).
      function updateRow(row: HTMLElement, t: Tab): void {
        pick(row, ".wt-switcher-row-dot").dataset["status"] = t.dot.dataset["status"] ?? "idle";
        pick(row, ".wt-switcher-row-label").textContent = t.display;
      }
      // animateRowIn / animateRowOut give a listed tab an enter / leave motion:
      // the row's own max-height grows from 0 (fading in) on add, and collapses
      // to 0 (fading out, then removed) on close. The flex list's height follows
      // the row, so adding/closing a tab animates the tray height rather than
      // snapping. Inline-driven (cleared when done); the caller gates motion.
      const ROW_ANIM_MS = 220;
      const ROW_ANIM_EASE = "cubic-bezier(0.2, 0, 0, 1)";
      function animateRowIn(row: HTMLElement): void {
        const h = row.getBoundingClientRect().height;
        if (h <= 0) {
          return;
        }
        row.style.overflow = "hidden";
        row.style.transition = "none";
        row.style.maxHeight = "0";
        row.style.opacity = "0";
        requestAnimationFrame(() => {
          row.style.transition = `max-height ${String(ROW_ANIM_MS)}ms ${ROW_ANIM_EASE}, opacity ${String(ROW_ANIM_MS)}ms ${ROW_ANIM_EASE}`;
          row.style.maxHeight = `${String(Math.ceil(h))}px`;
          row.style.opacity = "1";
        });
        window.setTimeout(() => {
          row.style.transition = "";
          row.style.maxHeight = "";
          row.style.opacity = "";
          row.style.overflow = "";
        }, ROW_ANIM_MS + 60);
      }
      function animateRowOut(row: HTMLElement): void {
        const h = row.getBoundingClientRect().height;
        row.style.overflow = "hidden";
        row.style.pointerEvents = "none";
        row.style.transition = "none";
        row.style.maxHeight = `${String(Math.ceil(h))}px`;
        row.style.opacity = "1";
        requestAnimationFrame(() => {
          row.style.transition = `max-height ${String(ROW_ANIM_MS)}ms ${ROW_ANIM_EASE}, opacity ${String(ROW_ANIM_MS)}ms ${ROW_ANIM_EASE}`;
          row.style.maxHeight = "0";
          row.style.opacity = "0";
        });
        window.setTimeout(() => {
          row.remove();
        }, ROW_ANIM_MS + 60);
      }

      // renderSwitcherList reconciles the expanded list to a row per OTHER tab
      // (the active tab lives in the bar row), REUSING existing row elements
      // rather than rebuilding, so element identity is stable and the swipe
      // rotation can FLIP the same rows between positions. Order is circular
      // starting AFTER the active tab, so the list reads as the queue that
      // follows the current one (active #k -> k+1, k+2, ... wrapping around); as
      // the active tab changes on a swipe, this order rotates by one.
      function renderSwitcherList(): void {
        const n = tabList.length;
        const activeIdx = tabList.findIndex((t) => t.id === activeId);
        const start = activeIdx >= 0 ? activeIdx : 0;
        const desired: Tab[] = [];
        for (let step = 1; step < n; step++) {
          const t = tabList[(start + step) % n];
          if (t) {
            desired.push(t);
          }
        }
        // Animate an incremental add/close only on an already-open list: NOT
        // during the initial expand (expanded is still false while expandSwitcher
        // populates), NOT during a reel (it owns row motion), NOT under reduced
        // motion — those paths reveal/move rows their own way.
        const anim = expanded && !reelReconcile && !prefersReduce();
        const keep = new Set(desired.map((t) => t.id));
        for (const [id, el] of rowEls) {
          if (!keep.has(id)) {
            rowEls.delete(id);
            if (anim) {
              animateRowOut(el); // collapse + fade, then remove
            } else {
              el.remove();
            }
          }
        }
        // Append in desired order: appendChild moves an existing node, so this
        // both inserts new rows and reorders reused ones into the new sequence.
        for (const t of desired) {
          let row = rowEls.get(t.id);
          const isNew = row === undefined;
          if (!row) {
            row = buildRow(t);
            rowEls.set(t.id, row);
          }
          updateRow(row, t);
          swList.appendChild(row);
          if (isNew && anim) {
            animateRowIn(row); // grow + fade in (the tray height follows)
          }
        }
      }

      // clearRows empties the list and drops the reused-row cache (after a
      // collapse), so the next expand rebuilds fresh rather than reusing rows
      // that might carry a stale reel transform.
      function clearRows(): void {
        endReelNow();
        swList.replaceChildren();
        rowEls.clear();
      }

      // The circular-queue rotation, as a true reel: when a swipe switches the
      // active tab while the list is expanded, every surviving row slides one
      // slot (the rows visibly rotate past a fixed frame), the row that becomes
      // active exits the leading edge, and the row that was active enters the
      // trailing edge. It is a FLIP over reused row elements: prepareReel (run
      // BEFORE syncChrome reconciles the list) snapshots the current row pixel
      // positions and lifts the leaving row out of the flow as an absolute ghost
      // so the reconcile can't reshuffle the survivors; the returned closure
      // (run AFTER the reconcile) inverts every row to its old spot and releases
      // it to the new one, and slides the ghost out. Pixel positions make it
      // correct regardless of the row gap, list padding, or separator border.
      const REEL_MS = 300;
      let reelTimer: ReturnType<typeof setTimeout> | null = null;
      let reelGhost: HTMLElement | null = null;
      // endReelNow settles any in-flight reel immediately: drop the ghost, clear
      // the row transforms, and hand overflow/position back to the stylesheet.
      function endReelNow(): void {
        if (reelTimer !== null) {
          clearTimeout(reelTimer);
          reelTimer = null;
        }
        if (reelGhost) {
          reelGhost.remove();
          reelGhost = null;
        }
        swList.style.overflow = "";
        swList.style.position = "";
        for (const el of rowEls.values()) {
          el.style.transition = "";
          el.style.transform = "";
          el.style.opacity = "";
        }
      }
      // leaving is the tab becoming active (its row exits the list); the entering
      // row (the previously-active tab) is built by the reconcile that runs
      // between prepareReel and the returned closure, so it needs no argument.
      function prepareReel(dir: "next" | "prev", leaving: Tab): (() => void) | undefined {
        const ghost = rowEls.get(leaving.id);
        if (!ghost) {
          return undefined;
        }
        // Capture positions BEFORE settling any in-flight transform, so a live
        // drag preview flows into the reel: each row starts where the finger left
        // it (First includes the preview offset). For a plain flick with no
        // preview, these are simply the rows' rest positions.
        const firstTops = new Map<string, number>();
        for (const [id, el] of rowEls) {
          firstTops.set(id, el.getBoundingClientRect().top);
        }
        const listRect = swList.getBoundingClientRect();
        const st = getComputedStyle(swList);
        const pitch = ghost.getBoundingClientRect().height + (parseFloat(st.rowGap) || 0);
        const top = (firstTops.get(leaving.id) ?? listRect.top) - listRect.top + swList.scrollTop;
        endReelNow(); // settle a prior reel / the drag preview before this one
        // Freeze the frame: clip overflow so rows leaving/entering are masked at
        // the edges, and anchor the leaving row absolutely at its captured spot so
        // the reconcile that follows leaves the survivors where they are.
        swList.style.overflow = "hidden";
        swList.style.position = "relative";
        rowEls.delete(leaving.id); // the reconcile must not touch the ghost
        ghost.style.position = "absolute";
        ghost.style.left = st.paddingLeft;
        ghost.style.right = st.paddingRight;
        ghost.style.top = `${String(Math.round(top))}px`;
        ghost.style.pointerEvents = "none";
        reelGhost = ghost;

        return () => {
          for (const [id, el] of rowEls) {
            const first = firstTops.get(id);
            let from: number;
            if (first !== undefined) {
              from = first - el.getBoundingClientRect().top; // survivor: old spot -> new
            } else {
              from = dir === "next" ? pitch : -pitch; // newcomer: in from the trailing edge
              el.style.opacity = "0";
            }
            el.style.transition = "none";
            el.style.transform = `translateY(${String(Math.round(from))}px)`;
          }
          const exit = dir === "next" ? -pitch : pitch; // leaving row off the leading edge
          requestAnimationFrame(() => {
            const trans = "transform 0.25s cubic-bezier(0.2, 0, 0, 1), opacity 0.2s ease-out";
            for (const el of rowEls.values()) {
              el.style.transition = trans;
              el.style.transform = "translateY(0)";
              el.style.opacity = "";
            }
            ghost.style.transition = trans;
            ghost.style.transform = `translateY(${String(Math.round(exit))}px)`;
            ghost.style.opacity = "0";
          });
          reelTimer = setTimeout(endReelNow, REEL_MS);
        };
      }

      // syncChrome refreshes every surface after any state change. Idempotent.
      function syncChrome(): void {
        relabelAll();
        paintActive();
        syncMobile();
        if (expanded) {
          renderSwitcherList();
        }
        maybeSwipeHint();
      }

      // closeKeyGrid closes the mobile key grid (if a keyboardToggle is wired and
      // open) and resets the switcher's keyboard button state. Used when the tab
      // list expands (the button is hidden then, so the grid must not linger
      // behind it) and when a tap on the terminal dismisses an open grid.
      function closeKeyGrid(): void {
        const kb = opts.keyboardToggle ? ctx.use(opts.keyboardToggle) : undefined;
        if (kb?.isOpen()) {
          kb.toggle();
        }
        swKb.setAttribute("aria-expanded", "false");
        swKb.classList.remove("wt-active");
      }

      // setExpandedState applies the resting expanded/collapsed state: the class
      // that drives the list's max-height (and its padding/border), the aria
      // flag, and (on collapse) the deferred row clear so the rows leave the a11y
      // tree only after the collapse animation. It does not render rows or touch
      // the inline styles the interactive drag uses; expandSwitcher and the drag
      // release own those.
      function setExpandedState(on: boolean): void {
        if (on) {
          if (collapseClearTimer !== null) {
            clearTimeout(collapseClearTimer);
            collapseClearTimer = null;
          }
          expanded = true;
          switcher.classList.add("wt-switcher-expanded");
          swCurrent.setAttribute("aria-expanded", "true");
          // Simplify the crowded bar: close the key grid and hide the keyboard
          // button while the list is open (CSS collapses it and the active row
          // grows to fill). Avoids the grid opening behind the expanded list.
          closeKeyGrid();
        } else {
          expanded = false;
          switcher.classList.remove("wt-switcher-expanded");
          swCurrent.setAttribute("aria-expanded", "false");
          if (collapseClearTimer !== null) {
            clearTimeout(collapseClearTimer);
          }
          collapseClearTimer = setTimeout(() => {
            collapseClearTimer = null;
            if (!expanded) {
              clearRows();
            }
          }, 260);
        }
      }

      // expandSwitcher grows the bar to list the other tabs below the active row
      // (swipe-up / tap). No-op with a single tab (nothing to list). Not modal:
      // it never steals focus (focusing the hidden input on touch would pop the
      // keyboard).
      function expandSwitcher(): void {
        if (expanded || tabList.length < 2) {
          return;
        }
        renderSwitcherList();
        setExpandedState(true);
        ctx.announce("Terminal list expanded");
      }

      // collapseSwitcher shrinks the bar back to just the active row (swipe-down /
      // tap / select).
      function collapseSwitcher(): void {
        if (!expanded) {
          return;
        }
        setExpandedState(false);
      }

      function toggleSwitcher(): void {
        if (expanded) {
          collapseSwitcher();
        } else {
          expandSwitcher();
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
        dot.dataset["status"] = info.status || "idle";
        const aria = tablist.registerTab(el);
        // Insert before the "+" button so it stays the last item in the strip.
        bar.insertBefore(el, newBtn);
        // Runtime-added tabs animate in; initial tabs do not (see `started`).
        // The timer (not animationend) also clears the class on the hidden mobile
        // strip, where the animation never fires.
        if (started) {
          el.classList.add("wt-tab-enter");
          setTimeout(() => {
            el.classList.remove("wt-tab-enter");
          }, 300);
        }

        const tab: Tab = {
          id: info.id,
          title: info.title,
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
        tab.display = baseLabel(tab).text;
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
        // Middle-click closes the tab (#8). Suppress the middle-click default on
        // mousedown so the browser's autoscroll/paste affordance does not fire.
        el.addEventListener("mousedown", (e) => {
          if (e.button === 1) {
            e.preventDefault();
          }
        });
        el.addEventListener("auxclick", (e) => {
          if (e.button === 1) {
            e.preventDefault();
            void close_(tab.id);
          }
        });
        // Right-click opens the tab context menu (desktop). preventDefault stops
        // the browser's own menu; the strip is hidden on a coarse pointer, so
        // this is desktop-only in practice.
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showTabMenu(e.clientX, e.clientY, tab.id);
        });
        // Drag-and-drop reorder on the desktop strip. The bar's dragover moves
        // this element live; dragend commits the new order into tabList.
        el.draggable = true;
        el.addEventListener("dragstart", (e) => {
          draggingEl = el;
          el.classList.add("wt-tab-dragging");
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            // Firefox requires drag data to be set for the drag to start.
            e.dataTransfer.setData("text/plain", tab.id);
          }
          hideTabMenu();
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("wt-tab-dragging");
          draggingEl = null;
          syncOrderFromDom();
        });
        return tab;
      }

      function switchTo(id: string, dir?: "next" | "prev"): void {
        if (id === activeId) {
          return;
        }
        const next = tabList.find((t) => t.id === id);
        if (!next) {
          return;
        }
        // Derive a slide direction from the index delta when the caller did not
        // give one (a desktop tab click, a sheet select): moving to a later tab
        // slides the incoming content in from the right, an earlier tab from the
        // left, so desktop switches feel like the mobile swipe.
        let slide = dir;
        if (slide === undefined && activeId !== null) {
          const from = tabList.findIndex((t) => t.id === activeId);
          const to = tabList.findIndex((t) => t.id === id);
          if (from >= 0 && to >= 0) {
            slide = to > from ? "next" : "prev";
          }
        }
        const surface = ctx.surface();
        // Detach the current tab: save its scroll memory (keep its cache).
        const cur = tabList.find((t) => t.id === activeId);
        if (cur) {
          cur.scrollTop = surface.scrollTop;
          cur.following = !ctx.scroll.isUserScrolledUp();
        }
        // Decide whether to animate the expanded list as a rotation: only a
        // swipe to an adjacent tab while the list is open. prepareReel snapshots
        // the rows BEFORE the reconcile below; the returned closure FLIPs them
        // into their new slots after it.
        const fromIdx = tabList.findIndex((t) => t.id === activeId);
        const toIdx = tabList.findIndex((t) => t.id === next.id);
        // A one-step move: adjacent, OR a wrap between the first and last tab
        // (index gap n-1), since the list rotates infinitely.
        const stepGap = Math.abs(toIdx - fromIdx);
        let playReel: (() => void) | undefined;
        if (
          expanded &&
          !creatingTab &&
          (slide === "next" || slide === "prev") &&
          (stepGap === 1 || stepGap === tabList.length - 1) &&
          !prefersReduce()
        ) {
          playReel = prepareReel(slide, next);
        }
        // Attach the next tab: point the renderer at its cached store and
        // rebuild viewport-first, so the last-known screen paints with no
        // round-trip. Then let the kernel reconnect the WS to it (resume delta).
        activeId = next.id;
        resetInputLine(); // a partial line typed in the old tab does not carry over
        ctx.render.bind(next.store);
        ctx.notifySwitch({ id: next.id });
        armCatchup();
        flashSwitch(slide);
        // Mark the reconcile as reel-driven so renderSwitcherList suppresses its
        // add/remove row animation (the reel owns row motion here).
        reelReconcile = playReel !== undefined;
        syncChrome(); // reconciles the expanded list into the new order
        reelReconcile = false;
        playReel?.(); // FLIP the rows so the reorder reads as a rotation, not a reload
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
        if (!coarse) {
          focusInput(); // desktop only; on touch this would pop the keyboard (#7)
        }
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
      // flashSwitch plays the switch animation the animations feature keys off
      // (a no-op when animations are absent or reduced-motion is set). With a
      // direction the incoming content slides in from that side (the swipe
      // feel); without one it is a plain cross-fade. The rAF re-adds the class a
      // frame after clearing it so a rapid re-switch restarts the animation.
      let switchAnimTimer: ReturnType<typeof setTimeout> | null = null;
      function flashSwitch(dir?: "next" | "prev"): void {
        const surface = ctx.surface();
        const cls = dir ? `wt-switching-${dir}` : "wt-switching";
        surface.classList.remove("wt-switching", "wt-switching-next", "wt-switching-prev");
        if (switchAnimTimer !== null) {
          clearTimeout(switchAnimTimer);
        }
        requestAnimationFrame(() => {
          surface.classList.add(cls);
        });
        switchAnimTimer = setTimeout(() => {
          switchAnimTimer = null;
          surface.classList.remove("wt-switching", "wt-switching-next", "wt-switching-prev");
        }, 360);
      }

      // The first screen frame after a switch is the resume delta landing.
      ctx.on("wire:screen", () => {
        clearCatchup();
      });

      // switchRelative moves delta tabs from the active one (swipe left = next).
      // The direction feeds the slide animation (next slides in from the right,
      // prev from the left).
      function switchRelative(delta: number): void {
        const n = tabList.length;
        if (n < 2) {
          return;
        }
        const idx = tabList.findIndex((t) => t.id === activeId);
        if (idx < 0) {
          return;
        }
        // Wrap around the ends so the list rotates infinitely: swiping past the
        // last tab lands on the first, and past the first on the last.
        const next = tabList[(((idx + delta) % n) + n) % n];
        if (next) {
          switchTo(next.id, delta > 0 ? "next" : "prev");
        }
      }

      // dragTargetBefore returns the first tab whose horizontal midpoint is past
      // x (the element the dragged tab should sit before), or null to drop at the
      // end (before the "+"). syncOrderFromDom rebuilds tabList to match the
      // strip's DOM order after a drag, so position indicators, the switcher, and
      // close-to-the-right/left all follow the visible order.
      function dragTargetBefore(x: number): HTMLElement | null {
        for (const el of bar.querySelectorAll<HTMLElement>(".wt-tab:not(.wt-tab-dragging)")) {
          const rect = el.getBoundingClientRect();
          if (x < rect.left + rect.width / 2) {
            return el;
          }
        }
        return null;
      }
      function syncOrderFromDom(): void {
        const order: Tab[] = [];
        for (const el of bar.querySelectorAll<HTMLElement>(".wt-tab")) {
          const t = tabList.find((x) => x.el === el);
          if (t) {
            order.push(t);
          }
        }
        if (order.length === tabList.length) {
          tabList.length = 0;
          tabList.push(...order);
          syncChrome();
        }
      }

      // adoptSession adds a tab for a session that exists server-side but has no
      // local tab yet, e.g. one created in another browser (the server pushes it
      // over the status SSE, and the poll fallback lists it). This keeps every
      // client's tab set converged on the server, so mobile and desktop never
      // desync. The caller runs syncChrome.
      function adoptSession(info: SessionInfo): void {
        if (tabList.find((t) => t.id === info.id)) {
          return;
        }
        tabList.push(addTabChrome(info));
      }

      async function create(): Promise<void> {
        let info: SessionInfo;
        try {
          info = await apiCreate();
        } catch {
          // A create can still fail transiently (network, server error); tell
          // the user rather than throwing.
          ctx.toast("Couldn't open a terminal");
          return;
        }
        // The status SSE may have adopted this session during the POST round-trip
        // (server broadcasts the new session to all clients); reuse that tab.
        let tab = tabList.find((t) => t.id === info.id);
        if (!tab) {
          tab = addTabChrome(info);
          tabList.push(tab);
        }
        // Suppress the swipe reel for a create: the list should grow and fade the
        // new row in (animateRowIn) rather than rotate. switchTo still slides the
        // terminal content and updates the active chip.
        creatingTab = true;
        switchTo(tab.id);
        creatingTab = false;
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
        // Closing the only remaining tab: spawn its replacement BEFORE removing
        // this one, so the strip never empties and the "+" never teleports to the
        // far left (then jumps back) while the create POST is in flight. create()
        // adds the new tab before the "+" and switches to it; dropping the old
        // one is then an ordinary non-last close (length > 1, so this intercept
        // does not re-fire -> no unbounded recursion). remote-only (a user
        // close). If create() fails it adds nothing (and toasts), so keep the
        // existing tab rather than stranding the user on an empty strip.
        if (remote && tabList.length === 1 && tabList[0]?.id === id) {
          await create();
          // Drop the old tab only if a replacement actually landed (create()
          // adds nothing and toasts on failure); otherwise keep the existing tab
          // rather than stranding the user on an empty strip. The replacement is
          // a different session, so dropping the old one is a non-last close and
          // this intercept does not re-fire.
          if (tabList.some((t) => t.id !== id)) {
            await dropTab(id, true);
          }
          return;
        }
        const [tab] = tabList.splice(idx, 1);
        if (!tab) {
          return;
        }
        tab.aria.remove();
        // Remove immediately (no exit animation): a lingering element made the
        // "+" teleport after a delay, and made a last-tab replacement appear in
        // the second slot before shifting left. The strip reflows in one frame.
        tab.el.remove();
        ctx.dropSession(id);
        // If this close empties the expanded list (only one tab remains),
        // collapse the switcher FIRST so the whole tray animates shut with the
        // last row still in it — otherwise it sits open-but-empty with the
        // separator shown and the keyboard button hidden. Collapsing flips
        // `expanded` off, so the syncChrome (and any re-home switchTo) below skip
        // the list reconcile and leave the row for the collapse to sweep away
        // (clearRows runs after the collapse transition).
        if (expanded && tabList.length < 2) {
          collapseSwitcher();
        }
        syncChrome(); // reflect the drop immediately (count, position)
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

      // closeMany closes a set of tabs at once. Each tab is a running agent, so
      // it confirms when closing two or more. It removes their chrome + cache,
      // re-homes the active tab to a survivor if it was among them, DELETEs each
      // server session, and guarantees at least one terminal stays open (a fresh
      // one is spawned only when every tab was closed). closeAll / closeOthers /
      // closeToRight / closeToLeft are thin wrappers that pick the id set.
      async function closeMany(ids: readonly string[]): Promise<void> {
        const victims = tabList.filter((t) => ids.includes(t.id));
        if (victims.length === 0) {
          return;
        }
        if (victims.length >= 2 && !window.confirm(`Close ${String(victims.length)} terminals?`)) {
          return;
        }
        const closingActive = activeId !== null && ids.includes(activeId);
        for (const t of victims) {
          const idx = tabList.indexOf(t);
          if (idx >= 0) {
            tabList.splice(idx, 1);
          }
          t.aria.remove();
          t.el.remove();
          ctx.dropSession(t.id);
        }
        // Re-home the live view before the DELETEs: if the active tab was closed,
        // attach a survivor; otherwise just refresh the chrome.
        if (closingActive) {
          activeId = null;
          const survivor = tabList[0];
          if (survivor) {
            switchTo(survivor.id);
          } else {
            syncChrome();
          }
        } else {
          syncChrome();
        }
        for (const t of victims) {
          await apiClose(t.id);
        }
        if (tabList.length === 0) {
          await create(); // there is always at least one terminal open
        }
      }

      function closeOthers(id: string): Promise<void> {
        return closeMany(tabList.filter((t) => t.id !== id).map((t) => t.id));
      }
      function closeToRight(id: string): Promise<void> {
        const idx = tabList.findIndex((t) => t.id === id);
        return idx < 0 ? Promise.resolve() : closeMany(tabList.slice(idx + 1).map((t) => t.id));
      }
      function closeToLeft(id: string): Promise<void> {
        const idx = tabList.findIndex((t) => t.id === id);
        return idx < 0 ? Promise.resolve() : closeMany(tabList.slice(0, idx).map((t) => t.id));
      }
      // closeAll closes every tab and leaves one fresh terminal (closeMany
      // confirms since it is destructive).
      function closeAll(): Promise<void> {
        return closeMany(tabList.map((t) => t.id));
      }

      // hideTabMenu / showTabMenu drive the right-click menu. showTabMenu rebuilds
      // the items for the target tab (disabled states reflect its position) and
      // clamps into the visible viewport, flipping above the pointer near the
      // bottom edge (mirrors context-menu.ts).
      function hideTabMenu(): void {
        tabMenu.classList.remove("visible");
        tabMenu.replaceChildren();
      }
      function tabMenuItem(label: string, disabled: boolean, run: () => void): void {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "menuitem");
        b.textContent = label;
        if (disabled) {
          b.disabled = true;
        } else {
          b.addEventListener("click", () => {
            hideTabMenu();
            run();
          });
        }
        tabMenu.appendChild(b);
      }
      function showTabMenu(x: number, y: number, id: string): void {
        hideTabMenu();
        const idx = tabList.findIndex((t) => t.id === id);
        if (idx < 0) {
          return;
        }
        const n = tabList.length;
        tabMenuItem("Close", false, () => {
          void close_(id);
        });
        tabMenuItem("Close others", n <= 1, () => {
          void closeOthers(id);
        });
        tabMenuItem("Close to the right", idx >= n - 1, () => {
          void closeToRight(id);
        });
        tabMenuItem("Close to the left", idx <= 0, () => {
          void closeToLeft(id);
        });
        tabMenuItem("Close all", false, () => {
          void closeAll();
        });
        // Make visible (so it has measurable size), then clamp within the visible
        // viewport; position:fixed means x/y are viewport coordinates, and the
        // visual viewport (when present) excludes the on-screen keyboard.
        tabMenu.classList.add("visible");
        const vv = window.visualViewport;
        const viewLeft = vv ? vv.offsetLeft : 0;
        const viewTop = vv ? vv.offsetTop : 0;
        const viewWidth = vv ? vv.width : window.innerWidth;
        const viewHeight = vv ? vv.height : window.innerHeight;
        const menuW = tabMenu.offsetWidth;
        const menuH = tabMenu.offsetHeight;
        const left = Math.max(
          viewLeft + TAB_MENU_EDGE,
          Math.min(x, viewLeft + viewWidth - menuW - TAB_MENU_EDGE),
        );
        let top = y;
        if (y + menuH + TAB_MENU_EDGE > viewTop + viewHeight) {
          top = y - menuH - TAB_MENU_GAP;
        }
        top = Math.max(
          viewTop + TAB_MENU_EDGE,
          Math.min(top, viewTop + viewHeight - menuH - TAB_MENU_EDGE),
        );
        tabMenu.style.left = `${String(left)}px`;
        tabMenu.style.top = `${String(top)}px`;
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
        ctx.toast("Swipe to switch terminals");
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
          // Adopt a session created in another browser so all clients converge.
          adoptSession({ id: s.id, title: s.title, createdAt: s.createdAt, status: s.status });
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
            adoptSession(info); // add sessions created elsewhere (no local tab)
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
      // Live reorder while dragging a tab over the strip (dragend commits it).
      bar.addEventListener("dragover", (e) => {
        if (!draggingEl) {
          return;
        }
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "move";
        }
        bar.insertBefore(draggingEl, dragTargetBefore(e.clientX) ?? newBtn);
      });
      // Keyboard button: open/close the key grid above the bar. The toolbar API
      // is read lazily (ctx.use) so feature ordering does not matter; the button
      // is hidden unless a keyboardToggle was provided (set above).
      swKb.addEventListener("click", () => {
        const kb = opts.keyboardToggle ? ctx.use(opts.keyboardToggle) : undefined;
        if (!kb) {
          return;
        }
        kb.toggle();
        const open = kb.isOpen();
        swKb.setAttribute("aria-expanded", String(open));
        swKb.classList.toggle("wt-active", open);
      });
      // Mobile "+": spawn a terminal (mirrors the desktop strip's newBtn).
      swNew.addEventListener("click", () => {
        void create();
      });
      // Active-row close (x): closes the current tab (mirrors a listed row's x).
      // stopPropagation so it is not read as a tap/swipe on the row surface.
      swClose.addEventListener("click", (e) => {
        e.stopPropagation();
        if (activeId !== null) {
          void close_(activeId);
        }
      });
      // Dismiss the tab context menu on an outside click, on Escape, and on
      // scroll (it is anchored to a viewport point, so a scroll would detach it).
      const onDocClickMenu = (): void => {
        hideTabMenu();
      };
      document.addEventListener("click", onDocClickMenu);
      // A right-click anywhere other than a tab (the terminal content, elsewhere,
      // or a native browser menu) dismisses the tab menu. A right-click ON a tab
      // is handled by that tab's own contextmenu handler (which reopens it), and
      // fires before this one, so the menu is not immediately re-hidden.
      const onDocContextMenu = (e: MouseEvent): void => {
        if (!(e.target as HTMLElement).closest(".wt-tab")) {
          hideTabMenu();
        }
      };
      document.addEventListener("contextmenu", onDocContextMenu);
      const onScrollMenu = (): void => {
        hideTabMenu();
      };
      window.addEventListener("scroll", onScrollMenu, true);
      const offMenuKey = ctx.registerKeydown((ev) => {
        if (ev.key === "Escape" && tabMenu.classList.contains("visible")) {
          ev.preventDefault();
          hideTabMenu();
          return true;
        }
        return false;
      });
      // A tap on the terminal/background dismisses an open mobile overlay — the
      // expanded tab list or the key grid — rather than opening the keyboard, so
      // tap 1 closes and tap 2 opens the keyboard. Runs in the capture phase and
      // stops propagation, so the kernel's surface tap-to-focus never fires for
      // the dismissing tap. Taps inside the switcher or the key grid are left to
      // their own controls; when nothing is open the tap falls through untouched.
      const onDocTapDismiss = (e: PointerEvent): void => {
        const kb = opts.keyboardToggle ? ctx.use(opts.keyboardToggle) : undefined;
        const gridOpen = kb?.isOpen() ?? false;
        if (!expanded && !gridOpen) {
          return;
        }
        const target = e.target as HTMLElement | null;
        const inChrome =
          target !== null &&
          (target.closest(".wt-switcher") !== null || target.closest(".key-toolbar") !== null);
        if (inChrome) {
          return;
        }
        if (expanded) {
          collapseSwitcher();
        } else {
          closeKeyGrid();
        }
        e.stopPropagation();
      };
      document.addEventListener("pointerup", onDocTapDismiss, true);

      // Interactive drag on the bar (mobile). The gesture follows the finger
      // live rather than only acting on release: after a small axis-lock move it
      // commits to horizontal (slide the terminal content to preview a tab
      // switch) or vertical (grow/shrink the tab list under the bar). On release
      // it snaps: a horizontal drag past a quarter-width commits the switch (else
      // springs back); a vertical drag past the halfway point snaps the list open
      // (else closed). A near-stationary release is a tap that toggles the list
      // (the click listener). swCurrent has touch-action:none so these drags
      // never scroll the page, and the pointer is captured so a drag that leaves
      // the bar still delivers its move/up here.
      let gDownX = 0;
      let gDownY = 0;
      let gAxis: "h" | "v" | null = null;
      let gActive = false;
      let gStartMax = 0; // list max-height (px) when a vertical drag began
      let gTargetMax = 0; // fully-open list height (px) for the current drag
      let swiped = false; // a drag was handled; the trailing click must not also toggle
      let gPointerId = -1; // the pointer that owns the drag; stray fingers are ignored
      let gDownT = 0; // pointerdown timestamp, for the flick duration test
      let gVX = 0; // last-sample velocity (px/ms) horizontal
      let gVY = 0; // last-sample velocity (px/ms) vertical
      let gLastX = 0;
      let gLastY = 0;
      let gLastT = 0; // time of the last pointermove sample (for the stale-velocity guard)
      // Owns the window-level move/end listeners for the current drag. They catch
      // the gesture wherever the finger goes and however it ends, so the state
      // machine can never be stranded (gActive stuck true) by a pointerup that
      // missed swCurrent — the case that bricked swiping until a reload.
      let gestureAbort: AbortController | null = null;

      // The row content follows the finger during a horizontal drag (the active
      // tab area physically swiping). The terminal content is NOT dragged: the
      // old finger-following content translate read as a few-pixel snap, so the
      // commit instead lets switchTo slide the incoming terminal in from the side.
      function beginHorizontal(): void {
        for (const el of swipeEls) {
          el.style.transition = "none"; // track the finger 1:1
        }
        // Preview the list rotation live during the drag when the list is open,
        // so it nudges with the finger instead of only moving on release (see
        // moveHorizontal). The rows translate as a group (clipped by the list,
        // whose box/border stay put); the release reel continues from there.
        dragActive = expanded && tabList.length >= 2 && !prefersReduce();
        if (!dragActive) {
          return;
        }
        endReelNow(); // cancel any settling reel/spring before previewing
        swList.style.overflow = "hidden";
        swList.style.position = "relative";
      }
      function moveHorizontal(dx: number): void {
        // The active-tab chip (dot + label + close) follows the finger 1:1. No
        // rubber-band: the list is circular, so there is no end to resist.
        const tx = `translateX(${String(Math.round(dx))}px)`;
        for (const el of swipeEls) {
          el.style.transform = tx;
        }
        if (!dragActive) {
          return;
        }
        // Peek the list a few pixels in the swipe direction — a hint of the
        // coming rotation, not the full shift (the incoming row only appears on
        // release, so a large move read wrong). Drag left (dx < 0, next) nudges
        // rows up; drag right (prev) nudges them down. The release reel continues
        // from this offset.
        const p = Math.max(-PREVIEW_PEEK_MAX, Math.min(PREVIEW_PEEK_MAX, dx * PREVIEW_DRAG_RATIO));
        for (const el of rowEls.values()) {
          el.style.transition = "none";
          el.style.transform = `translateY(${String(Math.round(p))}px)`;
        }
      }
      // springRowsBack eases the previewed rows back to rest when a drag is
      // released without committing, then hands overflow/position back to CSS.
      function springRowsBack(): void {
        const rows = [...rowEls.values()];
        requestAnimationFrame(() => {
          for (const el of rows) {
            el.style.transition = "transform 0.2s ease-out";
            el.style.transform = "translateY(0)";
          }
        });
        if (reelTimer !== null) {
          clearTimeout(reelTimer);
        }
        reelTimer = setTimeout(endReelNow, 220);
      }
      function endHorizontal(dx: number, releaseT: number, canceled: boolean): void {
        const width = ctx.surface().clientWidth || window.innerWidth;
        const dir = dx < 0 ? 1 : -1;
        // Commit on a flick (quick + fast + far enough) or once dragged past a
        // quarter width; a cancel/capture-loss never commits (springs back). The
        // list is circular, so any switch has a target: ≥2 tabs is the only gate.
        const paused = releaseT - gLastT > VELOCITY_STALE_MS;
        const vx = paused ? 0 : Math.abs(gVX);
        const flick =
          releaseT - gDownT < SWIPE_DURATION && vx > SWIPE_VELOCITY && Math.abs(dx) > SWIPE_MIN_PX;
        const commit = !canceled && (flick || Math.abs(dx) >= width * 0.25) && tabList.length >= 2;
        const wasDrag = dragActive;
        dragActive = false;
        if (!commit) {
          if (wasDrag) {
            springRowsBack(); // ease the previewed rows back to rest
          }
          const spring = prefersReduce() ? "" : "transform 0.2s ease-out";
          for (const el of swipeEls) {
            el.style.transition = spring;
            el.style.transform = "";
          }
          window.setTimeout(() => {
            for (const el of swipeEls) {
              el.style.transition = "";
            }
          }, 220);
          return;
        }
        // Commit: switchTo slides the incoming terminal in from the side and (when
        // the list is open) runs the reel, which continues from wherever the drag
        // preview left the rows. switchRelative wraps around the ends.
        switchRelative(dir);
        if (prefersReduce()) {
          for (const el of swipeEls) {
            el.style.transition = "";
            el.style.transform = "";
          }
          return;
        }
        // Slide the whole active-tab chip in from the swipe side (next from the
        // right, prev from the left), every part by the SAME pixel distance so
        // the close stays locked to the dot + label (a per-element % would move
        // the narrow close less than the wide label).
        const slide = (swInner.getBoundingClientRect().width || width) * dir;
        for (const el of swipeEls) {
          el.style.transition = "none";
          el.style.transform = `translateX(${String(Math.round(slide))}px)`;
        }
        requestAnimationFrame(() => {
          for (const el of swipeEls) {
            el.style.transition = "transform 0.25s cubic-bezier(0.2, 0, 0, 1)";
            el.style.transform = "translateX(0)";
          }
        });
        window.setTimeout(() => {
          for (const el of swipeEls) {
            el.style.transition = "";
            el.style.transform = "";
          }
        }, 320);
      }

      function beginVertical(): void {
        if (tabList.length < 2 && !expanded) {
          gTargetMax = 0; // nothing to reveal; the vertical drag is inert
          return;
        }
        if (!expanded) {
          renderSwitcherList();
        }
        // Apply the expanded styling (padding/border) so the reveal matches the
        // settled look, but drive the height with inline max-height (transition
        // off, clipping instead of auto-scroll) so it tracks the finger 1:1.
        switcher.classList.add("wt-switcher-expanded");
        swList.style.transition = "none";
        swList.style.overflowY = "hidden";
        gTargetMax = Math.min(swList.scrollHeight, Math.round(window.innerHeight * 0.5));
        gStartMax = expanded ? gTargetMax : 0;
        swList.style.maxHeight = `${String(gStartMax)}px`;
      }
      function moveVertical(dy: number): void {
        if (gTargetMax <= 0) {
          return;
        }
        // Drag up (dy < 0) grows the list; drag down shrinks it.
        const next = Math.max(0, Math.min(gTargetMax, gStartMax - dy));
        swList.style.maxHeight = `${String(next)}px`;
      }
      function endVertical(dy: number, releaseT: number, canceled: boolean): void {
        if (gTargetMax <= 0) {
          return;
        }
        const current = Math.max(0, Math.min(gTargetMax, gStartMax - dy));
        // A quick flick opens (drag up) or closes (drag down) regardless of how
        // far it got; otherwise snap to whichever state is nearer. A cancel snaps
        // to the nearer state (no flick).
        const paused = releaseT - gLastT > VELOCITY_STALE_MS;
        const vy = paused ? 0 : Math.abs(gVY);
        const flick =
          !canceled &&
          releaseT - gDownT < SWIPE_DURATION &&
          vy > SWIPE_VELOCITY &&
          Math.abs(dy) > SWIPE_MIN_PX;
        const open = flick ? dy < 0 : current >= gTargetMax / 2;
        // Hand height back to the class (transition restored) so it snaps to the
        // settled state from wherever the finger left it.
        swList.style.transition = "";
        swList.style.overflowY = "";
        swList.style.maxHeight = "";
        if (open) {
          setExpandedState(true);
          ctx.announce("Terminal list expanded");
        } else {
          setExpandedState(false);
        }
      }

      const endGesture = (e: PointerEvent, canceled: boolean): void => {
        if (!gActive || e.pointerId !== gPointerId) {
          return;
        }
        gActive = false;
        const dx = e.clientX - gDownX;
        const dy = e.clientY - gDownY;
        if (gAxis === "h") {
          endHorizontal(dx, e.timeStamp, canceled);
        } else if (gAxis === "v") {
          endVertical(dy, e.timeStamp, canceled);
        } else if (
          !canceled &&
          Math.abs(dx) >= SWIPE_MIN_PX &&
          Math.abs(dx) > Math.abs(dy) * 1.5 &&
          modes.getMouseMode() === 0
        ) {
          // No pointermove locked an axis (a flick with no intermediate move, or
          // a synthetic down/up): fall back to a discrete switch from the net
          // delta so the gesture still resolves.
          swiped = true;
          switchRelative(dx < 0 ? 1 : -1);
        } else if (!canceled && Math.abs(dy) >= SWIPE_MIN_PX && Math.abs(dy) > Math.abs(dx) * 1.5) {
          swiped = true;
          if (dy < 0) {
            expandSwitcher();
          } else {
            collapseSwitcher();
          }
        }
        gAxis = null;
        // The gesture is over: drop the window move/end listeners for it.
        gestureAbort?.abort();
        gestureAbort = null;
      };

      // The move handler runs on WINDOW (attached for the gesture's life on
      // pointerdown), so the drag is tracked wherever the finger goes — even if
      // setPointerCapture failed or the finger left the thin bar. With capture,
      // the events also bubble here; without it, this is the only path.
      function onGestureMove(e: PointerEvent): void {
        if (!gActive || e.pointerId !== gPointerId) {
          return;
        }
        // Track last-sample velocity for the flick test on release; guard
        // dt === 0 (high-refresh / coalesced events) against divide-by-zero.
        const dt = e.timeStamp - gLastT;
        if (dt > 0) {
          gVX = (e.clientX - gLastX) / dt;
          gVY = (e.clientY - gLastY) / dt;
          gLastX = e.clientX;
          gLastY = e.clientY;
          gLastT = e.timeStamp;
        }
        const dx = e.clientX - gDownX;
        const dy = e.clientY - gDownY;
        if (gAxis === null) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) {
            return;
          }
          if (Math.abs(dx) > Math.abs(dy)) {
            // Horizontal switch preview, unless a mouse-mode app is capturing
            // drags (leave the bar swipe inert then, matching the old gate).
            if (modes.getMouseMode() !== 0) {
              gActive = false;
              swiped = true;
              gestureAbort?.abort(); // gesture abandoned; drop the window listeners
              gestureAbort = null;
              return;
            }
            gAxis = "h";
            swiped = true;
            beginHorizontal();
          } else {
            gAxis = "v";
            swiped = true;
            beginVertical();
          }
        }
        if (gAxis === "h") {
          moveHorizontal(dx);
        } else {
          moveVertical(dy);
        }
      }
      const endOnUp = (e: PointerEvent): void => {
        endGesture(e, false);
      };
      const endOnCancel = (e: PointerEvent): void => {
        endGesture(e, true);
      };

      swCurrent.addEventListener(
        "pointerdown",
        (e) => {
          if (gActive) {
            return; // a drag already owns a pointer; ignore a second finger
          }
          gDownX = e.clientX;
          gDownY = e.clientY;
          gDownT = e.timeStamp;
          gLastX = e.clientX;
          gLastY = e.clientY;
          gLastT = e.timeStamp;
          gVX = 0;
          gVY = 0;
          gPointerId = e.pointerId;
          gAxis = null;
          gActive = true;
          swiped = false;
          try {
            swCurrent.setPointerCapture(e.pointerId);
          } catch {
            /* capture unavailable; the window listeners below track it anyway */
          }
          // Own the move/end on WINDOW for this gesture, so it always resolves —
          // wherever the finger goes and however it lifts. Relying only on
          // swCurrent (via pointer capture) stranded gActive=true forever when
          // capture failed and the release landed on another element, bricking
          // all future swipes until reload. Torn down in endGesture.
          gestureAbort?.abort();
          gestureAbort = new AbortController();
          const opts = { passive: true, signal: gestureAbort.signal };
          window.addEventListener("pointermove", onGestureMove, opts);
          window.addEventListener("pointerup", endOnUp, opts);
          window.addEventListener("pointercancel", endOnCancel, opts);
        },
        { passive: true },
      );
      // If the browser revokes pointer capture mid-drag (device change, system
      // interruption), end the gesture cleanly as an abort rather than leaving it
      // stuck — the safety net a hand-rolled drag usually misses. After a normal
      // pointerup this fires too, but gActive is already false so it no-ops.
      swCurrent.addEventListener(
        "lostpointercapture",
        (e) => {
          endGesture(e, true);
        },
        { passive: true },
      );
      swCurrent.addEventListener("click", () => {
        if (swiped) {
          swiped = false; // consumed by a drag; do not also toggle
          return;
        }
        toggleSwitcher();
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
      // Adopt (dedup) rather than blindly push. The status SSE pushes a snapshot
      // of the existing sessions on open, and tabs subscribes (monitor.onStatus)
      // BEFORE this list resolves, so a session may already have a tab by the
      // time the list lands. A straight push doubled every already-adopted
      // session (6 tabs from 3 across a fresh load), and paintActive then lit
      // both copies of the active id ("2 active tabs" that move together).
      for (const info of sessions) {
        adoptSession(info);
      }
      // From here on, tabs added at runtime (create / adopt) animate in.
      started = true;
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
          offArmed?.();
          offMenuKey();
          document.removeEventListener("click", onDocClickMenu);
          document.removeEventListener("contextmenu", onDocContextMenu);
          document.removeEventListener("pointerup", onDocTapDismiss, true);
          window.removeEventListener("scroll", onScrollMenu, true);
          if (pollTimer !== null) {
            clearInterval(pollTimer);
          }
          barResize.disconnect();
          swReserve.disconnect();
          surface.classList.remove("wt-with-tabbar");
          document.documentElement.style.removeProperty("--wt-tabbar-h");
          root?.classList.remove("wt-tabbed");
          document.documentElement.style.removeProperty("--wt-reserve-bottom");
          if (switchAnimTimer !== null) {
            clearTimeout(switchAnimTimer);
          }
          if (collapseClearTimer !== null) {
            clearTimeout(collapseClearTimer);
          }
          endReelNow();
          gestureAbort?.abort(); // drop any in-flight gesture's window listeners
          clearCatchup();
          hideTabMenu();
          for (const t of tabList) {
            t.aria.remove();
            t.el.remove();
          }
          tabList.length = 0;
          rowEls.clear();
          bar.remove();
          newBtn.remove();
          tabMenu.remove();
          switcher.remove();
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
