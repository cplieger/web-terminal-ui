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
import { fromHTML, holdFocusOnPress } from "../dom.js";
import { createClickSwallow, placeMenuAt } from "../menu-position.js";
import { centreChipLabels } from "./ink-centre.js";
import type { CueStatus, SessionInfo, StatusRecord, Tab } from "./model.js";
import {
  ACTIVE_TAB_KEY,
  CUE_SEEN_KEY,
  MAX_PERSISTED_CUE_SEEN,
  MAX_PINNED_NAME,
  PROGRESS_ABSENT,
  SWIPE_HINT_KEY,
  SessionAPIError,
  TAB_ORDER_KEY,
  baseLabel,
  createSessionAPI,
  createTombstones,
  hasPinnedName,
  isCueStatus,
  isEndedStatus,
  normalizeProgress,
  orderedInsertIndex,
  parseCueSeen,
  parseTabOrder,
  renderedProgress,
  sanitizePinnedName,
  serializeCueSeen,
  serializeTabOrder,
  statusPhrase,
  tabAccessibleName,
} from "./model.js";
import { browserNotifierEnv, createNotifier } from "./notify.js";
import {
  TAB_HTML,
  kbButtonHTML,
  newButtonHTML,
  paintProgress,
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
// The drag data type carrying a reordered tab's session id. A PRIVATE type, not
// text/plain, deliberately: WebKit resolves dropped plain text as a URL and
// NAVIGATES to it when no handler cancels the drop, so a bare session id read as
// a relative path — dropping a tab on iPadOS loaded /<session-id> instead of
// reordering. A custom type also keeps the id out of the system pasteboard when
// the drag leaves the browser, which is what MDN's recommended-drag-types
// guidance prescribes for data specific to one application.
const TAB_DRAG_TYPE = "application/x-web-terminal-tab";
// Tab context-menu viewport clamping + the flip-above-the-pointer gap live in
// the shared point-anchored positioner (menu-position.ts), shared with the
// terminal context menu (formerly two hand-synced copies of the same math).

export interface TabsApi {
  /** Spawn a fresh session and switch to it. Calls made while a create is in
   *  flight share that create, so one gesture opens exactly one terminal. */
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
  /** Presume every session reports activity (an agent shell, where the program
   *  always emits OSC 9;4 progress): each tab's dot is visible as idle from
   *  creation instead of popping in seconds later when the agent has booted
   *  far enough to first report — the server's sticky reportsActivity flag
   *  then merely confirms. Default false (evidence-driven reveal: a plain
   *  shell keeps clean, label-only tabs). presetAgentTabbed enables this. */
  presumeReports?: boolean;
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
/** Session creation can be legitimately and TEMPORARILY refused, which is not the
 *  same event as a broken server. web-terminal-kiro answers 503 with
 *  `Retry-After: 5` and a body message while its tool engine installs the
 *  manifest's tools on first boot, a window its own HEALTHCHECK budgets 20
 *  minutes for. That state used to reach the user as the same fixed "Couldn't
 *  open a terminal" toast as a 500, with no retry: the page looked broken while
 *  the server was deliberately waiting, and `/api/health` reported healthy at the
 *  same time, so the two channels contradicted each other.
 *
 *  So honour what the server published: retry on its own schedule, and repeat its
 *  own explanation rather than inventing library wording for a host-specific
 *  condition. Only 503 retries; a 429 rate limit, a 4xx, or a 500 still fails
 *  fast, because those are not "come back shortly".
 *
 *  The bound is ELAPSED TIME, not an attempt count. An attempt cap interacts
 *  badly with the server's hint: at web-terminal-kiro's `Retry-After: 5` a dozen
 *  attempts is only a minute, while the window this exists for can run twenty
 *  (toolbelt's boot job is bounded at 30 minutes, which is why that app's
 *  HEALTHCHECK carries --start-period=20m), so the retry would give up long
 *  before the server was ready and the whole fix would miss its case. Waiting is
 *  cheap here because every iteration sleeps at least the server's hint, so this
 *  is never a hot loop. The user is re-told periodically rather than once,
 *  because a page that silently retries for twenty minutes is its own kind of
 *  broken. */
const CREATE_RETRY_MAX_TOTAL_MS = 1200000;
const CREATE_RETRY_FALLBACK_MS = 5000;
const CREATE_RETRY_REANNOUNCE_MS = 60000;

/** orderSignature collapses an arrangement into one comparable string, so the
 *  persist path can decide "did the order change?" with a string compare instead
 *  of re-serializing and re-writing on every status tick. NUL is the separator
 *  because a session id can never contain one. */
function orderSignature(ids: readonly string[]): string {
  return ids.join("\u0000");
}

/** readSavedOrder loads the persisted tab arrangement, or [] when there is none
 *  to trust. Storage itself can throw — Safari in private mode, a disabled
 *  third-party context, an embedder's iframe — and an unreadable arrangement is
 *  never fatal: the strip falls back to the server's creation order, exactly as
 *  it behaved before arrangements were persisted. */
function readSavedOrder(): string[] {
  try {
    return parseTabOrder(localStorage.getItem(TAB_ORDER_KEY));
  } catch {
    return [];
  }
}

/** writeSavedOrder persists an arrangement, best-effort: a full quota or an
 *  unavailable store must not break a reorder the user just performed on screen.
 *  The in-memory arrangement stays authoritative for this page either way. */
function writeSavedOrder(ids: readonly string[]): void {
  try {
    localStorage.setItem(TAB_ORDER_KEY, serializeTabOrder(ids));
  } catch {
    /* storage unavailable or full — the order still holds for this page */
  }
}

/** readCueSeen loads the acknowledged background-tab cues, or an empty map when
 *  there is none to trust. Storage itself can throw (Safari private mode, a
 *  disabled third-party context, an embedder's iframe) and an unreadable map is
 *  never fatal: the dot simply lights again, exactly as it behaved before
 *  acknowledgements were remembered. */
function readCueSeen(): Map<string, CueStatus> {
  try {
    return parseCueSeen(localStorage.getItem(CUE_SEEN_KEY));
  } catch {
    return new Map<string, CueStatus>();
  }
}

/** writeCueSeen persists acknowledgements, best-effort: a full quota must not
 *  break the dismissal the user just performed on screen. */
function writeCueSeen(seen: ReadonlyMap<string, CueStatus>): void {
  try {
    localStorage.setItem(CUE_SEEN_KEY, serializeCueSeen(seen));
  } catch {
    /* storage unavailable or full — the dismissal still holds for this page */
  }
}

async function createSessionHonouringRetry(
  api: { create: () => Promise<SessionInfo> },
  ctx: TerminalContext,
  isTornDown: () => boolean,
): Promise<SessionInfo> {
  const startedAt = Date.now();
  let lastAnnouncedAt = 0;
  for (;;) {
    try {
      return await api.create();
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (
        !(err instanceof SessionAPIError) ||
        err.status !== 503 ||
        elapsed >= CREATE_RETRY_MAX_TOTAL_MS
      ) {
        throw err;
      }
      // First refusal always speaks; after that only every
      // CREATE_RETRY_REANNOUNCE_MS, so a multi-minute wait is neither silent nor
      // a toast storm.
      if (lastAnnouncedAt === 0 || elapsed - lastAnnouncedAt >= CREATE_RETRY_REANNOUNCE_MS) {
        lastAnnouncedAt = elapsed;
        const waiting = err.serverMessage ?? "Server is not ready yet";
        ctx.toast(`${waiting}; retrying`, 8000);
        ctx.announce(`${waiting}; retrying`);
      }
      // Separate from the throttled pair above, and unthrottled: this writes the
      // reason onto the loading OVERLAY, which is the only surface a user can
      // actually see before the first frame -- the toast and the banner both live
      // inside .wt-root and paint under it. It replaces text in place rather than
      // stacking notifications, so there is no storm to throttle, and repeating
      // the same string is idempotent. This is what turns the black screen of a
      // twenty-minute tools install into a screen that says why it is waiting.
      ctx.loadingReason(`${err.serverMessage ?? "Server is not ready yet"} — retrying…`);
      await new Promise((resolve) => {
        window.setTimeout(resolve, err.retryAfterMs ?? CREATE_RETRY_FALLBACK_MS);
      });
      // A reload or destroy during the wait must not resurrect a create.
      if (isTornDown()) {
        throw err;
      }
    }
  }
}

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
  const presumeReports = opts.presumeReports ?? false;
  // reportsOf floors the server's per-session reportsActivity flag with the
  // consumer's presumption (see TabsOptions.presumeReports): an agent shell
  // shows the idle dot from tab creation instead of waiting out the agent's
  // boot-to-first-OSC-9;4 window.
  const reportsOf = (reports?: boolean): boolean => presumeReports || (reports ?? false);
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
  // Set on teardown so an in-flight create RETRY (which sleeps between attempts,
  // potentially across a multi-minute install window) cannot resurrect a session
  // for a feature that is already gone.
  let tornDown = false;
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
        // Keeps the keyboard on the terminal and paints its own press state;
        // holdFocusOnPress explains why those two are one job. It does NOT make
        // one press one activation — that is create()'s in-flight coalescing,
        // for the opposite failure.
        holdFocusOnPress(btn);
        btn.addEventListener("click", () => {
          void create();
        });
        return btn;
      }
      function makeKbButton(cls: string): HTMLElement {
        const btn = fromHTML(kbButtonHTML(cls));
        holdFocusOnPress(btn);
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
      // other bar buttons it goes through holdFocusOnPress; its click toggles the
      // list (toggleSwitcher opens when collapsed, closes when expanded).
      function makeSwitchButton(): HTMLElement {
        const btn = fromHTML(switchButtonHTML("wt-switcher-switch wt-btn"));
        holdFocusOnPress(btn);
        btn.addEventListener("click", () => {
          toggleSwitcher();
        });
        return btn;
      }

      // --- Desktop tab strip (top-bar region) ---
      // Two layers: the bar itself never scrolls; an inner scroller
      // (.wt-tab-scroll, the tablist) holds ONLY the tabs. The "+" and the
      // keyboard button sit OUTSIDE the scroller as fixed bar items in the
      // order [scroller | + | kb], so an overflowing tab list can never push
      // or scroll either control away. The scroller shrink-wraps its content
      // (CSS flex: 0 1 auto), so while the tabs fit the "+" trails the last
      // tab exactly as if it were in the list, while the kb button (a wide
      // touchscreen; hidden on a fine pointer) stays pinned at the bar's FAR
      // right edge via margin-left: auto whatever the tab count. Once the
      // tabs overflow, the scroller caps at the remaining bar width and the
      // "+" packs right, up against the kb. Both controls are built + wired
      // by the same shared factories as the mobile switcher's; the kb button
      // is CSS-gated to a wide touchscreen and un-hidden below only when a
      // keyboardToggle is wired. addTabChrome appends each tab to the
      // scroller's end.
      const slot = ctx.region("top-bar", "tabs");
      const bar = document.createElement("div");
      bar.className = "wt-tab-bar";
      slot.appendChild(bar);
      const scroller = document.createElement("div");
      scroller.className = "wt-tab-scroll";
      scroller.setAttribute("role", "tablist");
      bar.appendChild(scroller);
      const newBtn = makeNewButton("wt-tab-new");
      bar.appendChild(newBtn);
      const deskKb = makeKbButton("wt-tab-kb wt-btn");
      bar.appendChild(deskKb);
      // A vertical mouse wheel anywhere over the strip scrolls the tab list
      // horizontally — the strip has no vertical dimension to spend the delta
      // on, and this is the affordance browser tab bars train. Bound on the
      // BAR so the empty strip area and the fixed controls translate too.
      // Horizontal-dominant deltas (a trackpad pan) keep native handling, and
      // a wheel over a non-overflowing strip falls through untouched. The
      // listener is non-passive because a translated tick must preventDefault
      // so an embedding page (wt-container mode) does not also scroll.
      bar.addEventListener(
        "wheel",
        (e) => {
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
            return; // horizontal-dominant: native scroll already handles it
          }
          if (scroller.scrollWidth <= scroller.clientWidth) {
            return; // nothing to scroll: let the page have the wheel
          }
          e.preventDefault();
          // deltaMode: 0 = pixels, 1 = lines (Firefox wheel), 2 = pages.
          const step =
            e.deltaMode === 1
              ? e.deltaY * 32
              : e.deltaMode === 2
                ? e.deltaY * scroller.clientWidth
                : e.deltaY;
          scroller.scrollLeft += step;
        },
        { passive: false },
      );

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
      // The active row's determinate progress bar. Scoped to the current chip:
      // every expanded list row carries a .wt-progress-bar of its own, so an
      // unscoped pick would be ambiguous the moment the list is populated.
      const swProgress = pick(switcher, ".wt-switcher-current .wt-progress-bar");
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
      // (acknowledgeSwitchNotify). "" = no pending cue; the dot is hidden. The
      // cue-worthy set is CueStatus (input / done / crashed — the states that
      // want the user), declared once in model.ts beside isCueStatus.
      let switchNotify: "" | CueStatus = "";
      // The session that raised the pending cue, so arriving on that tab (a
      // swipe or any switch) acknowledges it without opening the list.
      let switchNotifyId: string | null = null;
      // Cues this viewer has already SEEN, per session (see CUE_SEEN_KEY).
      // Loaded here so a reload starts from what the user already dismissed:
      // input/done stay LATCHED server-side, and the status stream re-pushes the
      // latch in the snapshot it sends on every open, so without this a
      // dismissed dot came back on the next load — and on every SSE reconnect,
      // which on a phone is just returning to a backgrounded page.
      const cueSeen = readCueSeen();
      // markCueSeen records that this viewer has seen `id` holding `status`:
      // either because that tab is the one on screen, or because the tray listing
      // every tab's dot was opened. A non-cue status is not an acknowledgeable
      // event, so it is ignored rather than stored.
      function markCueSeen(id: string, status: string): void {
        if (!isCueStatus(status) || cueSeen.get(id) === status) {
          return;
        }
        cueSeen.set(id, status);
        // Evict the oldest entries so the live map obeys the same cap the parser
        // does. dropTab prunes a session closed while this page was open, but one
        // that vanished while the page was CLOSED leaves an entry nothing else
        // collects; unbounded, that would eventually push the map past the cap and
        // make the parser discard whatever it read last — dropping fresh
        // acknowledgements to keep dead ones.
        while (cueSeen.size > MAX_PERSISTED_CUE_SEEN) {
          const oldest = cueSeen.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          cueSeen.delete(oldest);
        }
        writeCueSeen(cueSeen);
      }
      // forgetCueSeen drops an acknowledgement, so the session's NEXT input/done
      // is a fresh cue: called when its status moves off the acknowledged value
      // (a new working phase, an exit) and when the session goes away.
      function forgetCueSeen(id: string): void {
        if (cueSeen.delete(id)) {
          writeCueSeen(cueSeen);
        }
      }
      // OSC 9 Form B notifications: the one signal the specs say to surface
      // OUTSIDE the page ("post a notification"), so a finished turn can reach a
      // user who is looking at another app. All the policy — the suppression
      // rule, the gesture-gated permission request, the silent tab-only
      // degradation — lives in notify.ts; this feature only feeds it events and
      // gestures.
      const notifier = createNotifier(browserNotifierEnv());
      function paintSwitchDot(): void {
        // Reuse the per-tab status-dot colours (single source, css/05-tabs.css
        // .wt-status-dot[data-status="input"|"done"|"crashed"]) instead of
        // re-declaring them: the dot has the .wt-status-dot class, so data-status
        // colours it exactly like the tabs' own dots. Its tooltip comes from the
        // same wording map as theirs, so the aggregate cue names the state it is
        // showing rather than being a coloured dot with no explanation.
        if (switchNotify === "") {
          delete swSwitchDot.dataset["status"];
          swSwitchDot.removeAttribute("title");
        } else {
          swSwitchDot.dataset["status"] = switchNotify;
          swSwitchDot.title = statusPhrase(switchNotify);
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
      // Measured optical centring for every chip label in both layouts: writes
      // --label-ink-shift onto the strip and the switcher from the line box THIS
      // engine produced for THIS font at THIS size, rather than the em constant
      // in 00-tokens.css that can only be right at one size (see ink-centre.ts).
      const stopInkCentring = centreChipLabels(varRoot, { strip: bar, switcher });

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
      // The user's persisted tab arrangement (model.ts TAB_ORDER_KEY): read ONCE
      // at setup, before any session can be adopted, so every adopt — from the
      // status-stream snapshot or from the bootstrap's list, in either order —
      // can place its tab at the saved position. Read-only for the life of the
      // page: it is the arrangement to RESTORE, and the live strip must not
      // overwrite it (see persistOrder).
      const savedOrder: readonly string[] = readSavedOrder();
      // Signature of the arrangement currently on disk, so persistOrder can run
      // from syncChrome (which fires on every status tick) and still write only
      // when the sequence actually changed. Seeded from what was read, so a
      // window that simply restored an arrangement writes nothing.
      let persistedSig = orderSignature(savedOrder);
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
      //
      // The OSC 9;4 percentage prefix ("78% · one") is applied HERE, at render
      // time, and stored nowhere: `display` stays the plain de-duplicated label,
      // so de-duplication compares real names, the rename field opens on the real
      // name, `list()` reports the real name, and clearing the progress needs no
      // cleanup — the next paint simply stops adding it.
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
          // The accessible name carries the state and the percentage as well as
          // the label: the dots are aria-hidden decoration and the progress bar
          // is a 2px line with no text, so without this a screen-reader user
          // cannot tell a working tab from a crashed one, or hear how far along
          // a determinate one is.
          t.aria.setLabel(tabAccessibleName(display, statusOf(t), shownProgress(t)));
        }
      }

      /** statusOf reads a tab's current status back off its dot, which is where
       *  applyStatus records it (the dot is the one element that always has it,
       *  on every chip site). */
      function statusOf(t: Tab): string {
        return t.dot.dataset["status"] ?? "idle";
      }

      /** shownProgress is a tab's percentage as it may currently be DISPLAYED:
       *  the last value the server reported, dropped unless the current status is
       *  one the progress channel owns. Those are the only two ways a percentage
       *  stops showing — the program's own OSC 9;4;0 (an explicit -1) and a status
       *  from another channel; see renderedProgress for why there is no third. */
      function shownProgress(t: Tab): number {
        return renderedProgress(statusOf(t), t.progress);
      }

      const termInput = (): HTMLElement | null =>
        ctx.surface().querySelector<HTMLElement>(".term-input");
      function focusInput(): void {
        termInput()?.focus({ preventScroll: true });
      }

      // Did the terminal input own the keyboard when the pointer press now being
      // handled began? A press on tab chrome focuses the control it landed on
      // (the browser's mousedown default action), so by the time the click
      // handler runs the input is already blurred and only a pointerdown-time
      // snapshot still knows where the keyboard came from. Recorded for the whole
      // chrome by the two pointerdown listeners below (the strip and the
      // switcher), not per control: chips come and go with sessions, and the fact
      // belongs to the gesture rather than to what it hit.
      let inputFocusedAtPress = false;
      function noteChromePress(): void {
        const el = termInput();
        inputFocusedAtPress = el !== null && document.activeElement === el;
      }
      function keyboardParkedOnChrome(): boolean {
        const active = document.activeElement;
        return active !== null && (bar.contains(active) || switcher.contains(active));
      }

      // focusAfterSwitch applies the tab-switch focus rule. Two independent
      // reasons to hand the keyboard to the terminal input:
      //
      //  - A physical keyboard is (likely) present, so a switch should leave you
      //    able to type at once, with no extra tap (the iPad + Magic Keyboard
      //    ask). Skipped on a keyboard-less touchscreen, or every switch would
      //    pop the virtual keyboard (#7).
      //  - The press that drove this switch took the keyboard OFF the terminal —
      //    it focused the chip (or the x, or a switcher row) it pressed, and the
      //    keyboard is still parked there. Handing it back is not NEW focus, so
      //    it pops no soft keyboard: it restores what the press displaced. Both
      //    halves are required for exactly that reason — a switch with no press
      //    behind it (a remote adopt, ensureActive), or a press on a device where
      //    the input was not focused to begin with, must not summon a keyboard.
      //    Leaving the keyboard parked on a chip is not neutral either: the
      //    strip's own keydown handling reads arrows as "switch tab" and Delete
      //    as "close tab", so every keystroke meant for the terminal is eaten.
      //
      // Never while a rename field is open: it owns the keyboard until it closes,
      // and a switch (the leading click of a double-click, a remote-driven
      // ensureActive) would otherwise yank the caret out of the field.
      function focusAfterSwitch(): void {
        if (editingId !== null) {
          return;
        }
        if (physicalKeyboardLikely() || (inputFocusedAtPress && keyboardParkedOnChrome())) {
          focusInput();
        }
      }

      // paintActive updates the desktop strip's active state. When the ACTIVE
      // TAB CHANGES (tracked via lastRevealedActive — not on every chrome
      // sync, so a user browsing a scrolled strip is never yanked back by an
      // unrelated repaint), the newly active chip is brought into view in the
      // overflowed scroller; inline: "nearest" is a no-op when it is already
      // visible. The typeof guard covers happy-dom, which lacks
      // scrollIntoView.
      let lastRevealedActive = "";
      function paintActive(): void {
        for (const t of tabList) {
          const on = t.id === activeId;
          t.el.classList.toggle("wt-tab-active", on);
          // setSelected re-adds aria-selected and the roving tabindex, which would
          // undo setEditing(true) on the chip hosting the rename field — and
          // syncChrome runs on every status event, so that happens within a tick.
          // The chip regains its semantics from endEdit's setEditing(false), which
          // reads the CURRENT selected state.
          if (t.id !== editingId) {
            t.aria.setSelected(on);
          }
        }
        if (activeId && activeId !== lastRevealedActive) {
          lastRevealedActive = activeId;
          const active = tabList.find((t) => t.id === activeId);
          if (active && typeof active.el.scrollIntoView === "function") {
            active.el.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
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
        paintStatusDot(swDot, active ? statusOf(active) : "idle", active?.reports ?? false);
        paintProgress(swProgress, active ? shownProgress(active) : PROGRESS_ABSENT);
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
      // updateRow refreshes a reused row's live bits (status dot + label +
      // progress bar).
      function updateRow(row: HTMLElement, t: Tab): void {
        paintStatusDot(pick(row, ".wt-switcher-row-dot"), statusOf(t), t.reports);
        paintProgress(pick(row, ".wt-progress-bar"), shownProgress(t));
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
        persistOrder();
      }

      // The percentage is deliberately NOT written into the browser document
      // title. ConEmu's spec names the taskbar/title as a display site, and a
      // page's document title is the nearest analogue — but a page has exactly
      // ONE title while this UI multiplexes many sessions, so any rule for
      // choosing whose percentage it shows is arbitrary. Even restricted to the
      // active tab it churns a surface that doubles as the browser-tab label and
      // the bookmark name, and it invites reading one session's progress as the
      // window's. The per-chip prefix carries the same information without the
      // conflict, because each chip shows its own session. Do not add it back.

      // persistOrder stores the strip's current arrangement so it survives a
      // reload. It hangs off syncChrome — the one function every list mutation
      // already ends with (reorder, create, adopt, close, reconcile) — rather than
      // off the two reorder call sites, so a future path that rearranges tabs
      // cannot forget to persist. Three guards make that safe:
      //
      //  - `started`: nothing is written while the initial population runs. The
      //    strip grows one tab at a time there, and each intermediate state is a
      //    partial arrangement, NOT a user decision — writing them meant a reload
      //    landing mid-population could store a one-tab order and lose the real
      //    one. After the bootstrap every change is a genuine change.
      //  - the signature compare: syncChrome also runs on every status tick, so
      //    only a changed id sequence reaches storage.
      //  - a non-empty list: an empty strip carries no arrangement, and a
      //    transient empty state (the last tab closed just before its replacement
      //    lands, a reconcile against a restarted server) must not erase the
      //    stored order.
      //
      // savedOrder is deliberately NOT reassigned here. It is the ARRANGEMENT
      // READ AT LOAD, which is what adoption places tabs by; overwriting it with
      // the live strip discards the position of every session that has not been
      // adopted yet — which is precisely what a strip still filling up is full of.
      function persistOrder(): void {
        if (!started || tabList.length === 0) {
          return;
        }
        const ids = tabList.map((t) => t.id);
        const sig = orderSignature(ids);
        if (sig === persistedSig) {
          return;
        }
        persistedSig = sig;
        // Writing the LIVE strip also prunes: ids whose sessions are gone never
        // reach storage again, so the stored arrangement cannot grow forever.
        writeSavedOrder(ids);
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
        // The tray lists EVERY tab with its own status dot, so every latched tab
        // is acknowledged here, not just the cue's latest subject — several tabs
        // can be latched at once while the dot only ever showed the newest, and an
        // unacknowledged sibling would re-raise it on the next load.
        for (const t of tabList) {
          markCueSeen(t.id, t.dot.dataset["status"] ?? "");
        }
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

      function addTabChrome(info: StatusRecord): Tab {
        const el = fromHTML(TAB_HTML);
        const label = el.querySelector<HTMLElement>(".wt-tab-label");
        const dot = el.querySelector<HTMLElement>(".wt-tab-dot");
        const progressEl = el.querySelector<HTMLElement>(".wt-progress-bar");
        const close = el.querySelector<HTMLButtonElement>(".wt-tab-close");
        if (!label || !dot || !progressEl || !close) {
          throw new Error("web-terminal-ui: tab chrome missing parts");
        }
        paintStatusDot(dot, info.status, reportsOf(info.reportsActivity));
        const aria = tablist.registerTab(el);
        // Append to the scroller's end: the tab list is ALL the scroller holds
        // (the "+" and keyboard button are fixed bar items outside it).
        scroller.appendChild(el);
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
          pinnedTitle: info.pinnedTitle,
          nameSeq: 0,
          display: "",
          createdAt: info.createdAt,
          store: new LineStore(),
          el,
          label,
          dot,
          progressEl,
          // A percentage exists only on the status STREAM, so a tab adopted from
          // the REST list starts with none; the first status event fills it in.
          progress: normalizeProgress(info.progressValue),
          aria,
          scrollTop: 0,
          following: true,
          reports: reportsOf(info.reportsActivity),
        };
        paintProgress(progressEl, renderedProgress(info.status, tab.progress));
        // Set an initial label immediately (relabelAll refines it with de-dup
        // once the tab is in tabList and syncChrome runs).
        tab.display = baseLabel(tab).text;
        label.textContent = tab.display;
        aria.setLabel(
          tabAccessibleName(tab.display, info.status, renderedProgress(info.status, tab.progress)),
        );
        el.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".wt-tab-close")) {
            return; // handled by the close button
          }
          if (editingId === tab.id) {
            return; // the rename field owns this chip
          }
          switchTo(tab.id);
        });
        // Double-click renames, which is also the TOUCH entry path (a double-tap):
        // a long-press on a chip starts a reorder drag on iPadOS rather than
        // opening the context menu, because the chip is draggable — so the menu is
        // not reachable by touch and this is. The chip's touch-action:manipulation
        // (CSS) is what stops iOS eating the second tap as double-tap-to-zoom.
        // The leading click switches to the tab first; Finder selects before
        // renaming too, so that matches expectation.
        el.addEventListener("dblclick", (e) => {
          if ((e.target as HTMLElement).closest(".wt-tab-close")) {
            return;
          }
          e.preventDefault();
          beginEdit(tab.id, "pointer");
        });
        // Keyboard interaction for the ARIA tabs pattern (WCAG 2.1.1): arrows
        // move selection (wrapping), Home/End jump to the boundaries, Delete
        // closes the focused tab, F2 renames (the Explorer convention). Pairs with
        // the roving tabindex the kernel's registerTab manages (selected tab is
        // tabIndex 0, others -1).
        el.addEventListener("keydown", (e) => {
          const current = tabList.indexOf(tab);
          if (current < 0) {
            return;
          }
          // While this chip hosts the rename field, every key belongs to the field
          // (belt-and-braces with the field's own stopPropagation).
          if (editingId === tab.id) {
            return;
          }

          if (e.key === "F2") {
            e.preventDefault();
            beginEdit(tab.id, "keyboard");
            return;
          }

          if (e.key === "Delete") {
            e.preventDefault();
            void close_(tab.id);
            return;
          }

          let targetIndex: number;
          switch (e.key) {
            case "ArrowLeft":
              targetIndex = (current - 1 + tabList.length) % tabList.length;
              break;
            case "ArrowRight":
              targetIndex = (current + 1) % tabList.length;
              break;
            case "Home":
              targetIndex = 0;
              break;
            case "End":
              targetIndex = tabList.length - 1;
              break;
            default:
              return;
          }

          e.preventDefault();
          const target = tabList[targetIndex];
          if (!target) {
            return;
          }
          switchTo(target.id);
          target.el.focus();
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
          if (editingId === tab.id) {
            return; // middle-click in a text field pastes on X11; it must not close the tab
          }
          if (e.button === 1) {
            e.preventDefault();
            void close_(tab.id);
          }
        });
        // Right-click opens the tab context menu (desktop). preventDefault stops
        // the browser's own menu; the strip is hidden on a coarse pointer, so
        // this is desktop-only in practice.
        el.addEventListener("contextmenu", (e) => {
          if (editingId === tab.id) {
            // Let the browser's own text menu open: it is where Paste, Select All
            // and Undo live, and the tab menu would offer Close and Move mid-edit.
            return;
          }
          e.preventDefault();
          showTabMenu(e.clientX, e.clientY, tab.id);
        });
        // Drag-and-drop reorder on the desktop strip. The bar's dragover moves
        // this element live; drop/dragend commit the new order into tabList.
        el.draggable = true;
        el.addEventListener("dragstart", (e) => {
          if (editingId === tab.id) {
            e.preventDefault(); // renaming: a drag would fight caret selection
            return;
          }
          draggingEl = el;
          // Snapshot the preview from the PRISTINE chip, before the dim class.
          setDragGhost(e, el);
          el.classList.add("wt-tab-dragging");
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            // Firefox requires drag data to be set for the drag to start; the
            // private type keeps the payload undroppable everywhere else (see
            // TAB_DRAG_TYPE).
            e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
          }
          hideTabMenu();
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("wt-tab-dragging");
          draggingEl = null;
          clearDragGhost(); // belt-and-braces: the rAF normally got there first
          syncOrderFromDom();
        });
        return tab;
      }

      function switchTo(id: string, dir?: "next" | "prev"): void {
        if (id === activeId) {
          // Already active, so there is no switch to perform — but the FOCUS rule
          // still owes an answer, because the press that delivered this click has
          // already moved the keyboard onto the chip. Two pointer paths land here:
          // clicking the tab that is already active, and the SECOND activation of
          // one press on another tab (see create() for the evidence that this
          // device delivers those). The first activation switches and focuses the
          // terminal; the second one's mousedown re-focuses the chip and then fell
          // out here with the keyboard stranded on it — the reported "the
          // invisible input loses focus when I click another tab", and the same
          // hole a plain mouse click on the active tab hit on every platform.
          focusAfterSwitch();
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
        // list). Its current latch is acknowledged whether or not it was the
        // cue's subject: the terminal is now on screen, so a reload must not
        // notify about a state the user just looked at.
        acknowledgeSwitchNotify(next.id);
        markCueSeen(next.id, next.dot.dataset["status"] ?? "");
        try {
          localStorage.setItem(ACTIVE_TAB_KEY, next.id);
        } catch {
          /* storage unavailable (private mode / disabled) — non-fatal */
        }
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
        focusAfterSwitch();
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
      // x (the element the dragged tab should sit before), or null to drop at
      // the end of the tab list. syncOrderFromDom rebuilds tabList to
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

      // --- Drag preview (the ghost) ---
      // WebKit renders NO automatic drag image for an element whose ancestor
      // carries a filter or transform (webkit.org/b/22787) — and the strip's own
      // backdrop-filter is exactly such an ancestor, so on iPadOS the preview
      // came out as broken white geometry instead of the chip (desktop Chrome,
      // which snapshots the element regardless, always looked right). An EXPLICIT
      // drag image fixes it: a clone parked directly under .wt-root, outside the
      // bar's filtered subtree yet still inside the styling boundary so the
      // scoped .wt-tab rules paint it. It is laid exactly over the real chip, so
      // it is indistinguishable from it in the unlikely event it ever paints, and
      // dropped on the next frame — the browser has already snapshotted it by
      // then (the snapshot is taken when the dragstart handler returns).
      let dragGhost: HTMLElement | null = null;
      function clearDragGhost(): void {
        dragGhost?.remove();
        dragGhost = null;
      }
      function setDragGhost(e: DragEvent, el: HTMLElement): void {
        clearDragGhost();
        const rect = el.getBoundingClientRect();
        const rootRect = varRoot.getBoundingClientRect();
        const ghost = el.cloneNode(true) as HTMLElement;
        ghost.classList.add("wt-tab-ghost");
        // A duplicated role="tab" must not reach assistive tech for the frame the
        // clone exists (CSS keeps it non-interactive).
        ghost.setAttribute("aria-hidden", "true");
        ghost.style.left = `${String(rect.left - rootRect.left)}px`;
        ghost.style.top = `${String(rect.top - rootRect.top)}px`;
        // The chip's width comes from a flex-shrink in the strip; out of that
        // flex context the clone would snap back to the unshrunk 300px.
        ghost.style.width = `${String(rect.width)}px`;
        ghost.style.height = `${String(rect.height)}px`;
        varRoot.appendChild(ghost);
        dragGhost = ghost;
        // Offset from the chip's own box, not e.offsetX/offsetY: those are
        // relative to the event TARGET, which is the label or the close button
        // when the drag starts on one of them.
        e.dataTransfer?.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top);
        requestAnimationFrame(clearDragGhost);
      }

      // moveTab shifts a tab one slot left or right in tabList and re-appends
      // every tab element in list order so the DOM matches.
      // It is the single-pointer / non-drag alternative to the drag-and-drop
      // reorder (WCAG 2.5.7), surfaced as Move left / Move right in the tab
      // context menu.
      function moveTab(id: string, delta: -1 | 1): void {
        // Reordering re-appends every chip, and reparenting the focused field blurs
        // it — so an open edit would be committed as a side effect of moving some
        // OTHER tab, via a blur the user never performed. Resolve it here instead,
        // so the outcome is chosen and testable rather than emergent (happy-dom
        // does not reproduce the reparent-blur, so no test could catch it).
        resolveEdit("blur", false);
        const from = tabList.findIndex((t) => t.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= tabList.length) {
          return;
        }
        const [tab] = tabList.splice(from, 1);
        if (!tab) {
          return;
        }
        tabList.splice(to, 0, tab);
        for (const item of tabList) {
          scroller.appendChild(item.el);
        }
        syncChrome();
        ctx.announce(`Moved ${tab.display} to position ${String(to + 1)}`);
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
        const tab = addTabChrome(info);
        // Place the tab where the user's stored arrangement says it goes, not
        // where it happened to arrive: the status-stream snapshot and the
        // bootstrap's GET /api/sessions race each other, so arrival order is not
        // the user's order (and is not even stable between loads). A session the
        // arrangement does not know is appended, which is what a genuinely new
        // tab wants.
        const at = orderedInsertIndex(
          tabList.map((t) => t.id),
          savedOrder,
          info.id,
        );
        tabList.splice(at, 0, tab);
        // addTabChrome appended the chip to the scroller's end; move it to match
        // the list when the arrangement put it earlier, so the DOM, the switcher
        // rows, and the position announcements all read the same order.
        const after = tabList[at + 1];
        if (after) {
          scroller.insertBefore(tab.el, after.el);
        }
      }

      // Activate the first tab when nothing is active. The bootstrap normally
      // activates a tab, but if the initial apiList AND apiCreate both fail at
      // load its `if (startTab)` activation is skipped, leaving activeId null
      // and connectionInitiated false -- so the kernel never opens the terminal
      // WS and its wake handlers no-op. When the server recovers, the status
      // stream / poll adopt the existing sessions below; without this they would
      // render inert (blank, never connecting) until the user taps a tab. This
      // is the sibling of the '+'-retry recovery the bootstrap already handles.
      // A live tab outranks an ENDED one (its dot status is fed by the same
      // SSE/poll that adopted it); a corpse is only auto-activated when nothing
      // else exists. "Ended" covers both ways a process goes (exited and
      // crashed) — a crashed session is exactly as unable to produce output as a
      // cleanly exited one, so activating it would wedge the page the same way.
      function ensureActive(): void {
        if (activeId !== null) {
          return;
        }
        const first = tabList.find((t) => !isEndedStatus(statusOf(t))) ?? tabList[0];
        if (first) {
          switchTo(first.id);
        }
      }

      // create is the coalesced door: while one create is in flight, every caller
      // asking for another gets THAT one, so a single gesture can only ever open
      // one terminal. Spawning a session is expensive and non-idempotent, and one
      // press does not reliably arrive as one activation — the web-terminal-kiro
      // server logged two POST /api/sessions 0-3ms apart (three times in one
      // afternoon, both answered 201) for single "+" taps from an iPad + Magic
      // Keyboard, so the user got two terminals and had to close one. Sharing the
      // in-flight promise needs no threshold to make that decision, unlike a
      // click-level debounce: a duplicate activation lands while the POST is still
      // open and collapses into it, while a deliberate second tap (the POST
      // resolves in milliseconds) still opens a second terminal. It also stops "+"
      // mashing from queueing sessions across the server's 503 install window,
      // where createSessionHonouringRetry legitimately waits minutes.
      let creating: Promise<void> | null = null;
      function create(): Promise<void> {
        creating ??= openNewSession().finally(() => {
          creating = null;
        });
        return creating;
      }

      async function openNewSession(): Promise<void> {
        let info: SessionInfo;
        try {
          info = await createSessionHonouringRetry(api, ctx, () => tornDown);
        } catch (err) {
          // A create can still fail transiently (network, server error); tell
          // the user rather than throwing. A 503 has already been retried on the
          // server's own schedule by this point, so reaching here means it never
          // became ready -- say so with the server's own words when it gave any,
          // rather than the generic message that used to cover both cases.
          ctx.toast(
            err instanceof SessionAPIError && err.serverMessage !== undefined
              ? `Couldn't open a terminal: ${err.serverMessage}`
              : "Couldn't open a terminal",
          );
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
        // A tab removed mid-edit (a user close, an SSE removal, or the list
        // reconcile dropping it) abandons the edit with no request: the field
        // lives inside the chip and goes away with it, so the state must not
        // outlive it.
        if (editingId === id) {
          endEdit();
        }
        // Tombstone this id briefly so a stale status snapshot/poll that predates
        // the server reaping it cannot re-adopt the just-closed tab.
        tombstones.add(id);
        // A pending switch-button cue whose subject just closed is moot: clear
        // it rather than leaving a dot no tab visit can ever resolve. Its stored
        // acknowledgement goes too — the session is gone, so the entry would only
        // sit in storage forever.
        acknowledgeSwitchNotify(id);
        forgetCueSeen(id);
        notifier.forget(id); // no more notifications can arrive for a gone session
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
        // The bulk-close path drops tabs itself rather than through dropTab, so it
        // needs the same mid-edit guard: an open editor on a tab being removed must
        // be abandoned, or editingId outlives its chip and permanently suppresses
        // focus-on-switch.
        if (editingId !== null && ids.includes(editingId)) {
          endEdit();
        }
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

      // --- Inline rename (R5) ---
      // The edit surface is the label's OWN box, so the width the user types into
      // is the width the label will have. An <input>, not contenteditable: real
      // text-input semantics, IME support, a mobile keyboard, and no rich-HTML
      // paste surface.
      //
      // editingId is also the stand-down flag for every chip handler that would
      // otherwise fight the field (click-to-switch, the arrow/Delete keys,
      // focus-on-switch, the drag) — see the guards at each site.
      let editingId: string | null = null;
      let editInput: HTMLInputElement | null = null;
      // Where focus goes when the edit ends. R9: back to the chip when the user
      // arrived from the keyboard (F2 — they were navigating the strip and should
      // still be), to the terminal otherwise. Recorded at entry because the exit
      // paths cannot tell them apart.
      let editFrom: "keyboard" | "pointer" = "pointer";
      // Tab ids with a pinned-name request in flight. While an id is here, a status
      // record carrying a DIFFERENT value is applied for display but does not
      // supersede the request: SSE delivery order and REST mutation order are not
      // one total order, so a record sampled BEFORE our PUT can arrive after it,
      // and treating it as newer authority would suppress the request's own
      // rollback and its failure toast.
      const namesInFlight = new Set<string>();

      /** restoreFocusAfterEdit sends focus where the entry path implies. The
       *  terminal branch is gated exactly like switchTo's focus-on-switch: on a
       *  keyboard-less touchscreen, focusing the hidden textarea pops the soft
       *  keyboard, which is not what finishing a rename by double-tap should do. */
      function restoreFocusAfterEdit(el: HTMLElement | undefined): void {
        if (editFrom === "keyboard" && el) {
          el.focus();
          return;
        }
        if (physicalKeyboardLikely()) {
          focusInput();
        }
      }

      /** endEdit tears the field down and restores the chip. It never issues a
       *  request; each caller decides what to commit first. */
      function endEdit(): void {
        const id = editingId;
        editingId = null;
        const input = editInput;
        editInput = null;
        if (id === null) {
          return;
        }
        const t = tabList.find((x) => x.id === id);
        input?.remove();
        if (!t) {
          return; // the tab went away mid-edit; its chrome is already gone
        }
        t.label.hidden = false;
        t.el.classList.remove("wt-tab-editing");
        t.el.draggable = true;
        // Restore the tab semantics from the CURRENT selected state: the active
        // tab can change while an edit is open on a different chip.
        t.aria.setEditing(false, t.id === activeId);
      }

      /** commitRename applies a finished edit. An empty value CLEARS the pin, but
       *  only on an explicit confirm — see beginEdit's Enter/blur split. */
      function commitRename(id: string, raw: string): boolean {
        const t = tabList.find((x) => x.id === id);
        if (!t) {
          return false;
        }
        // Sanitize client-side rather than trusting the round-trip: strip control
        // characters and bound the length exactly as the server does.
        const name = sanitizePinnedName(raw);
        const before = t.pinnedTitle ?? "";
        if (name === before) {
          return false; // nothing to do; no request, no toast
        }
        // Optimistic: paint it now, guarded by a monotonic counter AND the tab's
        // birth epoch so a slow response cannot roll back a newer rename, a later
        // clear, a remote update, or — if this id were ever reused by a fresh
        // session — a different tab entirely.
        const seq = ++t.nameSeq;
        const born = t.born;
        t.pinnedTitle = name;
        syncChrome();
        // Announce the OUTCOME, which for a clear is whatever the automatic
        // sources now yield — and that can be the "New tab" fallback, in which
        // case claiming an automatic name would be false.
        if (name !== "") {
          ctx.announce(`Renamed to ${name}`);
        } else {
          const { text, fallback } = baseLabel(t);
          ctx.announce(fallback ? "Custom name removed" : `Using automatic name: ${text}`);
        }
        namesInFlight.add(id);
        const request = name === "" ? api.clearPinnedTitle(id) : api.setPinnedTitle(id, name);
        void request
          .catch(() => {
            const cur = tabList.find((x) => x.id === id);
            if (cur?.born !== born || cur.nameSeq !== seq) {
              return; // gone, reused, or superseded: the newer state stands
            }
            cur.pinnedTitle = before;
            syncChrome();
            ctx.toast("Couldn't save the terminal name");
          })
          .finally(() => {
            namesInFlight.delete(id);
          });
        return true;
      }

      /** beginEdit swaps a chip's label for a text field. Idempotent per tab; a
       *  second tab entering edit commits the first. */
      function beginEdit(id: string, from: "keyboard" | "pointer"): void {
        if (editingId === id) {
          return;
        }
        if (editingId !== null) {
          // Entering edit elsewhere resolves the open one under the blur rules —
          // this is not an Enter, so it must not be able to CLEAR a pin from a
          // field the user happened to empty. Focus is about to move to the new
          // field, so it is not restored here.
          resolveEdit("blur", false);
        }
        editFrom = from;
        const t = tabList.find((x) => x.id === id);
        if (!t) {
          return;
        }
        const input = document.createElement("input");
        input.type = "text";
        input.className = "wt-tab-rename";
        input.setAttribute("aria-label", "Rename terminal");
        // Prefill with the PIN, not the rendered label. t.display is presentation
        // output: for an unpinned tab it is the automatic title, the "New tab"
        // fallback, or a de-duplication suffix relabelAll generated (`auth (2)`).
        // Since a blur commits a non-empty value, prefilling it meant opening the
        // editor and clicking away silently pinned presentation text as the user's
        // chosen name. An unpinned tab therefore starts EMPTY, with the current
        // label as the placeholder so the user still sees what they are replacing.
        input.value = t.pinnedTitle ?? "";
        input.placeholder = t.display;
        // maxLength is a UI affordance only, in UTF-16 code units; the server
        // counts runes, so sanitizePinnedName (code points) is the real bound.
        input.maxLength = MAX_PINNED_NAME;
        // iPadOS is the device this affordance was designed for, and its defaults
        // are wrong for a short identifier: autocapitalize would upper-case the
        // first letter of every tab name and autocorrect would rewrite it on
        // commit. enterkeyhint labels the soft keyboard's action key.
        input.autocapitalize = "off";
        input.spellcheck = false;
        input.setAttribute("autocorrect", "off");
        input.enterKeyHint = "done";
        // A tab shrinks toward a 100px floor once the strip is full, and a 100px
        // edit box is unusable, so the edited chip is given its full width for the
        // duration — on ENTRY only, never per keystroke, so the strip does not
        // jitter as the user types.
        t.el.classList.add("wt-tab-editing");
        t.label.hidden = true;
        t.el.insertBefore(input, t.label.nextSibling);
        // Drop the tab semantics while a textbox lives in the chip, and stop the
        // chip being draggable: a draggable ancestor interferes with drag-selecting
        // text, and dragging the tab you are renaming is meaningless.
        t.aria.setEditing(true, t.id === activeId);
        t.el.draggable = false;
        editingId = id;
        editInput = input;
        if (typeof t.el.scrollIntoView === "function") {
          t.el.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        input.focus();
        input.select();
        ctx.announce(`Renaming ${t.display}`);

        input.addEventListener("keydown", (e) => {
          // The chip's own keydown handler treats arrows as tab switching and
          // Delete as close; the field must own them. stopPropagation is the
          // narrowest fix and keeps the chip's handler unaware of edit mode.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            resolveEdit("confirm");
          } else if (e.key === "Escape") {
            e.preventDefault();
            resolveEdit("cancel");
          }
        });
        // A click inside the field must not reach the chip's switch-on-click.
        input.addEventListener("click", (e) => {
          e.stopPropagation();
        });
        input.addEventListener("blur", () => {
          if (editingId !== id) {
            return; // already resolved by Enter/Escape/teardown
          }
          // A blur is not the user asking for focus to go anywhere in particular,
          // so it does not move it.
          resolveEdit("blur", false);
        });
      }

      /** resolveEdit closes the open edit and applies its value under the rules for
       *  HOW it was closed. One function rather than a commit path per caller,
       *  because the empty-value rule differs and every caller that got it wrong
       *  did so by hand-inlining a variant:
       *
       *  - `"confirm"` (Enter) is the only deliberate confirmation, so it is the
       *    only mode that may CLEAR a pin from an emptied field.
       *  - `"blur"` commits a non-empty value (Finder and Explorer both do;
       *    discarding on a stray click is hostile) and reverts an empty one — a
       *    blur is loss of focus, not destructive intent, and on a tablet
       *    dismissing the soft keyboard IS a blur.
       *  - `"cancel"` (Escape) applies nothing.
       *
       *  `focus` is opt-out for the callers that are not a user finishing an edit
       *  (a reorder, a pre-empting second edit): they should not move focus. */
      function resolveEdit(mode: "confirm" | "blur" | "cancel", focus = true): void {
        const id = editingId;
        if (id === null) {
          return;
        }
        const value = editInput?.value ?? "";
        const t = tabList.find((x) => x.id === id);
        const label = t?.display ?? "";
        endEdit();
        if (mode === "cancel") {
          ctx.announce(`Rename cancelled, keeping ${label}`);
        } else if (mode === "confirm" || value.trim() !== "") {
          // A confirm that changes nothing must still close the narrative: without
          // this a screen reader hears "Renaming X" and then silence, which is
          // indistinguishable from the edit still being open.
          if (!commitRename(id, value) && mode === "confirm") {
            ctx.announce(`Rename finished, keeping ${label}`);
          }
        }
        if (focus) {
          restoreFocusAfterEdit(t?.el);
        }
      }

      // hideTabMenu / showTabMenu drive the right-click menu. showTabMenu rebuilds
      // the items for the target tab (disabled states reflect its position) and
      // clamps into the visible viewport, flipping above the pointer near the
      // bottom edge (mirrors context-menu.ts).
      //
      // menuSwallow covers the contextmenu-then-touchend race: iPadOS Safari
      // raises a context menu from a LONG-PRESS, and the same gesture emits a
      // click on release which onDocClickMenu would read as a click-away. The
      // terminal menu has guarded this since it shipped; this one did not, so a
      // long-pressed tab menu closed itself on release — on the one platform
      // where the desktop strip is the chrome you touch. menuTouch records
      // whether the press that raised the menu was a finger, since only touch
      // emits that trailing click.
      const menuSwallow = createClickSwallow();
      let menuTouch = false;
      // One listener on the bar rather than one per chip: chips are created and
      // destroyed as sessions come and go, and both facts recorded here (the
      // gesture's pointer type, and whether it took the keyboard off the
      // terminal) belong to the gesture, not to a chip.
      bar.addEventListener(
        "pointerdown",
        (e) => {
          menuTouch = e.pointerType === "touch";
          noteChromePress();
          notifier.gesture();
        },
        { passive: true },
      );
      // The switcher's half of that snapshot (its rows and the x are buttons, so
      // pressing one focuses it and blurs the terminal exactly as a chip does).
      // It is also the mobile half of the notification-permission gesture.
      switcher.addEventListener(
        "pointerdown",
        () => {
          noteChromePress();
          notifier.gesture();
        },
        { passive: true },
      );
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
      function tabMenuSeparator(): void {
        const hr = document.createElement("div");
        hr.className = "wt-tab-menu-sep";
        hr.setAttribute("role", "separator");
        tabMenu.appendChild(hr);
      }
      function showTabMenu(x: number, y: number, id: string): void {
        hideTabMenu();
        const idx = tabList.findIndex((t) => t.id === id);
        const target = tabList[idx];
        if (idx < 0 || !target) {
          return;
        }
        const n = tabList.length;
        // The naming pair goes FIRST, farthest from the accidental-close zone.
        tabMenuItem("Rename\u2026", false, () => {
          beginEdit(id, "pointer");
        });
        // Always present, disabled when there is no pin — matching the menu's
        // existing rule for Move left / Close to the right. Not for consistency's
        // own sake: an item that appeared only sometimes would shift every close
        // item up or down by a row depending on whether the tab happens to be
        // renamed, so right-clicking two tabs and clicking the same point could
        // reset a name on one and close tabs on the other.
        tabMenuItem("Use automatic name", !hasPinnedName(target), () => {
          commitRename(id, ""); // the same operation an emptied, confirmed edit performs
        });
        tabMenuSeparator();
        tabMenuItem("Move left", idx <= 0, () => {
          moveTab(id, -1);
        });
        tabMenuItem("Move right", idx >= n - 1, () => {
          moveTab(id, 1);
        });
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
        if (menuTouch) {
          menuSwallow.arm();
        }
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

      // applyStatus updates one tab's dot (status + reveal) + titles from a status
      // record (shared by the SSE monitor and the polling fallback). It takes the
      // record whole rather than as positional fields: both callers already hold
      // one, and its title fields are interchangeable strings that as positional
      // parameters would be trivially swappable. reports is the server's sticky reportsActivity flag, passed
      // separately because it is normalised (reportsOf) before it gets here.
      function applyStatus(rec: StatusRecord, reports: boolean): void {
        const t = tabList.find((tab) => tab.id === rec.id);
        if (!t) {
          return;
        }
        t.reports = reports;
        paintStatusDot(t.dot, rec.status, reports);
        // The OSC 9;4 percentage. Only an explicitly PRESENT value updates the
        // tab: the polling fallback lists SessionInfo, which carries no
        // percentage at all, and reading that absence as "cleared" would blank a
        // live bar on every poll tick. The spec's own clear (OSC 9;4;0, or the
        // abbreviated form) arrives as an explicit -1; the only other clear is
        // the process ending, applied at render time (renderedProgress). No
        // timer, and nothing special about 100%.
        if (rec.progressValue !== undefined) {
          t.progress = normalizeProgress(rec.progressValue);
        }
        paintProgress(t.progressEl, shownProgress(t));
        // A session that reports activity is a session whose program speaks OSC 9,
        // so it is also one that may post a notification: arm the permission
        // request for the next user gesture (see notify.ts).
        if (reports) {
          notifier.arm();
        }
        // Latest-wins background-tab notification for the switch button's dot: a
        // background tab (not the active one) reaching "input" (needs you) or
        // "done" (turn finished) raises the cue in that colour; each qualifying
        // event overwrites the prior one, and expandSwitcher clears it when the
        // list opens. The active surface keeps its own needs-input cue (see
        // syncMobile); this is the moved + upgraded, glanceable version on the
        // dedicated button.
        //
        // Both statuses are LATCHED server-side, so this runs on re-delivered
        // state as well as on genuine transitions: every SSE (re)open pushes a
        // snapshot and the poll fallback re-lists every few seconds. What makes a
        // dismissal stick across those is cueSeen — a latch this viewer already
        // acknowledged raises nothing, while a status that moved on drops the
        // acknowledgement so the next latch is a fresh cue.
        if (!isCueStatus(rec.status)) {
          forgetCueSeen(rec.id);
        } else if (rec.id === activeId) {
          // The user is looking at this terminal as it latches, so there is
          // nothing to notify — and nothing to re-raise once they move away.
          markCueSeen(rec.id, rec.status);
        } else if (cueSeen.get(rec.id) !== rec.status) {
          switchNotify = rec.status;
          switchNotifyId = rec.id;
          paintSwitchDot();
        }
        // Record the raw server title; the displayed label (fallback + de-dup)
        // is recomputed by relabelAll via syncChrome, which the callers run
        // right after applyStatus. Ignore a BLANK title: a status sweep (or the
        // process clearing its OSC 0/2 window title) reports an empty string,
        // and overwriting a good label with it dropped an idle tab back to "New
        // tab". Hold the last known title until a genuine (non-blank) one
        // arrives; the derived-from-input fallback is likewise sticky.
        // The typeof check is not redundant with the type: rec comes from
        // unvalidated server JSON, and a missing title would make .trim() throw
        // here and abort the caller's whole reconcile loop.
        if (typeof rec.title === "string" && rec.title.trim() !== "") {
          t.title = rec.title;
        }
        // The pinned name is likewise authoritative and un-guarded, and "" is the
        // meaningful value: it is how a clear made in ANOTHER browser reaches this
        // one. A blank-guard here would make a remote un-rename invisible.
        //
        // The nameSeq bump is gated on the value actually DIFFERING from what we
        // believe. The wire carries pinnedTitle on every status event, so bumping
        // unconditionally would mark an in-flight local rename as superseded by
        // the server's echo of that same rename — and its failure handler would
        // then decline to roll back or explain itself. A differing value really is
        // newer authority (a remote rename or clear), and supersedes.
        if (rec.pinnedTitle !== undefined && rec.pinnedTitle !== (t.pinnedTitle ?? "")) {
          t.pinnedTitle = rec.pinnedTitle;
          // Only a value arriving with no request of ours in flight is newer
          // AUTHORITY. During a pending request the record may predate our own PUT
          // (SSE delivery and REST mutation are not one total order), and bumping
          // would suppress that request's rollback and its failure toast.
          if (!namesInFlight.has(rec.id)) {
            t.nameSeq++;
          }
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
            applyStatus(info, reportsOf(info.reportsActivity));
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
          // The status record IS the session's wire shape (SessionStatus extends
          // SessionInfo), so it flows through whole.
          adoptSession(s);
          applyStatus(s, reportsOf(s.reportsActivity));
          ensureActive();
          syncChrome();
          // A notification is an EVENT the engine delivers once, on the sweep
          // that first observes it, so it is handled here rather than in
          // applyStatus (which also runs on re-delivered STATE). Delivered after
          // syncChrome so the notification's title is the label the user would
          // see. The status record is the notification's carrier whether or not
          // the server has a classifier installed.
          notifier.deliver(s, {
            sessionIsActive: s.id === activeId,
            label: tabList.find((t) => t.id === s.id)?.display ?? s.title,
            // What clicking the notification does. The platform's own click
            // default focuses the page; this supplies the other half, landing the
            // user on the session that raised the notification rather than on
            // whichever tab they last left active. switchTo already no-ops on an
            // id that is gone, which is the case that matters here: the prompt may
            // have been answered, or the tab closed, between post and click.
            activate: () => {
              switchTo(s.id);
            },
          });
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
      // No input observer. The ENGINE derives a session's name from the input
      // stream when its host asked for that (terminal.WithInputTitle), so no preset
      // does per-keystroke title work in the browser, and the name is identical for
      // every client attached to the session — including one that attaches later.
      // Observe (never consume) keydowns to detect a physical keyboard: a
      // hardware-only key latches sawHardwareKey, which upgrades focus-on-switch
      // for a keyboard folio with no trackpad (no fine pointer to key off).
      const offHwKey = ctx.registerKeydown((ev) => {
        if (!sawHardwareKey && looksLikeHardwareKey(ev)) {
          sawHardwareKey = true;
        }
        return false;
      });
      // Live reorder while dragging a tab over the strip (drop/dragend commit it).
      bar.addEventListener("dragover", (e) => {
        if (!draggingEl) {
          return;
        }
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "move";
        }
        scroller.insertBefore(draggingEl, dragTargetBefore(e.clientX));
      });
      // Commit on drop — and, load-bearing, CANCEL the drop's default action. An
      // uncancelled drop leaves the browser free to act on the drag payload
      // itself, and WebKit's action is to LOAD it as a URL: with no drop handler
      // at all, dropping a tab on iPadOS navigated the page to /<session-id>
      // instead of reordering. Chrome and Firefox ignore an unhandled reorder
      // drop, which is why the strip looked fine on the desktop.
      bar.addEventListener("drop", (e) => {
        if (!draggingEl) {
          return;
        }
        e.preventDefault();
        syncOrderFromDom();
      });
      // A tab released anywhere OTHER than the strip — over the terminal, over
      // any other chrome — must be inert as well, not a navigation, so claim the
      // whole document as a drop target for the life of a tab drag and swallow
      // the drop there too. dragend still commits whatever order the strip was
      // previewing. Gated on draggingEl so an unrelated drag (a file dropped on
      // the page) is left entirely to the browser.
      const onDocTabDrop = (e: DragEvent): void => {
        if (draggingEl) {
          e.preventDefault();
        }
      };
      document.addEventListener("dragover", onDocTabDrop);
      document.addEventListener("drop", onDocTabDrop);
      // Active-row close (x): closes the current tab (mirrors a listed row's x).
      // stopPropagation so it is not read as a tap/swipe on the row surface.
      swClose.addEventListener("click", (e) => {
        e.stopPropagation();
        if (activeId !== null) {
          void close_(activeId);
        }
      });
      // Dismiss the tab context menu on an outside click, on Escape, and on a
      // scroll of the strip itself (which moves the chip the menu is anchored to).
      const onDocClickMenu = (): void => {
        // The trailing click of the long-press that just opened the menu is that
        // gesture's own release, not a click-away.
        if (menuSwallow.swallowing()) {
          return;
        }
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
      // Only a scroll that moves the menu's ANCHOR dismisses it, which is the
      // strip's own horizontal scroller and nothing else: the menu is placed
      // root-relative (menu-position.ts rebases onto the offsetParent), so any
      // scroll that moves .wt-root moves the menu with it, and the terminal's
      // scroller does not move the chip at all.
      //
      // The target check is load-bearing, not a micro-optimization. This listener
      // is capture-phase on window, so it sees EVERY scroll in the document —
      // including the terminal surface auto-scrolling to the bottom on each chunk
      // of output. Without the check, an agent printing into the TUI closed the
      // tab menu within a frame of it opening, which is unusable on exactly the
      // screen the menu exists for (a busy multi-agent strip).
      const onScrollMenu = (e: Event): void => {
        const target = e.target;
        if (target instanceof Element && target.closest(".wt-tab-scroll")) {
          hideTabMenu();
        }
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
        // Spawn a fresh session unless a LIVE one is listed. An ended session
        // (exited cleanly OR crashed) is viewable history, not a working
        // terminal — booting a page whose every session has died (the agent
        // exited: a sign-in dead end, a crash) onto a corpse was the
        // stuck-loading wedge. The dead ones are still adopted below (switch to
        // them to read their final screen; close them by hand).
        if (!sessions.some((s) => !isEndedStatus(s.status))) {
          try {
            sessions = [...sessions, await createSessionHonouringRetry(api, ctx, () => tornDown)];
          } catch (err) {
            // Match the runtime create() path: toast and leave the chrome up so
            // "+" can retry. Any exited sessions stay adopted (frozen screen +
            // "Session ended" is still better than a blank page). A throw here
            // would also be survivable (the kernel treats a rejected resolver
            // as null), but the toast is the better UX. A 503 was already
            // retried on the server's schedule, so this is the give-up path;
            // carry the server's explanation when it gave one.
            ctx.toast(
              err instanceof SessionAPIError && err.serverMessage !== undefined
                ? `Couldn't open a terminal: ${err.serverMessage}`
                : "Couldn't open a terminal",
            );
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
        // Live sessions outrank ended ones (exited or crashed): the saved id is
        // honored only while its session is still live (a reload used to restore
        // straight onto the corpse of a died-while-away session and wedge
        // there), and the default is the oldest LIVE tab. Only when nothing is
        // live (the fresh-spawn above failed too) does a dead tab start — a
        // frozen final screen with the "Session ended" banner beats a blank
        // page.
        const liveIds = new Set(sessions.filter((s) => !isEndedStatus(s.status)).map((s) => s.id));
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
          tornDown = true;
          resolveImpl = null;
          offStatus?.();
          offStreamOpen?.();
          offHwKey();
          offArmed?.();
          offMenuKey();
          document.removeEventListener("click", onDocClickMenu);
          document.removeEventListener("contextmenu", onDocContextMenu);
          document.removeEventListener("pointerup", onDocTapDismiss, true);
          document.removeEventListener("dragover", onDocTabDrop);
          document.removeEventListener("drop", onDocTabDrop);
          window.removeEventListener("scroll", onScrollMenu, true);
          if (pollTimer !== null) {
            clearInterval(pollTimer);
          }
          barResize.disconnect();
          swReserve.disconnect();
          stopInkCentring();
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
          endEdit(); // abandon an open rename without issuing a request
          clearDragGhost();
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
