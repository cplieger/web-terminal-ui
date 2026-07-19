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
import type { SessionRef, TerminalContext, TerminalFeature } from "../../kernel/types.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
import type { MobileToolbarApi } from "../mobile-toolbar.js";
import { fromHTML } from "../dom.js";
import { placeMenuAt } from "../menu-position.js";
import type { SessionInfo, Tab } from "./model.js";
import {
  ACTIVE_TAB_KEY,
  STATUS_EXITED,
  SWIPE_HINT_KEY,
  baseLabel,
  createInputTitleDeriver,
  createSessionAPI,
  createTombstones,
} from "./model.js";
import {
  TAB_HTML,
  kbButtonHTML,
  newButtonHTML,
  paintStatusDot,
  pick,
  switchButtonHTML,
} from "./strip.js";
import {
  AXIS_LOCK_PX,
  PREVIEW_DRAG_RATIO,
  PREVIEW_PEEK_MAX,
  SWIPE_DURATION,
  SWIPE_MIN_PX,
  SWIPE_VELOCITY,
  SWITCHER_HTML,
  SWITCHER_ROW_HTML,
  VELOCITY_STALE_MS,
  animateRowIn,
  animateRowOut,
} from "./switcher.js";

const DEFAULT_API_BASE = "/api/sessions";
// The mobile bottom-switcher (a single full-width active-tab chip + swipe) is
// used ONLY on a narrow coarse-pointer device (a phone — in EITHER
// orientation: a landscape phone is wide but short, and the kernel's narrow
// fact covers both). A big touchscreen (an iPad) and every fine-pointer device
// (a desktop, or an iPad with a trackpad / Magic Keyboard) get the multi-tab
// top strip instead — the switcher's single-giant-tab layout wastes a big
// screen (an iPad was getting the phone UI). The narrow half of that fact is
// the kernel's .wt-narrow root class / ctx.layout().narrow (kernel-owned
// breakpoint constants, root-size driven); CSS pairs it with
// (pointer: coarse) where touch matters.
// Default cadence for the no-activityMonitor polling fallback.
const DEFAULT_POLL_MS = 4000;
// Tab context-menu viewport clamping + the flip-above-the-pointer gap live in
// the shared point-anchored positioner (menu-position.ts), shared with the
// terminal context menu (formerly two hand-synced copies of the same math).

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
  /** Prefer the input-derived title over the process OSC 0/2 title. Default
   *  false (OSC-first: a program that sets its own window title wins, else the
   *  last submitted line). Set true for an agent shell whose program emits a
   *  non-empty but useless OSC title (kiro-cli under web-terminal-kiro): the label then
   *  follows the latest submitted line (live) or the persisted client title (on
   *  reload), and the unreliable OSC title is ignored entirely. presetAgentTabbed
   *  enables this. */
  preferInputTitle?: boolean;
}

// looksLikeHardwareKey reports whether a keydown could only have come from a
// PHYSICAL keyboard on a touch device. There is no web API that directly says "a
// hardware keyboard is attached" (navigator.keyboard is layout/lock only and
// unsupported on iOS Safari; navigator.virtualKeyboard is Chromium-only), so we
// infer it: the iOS on-screen keyboard has no modifier keys and no
// arrows/Escape/Tab/nav/function keys, so any of these means real hardware. Used
// to latch a "physical keyboard present" flag that also covers a keyboard-only
// Smart Keyboard Folio (which, unlike a Magic Keyboard, adds no trackpad and so
// does not match `any-pointer: fine`).
function looksLikeHardwareKey(ev: KeyboardEvent): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) {
    return true;
  }
  switch (ev.key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
    case "Escape":
    case "Tab":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
      return true;
    default:
      return /^F\d{1,2}$/.test(ev.key); // F1–F12
  }
}

export function tabs(opts: TabsOptions = {}): TerminalFeature<TabsApi> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const preferInputTitle = opts.preferInputTitle ?? false;
  // The session REST client (model.ts): every call timeout-bounded, list
  // shape-guarded, title persistence fire-and-forget.
  const api = createSessionAPI(apiBase);

  // tabs owns session selection. The static sessionOwner registration tells
  // the kernel not to open a bare /ws at startup (which a SessionManager would
  // 404 for lack of ?session=); the kernel instead awaits
  // resolveInitialSession() once setup completes and performs the first switch
  // itself. The registration must exist on the feature VALUE (read before
  // setup), while the bootstrap needs setup-scoped state — so it delegates to
  // a closure setup() wires. resolveImpl is nulled on teardown.
  let resolveImpl: (() => Promise<SessionRef | null>) | null = null;
  return {
    name: "tabs",
    sessionOwner: {
      resolveInitialSession: () => (resolveImpl ? resolveImpl() : Promise.resolve(null)),
    },
    // Synchronous setup: the chrome mounts immediately; the async session
    // bootstrap that used to live here is the kernel-driven resolver above.
    setup(ctx: TerminalContext) {
      const tablist = ctx.tablist();
      const monitor = opts.activityMonitor ? ctx.use(opts.activityMonitor) : undefined;

      // The keyboard buttons wired to the key grid — the mobile switcher's and
      // the desktop strip's — built + wired by the ONE makeKbButton factory;
      // closeKeyGrid and the sticky-Ctrl armed reflect update every one.
      const kbButtons: HTMLElement[] = [];
      // makeNewButton / makeKbButton are the shared control factories (goals 2 &
      // 3): one "+" and one keyboard-button implementation, each built + wired
      // once and reused for the desktop strip and the mobile switcher. The "+"
      // spawns a terminal; the keyboard button toggles the key grid (via the
      // keyboardToggle feature, read lazily so feature ordering does not matter)
      // and reflects its open state on every keyboard button.
      function makeNewButton(cls: string): HTMLElement {
        const btn = fromHTML(newButtonHTML(cls));
        // Keep the hidden terminal textarea focused: a bar button needs no focus
        // of its own, and letting the tap shift focus makes iOS/iPadOS consume
        // the FIRST tap to blur the input (so "+" only fired create on the second
        // tap — the reported double-tap). preventDefault on pointerdown fires the
        // action on the first tap; switchTo then re-focuses the input for the new
        // tab on a physical-keyboard device.
        btn.addEventListener("pointerdown", (e) => {
          e.preventDefault();
        });
        btn.addEventListener("click", () => {
          void create();
        });
        return btn;
      }
      function makeKbButton(cls: string): HTMLElement {
        const btn = fromHTML(kbButtonHTML(cls));
        // First-tap focus retention (see makeNewButton): keep the terminal
        // textarea focused so the toggle fires on the first tap on iOS/iPadOS.
        btn.addEventListener("pointerdown", (e) => {
          e.preventDefault();
        });
        btn.addEventListener("click", () => {
          const kb = opts.keyboardToggle ? ctx.use(opts.keyboardToggle) : undefined;
          if (!kb) {
            return;
          }
          kb.toggle();
          const open = kb.isOpen();
          for (const b of kbButtons) {
            b.setAttribute("aria-expanded", String(open));
            b.classList.toggle("wt-active", open);
          }
        });
        kbButtons.push(btn);
        return btn;
      }
      // makeSwitchButton builds the mobile switcher's dedicated open/close
      // button (its notification dot is painted by paintSwitchDot). Like the
      // other bar buttons it preventDefaults pointerdown for first-tap focus
      // retention (keeps the terminal textarea focused so it fires on the first
      // tap on iOS/iPadOS); its click toggles the list (toggleSwitcher opens when
      // collapsed, closes when expanded).
      function makeSwitchButton(): HTMLElement {
        const btn = fromHTML(switchButtonHTML("wt-switcher-switch wt-btn"));
        btn.addEventListener("pointerdown", (e) => {
          e.preventDefault();
        });
        btn.addEventListener("click", () => {
          toggleSwitcher();
        });
        return btn;
      }

      // --- Desktop tab strip (top-bar region) ---
      // Two layers: the bar itself never scrolls; an inner scroller
      // (.wt-tab-scroll, the tablist) holds the tabs plus the "+", which floats
      // right of the tab list and scrolls WITH it when many tabs overflow. The
      // keyboard button sits OUTSIDE the scroller as the bar's last flex item,
      // pinned at the bar's right edge in the scroll-to-bottom button's column
      // (an overflowing tab list can never push or scroll it away). On a fine
      // pointer it is display:none (CSS), and the scroller stretches to the
      // full bar width so the tabs reclaim that space. Both controls are built
      // + wired by the same shared factories as the mobile switcher's; the kb
      // button is CSS-gated to a wide touchscreen and un-hidden below only when
      // a keyboardToggle is wired. addTabChrome inserts each tab before newBtn,
      // keeping the scroller [tabs… +].
      const slot = ctx.region("top-bar", "tabs");
      const bar = document.createElement("div");
      bar.className = "wt-tab-bar";
      slot.appendChild(bar);
      const scroller = document.createElement("div");
      scroller.className = "wt-tab-scroll";
      scroller.setAttribute("role", "tablist");
      bar.appendChild(scroller);
      const newBtn = makeNewButton("wt-tab-new");
      scroller.appendChild(newBtn);
      const deskKb = makeKbButton("wt-tab-kb wt-btn");
      bar.appendChild(deskKb);

      // Pull the terminal surface up off the docked BOTTOM strip on desktop so
      // the bar does not overlap the last rows. The surface is absolute
      // inset:0, so a bottom offset (gated to a fine pointer / non-narrow root
      // in CSS, since the strip is hidden on the narrow-coarse phone where the
      // mobile switcher applies its own inset) clears it. A ResizeObserver
      // keeps the offset in step with the real strip height rather than a
      // hard-coded guess. The measured height is published on the terminal
      // ROOT (not the surface): the scroll-to-bottom button sits in a sibling
      // region, not inside .term, so a property set on .term would not inherit
      // to it and it would fall back to the 44px guess and overlap the strip.
      // Both .term and the button inherit it from .wt-root — and the host page
      // never sees it.
      const surface = ctx.surface();
      surface.classList.add("wt-with-tabbar");
      const varRoot = surface.parentElement ?? surface;
      const barResize = new ResizeObserver(() => {
        varRoot.style.setProperty("--wt-tabbar-h", `${String(bar.offsetHeight)}px`);
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
      // The mobile "+", keyboard, and switcher buttons: built + wired by the
      // SAME shared factories as the desktop strip's, then appended to the bar
      // row so the order stays current-wrap | keyboard | switch | "+". Unifying
      // the controls means one implementation placed per layout rather than
      // duplicated markup. The switch button sits BETWEEN the keyboard and "+":
      // it toggles the list and carries the moved background-tab attention cue.
      const swKb = makeKbButton("wt-switcher-kb wt-btn");
      const swSwitch = makeSwitchButton();
      const swSwitchDot = pick(swSwitch, ".wt-switcher-switch-dot");
      const swNew = makeNewButton("wt-switcher-new wt-btn wt-switcher-new-btn");
      swBar.append(swKb, swSwitch, swNew);
      // Latest-wins notification state for the switch button's dot: overwritten
      // by each qualifying background-tab event (applyStatus) and cleared when
      // the list opens (expandSwitcher) or the raising tab is visited or closed
      // (acknowledgeSwitchNotify). "" = no pending cue; the dot is hidden.
      let switchNotify: "" | "input" | "done" = "";
      // The session that raised the pending cue, so arriving on that tab (a
      // swipe or any switch) acknowledges it without opening the list.
      let switchNotifyId: string | null = null;
      function paintSwitchDot(): void {
        // Reuse the per-tab status-dot colours (single source, css/05-tabs.css
        // .wt-status-dot[data-status="input"|"done"]) instead of re-declaring
        // them: the dot has the .wt-status-dot class, so data-status colours it
        // exactly like the tabs' own dots.
        if (switchNotify === "") {
          delete swSwitchDot.dataset["status"];
        } else {
          swSwitchDot.dataset["status"] = switchNotify;
        }
      }
      function clearSwitchNotify(): void {
        switchNotify = "";
        switchNotifyId = null;
        paintSwitchDot();
      }
      // acknowledgeSwitchNotify clears the pending cue when its subject session
      // is reached (switchTo — including a swipe arriving on it) or ceases to
      // exist (a close/reap): the notification is resolved or moot then, and
      // only opening the list used to clear it (the reported "swiping to the
      // concerned tab leaves the dot lit").
      function acknowledgeSwitchNotify(id: string): void {
        if (switchNotifyId === id) {
          clearSwitchNotify();
        }
      }
      ctx.region("bottom-switcher", "switcher").appendChild(switcher);
      // The keyboard buttons open the key grid; show them only when a toolbar is
      // wired to drive. Read the toolbar's API lazily at tap time (ctx.use), so
      // feature ordering does not matter.
      let offArmed: (() => void) | undefined;
      if (opts.keyboardToggle) {
        // Un-hide every keyboard button; the mobile one then shows in the
        // switcher bar, the desktop one is CSS-gated to a wide touchscreen.
        for (const b of kbButtons) {
          b.hidden = false;
        }
        // Mirror sticky-Ctrl on every keyboard button: when a Ctrl press is
        // armed, invert the button (like the armed Ctrl key) so the pending
        // modifier is visible with the grid closed — the toolbar sets up before
        // tabs, so its API is available now (see the preset ordering note). Also
        // clears on the auto-disarm after a Ctrl byte and on a tab switch
        // (onDetach disarms).
        const kbApi = ctx.use(opts.keyboardToggle);
        if (kbApi) {
          const reflectArmed = (armed: boolean): void => {
            for (const b of kbButtons) {
              b.classList.toggle("wt-armed", armed);
            }
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
      // bottom inset (it reads the var off the surface, which inherits it from
      // the root). Measure the bar row (not the expandable list, which just
      // overlays content). innerHeight - rect.top captures the row plus the
      // safe-area beneath it; the RO fires with the keyboard closed, so the value
      // excludes the keyboard lift (viewport.ts adds that separately). The
      // synthetic visualViewport resize makes viewport.ts recompute immediately.
      const swReserve = new ResizeObserver(() => {
        const rect = swBar.getBoundingClientRect();
        const px = rect.height > 0 ? Math.max(0, Math.round(window.innerHeight - rect.top)) : 0;
        varRoot.style.setProperty("--wt-reserve-bottom", `${String(px)}px`);
        window.visualViewport?.dispatchEvent(new Event("resize"));
      });
      swReserve.observe(swBar);

      // Activity dots are revealed PER TAB, not chrome-wide: each dot stays
      // hidden (CSS: .wt-status-dot { display: none }) until its session reports
      // activity (OSC 9;4 progress or a classified OSC 9 notification), at which
      // point paintStatusDot adds .wt-reports to reveal it (see applyStatus /
      // syncMobile / updateRow). A program that emits no OSC 9 signal (a plain
      // bash/sh) keeps clean, label-only tabs; an agent's tabs light up. The
      // monitor (below) is the live source; without it the poll fallback feeds
      // the same reportsActivity flag.

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
      // Monotonic local-mutation counter stamped onto each adopted tab (Tab.born)
      // and snapshotted by reconcileOnce before its GET /api/sessions, so a
      // stale listing can never drop a tab adopted while it was in flight (the
      // boot race: the bootstrap's create vs the SSE stream-open reconcile).
      let tabEpoch = 0;
      // Close tombstones (model.ts): ids the user closed recently, so a stale
      // server listing (the SSE re-open snapshot, or the poll's GET
      // /api/sessions) that predates the server reaping the session does not
      // re-adopt (flash back) a closed tab.
      const tombstones = createTombstones();
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
      // Whether to focus the input on a tab switch. On a device with a physical
      // keyboard this is what you want (switch, then type immediately); on a
      // keyboard-less touchscreen it must NOT happen, or every switch pops the
      // virtual keyboard. No web API reports a hardware keyboard directly, so we
      // combine two proxies: (1) a fine pointer (a Magic Keyboard carries a
      // trackpad, so an iPad with one matches, as does every desktop; a bare
      // phone / keyboard-less tablet does not) — read live, since a keyboard can
      // be attached/detached; and (2) sawHardwareKey, latched once we observe a
      // keydown only a hardware keyboard emits (covers a trackpad-less keyboard
      // folio). See looksLikeHardwareKey and the keydown observer below.
      let sawHardwareKey = false;
      const hasFinePointer = (): boolean =>
        typeof window.matchMedia === "function" && window.matchMedia("(any-pointer: fine)").matches;
      const physicalKeyboardLikely = (): boolean => sawHardwareKey || hasFinePointer();
      // Motion opt-out (checked live: the OS setting can change). Gates the
      // interactive swipe/rotation animations, mirroring the CSS .wt-animate gate.
      const prefersReduce = (): boolean =>
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // relabelAll recomputes every tab's display label with de-duplication:
      // when two tabs resolve to the same base label (e.g. two shells with the
      // same window title, or two tabs whose last submitted line was identical),
      // the second and later get a " (k)" suffix in creation order, so the strip
      // never shows two identical labels.
      function relabelAll(): void {
        // Count only real (non-fallback) labels, so multiple untitled tabs all
        // read "New tab" without a numeric suffix.
        const counts = new Map<string, number>();
        for (const t of tabList) {
          const { text, fallback } = baseLabel(t, preferInputTitle);
          if (!fallback) {
            counts.set(text, (counts.get(text) ?? 0) + 1);
          }
        }
        const seen = new Map<string, number>();
        for (const t of tabList) {
          const { text, fallback } = baseLabel(t, preferInputTitle);
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

      // --- Fallback title derivation from the user's submitted lines ---
      // The line-editor state machine lives in model.ts
      // (createInputTitleDeriver); this wires its submissions to the active
      // tab. Used only when the process sets no OSC window title of its own
      // (baseLabel prefers tab.title). The kernel routes input to the active
      // session, so an input observer's bytes belong to activeId. Every
      // non-empty submitted line updates the fallback title (the last one
      // wins) and is persisted server-side (engine PUT .../title) so a reload
      // and other devices recover this "latest message" label; the engine uses
      // it only when the program emits no OSC title.
      const titleDeriver = createInputTitleDeriver((line) => {
        const t = tabList.find((x) => x.id === activeId);
        if (!t) {
          return; // no active tab
        }
        t.derived = line;
        void api.setTitle(t.id, t.derived);
        syncChrome();
      });

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
        paintStatusDot(swDot, active?.dot.dataset["status"] ?? "idle", active?.reports ?? false);
        // The aggregate background-notification cue rides the dedicated switch
        // button's dot (paintSwitchDot), not the active surface (it did not fit
        // there).
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
        paintStatusDot(
          pick(row, ".wt-switcher-row-dot"),
          t.dot.dataset["status"] ?? "idle",
          t.reports,
        );
        pick(row, ".wt-switcher-row-label").textContent = t.display;
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
        // Publish the measured content height so the expanded list animates its
        // max-height between 0 and the REAL content height (--wt-list-h in
        // 06-mobile.css), not a fixed 50dvh far larger than the content — which
        // made the open finish early and the close start late (box height =
        // min(content, max-height), so the transition's stretch past the content
        // moved nothing: the asymmetric, choppy toggle). scrollHeight is the full
        // content height regardless of the collapsed max-height:0 clip, so this
        // is valid whether measured while collapsed (on open, before the expanded
        // class) or already open (a tab added/closed). Capped at 50dvh (then
        // overflow-y:auto scrolls). This works without interpolate-size (iOS
        // Safari lacks it), unlike a height:auto transition.
        const visH = window.visualViewport?.height ?? window.innerHeight;
        switcher.style.setProperty(
          "--wt-list-h",
          `${String(Math.min(swList.scrollHeight, Math.round(visH * 0.5)))}px`,
        );
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
              el.style.opacity = "0"; // fades in as it rotates to its slot (below)
            }
            el.style.transition = "none";
            el.style.transform = `translateY(${String(Math.round(from))}px)`;
          }
          const exit = dir === "next" ? -pitch : pitch; // leaving row off the leading edge
          // The leaving row starts at its captured spot, fully opaque.
          ghost.style.transition = "none";
          ghost.style.transform = "translateY(0)";
          ghost.style.opacity = "1";
          // Commit the from-state (transforms + opacities) with a forced reflow
          // BEFORE the to-state, so BOTH the transform and the opacity transitions
          // fire from it. The prior code used a bare rAF (letting the browser
          // collapse from->to into one recalc) and reverted the entering row's
          // opacity to "" (no explicit end value), so the fade never animated
          // (the reported "no fade in / fade out"). The modern display/visibility
          // transition (transition-behavior: allow-discrete + @starting-style,
          // Baseline 2024) does NOT apply here: these rows are reused and moved by
          // a JS transform FLIP, not toggled via display:none, so the reliable
          // path is a real reflow plus an explicit opacity transition.
          swList.getBoundingClientRect(); // read forces the reflow (commit the from-state)
          // Couple opacity to the SAME easing + duration as the transform so a
          // row's fade tracks its DISTANCE from its target slot (each reel row
          // travels one pitch): a row is transparent a pitch away (at the clipped
          // edge) and only fully opaque once it settles. Entering rows fade IN as
          // they rotate in, the leaving row fades OUT as it exits: no hard cutoff
          // at the list edges and no permanent edge mask.
          const trans =
            "transform 0.25s cubic-bezier(0.2, 0, 0, 1), opacity 0.25s cubic-bezier(0.2, 0, 0, 1)";
          for (const el of rowEls.values()) {
            el.style.transition = trans;
            el.style.transform = "translateY(0)";
            el.style.opacity = "1";
          }
          ghost.style.transition = trans;
          ghost.style.transform = `translateY(${String(Math.round(exit))}px)`;
          ghost.style.opacity = "0";
          reelTimer = setTimeout(endReelNow, REEL_MS);
        };
      }

      // syncChrome refreshes every surface after any state change. Idempotent.
      function syncChrome(): void {
        relabelAll();
        paintActive();
        syncMobile();
        // The dedicated switch button only earns its place once there are ≥2
        // tabs (a single tab has nothing to switch to; expandSwitcher no-ops
        // there). .wt-switcher-multi drives its collapse-when-single / animate-in
        // -when-a-second-opens motion in CSS (the active chip shrinks to make
        // room in lockstep, via the flex layout); aria-hidden + tabindex keep the
        // collapsed button out of the a11y tree and tab order.
        const multiTab = tabList.length >= 2;
        switcher.classList.toggle("wt-switcher-multi", multiTab);
        swSwitch.setAttribute("aria-hidden", multiTab ? "false" : "true");
        swSwitch.tabIndex = multiTab ? 0 : -1;
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
        for (const b of kbButtons) {
          b.setAttribute("aria-expanded", "false");
          b.classList.remove("wt-active");
        }
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
        // Opening the list acknowledges any pending background-tab notification:
        // the user is now looking at the tabs, so clear the switch button's dot.
        clearSwitchNotify();
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
        paintStatusDot(dot, info.status, info.reportsActivity ?? false);
        const aria = tablist.registerTab(el);
        // Insert before the "+" so it stays the last item of the scrolling tab
        // list (the keyboard button lives outside the scroller, at the bar end).
        scroller.insertBefore(el, newBtn);
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
          born: ++tabEpoch,
          title: info.title,
          clientTitle: info.clientTitle,
          display: "",
          createdAt: info.createdAt,
          store: new LineStore(),
          el,
          label,
          dot,
          aria,
          scrollTop: 0,
          following: true,
          reports: info.reportsActivity ?? false,
        };
        // Set an initial label immediately (relabelAll refines it with de-dup
        // once the tab is in tabList and syncChrome runs).
        tab.display = baseLabel(tab, preferInputTitle).text;
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
        // Detach the current tab: save its scroll memory (keep its cache).
        // Read through the engine's scroll seam, never surface.scrollTop —
        // the controller owns the container's scroll geometry.
        const cur = tabList.find((t) => t.id === activeId);
        if (cur) {
          cur.scrollTop = ctx.scroll.currentScrollTop();
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
        // Arriving on the tab that raised the switch-button cue resolves it
        // (a swipe through the tabs must dismiss the dot, not only opening the
        // list).
        acknowledgeSwitchNotify(next.id);
        try {
          localStorage.setItem(ACTIVE_TAB_KEY, next.id);
        } catch {
          /* storage unavailable (private mode / disabled) — non-fatal */
        }
        titleDeriver.reset(); // a partial line typed in the old tab does not carry over
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
        // Restore scroll memory best-effort after the async rebuild. The engine
        // scroll controller's follow flag is GLOBAL (one per kernel) and still
        // reflects the tab we just left, so binding a following tab right after
        // being scrolled up in another tab left the controller in "holding":
        // the renderer's post-flush stickToBottom() no-op'd and the cached
        // screen rendered above the viewport (a black gap until a touch scrolled
        // it and re-engaged follow — the "content pops down when I wiggle it"
        // symptom). Re-assert here: scrollToBottom() snaps down AND re-engages
        // follow (so the resume delta then pins correctly); a scrolled-up tab
        // restores its saved read position instead.
        const savedTop = next.scrollTop;
        const following = next.following;
        requestAnimationFrame(() => {
          if (following) {
            ctx.scroll.scrollToBottom();
          } else {
            // The write half of scroll memory goes through the same seam; the
            // controller re-derives hold from the resulting scroll event.
            ctx.scroll.restoreScrollTop(savedTop);
          }
        });
        ctx.announce(`Switched to ${next.display}`);
        if (physicalKeyboardLikely()) {
          // A physical keyboard is (likely) present, so focus the input on
          // switch — switch and type immediately (the iPad + Magic Keyboard
          // ask). On a keyboard-less touchscreen this is skipped, or every
          // switch would pop the virtual keyboard (#7).
          focusInput();
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

      // Live window-title updates for the active session: the engine sends a
      // TITLE frame on the live socket whenever the process changes its OSC 0/2
      // title, which the kernel republishes as wire:title. baseLabel prefers the
      // OSC title, so applying it here updates the active tab's label at once
      // rather than waiting for the next status-SSE/poll sweep (background tabs,
      // which have no live socket, still refresh their title from that sweep).
      ctx.on("wire:title", ({ session, title }) => {
        const t = tabList.find((x) => x.id === session);
        // Ignore a blank title (an OSC 0/2 clear the process may emit when it
        // redraws its prompt after idling): keep the last good label until a real
        // replacement arrives, rather than reverting to "New tab". A non-blank
        // change updates the label at once.
        if (t && title.trim() !== "" && title !== t.title) {
          t.title = title;
          syncChrome();
        }
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
      // end (before the "+"). syncOrderFromDom rebuilds tabList to
      // match the strip's DOM order after a drag, so position indicators, the
      // switcher, and close-to-the-right/left all follow the visible order.
      function dragTargetBefore(x: number): HTMLElement | null {
        for (const el of scroller.querySelectorAll<HTMLElement>(".wt-tab:not(.wt-tab-dragging)")) {
          const rect = el.getBoundingClientRect();
          if (x < rect.left + rect.width / 2) {
            return el;
          }
        }
        return null;
      }
      function syncOrderFromDom(): void {
        const order: Tab[] = [];
        for (const el of scroller.querySelectorAll<HTMLElement>(".wt-tab")) {
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
        if (tombstones.active(info.id)) {
          return; // just closed here; ignore a stale listing until the server reaps it
        }
        tabList.push(addTabChrome(info));
      }

      // Activate the first tab when nothing is active. The bootstrap normally
      // activates a tab, but if the initial apiList AND apiCreate both fail at
      // load its `if (startTab)` activation is skipped, leaving activeId null
      // and connectionInitiated false -- so the kernel never opens the terminal
      // WS and its wake handlers no-op. When the server recovers, the status
      // stream / poll adopt the existing sessions below; without this they would
      // render inert (blank, never connecting) until the user taps a tab. This
      // is the sibling of the '+'-retry recovery the bootstrap already handles.
      // A live tab outranks an exited one (its dot status is fed by the same
      // SSE/poll that adopted it); a corpse is only auto-activated when nothing
      // else exists.
      function ensureActive(): void {
        if (activeId !== null) {
          return;
        }
        const first = tabList.find((t) => t.dot.dataset["status"] !== STATUS_EXITED) ?? tabList[0];
        if (first) {
          switchTo(first.id);
        }
      }

      async function create(): Promise<void> {
        let info: SessionInfo;
        try {
          info = await api.create();
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
        // Tombstone this id briefly so a stale status snapshot/poll that predates
        // the server reaping it cannot re-adopt the just-closed tab.
        tombstones.add(id);
        // A pending switch-button cue whose subject just closed is moot: clear
        // it rather than leaving a dot no tab visit can ever resolve.
        acknowledgeSwitchNotify(id);
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
          try {
            await api.close(id);
          } catch {
            ctx.toast("Couldn't close the terminal on the server");
          }
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
          // Tombstone briefly so a stale status snapshot/poll that predates the
          // server reaping these sessions cannot re-adopt (flash back) a just-
          // closed tab -- mirrors the single-close path in dropTab (h-f2).
          tombstones.add(t.id);
          acknowledgeSwitchNotify(t.id); // a cue for a closed tab is moot
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
          try {
            await api.close(t.id);
          } catch {
            ctx.toast("Couldn't close a terminal on the server");
          }
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
        // Make visible (so it has measurable size), then place it within the
        // visible viewport via the shared point-anchored positioner (clamp to
        // the visual viewport; flip above the pointer near the bottom edge).
        tabMenu.classList.add("visible");
        placeMenuAt(tabMenu, x, y);
      }

      // One-time "swipe to switch" hint on first multi-tab state, mobile only.
      function maybeSwipeHint(): void {
        if (hintShown || tabList.length < 2) {
          return;
        }
        hintShown = true;
        const l = ctx.layout();
        if (!(l.narrow && l.coarse)) {
          return; // only the mobile switcher layout has a swipe-to-switch bar
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

      // applyStatus updates one tab's dot (status + reveal) + title from a status
      // record (shared by the SSE monitor and the polling fallback). reports is
      // the server's sticky reportsActivity flag; it gates the dot's visibility.
      function applyStatus(
        id: string,
        status: string,
        title: string | undefined,
        clientTitle: string | undefined,
        reports: boolean,
      ): void {
        const t = tabList.find((tab) => tab.id === id);
        if (!t) {
          return;
        }
        t.reports = reports;
        paintStatusDot(t.dot, status, reports);
        // Latest-wins background-tab notification for the switch button's dot: a
        // background tab (not the active one) reaching "input" (needs you) or
        // "done" (turn finished) raises the cue in that colour; each qualifying
        // event overwrites the prior one, and expandSwitcher clears it when the
        // list opens. The active surface keeps its own needs-input cue (see
        // syncMobile); this is the moved + upgraded, glanceable version on the
        // dedicated button.
        if (id !== activeId && (status === "input" || status === "done")) {
          switchNotify = status;
          switchNotifyId = id;
          paintSwitchDot();
        }
        // Record the raw server title; the displayed label (fallback + de-dup)
        // is recomputed by relabelAll via syncChrome, which the callers run
        // right after applyStatus. Ignore a BLANK title: a status sweep (or the
        // process clearing its OSC 0/2 window title) reports an empty string,
        // and overwriting a good label with it dropped an idle tab back to "New
        // tab". Hold the last known title until a genuine (non-blank) one
        // arrives; the derived-from-input fallback is likewise sticky.
        if (title !== undefined && title.trim() !== "") {
          t.title = title;
        }
        // The persisted client title is authoritative from the server (set via
        // PUT .../title); apply it as-is, including "" for a fresh session, so the
        // preferInputTitle label recovers it on reload. No blank-guard: unlike the
        // OSC title it does not flicker (it changes only on an explicit push).
        if (clientTitle !== undefined) {
          t.clientTitle = clientTitle;
        }
      }

      // Live status: the activity monitor (SSE push) when present, else a poll of
      // GET /api/sessions. Either way, dots + titles update and vanished sessions
      // drop; the poll additionally learns of a background exit the SSE would
      // have pushed (section 22.5).
      let offStatus: (() => void) | undefined;
      let offStreamOpen: (() => void) | undefined;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      // One-shot list reconcile shared by both status sources: adopt every
      // session the server lists, then drop tabs it no longer lists. The poll
      // fallback runs it on a timer; the SSE path runs it on every stream
      // (re)open — the reopen against a RESTARTED manager is the moment
      // zombie tabs must drop, because the fresh server's snapshot carries no
      // tombstones for sessions it never knew, so those tabs would otherwise
      // spin "Reconnecting…" forever (judgement finding sf-2).
      // Guarded against overlapping runs: a server slower than the trigger
      // cadence (but within the 15s API timeout) would otherwise race tabList
      // mutation. Skip the extra run instead.
      let reconciling = false;
      const reconcileOnce = async (): Promise<void> => {
        if (reconciling) {
          return;
        }
        reconciling = true;
        try {
          // Snapshot the mutation epoch BEFORE the list round-trip: the listing
          // is authoritative only for tabs that already existed when it was
          // requested. A tab adopted while the GET was in flight (the boot
          // race: the bootstrap's create vs this stream-open reconcile) is
          // invisible to the returned snapshot, and dropping it here cascaded
          // into a duplicate replacement session (dropTab's last-tab intercept
          // spawns one) — the double-create boot bug.
          const epochAtList = tabEpoch;
          let list: SessionInfo[];
          try {
            list = await api.list();
          } catch {
            return; // transient; try again on the next trigger
          }
          const seen = new Set(list.map((s) => s.id));
          for (const info of list) {
            adoptSession(info); // add sessions created elsewhere (no local tab)
            applyStatus(
              info.id,
              info.status,
              info.title,
              info.clientTitle,
              info.reportsActivity ?? false,
            );
          }
          // A tab the server no longer lists was reaped/closed elsewhere (or
          // died with a restarted manager): drop it locally (no DELETE — it
          // is already gone). Tabs born after the list snapshot are spared this
          // round; the next reconcile sees the server truth for them.
          const gone = tabList
            .filter((t) => !seen.has(t.id) && t.born <= epochAtList)
            .map((t) => t.id);
          for (const id of gone) {
            await dropTab(id, false);
          }
          ensureActive();
          syncChrome();
        } finally {
          reconciling = false;
        }
      };
      if (monitor) {
        offStatus = monitor.onStatus((s) => {
          if (s.removed) {
            void dropTab(s.id, false); // already gone server-side; no DELETE
            return;
          }
          // Adopt a session created in another browser so all clients converge.
          // The status record IS the session's wire shape (SessionStatus
          // extends SessionInfo), so it flows through whole — which also
          // carries the persisted clientTitle: the SSE snapshot usually beats
          // the initial GET /api/sessions (whose adoptSession then dedups and
          // never re-applies its fields), so dropping it here left every
          // SSE-adopted tab without its persisted title — in preferInputTitle
          // mode the label then fell back to "New tab" on reload.
          adoptSession(s);
          applyStatus(s.id, s.status, s.title, s.clientTitle, s.reportsActivity ?? false);
          ensureActive();
          syncChrome();
        });
        offStreamOpen = monitor.onStreamOpen?.(() => {
          void reconcileOnce();
        });
      } else {
        const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
        pollTimer = setInterval(() => {
          void reconcileOnce();
        }, pollMs);
      }

      // --- Event wiring ---
      // Derive each tab's title from the lines the user submits into it.
      const offInput = ctx.registerInputObserver((bytes) => {
        titleDeriver.observe(bytes);
      });
      // Observe (never consume) keydowns to detect a physical keyboard: a
      // hardware-only key latches sawHardwareKey, which upgrades focus-on-switch
      // for a keyboard folio with no trackpad (no fine pointer to key off).
      const offHwKey = ctx.registerKeydown((ev) => {
        if (!sawHardwareKey && looksLikeHardwareKey(ev)) {
          sawHardwareKey = true;
        }
        return false;
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
        scroller.insertBefore(draggingEl, dragTargetBefore(e.clientX) ?? newBtn);
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
        // A swipe gesture on the switcher owns the pointer; its own end logic
        // (endHorizontal/endVertical, via the window-level endOnUp) resolves the
        // outcome. Stand down here so this capture-phase handler's stopPropagation
        // cannot swallow that window-bubble pointerup -- which, when setPointerCapture
        // failed and the finger released outside the switcher, would strand gActive=true
        // and brick all future swipes until reload.
        if (gActive) {
          return;
        }
        const kb = opts.keyboardToggle ? ctx.use(opts.keyboardToggle) : undefined;
        const gridOpen = kb?.isOpen() ?? false;
        if (!expanded && !gridOpen) {
          return;
        }
        const target = e.target as HTMLElement | null;
        // The tab strip counts as chrome like the switcher: without it, the
        // desktop-strip keyboard button's own pointerup landed here, closed the
        // grid, and the button's click then re-opened it — so tapping the button
        // to CLOSE the grid never worked (a wide-touchscreen / landscape-phone
        // bug; the switcher's kb button was already exempt via .wt-switcher).
        const inChrome =
          target !== null &&
          (target.closest(".wt-switcher") !== null ||
            target.closest(".wt-tab-bar") !== null ||
            target.closest(".key-toolbar") !== null);
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
        // Bound the interactive drag against the VISUAL viewport (the region above the soft
        // keyboard), matching the switcher's kb-inset bottom anchor, so the list can't grow
        // past the visible area with the keyboard open.
        const visH = window.visualViewport?.height ?? window.innerHeight;
        gTargetMax = Math.min(swList.scrollHeight, Math.round(visH * 0.5));
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

      // The kernel-driven bootstrap (sessionOwner.resolveInitialSession): list
      // existing sessions or create the first one, adopt them, pick the start
      // tab, bind the renderer to its store — and RETURN its ref rather than
      // switching; the kernel performs the switch through the same path a tab
      // switch uses. A null return (nothing could be listed or spawned) keeps
      // the chrome up with the "+" retry alive, and the kernel — which now sees
      // the failure directly — dismisses the loading overlay over it.
      resolveImpl = async (): Promise<SessionRef | null> => {
        // Initial population: list existing sessions, or create the first one.
        let sessions: SessionInfo[];
        try {
          sessions = await api.list();
        } catch {
          sessions = [];
        }
        // Spawn a fresh session unless a LIVE one is listed. An exited session
        // is viewable history, not a working terminal — booting a page whose
        // every session has died (the agent exited: a sign-in dead end, a
        // crash) onto a corpse was the stuck-loading wedge. The exited ones are
        // still adopted below (switch to them to read their final screen; close
        // them by hand).
        if (!sessions.some((s) => s.status !== STATUS_EXITED)) {
          try {
            sessions = [...sessions, await api.create()];
          } catch {
            // Match the runtime create() path: toast and leave the chrome up so
            // "+" can retry. Any exited sessions stay adopted (frozen screen +
            // "Session ended" is still better than a blank page). A throw here
            // would also be survivable (the kernel treats a rejected resolver
            // as null), but the toast is the better UX.
            ctx.toast("Couldn't open a terminal");
          }
        }
        // Adopt (dedup) rather than blindly push. The status SSE pushes a
        // snapshot of the existing sessions on open, and tabs subscribes
        // (monitor.onStatus) BEFORE this list resolves, so a session may
        // already have a tab by the time the list lands. A straight push
        // doubled every already-adopted session (6 tabs from 3 across a fresh
        // load), and paintActive then lit both copies of the active id
        // ("2 active tabs" that move together).
        for (const info of sessions) {
          adoptSession(info);
        }
        // From here on, tabs added at runtime (create / adopt) animate in.
        started = true;
        // The SSE snapshot may have raced this bootstrap and already activated
        // a tab (ensureActive during the await above). The switch is then
        // already in flight — return null; the kernel sees connectionInitiated
        // and leaves the loading overlay to the normal ready path.
        if (activeId !== null) {
          return null;
        }
        // Activate the previously-active session if it still exists, else the
        // first (oldest). Session ids are stable server-side, so a page reload
        // reconnects to the tab the user left on instead of always the oldest.
        // Live sessions outrank exited ones: the saved id is honored only while
        // its session is still live (a reload used to restore straight onto the
        // corpse of a died-while-away session and wedge there), and the default
        // is the oldest LIVE tab. Only when nothing is live (the fresh-spawn
        // above failed too) does an exited tab start — a frozen final screen
        // with the "Session ended" banner beats a blank page.
        const liveIds = new Set(
          sessions.filter((s) => s.status !== STATUS_EXITED).map((s) => s.id),
        );
        const oldestLive = tabList.find((t) => liveIds.has(t.id));
        let startTab = oldestLive ?? tabList[0];
        try {
          const savedId = localStorage.getItem(ACTIVE_TAB_KEY);
          if (savedId !== null && savedId !== "") {
            const saved = tabList.find((x) => x.id === savedId);
            if (saved && (liveIds.has(saved.id) || oldestLive === undefined)) {
              startTab = saved;
            }
          }
        } catch {
          /* storage unavailable — fall back to the oldest live tab */
        }
        if (!startTab) {
          return null;
        }
        activeId = startTab.id;
        try {
          localStorage.setItem(ACTIVE_TAB_KEY, startTab.id);
        } catch {
          /* storage unavailable — non-fatal */
        }
        ctx.render.bind(startTab.store);
        syncChrome();
        focusInput();
        return { id: startTab.id };
      };

      return {
        api: {
          create,
          close: close_,
          switchTo,
          list: () =>
            tabList.map((t) => ({ id: t.id, title: t.display, active: t.id === activeId })),
        },
        teardown() {
          resolveImpl = null;
          offStatus?.();
          offStreamOpen?.();
          offInput();
          offHwKey();
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
          varRoot.style.removeProperty("--wt-tabbar-h");
          root?.classList.remove("wt-tabbed");
          varRoot.style.removeProperty("--wt-reserve-bottom");
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
          deskKb.remove();
          tabMenu.remove();
          switcher.remove();
          catchup.remove();
        },
      };
    },
  };
}
