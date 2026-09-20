// Showing a tab re-points a pane's renderer at the tab's cached store before the
// reconnect, so the last-known screen paints instantly and the delta arrives
// after.

import type {
  PaneHandle,
  PaneLayoutOwnerRegistration,
  PaneSide,
  TerminalContext,
  TerminalFeature,
  Unsubscribe,
} from "../../kernel/types.js";
import { isPaneSide, MIN_SPLIT_AREA_PX } from "../../kernel/layout-policy.js";
import { windowOf } from "../../kernel/realm.js";
import type { ActivityMonitorApi } from "../activity-monitor.js";
import type { MobileToolbarApi } from "../mobile-toolbar.js";
import { fromHTML, holdFocusOnPress } from "../dom.js";
import { createClickSwallow, placeMenuAt } from "../menu-position.js";
import { centreChipLabels } from "./ink-centre.js";
import { SWITCH_ANIMATIONS, SWITCH_CLASSES } from "./switch-anim.js";
import type { CueStatus, PaneLayout, SessionInfo, StatusRecord, Tab } from "./model.js";
import {
  CUE_SEEN_KEY,
  MAX_PERSISTED_CUE_SEEN,
  MAX_PINNED_NAME,
  PROGRESS_ABSENT,
  SWIPE_HINT_KEY,
  SessionAPIError,
  baseLabel,
  compareTabOrder,
  createSessionAPI,
  createTombstones,
  cueIconName,
  foldedCueStatus,
  hasPinnedName,
  isCueStatus,
  isEndedStatus,
  isUnseenCue,
  normalizeActivity,
  normalizeActivityCount,
  normalizeProgress,
  orderedInsertIndex,
  parseCueSeen,
  renderedProgress,
  sanitizePinnedName,
  serializeCueSeen,
  statusPhrase,
  summarizeCues,
  tabAccessibleName,
} from "./model.js";
import {
  REORDER_MOVE_EPS_PX,
  REORDER_REST_MS,
  REORDER_STILL_MS,
  REORDER_SETTLE_MS,
  REORDER_SHIFT_TRANS,
  REORDER_SLOT_FADE_MS,
  TAB_HTML,
  kbButtonHTML,
  newButtonHTML,
  paintActivityMark,
  paintProgress,
  paintStatusDot,
  pick,
  splitButtonHTML,
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
// The mobile switcher is used only on a narrow coarse-pointer device, in EITHER
// orientation; a big touchscreen and every fine-pointer device get the strip.
const DEFAULT_POLL_MS = 4000;
// A PRIVATE drag type, not text/plain: WebKit resolves dropped plain text as a
// URL and NAVIGATES to it when no handler cancels the drop, so a bare session id
// loaded /<session-id> on iPadOS. It also keeps the id out of the pasteboard.
const TAB_DRAG_TYPE = "application/x-web-terminal-tab";

/** The value a peer or a host reads through `ctx.use(tabs(...))`. `create` and
 *  `close` are server round trips and NEITHER rejects: a refusal is toasted and
 *  the promise resolves anyway, so read `list` for the outcome. `create` shares
 *  an in-flight create, so a duplicate activation opens one terminal. `list` is a
 *  snapshot of display data, not a live view. */
export interface TabsApi {
  /** Spawn a fresh session and show it where a tab click would land it. Calls
   *  made while a create is in flight share that create, so one gesture opens
   *  exactly one terminal. */
  create(): Promise<void>;
  /** Close a session (kills its process) and drop its tab + cache. */
  close(id: string): Promise<void>;
  /** Show a tab: in the first empty pane, else in the selected pane; a tab a
   *  pane already shows has that pane selected instead. */
  switchTo(id: string): void;
  /** Show a tab on one side of the split, opening it when closed; whatever that
   *  side showed becomes an ordinary tab, the tab's old side is emptied, and the
   *  tab's pane is selected. False when refused: an unknown id, an invalid side,
   *  or a split the pane row is too narrow to open. */
  snap(id: string, side: PaneSide): boolean;
  /** The current tabs, first-to-last by creation; `active` marks a tab a pane
   *  shows. */
  list(): readonly { id: string; title: string; active: boolean }[];
}

/** Options for the tabs feature. The two feature-valued members must be the SAME
 *  values the composition includes, ordered before tabs (`ctx.use` only resolves
 *  a peer already set up) and marked `scope: "shell"`, since a pane feature's api
 *  is not visible at the shell. Both degrade rather than fail when absent. */
export interface TabsOptions {
  /** REST base for the session API (default "/api/sessions"). */
  apiBase?: string;
  /** The activityMonitor feature value, for live status dots and dropping
   *  exited tabs. Without it, tabs polls the session list (see pollMs). */
  activityMonitor?: TerminalFeature<ActivityMonitorApi>;
  /** Poll interval in ms for the no-activityMonitor fallback (default 4000). */
  pollMs?: number;
  /** The mobileToolbar feature value, built with { externalToggle: true }, so
   *  the mobile switcher bar renders a keyboard button that opens the key grid. */
  keyboardToggle?: TerminalFeature<MobileToolbarApi>;
  /** Presume every session reports activity (an agent shell): each tab's dot is
   *  visible as idle from creation instead of popping in when the agent first
   *  reports. Default false, so a plain shell keeps clean, label-only tabs. */
  presumeReports?: boolean;
  /** Swap the page's icon links to a status variant while a background session
   *  holds an unacknowledged cue. Default false, because it needs assets the
   *  library cannot ship: for every `link[rel=icon]` whose filename starts with
   *  `favicon`, variants with `-input`, `-done` and `-alert` inserted after that
   *  token must be served (`/favicon-32x32.png` needs `/favicon-input-32x32.png`),
   *  and a missing one is a blank tab icon. Safari ignores later icon changes; the
   *  title count is not gated on this, so nothing is lost there. */
  attentionIcons?: boolean;
}

/** Session creation can be TEMPORARILY refused: a host answers 503 with
 *  `Retry-After` and a body message while it installs tools on first boot, a
 *  window that can run twenty minutes. Only 503 retries, on the server's own
 *  schedule and repeating its own explanation. The bound is ELAPSED TIME, not an
 *  attempt count, which at `Retry-After: 5` would give up in a minute; every
 *  iteration sleeps at least the hint, so this is never a hot loop, and the user
 *  is re-told periodically. */
const CREATE_RETRY_MAX_TOTAL_MS = 1200000;
const CREATE_RETRY_FALLBACK_MS = 5000;
const CREATE_RETRY_REANNOUNCE_MS = 60000;

/** A backlog that never drains (the socket drops mid-replay) must not leave a
 *  "Catching up" badge on screen forever. */
const CATCHUP_MAX_MS = 30000;
/** The render queue empties BETWEEN the server's replay chunks, so a bare "queue
 *  is empty" test declares victory several times per restore. */
const CATCHUP_SETTLE_MS = 250;
/** The renderer builds at most 300 rows per frame, so a backlog above this needs
 *  multiple frames; ordinary streaming must never arm the cue. */
const CATCHUP_MIN_BACKLOG = 400;

/** The acknowledged background-tab cues, or an empty map when storage throws or
 *  holds nothing trustworthy: the dot simply lights again. */
function readCueSeen(win: Pick<Window, "localStorage">): Map<string, CueStatus> {
  try {
    return parseCueSeen(win.localStorage.getItem(CUE_SEEN_KEY));
  } catch {
    return new Map<string, CueStatus>();
  }
}

/** writeCueSeen persists acknowledgements, best-effort: a full quota must not
 *  break the dismissal the user just performed on screen. */
function writeCueSeen(
  win: Pick<Window, "localStorage">,
  seen: ReadonlyMap<string, CueStatus>,
): void {
  try {
    win.localStorage.setItem(CUE_SEEN_KEY, serializeCueSeen(seen));
  } catch {
    /* storage unavailable or full — the dismissal still holds for this page */
  }
}

/** A wait the feature's teardown ends early: the timer goes with the feature. */
function retryWait(win: Window, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = win.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      win.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Create a session, honouring the server's retry schedule, for as long as
 *  `signal` stays live: an abort ends the wait and throws its reason, and a
 *  create that finishes after the abort is closed rather than returned, because
 *  the page that asked for it has no tab left to hold it. */
async function createSessionHonouringRetry(
  api: { create: () => Promise<SessionInfo>; close: (id: string) => Promise<void> },
  ctx: TerminalContext,
  signal: AbortSignal,
): Promise<SessionInfo> {
  const win = windowOf(ctx.shell.root.ownerDocument);
  const startedAt = win.Date.now();
  // Null, NOT a 0 sentinel: elapsed is legitimately 0 when a host on the same
  // machine refuses inside the first millisecond.
  let lastAnnouncedAt: number | null = null;
  for (;;) {
    signal.throwIfAborted();
    let info: SessionInfo;
    try {
      info = await api.create();
    } catch (err) {
      signal.throwIfAborted();
      const elapsed = win.Date.now() - startedAt;
      if (
        !(err instanceof SessionAPIError) ||
        err.status !== 503 ||
        elapsed >= CREATE_RETRY_MAX_TOTAL_MS
      ) {
        throw err;
      }
      // "waiting", not "retrying": the server only said "not yet", and the first
      // announcement fires before any retry has happened.
      if (lastAnnouncedAt === null || elapsed - lastAnnouncedAt >= CREATE_RETRY_REANNOUNCE_MS) {
        lastAnnouncedAt = elapsed;
        const reason = err.serverMessage ?? "Server is not ready yet";
        ctx.toast(`${reason}; waiting…`, 8000);
        ctx.announce(`${reason}; waiting…`);
      }
      // Unthrottled: the overlay is the only surface visible before the first
      // frame, and it replaces text in place.
      ctx.loadingReason(`${err.serverMessage ?? "Server is not ready yet"}; waiting…`);
      await retryWait(win, err.retryAfterMs ?? CREATE_RETRY_FALLBACK_MS, signal);
      continue;
    }
    if (signal.aborted) {
      void api.close(info.id).catch((err: unknown) => {
        console.warn(
          `web-terminal-ui: session ${info.id} was created after teardown and could not be closed`,
          err,
        );
      });
      signal.throwIfAborted();
    }
    return info;
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

/** Build the tabs feature.
 *  Requires a server that speaks the session API (`GET`/`POST`/`DELETE` on
 *  `/api/sessions`, `?session=<id>` on the WebSocket, ideally the status SSE).
 *  It registers as the terminal's `paneLayoutOwner`, so it decides which session
 *  the first connect attaches to; two owners fail at `kernel-init`. The strip's
 *  order and the pane layout are SERVER state every viewer shares; the dismissed
 *  cues are per-viewer in `localStorage`. Teardown removes the chrome and leaves
 *  the sessions running; closing a tab is what kills a process. */
export function tabs(opts: TabsOptions = {}): TerminalFeature<TabsApi> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const presumeReports = opts.presumeReports ?? false;
  const reportsOf = (reports?: boolean): boolean => presumeReports || (reports ?? false);

  // The registration must exist on the feature VALUE, read before setup, while
  // its members need setup-scoped state; setup() wires the closure.
  let live: PaneLayoutOwnerRegistration | null = null;
  return {
    name: "tabs",
    scope: "shell",
    paneLayoutOwner: {
      resolveInitialLayout: () => live?.resolveInitialLayout() ?? Promise.resolve(false),
      shownIn: (side) => live?.shownIn(side) ?? null,
      showIn: (side, id) => live?.showIn(side, id) ?? false,
    },
    setup(ctx: TerminalContext) {
      const doc = ctx.shell.root.ownerDocument;
      const win = windowOf(doc);
      const api = createSessionAPI(apiBase, win);
      // Every request continuation and retry wait checks this after its await, so
      // nothing this feature started can touch the chrome, a pane or the server
      // once the feature is gone.
      const lifetime = new AbortController();
      ctx.defer(() => {
        lifetime.abort();
      });
      // A live read: a plain property read is narrowed to always-false by TS CFA,
      // which cannot model the abort firing during an await.
      const tornDown = (): boolean => lifetime.signal.aborted;
      const tablist = ctx.tablist();
      const monitor = opts.activityMonitor ? ctx.use(opts.activityMonitor) : undefined;

      // Every keyboard button (the switcher's and the strip's) reflects the grid's
      // open state and the sticky-Ctrl armed state.
      const kbButtons: HTMLElement[] = [];
      function makeNewButton(cls: string): HTMLElement {
        const btn = fromHTML(doc, newButtonHTML(cls));
        // Keeps the keyboard on the terminal and paints its own press state;
        // holdFocusOnPress explains why those two are one job. It does NOT make
        // one press one activation — that is create()'s in-flight coalescing,
        // for the opposite failure.
        ctx.defer(holdFocusOnPress(btn));
        btn.addEventListener("click", () => {
          void create();
        });
        return btn;
      }
      function makeKbButton(cls: string): HTMLElement {
        const btn = fromHTML(doc, kbButtonHTML(cls));
        ctx.defer(holdFocusOnPress(btn));
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
      // Both split buttons (the strip's and the switcher's) toggle the split and
      // reflect its state; a terminal built without the split option has none.
      const splitButtons: HTMLElement[] = [];
      function makeSplitButton(cls: string): HTMLElement | null {
        if (!ctx.shell.split.enabled) {
          return null;
        }
        const btn = fromHTML(doc, splitButtonHTML(cls));
        ctx.defer(holdFocusOnPress(btn));
        btn.addEventListener("click", () => {
          const split = ctx.shell.split;
          if (split.isOpen()) {
            split.close();
          } else {
            split.open();
          }
        });
        splitButtons.push(btn);
        return btn;
      }
      function rowFitsSplit(): boolean {
        return ctx.shell.root.clientWidth >= MIN_SPLIT_AREA_PX;
      }
      function paintSplitButtons(): void {
        const open = ctx.shell.split.isOpen();
        const hidden = !rowFitsSplit();
        for (const b of splitButtons) {
          b.hidden = hidden;
          b.setAttribute("aria-expanded", String(open));
        }
        // Two selected tabs are a valid state exactly while two panes are shown.
        if (open) {
          scroller.setAttribute("aria-multiselectable", "true");
        } else {
          scroller.removeAttribute("aria-multiselectable");
        }
      }
      // makeSwitchButton builds the mobile switcher's dedicated open/close
      // button (its notification dot is painted by paintSwitchDot). Like the
      // other bar buttons it goes through holdFocusOnPress; its click toggles the
      // list (toggleSwitcher opens when collapsed, closes when expanded).
      function makeSwitchButton(): HTMLElement {
        const btn = fromHTML(doc, switchButtonHTML("wt-switcher-switch wt-btn"));
        ctx.defer(holdFocusOnPress(btn));
        btn.addEventListener("click", () => {
          toggleSwitcher();
        });
        return btn;
      }

      // The bar never scrolls; the inner scroller holds ONLY the tabs, and the
      // "+" and keyboard buttons sit outside it as fixed bar items, so an
      // overflowing tab list can never push or scroll either control away.
      const slot = ctx.region("top-bar", "tabs");
      const bar = doc.createElement("div");
      bar.className = "wt-tab-bar";
      slot.appendChild(bar);
      const scroller = doc.createElement("div");
      scroller.className = "wt-tab-scroll";
      scroller.setAttribute("role", "tablist");
      bar.appendChild(scroller);
      const newBtn = makeNewButton("wt-tab-new");
      bar.appendChild(newBtn);
      const deskSplit = makeSplitButton("wt-tab-split wt-btn");
      if (deskSplit !== null) {
        bar.appendChild(deskSplit);
      }
      const deskKb = makeKbButton("wt-tab-kb wt-btn");
      bar.appendChild(deskKb);
      // A vertical wheel over the strip scrolls the tab list horizontally, the
      // affordance browser tab bars train. Non-passive because a translated tick
      // must preventDefault so an embedding page does not also scroll.
      bar.addEventListener(
        "wheel",
        (e) => {
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
            return;
          }
          if (scroller.scrollWidth <= scroller.clientWidth) {
            return;
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

      // Every pane's surface clears the strip, the one a later open builds too;
      // the measured strip height is published on the shell ROOT, not a surface:
      // the scroll-to-bottom button sits in a sibling region, so a property set on
      // .term would not reach it and it would overlap the strip.
      const markSurfaces = (): void => {
        for (const p of ctx.shell.panes()) {
          p.surface().classList.add("wt-with-tabbar");
        }
      };
      markSurfaces();
      ctx.defer(() => {
        for (const p of ctx.shell.panes()) {
          p.surface().classList.remove("wt-with-tabbar");
        }
      });
      const varRoot = ctx.shell.root;
      const barResize = new win.ResizeObserver(() => {
        varRoot.style.setProperty("--wt-tabbar-h", `${String(bar.offsetHeight)}px`);
      });
      barResize.observe(bar);
      ctx.defer(() => {
        barResize.disconnect();
      });

      const switcher = fromHTML(doc, SWITCHER_HTML);
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
      // The active row's secondary activity mark, scoped for the same reason.
      const swActivity = pick(switcher, ".wt-switcher-current .wt-activity-mark");
      const swClose = pick(switcher, ".wt-switcher-current-close");
      // The active-tab elements that translate together during a horizontal
      // swipe: the content (dot + label) and the close (x). Moving both keeps the
      // whole active-tab chip sliding as one, rather than the close staying put.
      const swipeEls = [swInner, swClose];
      // The mobile "+", keyboard, split and switcher buttons: built + wired by
      // the SAME shared factories as the desktop strip's, then appended to the
      // bar row so the order stays current-wrap | keyboard | split | switch | "+".
      // Unifying the controls means one implementation placed per layout rather
      // than duplicated markup. The switch button sits BETWEEN the split and "+":
      // it toggles the list and carries the moved background-tab attention cue.
      const swKb = makeKbButton("wt-switcher-kb wt-btn");
      const swSplit = makeSplitButton("wt-switcher-split wt-btn");
      const swSwitch = makeSwitchButton();
      const swSwitchDot = pick(swSwitch, ".wt-switcher-switch-dot");
      const swNew = makeNewButton("wt-switcher-new wt-btn wt-switcher-new-btn");
      swBar.append(swKb, ...(swSplit === null ? [] : [swSplit]), swSwitch, swNew);
      // Latest-wins cue for the switch button's dot, cleared when the list opens or
      // the raising tab is visited or closed; "" is no pending cue.
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
      const cueSeen = readCueSeen(win);
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
        writeCueSeen(win, cueSeen);
        // An acknowledgement can change the unseen count without touching the tab
        // list, so syncChrome's sweep is not enough on its own: opening the tray
        // and arriving on a tab both land here and neither adds or removes a chip.
        paintAttention();
      }
      // forgetCueSeen drops an acknowledgement, so the session's NEXT input/done
      // is a fresh cue: called when its status moves off the acknowledged value
      // (a new working phase, an exit) and when the session goes away.
      function forgetCueSeen(id: string): void {
        if (cueSeen.delete(id)) {
          writeCueSeen(win, cueSeen);
          paintAttention();
        }
      }
      // The out-of-page surfaces render the SAME unseen-cue set the switch dot
      // shows, fed only through paintAttention below.
      const attention = ctx.shell.attention({ icons: opts.attentionIcons === true });
      // visibilityState, not document.hasFocus(), which is false for a
      // visible-but-unfocused window where the terminal IS on screen.
      function pageVisible(): boolean {
        return doc.visibilityState !== "hidden";
      }

      // The DEFERRED half of the shown-tab acknowledgement: a cue that latched on
      // a hidden page raised the out-of-page surfaces and is acknowledged when the
      // user can see the terminal. The SHOWN tabs only: blanking a background
      // tab's cue the viewer never saw loses the thing they came back for.
      function onPageVisible(): void {
        if (!pageVisible()) {
          return;
        }
        for (const t of tabList) {
          if (isShown(t.id)) {
            markCueSeen(t.id, statusOf(t));
          }
        }
      }
      doc.addEventListener("visibilitychange", onPageVisible);
      ctx.defer(() => {
        doc.removeEventListener("visibilitychange", onPageVisible);
      });

      // A FOLD over the tab list rather than incremental bookkeeping: no state of
      // its own can go stale, and the shell no-ops when nothing changed.
      function paintAttention(): void {
        const { count, worst } = summarizeCues(
          tabList.map((t) => ({ id: t.id, status: cueStatusOf(t) })),
          cueSeen,
        );
        attention.report({ count, icon: worst === "" ? null : cueIconName(worst) });
      }
      function paintSwitchDot(): void {
        // The dot carries .wt-status-dot, so data-status colours it like the tabs'
        // own dots, and its tooltip comes from their wording map, so the aggregate
        // cue names the state it shows.
        if (switchNotify === "") {
          delete swSwitchDot.dataset["status"];
          swSwitchDot.removeAttribute("title");
        } else {
          swSwitchDot.dataset["status"] = switchNotify;
          swSwitchDot.title = statusPhrase(switchNotify);
        }
        // The out-of-page surfaces answer to the same set, so they repaint
        // wherever this does: a raise, and every clear through clearSwitchNotify.
        paintAttention();
      }
      function clearSwitchNotify(): void {
        switchNotify = "";
        switchNotifyId = null;
        paintSwitchDot();
      }
      // The pending cue is resolved when its session is reached (a switch, a swipe
      // arriving on it) and moot when the session ceases to exist (a close, a
      // reap); opening the list alone does not clear it.
      function acknowledgeSwitchNotify(id: string): void {
        if (switchNotifyId === id) {
          clearSwitchNotify();
        }
      }
      ctx.region("bottom-switcher", "switcher").appendChild(switcher);
      // The keyboard buttons open the key grid; show them only when a toolbar is
      // wired to drive. Read the toolbar's API lazily at tap time (ctx.use), so
      // feature ordering does not matter.
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
          ctx.defer(kbApi.onCtrlArmedChange(reflectArmed));
        }
      }
      // Measured optical centring for every chip label in both layouts: writes
      // --label-ink-shift onto the strip and the switcher from the line box THIS
      // engine produced for THIS font at THIS size, rather than the em constant
      // in 00-tokens.css that can only be right at one size (see ink-centre.ts).
      ctx.defer(centreChipLabels(varRoot, { strip: bar, switcher }));

      // Mark the root so the CSS lifts the bottom-anchored chrome (banner, toast,
      // scroll-to-bottom, key grid) above the switcher bar on a coarse pointer.
      const root = ctx.shell.root;
      root.classList.add("wt-tabbed");
      // Reserve the collapsed bar row's height so terminal content stops above
      // it: viewport.ts adds --wt-reserve-bottom to the surface's
      // bottom inset (it reads the var off the surface, which inherits it from
      // the root). Measure the bar row (not the expandable list, which just
      // overlays content). innerHeight - rect.top captures the row plus the
      // safe-area beneath it; the RO fires with the keyboard closed, so the value
      // excludes the keyboard lift (viewport.ts adds that separately). The
      // synthetic visualViewport resize makes viewport.ts recompute immediately.
      const swReserve = new win.ResizeObserver(() => {
        const rect = swBar.getBoundingClientRect();
        const px = rect.height > 0 ? Math.max(0, Math.round(win.innerHeight - rect.top)) : 0;
        varRoot.style.setProperty("--wt-reserve-bottom", `${String(px)}px`);
        win.visualViewport?.dispatchEvent(new win.Event("resize"));
      });
      swReserve.observe(swBar);
      ctx.defer(() => {
        swReserve.disconnect();
      });

      // Fire-and-forget frames and timers, cancelled together at teardown so no
      // callback writes to a chip or a row this feature no longer owns.
      const frames = new Set<number>();
      const timers = new Set<number>();
      function frame(cb: () => void): void {
        const id = win.requestAnimationFrame(() => {
          frames.delete(id);
          cb();
        });
        frames.add(id);
      }
      function after(ms: number, cb: () => void): void {
        const id = win.setTimeout(() => {
          timers.delete(id);
          cb();
        }, ms);
        timers.add(id);
      }
      ctx.defer(() => {
        for (const id of frames) {
          win.cancelAnimationFrame(id);
        }
        for (const id of timers) {
          win.clearTimeout(id);
        }
        frames.clear();
        timers.clear();
      });

      // The tab menu is built on demand (as context-menu.ts builds its own) so
      // each item targets the right-clicked tab and its disabled state reflects
      // that tab's position.
      const tabMenu = doc.createElement("div");
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
      const tombstones = createTombstones(() => win.Date.now());
      // The expanded mobile list's row elements, keyed by tab id. Rows are
      // reused across re-renders (reconcile, not rebuild) so a swipe can FLIP the
      // same elements from their old slots to their new ones (the rotation).
      const rowEls = new Map<string, HTMLElement>();
      // Which tab each pane shows is the PANES' fact, read from them rather than
      // mirrored: the shell empties a pane on a close of the split without asking.
      function shownIn(side: PaneSide): string | null {
        const pane = ctx.shell.pane(side);
        return pane !== null && pane.state() === "shown" ? pane.session.id : null;
      }
      function sideOf(id: string): PaneSide | null {
        for (const p of ctx.shell.panes()) {
          if (p.state() === "shown" && p.session.id === id) {
            return p.side;
          }
        }
        return null;
      }
      const isShown = (id: string): boolean => sideOf(id) !== null;
      const anyShown = (): boolean => ctx.shell.panes().some((p) => p.state() === "shown");
      /** The tab that receives typing: the selected pane's. */
      const selectedId = (): string | null => shownIn(ctx.shell.selected());
      const otherSide = (side: PaneSide): PaneSide => (side === "left" ? "right" : "left");
      // Set by a bootstrap that showed nothing, cleared by the first showIn: the
      // one case a status event may pick a tab to show.
      let bootShowedNothing = false;
      // The coalesced layout write (scheduleLayoutWrite): one PUT per macrotask,
      // one in flight at a time, and a change during the flight sends the latest
      // state once it lands, so an older record can never become the server's.
      let layoutWrite: number | null = null;
      let layoutInFlight: Promise<void> | null = null;
      let layoutDirty = false;
      // The record is read once and never written back by a read.
      let applyingRecord = false;
      let warnedLayout = false;
      let draggingEl: HTMLElement | null = null;
      // The chips currently carrying an inline displacement from the commit slide.
      // A set plus one settle function, so whatever a slide wrote can always be handed
      // back to the stylesheet — including when a second drag interrupts the first.
      const shifted = new Set<HTMLElement>();
      let shiftTimer: number | null = null;
      // The no-events fallback timer. It carries its own target, so there is
      // deliberately NO pending-slot field here: one was the cause of the reorder
      // dropping commits (see trackRest). restX is the last pointer position seen, which
      // is how movement is told from stillness.
      let restTimer: number | null = null;
      let restX: number | null = null;
      // When the pointer last actually MOVED. A stationary dragover this long after it
      // is believed as a stop (see trackRest).
      let restMovedAt = 0;
      // Whether a `drop` fired for the drag in flight. It is the exact signal for
      // "the user released deliberately" as opposed to "the drag was abandoned":
      // Escape and a refused release fire dragend with no drop at all. dragend
      // without it reverts the preview, which is the cancel this reorder never had.
      let dropped = false;
      // The chip mid slot-fade, and the timer that ends it.
      let slotFadeEl: HTMLElement | null = null;
      let slotFadeTimer: number | null = null;
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
      let collapseClearTimer: number | null = null;
      let hintShown = false;
      // No web API reports a hardware keyboard, so two proxies: a fine pointer
      // (read live, since a keyboard folio with a trackpad can be detached) and a
      // keydown only a hardware keyboard emits (a trackpad-less folio).
      let sawHardwareKey = false;
      const hasFinePointer = (): boolean =>
        typeof win.matchMedia === "function" && win.matchMedia("(any-pointer: fine)").matches;
      const physicalKeyboardLikely = (): boolean => sawHardwareKey || hasFinePointer();
      const prefersReduce = (): boolean =>
        win.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // Recomputes every display label with de-duplication. The percentage prefix
      // is applied at render time and stored nowhere, so de-duplication and the
      // rename field see real names and clearing it needs no cleanup.
      function relabelAll(): void {
        // The "(k)" suffix is numbered by the session's AGE, never by its slot:
        // numbered by encounter order, the labels stayed put while the sessions
        // moved underneath them, so a reorder was invisible. Server createdAt
        // rather than the local `born` counter, so every device agrees which
        // "workspace" is (2). Recomputed over the LIVE group, so closing "(2)" of
        // three renumbers the survivor.
        const groups = new Map<string, Tab[]>();
        for (const t of tabList) {
          const { text, fallback } = baseLabel(t);
          // Several untitled tabs all read "New tab" with no numbering.
          if (fallback) {
            continue;
          }
          const group = groups.get(text);
          if (group) {
            group.push(t);
          } else {
            groups.set(text, [t]);
          }
        }
        const ordinals = new Map<Tab, number>();
        for (const group of groups.values()) {
          if (group.length < 2) {
            continue; // nothing to disambiguate from, so no suffix at all
          }
          [...group]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
            .forEach((t, i) => {
              ordinals.set(t, i + 1);
            });
        }
        for (const t of tabList) {
          const { text } = baseLabel(t);
          const k = ordinals.get(t);
          const display = k !== undefined && k > 1 ? `${text} (${String(k)})` : text;
          t.display = display;
          t.label.textContent = display;
          // The accessible name carries the state and the percentage as well as
          // the label: the dots are aria-hidden decoration and the progress bar
          // is a 2px line with no text, so without this a screen-reader user
          // cannot tell a working tab from a crashed one, or hear how far along
          // a determinate one is.
          t.aria.setLabel(
            tabAccessibleName({
              label: display,
              status: statusOf(t),
              progress: shownProgress(t),
              activity: t.activity,
              activityCount: t.activityCount,
            }),
          );
        }
      }

      /** statusOf reads a tab's current status back off its dot, which is where
       *  applyStatus records it (the dot is the one element that always has it,
       *  on every chip site). */
      function statusOf(t: Tab): string {
        return t.dot.dataset["status"] ?? "idle";
      }

      /** cueStatusOf folds a tab for the cue surfaces (foldedCueStatus). Off the
       *  DOT rather than the wire status, so a server's empty status arrives here
       *  as "idle" and cannot be mistaken for the blanked-cue sentinel. */
      function cueStatusOf(t: Tab): string {
        return foldedCueStatus(statusOf(t), t.activity);
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

      // A press on the chrome focuses the control it hit before the click handler
      // runs, so only a pointerdown-time snapshot knows whether the terminal input
      // held the keyboard; recorded per gesture, since chips come and go.
      let inputFocusedAtPress = false;
      function noteChromePress(): void {
        const el = termInput();
        inputFocusedAtPress = el !== null && doc.activeElement === el;
      }
      function keyboardParkedOnChrome(): boolean {
        const active = doc.activeElement;
        return active !== null && (bar.contains(active) || switcher.contains(active));
      }

      // The keyboard goes to the terminal input when a physical keyboard is likely
      // (on a keyboard-less touchscreen every switch would pop the soft keyboard)
      // or when the press behind this switch parked it on the chrome, where the
      // strip's own keydown handling would eat every keystroke; restoring what the
      // press displaced pops no keyboard. Never while a rename field is open.
      function focusAfterSwitch(): void {
        if (editingId !== null) {
          return;
        }
        if (physicalKeyboardLikely() || (inputFocusedAtPress && keyboardParkedOnChrome())) {
          focusInput();
        }
      }

      // Every shown chip renders active, with no difference between the two panes'
      // (selection is the handle's and the cursor's to show). The selected pane's
      // chip is revealed in the scroller only when THAT TAB CHANGES, so a user
      // browsing a scrolled strip is never yanked back by an unrelated repaint.
      let lastRevealedActive = "";
      function paintActive(): void {
        const open = ctx.shell.split.isOpen();
        for (const t of tabList) {
          const side = sideOf(t.id);
          const on = side !== null;
          t.el.classList.toggle("wt-tab-active", on);
          t.aria.setPanel(side);
          t.aria.setExpanded(open ? on : null);
          // setSelected would undo setEditing(true) on the chip hosting the rename
          // field within a tick; endEdit restores the semantics from the CURRENT
          // state.
          if (t.id !== editingId) {
            t.aria.setSelected(on);
          }
        }
        const current = selectedId();
        if (current !== null && current !== lastRevealedActive) {
          lastRevealedActive = current;
          const active = tabList.find((t) => t.id === current);
          if (active && typeof active.el.scrollIntoView === "function") {
            active.el.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        }
        paintSplitButtons();
      }

      // syncMobile updates the bottom bar: the selected pane's label + dot, and
      // the aggregate needs-input cue. The cue rides the active surface: a
      // background tab blocked on input is glanceable, and tapping/swiping opens
      // the list to resolve it.
      function syncMobile(): void {
        const current = selectedId();
        const active = tabList.find((t) => t.id === current);
        swLabel.textContent = active ? active.display : "";
        paintStatusDot(swDot, active ? statusOf(active) : "idle", active?.reports ?? false);
        paintProgress(swProgress, active ? shownProgress(active) : PROGRESS_ABSENT);
        paintActivityMark(swActivity, active?.activity ?? "", active?.activityCount ?? 0);
        // The aggregate background-notification cue rides the dedicated switch
        // button's dot (paintSwitchDot), not the active surface (it did not fit
        // there).
      }

      // buildRow creates one expanded-list row for a tab and wires its handlers
      // (select = switch + collapse; x = close). Its dot/label are filled by
      // updateRow. The element is cached in rowEls and reused across renders.
      function buildRow(t: Tab): HTMLElement {
        const row = fromHTML(doc, SWITCHER_ROW_HTML);
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
        paintActivityMark(pick(row, ".wt-activity-mark"), t.activity, t.activityCount);
        pick(row, ".wt-switcher-row-label").textContent = t.display;
      }
      // Rows are REUSED, never rebuilt, so their identity is stable for the swipe
      // FLIP; the order is circular from the tab after the active one, so a swipe
      // rotates it by one.
      function renderSwitcherList(): void {
        const n = tabList.length;
        const current = selectedId();
        const activeIdx = tabList.findIndex((t) => t.id === current);
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
              animateRowOut(el, lifetime.signal); // collapse + fade, then remove
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
            animateRowIn(row, lifetime.signal); // grow + fade in (the tray height follows)
          }
        }
        // The list animates its max-height to the REAL content height, not a fixed
        // 50dvh: the stretch past the content moved nothing, so the open finished
        // early and the close started late. scrollHeight is the full height under
        // the collapsed max-height:0 clip, and this needs no interpolate-size,
        // which iOS Safari lacks.
        const visH = win.visualViewport?.height ?? win.innerHeight;
        switcher.style.setProperty(
          "--wt-list-h",
          `${String(Math.min(swList.scrollHeight, Math.round(visH * 0.5)))}px`,
        );
      }

      // Drops the reused-row cache too, so the next expand cannot reuse a row
      // carrying a stale reel transform.
      function clearRows(): void {
        endReelNow();
        swList.replaceChildren();
        rowEls.clear();
      }

      // The expanded list rotates as a reel on a swipe: a FLIP over reused rows.
      // prepareReel (BEFORE the reconcile) snapshots row positions and lifts the
      // leaving row out of the flow as an absolute ghost so the reconcile cannot
      // reshuffle the survivors; the returned closure (AFTER it) inverts every
      // row to its old spot and releases it. Pixel positions, so the row gap and
      // separators cannot make it wrong.
      const REEL_MS = 300;
      let reelTimer: number | null = null;
      let reelGhost: HTMLElement | null = null;
      function endReelNow(): void {
        if (reelTimer !== null) {
          win.clearTimeout(reelTimer);
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
        const st = win.getComputedStyle(swList);
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
          // A forced reflow commits the from-state BEFORE the to-state, or the
          // browser collapses the two into one recalc and nothing animates. The
          // end opacity is explicit for the same reason; a bare "" never faded.
          // @starting-style does not apply: these rows are moved by a JS FLIP, not
          // toggled through display.
          swList.getBoundingClientRect();
          // Opacity shares the transform's easing so a row's fade tracks its
          // DISTANCE from its slot: transparent a pitch away, opaque once settled.
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
          reelTimer = win.setTimeout(endReelNow, REEL_MS);
        };
      }

      // syncChrome refreshes every surface after any state change. Idempotent.
      function syncChrome(): void {
        relabelAll();
        paintActive();
        syncMobile();
        // A single tab has nothing to switch to; aria-hidden and tabindex keep the
        // collapsed button out of the a11y tree and the tab order.
        const multiTab = tabList.length >= 2;
        switcher.classList.toggle("wt-switcher-multi", multiTab);
        swSwitch.setAttribute("aria-hidden", multiTab ? "false" : "true");
        swSwitch.tabIndex = multiTab ? 0 : -1;
        if (expanded) {
          renderSwitcherList();
        }
        maybeSwipeHint();
        applyServerOrder();
        // Every list mutation ends in syncChrome, so no path can forget the
        // out-of-page surfaces; the fold is idempotent and the sinks no-op.
        paintAttention();
      }

      // The percentage is deliberately NOT written into the document title: a page
      // has ONE title over many sessions, so any rule for whose percentage it shows
      // is arbitrary, and it churns the browser-tab label and bookmark name. The
      // unseen-cue COUNT is not a softening of this rule: it names no session.

      // The read half of tab-order sync, hung off syncChrome so no path can forget
      // it. Safe that often because it is a no-op when the strip already matches,
      // skipped mid-drag (the DOM then holds a preview not yet in tabList), and
      // sorted by the same order adoption inserts by.
      function applyServerOrder(): void {
        if (draggingEl !== null) {
          return;
        }
        const sorted = [...tabList].sort(compareTabOrder);
        let moved = false;
        for (let i = 0; i < sorted.length; i++) {
          if (sorted[i] !== tabList[i]) {
            moved = true;
            break;
          }
        }
        if (!moved) {
          return;
        }
        tabList.length = 0;
        tabList.push(...sorted);
        // appendChild MOVES an existing node, so one pass in the wanted sequence
        // both reorders the chips and leaves no duplicates behind.
        for (const tab of tabList) {
          scroller.appendChild(tab.el);
        }
        paintActive();
        syncMobile();
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

      // The RESTING state only: rows leave the a11y tree after the collapse
      // animation, and the inline styles the interactive drag writes are
      // expandSwitcher's and the drag release's to own.
      function setExpandedState(on: boolean): void {
        if (on) {
          if (collapseClearTimer !== null) {
            win.clearTimeout(collapseClearTimer);
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
            win.clearTimeout(collapseClearTimer);
          }
          collapseClearTimer = win.setTimeout(() => {
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
        const el = fromHTML(doc, TAB_HTML);
        const label = el.querySelector<HTMLElement>(".wt-tab-label");
        const dot = el.querySelector<HTMLElement>(".wt-tab-dot");
        const activityEl = el.querySelector<HTMLElement>(".wt-activity-mark");
        const progressEl = el.querySelector<HTMLElement>(".wt-progress-bar");
        const close = el.querySelector<HTMLButtonElement>(".wt-tab-close");
        if (!label || !dot || !activityEl || !progressEl || !close) {
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
          after(300, () => {
            el.classList.remove("wt-tab-enter");
          });
        }

        const tab: Tab = {
          id: info.id,
          born: ++tabEpoch,
          title: info.title,
          pinnedTitle: info.pinnedTitle,
          nameSeq: 0,
          display: "",
          createdAt: info.createdAt,
          order: info.order,
          // Through the kernel factory, never `new LineStore()`: the factory
          // applies the consumer's scrollbackLines cap, so per-tab caches and
          // the kernel's implicit store share one retained-line budget. The id
          // is what lets it come back HYDRATED when the consumer enabled
          // persistScrollback, and registers it to be saved.
          store: ctx.newLineStore(info.id),
          el,
          label,
          dot,
          activityEl,
          progressEl,
          // A percentage exists only on the status STREAM, so a tab adopted from
          // the REST list starts with none; the first status event fills it in.
          progress: normalizeProgress(info.progressValue),
          activity: normalizeActivity(info.activity),
          activityCount: normalizeActivityCount(info.activityCount),
          aria,
          view: null,
          reports: reportsOf(info.reportsActivity),
        };
        paintProgress(progressEl, renderedProgress(info.status, tab.progress));
        paintActivityMark(activityEl, tab.activity, tab.activityCount);
        // Set an initial label immediately (relabelAll refines it with de-dup
        // once the tab is in tabList and syncChrome runs).
        tab.display = baseLabel(tab).text;
        label.textContent = tab.display;
        aria.setLabel(
          tabAccessibleName({
            label: tab.display,
            status: info.status,
            progress: renderedProgress(info.status, tab.progress),
            activity: tab.activity,
            activityCount: tab.activityCount,
          }),
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
        // Also the TOUCH rename path: a long-press on a draggable chip starts a
        // reorder drag on iPadOS instead of opening the menu. The chip's
        // touch-action: manipulation keeps iOS from reading the second tap as a zoom.
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
        // Drag-and-drop reorder on the desktop strip. The bar's dragover arms a
        // slot, the hold (or a drop) commits it, and drop/dragend commit the
        // resulting order into tabList. See the reorder-preview block below.
        el.draggable = true;
        el.addEventListener("dragstart", (e) => {
          if (editingId === tab.id) {
            e.preventDefault(); // renaming: a drag would fight caret selection
            return;
          }
          endReorderPreview(); // no residue from a previous drag
          endShift(); // ...and nothing mid-slide, so this gesture starts from rest
          dropped = false;
          draggingEl = el;
          // Snapshot the preview from the PRISTINE chip, before the slot class.
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
          paintDropHalf(null);
          if (!dropped) {
            // No drop fired, so the drag was abandoned: Escape, or a release the
            // browser refused. Put the strip back — tabList still holds the order
            // the gesture started from, because only a drop writes to it.
            revertPreview();
          }
          draggingEl = null;
          // The gesture's state goes; a slide started by the revert above is left to
          // finish under its own settle timer (see endReorderPreview).
          endReorderPreview();
          clearDragGhost(); // belt-and-braces: the rAF normally got there first
        });
        return tab;
      }

      /** Show `id` in the pane on `side`: the pane's current tab becomes an
       *  ordinary tab, a pane elsewhere showing `id` is emptied first (a session is
       *  never shown twice), and the pane is selected. False when `side` names no
       *  pane that can show a tab (absent, failed or hidden) or `id` no tab. */
      function showIn(side: PaneSide, id: string, dir?: "next" | "prev"): boolean {
        const pane = ctx.shell.pane(side);
        const next = tabList.find((t) => t.id === id);
        if (pane === null || !next) {
          return false;
        }
        const state = pane.state();
        if (state === "failed" || state === "hidden") {
          return false;
        }
        const curId = shownIn(side);
        if (curId === id) {
          // The press that delivered this click has already moved the keyboard onto
          // the chip, so the FOCUS rule still owes an answer or the input stays
          // stranded (a click on the shown tab, or the second activation of one
          // press).
          ctx.shell.select(side);
          focusAfterSwitch();
          return true;
        }
        const from = sideOf(id);
        if (from !== null) {
          const losing = ctx.shell.pane(from);
          if (losing !== null) {
            next.view = losing.render.captureViewMemory();
            losing.clearActiveSession();
          }
        }
        // A later tab slides in from the right, an earlier one from the left, so a
        // desktop switch feels like the mobile swipe.
        let slide = dir;
        const fromIdx = curId === null ? -1 : tabList.findIndex((t) => t.id === curId);
        const toIdx = tabList.findIndex((t) => t.id === id);
        if (slide === undefined && fromIdx >= 0) {
          slide = toIdx > fromIdx ? "next" : "prev";
        }
        // A LINE, never surface.scrollTop: the line survives the rebuild and the
        // background output this tab's session produces before we come back.
        const cur = curId === null ? undefined : tabList.find((t) => t.id === curId);
        if (cur) {
          cur.view = pane.render.captureViewMemory();
        }
        // The expanded list rotates only for a swipe to an adjacent tab, wrap
        // between first and last included. prepareReel snapshots the rows BEFORE
        // the reconcile; the returned closure FLIPs them after it.
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
        bootShowedNothing = false;
        // The terminal is now on screen, so a reload must not notify about a state
        // the user just looked at.
        acknowledgeSwitchNotify(next.id);
        markCueSeen(next.id, next.dot.dataset["status"] ?? "");
        // The view goes in WITH the bind, which makes the swap atomic: the pane's
        // follow flag is one per renderer, so a bind without it gated the first
        // flush on the state of the tab we LEFT and the cached screen rendered
        // above the viewport until a touch re-engaged follow.
        pane.render.bind(next.store, { view: next.view });
        pane.notifySwitch({ id: next.id });
        // Mark the reconcile as reel-driven so renderSwitcherList suppresses its
        // add/remove row animation (the reel owns row motion here); set before the
        // selection change, whose listener reconciles the list too.
        reelReconcile = playReel !== undefined;
        ctx.shell.select(side);
        scheduleLayoutWrite();
        // Only when the user is about to wait: a revisited tab with a warm store
        // paints from cache in one frame and must not flash a cue at every switch.
        if (
          pane.render.pendingRowCount() > CATCHUP_MIN_BACKLOG ||
          pane.render.getHighestIndex() < 0
        ) {
          armCatchup(pane);
        }
        flashSwitch(pane.surface(), slide);
        syncChrome(); // reconciles the expanded list into the new order
        reelReconcile = false;
        playReel?.(); // FLIP the rows so the reorder reads as a rotation, not a reload
        ctx.announce(`Switched to ${next.display}`);
        focusAfterSwitch();
        return true;
      }

      // The tab-click rule: a tab a pane shows has that pane selected; any other
      // tab fills the first empty pane, else replaces the selected pane's tab.
      function switchTo(id: string, dir?: "next" | "prev"): void {
        const shownOn = sideOf(id);
        if (shownOn !== null) {
          ctx.shell.select(shownOn);
          focusAfterSwitch();
          return;
        }
        showIn(ctx.shell.targetFor(id), id, dir);
      }

      // The one rule every split entry point reduces to: the named side shows the
      // tab, whatever was there becomes an ordinary tab, the tab's old side becomes
      // empty, and the tab's pane is selected.
      function snap(id: string, side: PaneSide): boolean {
        if (!isPaneSide(side) || !tabList.some((t) => t.id === id)) {
          return false;
        }
        const split = ctx.shell.split;
        if (!split.isOpen() && (!split.canOpen() || !split.open())) {
          return false;
        }
        return showIn(side, id);
      }

      // A switched-into tab's cached screen is stale until its resume delta lands,
      // so it must not read as live. The cue measures the RENDER backlog of the
      // pane it sits in, which is what the user waits on whatever produced it: not
      // the first screen frame and not the resumeAck's `committed`, because the
      // window frame delivers the HIGHEST indices first and both cleared a
      // 4000-line restore at once. The second half covers a never-viewed tab,
      // whose queue is empty while its screen is on the network.
      const catchupWarranted = (pane: PaneHandle): boolean =>
        pane.render.pendingRowCount() > 0 || pane.render.getHighestIndex() < 0;

      interface PaneCatchup {
        readonly pane: PaneHandle;
        readonly el: HTMLElement;
        /** The anti-flicker delay before the cue shows. */
        timer: number | null;
        /** The completion poll, on rAF because the renderer has no "queue drained" event. */
        poll: number | null;
        emptySince: number;
        deadline: number;
        offScreen: Unsubscribe;
      }
      const catchups = new Map<PaneHandle, PaneCatchup>();
      function armCatchup(pane: PaneHandle): void {
        const c = catchups.get(pane);
        if (c === undefined) {
          return;
        }
        if (c.timer === null && !c.el.classList.contains("visible")) {
          c.timer = win.setTimeout(() => {
            c.timer = null;
            // A burst that drains inside the anti-flicker delay has nothing to
            // report, and the clear path needs CATCHUP_SETTLE_MS of quiet.
            if (catchupWarranted(pane)) {
              c.el.classList.add("visible");
            }
          }, 150);
        }
        c.deadline = win.Date.now() + CATCHUP_MAX_MS;
        c.emptySince = 0;
        if (c.poll === null) {
          pollCatchup(c);
        }
      }
      function pollCatchup(c: PaneCatchup): void {
        c.poll = win.requestAnimationFrame(() => {
          c.poll = null;
          if (catchupWarranted(c.pane)) {
            c.emptySince = 0;
          } else if (c.emptySince === 0) {
            c.emptySince = win.Date.now();
          } else if (win.Date.now() - c.emptySince >= CATCHUP_SETTLE_MS) {
            clearCatchup(c);
            return;
          }
          if (win.Date.now() > c.deadline) {
            clearCatchup(c);
            return;
          }
          pollCatchup(c);
        });
      }
      function clearCatchup(c: PaneCatchup): void {
        if (c.timer !== null) {
          win.clearTimeout(c.timer);
          c.timer = null;
        }
        if (c.poll !== null) {
          win.cancelAnimationFrame(c.poll);
          c.poll = null;
        }
        c.emptySince = 0;
        c.el.classList.remove("visible");
      }
      function dropCatchup(c: PaneCatchup): void {
        clearCatchup(c);
        c.offScreen();
        c.el.remove();
        catchups.delete(c.pane);
      }
      // Any frame can reveal a backlog worth telling the user about: a resume
      // replay after a wake or reconnect, the rebuild after a tab switch, or a
      // program that dumped thousands of lines at once. Arming off the backlog
      // itself is what makes the cue fire on a wake; the threshold keeps ordinary
      // streaming out of it, so the completion poll only exists while there is
      // something to complete.
      function watchCatchup(pane: PaneHandle): void {
        const el = doc.createElement("div");
        el.className = "wt-catchup";
        el.setAttribute("role", "status");
        el.textContent = "Catching up\u2026";
        pane.region("banner", "catchup").appendChild(el);
        catchups.set(pane, {
          pane,
          el,
          timer: null,
          poll: null,
          emptySince: 0,
          deadline: 0,
          offScreen: pane.on("wire:screen", () => {
            if (pane.render.pendingRowCount() > CATCHUP_MIN_BACKLOG) {
              armCatchup(pane);
            }
          }),
        });
      }
      /** A cue for every live pane, the one a later open builds included; a pane
       *  torn down or failed loses its cue with its timers. */
      function syncCatchups(): void {
        const live = new Set(ctx.shell.panes().filter((p) => p.state() !== "failed"));
        for (const c of [...catchups.values()]) {
          if (!live.has(c.pane)) {
            dropCatchup(c);
          }
        }
        for (const pane of live) {
          if (!catchups.has(pane)) {
            watchCatchup(pane);
          }
        }
      }
      syncCatchups();
      ctx.defer(() => {
        for (const c of [...catchups.values()]) {
          dropCatchup(c);
        }
      });
      // The switch class comes off on the animation's OWN end; the timer is the
      // net, and it cannot be dropped: an interrupted animation fires no
      // animationend (animationcancel is unreliable in Blink), reduced motion
      // removes .wt-animate so no event ever fires, and a consumer stylesheet may
      // drop the rules. The listener filters on the ONE expected animation name
      // (switch N's queued completion would otherwise end switch N+1's animation)
      // AND on the class being present (the class lands a frame after the listener).
      const SWITCH_ANIM_NET_MS = 360;
      let switchAnimTimer: number | null = null;
      let switchAnimFrame: number | null = null;
      let switchAnimOff: (() => void) | null = null;
      // The surface mid-animation; a switch in the other pane ends this one first.
      let switchAnimSurface: HTMLElement | null = null;

      // All three torn down together: a surviving rAF would ADD the previous
      // direction's class beside the new one, and the cascade's winner is the LAST
      // rule in the stylesheet, so a forward switch could animate backwards.
      function endSwitchAnim(): void {
        switchAnimSurface?.classList.remove(...SWITCH_CLASSES);
        switchAnimSurface = null;
        if (switchAnimTimer !== null) {
          win.clearTimeout(switchAnimTimer);
          switchAnimTimer = null;
        }
        if (switchAnimFrame !== null) {
          win.cancelAnimationFrame(switchAnimFrame);
          switchAnimFrame = null;
        }
        if (switchAnimOff !== null) {
          switchAnimOff();
          switchAnimOff = null;
        }
      }

      function flashSwitch(surface: HTMLElement, dir?: "next" | "prev"): void {
        const cls = dir ? (`wt-switching-${dir}` as const) : ("wt-switching" as const);
        endSwitchAnim();
        switchAnimSurface = surface;
        const expected = SWITCH_ANIMATIONS[cls];
        const onAnimEnd = (ev: AnimationEvent): void => {
          if (ev.animationName !== expected || !surface.classList.contains(cls)) {
            return;
          }
          endSwitchAnim();
        };
        surface.addEventListener("animationend", onAnimEnd);
        switchAnimOff = (): void => {
          surface.removeEventListener("animationend", onAnimEnd);
        };
        // The net is armed INSIDE the frame that adds the class: rAF pauses in a
        // hidden document, so a timer armed beside it could fire first and its
        // endSwitchAnim would cancel the pending class-add and skip the animation.
        switchAnimFrame = win.requestAnimationFrame(() => {
          switchAnimFrame = null;
          surface.classList.add(cls);
          switchAnimTimer = win.setTimeout(() => {
            switchAnimTimer = null;
            endSwitchAnim();
          }, SWITCH_ANIM_NET_MS);
        });
      }

      // A shown session's OSC 0/2 title arrives on its live socket and relabels
      // the tab at once; a background tab's title waits for the status sweep.
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
        const current = selectedId();
        const idx = tabList.findIndex((t) => t.id === current);
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

      // A MOVING pointer rearranges nothing and a STOPPED one opens the slot; the
      // dragged chip stays in the flow as the slot it will land in, drawn as a
      // dashed outline because the solid copy is the drag image under the pointer.
      // Rest is detected from movement, not waited out (a fixed hold delayed the
      // one case that should be instant), and a drop commits the slot under the
      // pointer at once.

      // The first tab whose midpoint is past x, or null for the end. Hit-tests
      // LAYOUT geometry, never a rect: a rect read mid-slide is the INTERPOLATED
      // position, so the preview's own motion fed back into the decision and the
      // strip oscillated near a boundary. Layout offsets ignore scrolling, so
      // clientX is converted by adding scrollLeft back.
      function dropTargetBefore(clientX: number): HTMLElement | null {
        const x = clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft;
        const base = scroller.offsetLeft;
        for (const el of scroller.querySelectorAll<HTMLElement>(".wt-tab")) {
          if (el === draggingEl) {
            continue;
          }
          if (x < el.offsetLeft - base + el.offsetWidth / 2) {
            return el;
          }
        }
        return null;
      }

      // `translate`, NOT `transform`: a running CSS ANIMATION out-ranks inline
      // style, so a chip mid `wt-slot-in` or `wt-tab-in` (both `transform: scale`)
      // would ignore an inline transform and refuse to move. `translate` composes
      // with it instead, so the two can own one chip at the same time.
      function applyShift(px: ReadonlyMap<HTMLElement, number>, trans: string): void {
        if (shiftTimer !== null) {
          win.clearTimeout(shiftTimer);
          shiftTimer = null;
        }
        for (const [el, dx] of px) {
          el.style.transition = trans;
          el.style.translate = `${String(Math.round(dx))}px`;
          shifted.add(el);
        }
      }
      // Hands every displaced chip back to the stylesheet. Idempotent.
      function endShift(): void {
        if (shiftTimer !== null) {
          win.clearTimeout(shiftTimer);
          shiftTimer = null;
        }
        for (const el of shifted) {
          el.style.transition = "";
          el.style.translate = "";
        }
        shifted.clear();
      }

      // A travelling pointer rearranges nothing; the slot opens when it comes to
      // REST. A dragover at an unchanged position is POSITIVE evidence of a stop
      // and commits after the short REORDER_STILL_MS; the absence of events is only
      // a fallback that must out-wait the drag loop's 350 ms cadence.
      function trackRest(clientX: number): void {
        const dragged = draggingEl;
        if (!dragged) {
          return;
        }
        const now = win.Date.now();
        const moved = restX === null || Math.abs(clientX - restX) > REORDER_MOVE_EPS_PX;
        restX = clientX;
        if (moved) {
          restMovedAt = now;
        }
        // Recomputed from THIS event, never a stored pending target: a stored one
        // was nulled by the already-there branch on the way past, so a stop after it
        // committed NOTHING until the mouse was jiggled.
        const before = dropTargetBefore(clientX);
        if (before === dragged.nextElementSibling) {
          endRestNet();
          return;
        }
        // The elapsed check filters one event of a sweep landing within the epsilon
        // of the previous (a reversal, or a mostly vertical frame).
        if (!moved && now - restMovedAt >= REORDER_STILL_MS) {
          endRestNet();
          commitSlot(before);
          return;
        }
        armRestNet(before);
      }
      // The no-events fallback for a browser that stops delivering dragover; it
      // carries its own target for the reason trackRest recomputes one.
      function armRestNet(before: HTMLElement | null): void {
        endRestNet();
        restTimer = win.setTimeout(() => {
          restTimer = null;
          commitSlot(before);
        }, REORDER_REST_MS);
      }
      function endRestNet(): void {
        if (restTimer !== null) {
          win.clearTimeout(restTimer);
          restTimer = null;
        }
      }

      // FLIP a rearranging mutation so every chip that ends up somewhere new slides
      // there. `hold` is the one chip that must NOT slide: on a commit the dragged
      // chip, since the pointer already carries a solid copy of it.
      function flipTo(mutate: () => void, hold: HTMLElement | null): void {
        // The gate belongs HERE and not only in the CSS: these transitions are
        // written inline, and no stylesheet gate can reach them.
        if (prefersReduce()) {
          endShift();
          mutate();
          return;
        }
        // Where each chip is right now, MID-SLIDE INCLUDED, so a second commit
        // continues from wherever the first got to. Rects, because this is VISUAL
        // position; hit-testing wants layout offsets instead.
        const first = new Map<HTMLElement, number>();
        for (const el of scroller.querySelectorAll<HTMLElement>(".wt-tab")) {
          if (el !== hold) {
            first.set(el, el.getBoundingClientRect().left);
          }
        }
        endShift();
        mutate();
        const invert = new Map<HTMLElement, number>();
        for (const [el, was] of first) {
          const dx = el.isConnected ? was - el.getBoundingClientRect().left : 0;
          if (dx !== 0) {
            invert.set(el, dx);
          }
        }
        if (invert.size === 0) {
          return;
        }
        applyShift(invert, "none");
        // The read forces the reflow that COMMITS the from-state; without it the two
        // writes collapse into one recalc and no transition runs.
        scroller.getBoundingClientRect();
        const rest = new Map<HTMLElement, number>();
        for (const el of invert.keys()) {
          rest.set(el, 0);
        }
        applyShift(rest, REORDER_SHIFT_TRANS);
        shiftTimer = win.setTimeout(endShift, REORDER_SETTLE_MS);
      }

      // Moves the DOM and NOT tabList, which is what makes the preview a preview:
      // only a drop writes tabList, so a cancel is a re-projection and a syncChrome
      // arriving mid-drag renders the committed order.
      function commitSlot(before: HTMLElement | null): void {
        const dragged = draggingEl;
        if (!dragged?.isConnected) {
          return;
        }
        // A session closed elsewhere removes chips while the gesture is open, and
        // insertBefore throws on a reference that is no longer a child. null stays
        // legal: past the last chip.
        if (before !== null && before.parentNode !== scroller) {
          return;
        }
        if (before === dragged || before === dragged.nextElementSibling) {
          return;
        }
        flipTo(() => {
          scroller.insertBefore(dragged, before);
        }, dragged);
        flashSlot(dragged);
        announceTarget(dragged);
      }

      // Put the strip back the way the gesture found it. No saved snapshot is
      // needed: nothing but a drop writes tabList, so it IS the snapshot.
      function revertPreview(): void {
        const chips = [...scroller.querySelectorAll<HTMLElement>(".wt-tab")];
        const untouched =
          chips.length === tabList.length && chips.every((el, i) => tabList[i]?.el === el);
        if (untouched) {
          return;
        }
        flipTo(() => {
          for (const t of tabList) {
            scroller.appendChild(t.el);
          }
        }, null);
        ctx.announce("Move cancelled");
      }

      // Re-adding a class an element already carries restarts nothing, and the
      // layout read between the two writes is what keeps them from collapsing.
      function flashSlot(el: HTMLElement): void {
        endSlotFade();
        el.classList.remove("wt-tab-slotted");
        el.getBoundingClientRect();
        el.classList.add("wt-tab-slotted");
        slotFadeEl = el;
        slotFadeTimer = win.setTimeout(() => {
          slotFadeTimer = null;
          endSlotFade();
        }, REORDER_SLOT_FADE_MS);
      }
      function endSlotFade(): void {
        if (slotFadeTimer !== null) {
          win.clearTimeout(slotFadeTimer);
          slotFadeTimer = null;
        }
        slotFadeEl?.classList.remove("wt-tab-slotted");
        slotFadeEl = null;
      }

      // A committed slot is a PREVIEW Escape can still undo, so it announces a
      // TARGET and only the drop announces a move; announcing "Moved" three times
      // and then "Move cancelled" told a screen-reader user a hover was an action.
      // The position is read from the DOM, which is what the preview moved.
      function slotPosition(el: HTMLElement): number {
        return [...scroller.querySelectorAll<HTMLElement>(".wt-tab")].indexOf(el) + 1;
      }
      function announceTarget(el: HTMLElement): void {
        const at = slotPosition(el);
        if (at > 0) {
          ctx.announce(`Drop position ${String(at)}`);
        }
      }
      function announceMoved(el: HTMLElement): void {
        const tab = tabList.find((t) => t.el === el);
        const at = slotPosition(el);
        if (tab && at > 0) {
          ctx.announce(`Moved ${tab.display} to position ${String(at)}`);
        }
      }

      // Ends the GESTURE's state but NOT a slide already playing: dragend fires
      // right after a revert starts, and cutting the slide here would make the
      // revert snap home instead of run. dragstart and teardown call endShift().
      function endReorderPreview(): void {
        endRestNet();
        restX = null;
        endSlotFade();
      }

      // For every site that REMOVES a chip while a drag may be open. A browser is
      // not obliged to fire dragend for a removed source, and a `draggingEl` left
      // pointing at a detached node would make the document-level guard
      // preventDefault every unrelated file or text drop from then on.
      function abortReorderFor(removed: HTMLElement): void {
        if (removed !== draggingEl) {
          return;
        }
        removed.classList.remove("wt-tab-dragging");
        draggingEl = null;
        dropped = false;
        endReorderPreview();
        endShift();
        clearDragGhost();
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
          // Before syncChrome: it ends in applyServerOrder, which would undo this
          // move while the tabs still carry their old positions.
          publishOrder();
          syncChrome();
        }
      }

      // The write half of tab-order sync, called only from the paths that COMMIT
      // a reorder. It renumbers BEFORE sending: every tab still carries the
      // server's old position, and the caller's applyServerOrder pass would sort
      // the strip straight back. A 409 means this client's list is stale, so the
      // server's word is taken; any other failure leaves the arrangement local.
      function publishOrder(): void {
        if (tabList.length === 0) {
          return;
        }
        tabList.forEach((tab, i) => {
          tab.order = i;
        });
        if (!started) {
          return;
        }
        const ids = tabList.map((t) => t.id);
        void api.setOrder(ids).catch((err: unknown) => {
          if (!tornDown() && err instanceof SessionAPIError && err.status === 409) {
            void reconcileOnce();
          }
        });
      }

      // WebKit renders NO automatic drag image under an ancestor with a filter or
      // transform (webkit.org/b/22787), and the strip's backdrop-filter is one, so
      // the preview came out as broken white geometry on iPadOS. The clone is
      // parked under .wt-root, outside the filtered subtree but inside the styling
      // boundary, laid exactly over the chip, and dropped on the next frame, by
      // which time the browser has snapshotted it.
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
        frame(clearDragGhost);
      }

      // The non-drag alternative to the drag-and-drop reorder (WCAG 2.5.7).
      function moveTab(id: string, delta: -1 | 1): void {
        // Re-appending every chip reparents a focused field, which blurs it, so an
        // open edit would be committed by a blur the user never performed.
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
        publishOrder(); // before syncChrome, for the reason at its definition
        syncChrome();
        ctx.announce(`Moved ${tab.display} to position ${String(to + 1)}`);
      }

      // Add a tab for a session that exists server-side but has no local tab yet
      // (one created in another browser), so every client's tab set converges on
      // the server. The caller runs syncChrome.
      function adoptSession(info: SessionInfo): void {
        if (tabList.find((t) => t.id === info.id)) {
          return;
        }
        if (tombstones.active(info.id)) {
          return;
        }
        const tab = addTabChrome(info);
        // Placed by the SERVER's order, not by arrival: the stream's snapshot and
        // the bootstrap's list race, so arrival order is not stable between loads.
        const at = orderedInsertIndex(tabList, info);
        tabList.splice(at, 0, tab);
        // addTabChrome appended the chip at the end; the DOM must read in list order.
        const after = tabList[at + 1];
        if (after) {
          scroller.insertBefore(tab.el, after.el);
        }
      }

      // The runtime repair for a bootstrap whose list AND create both failed: the
      // sessions the stream later adopts would otherwise render inert until the
      // user taps a tab. Gated on that one case, so a pane the closing rules
      // emptied is never refilled by a status event. A live tab outranks an ENDED
      // one, which would wedge the page the same way.
      function ensureActive(): void {
        if (!bootShowedNothing || anyShown()) {
          return;
        }
        const first = tabList.find((t) => !isEndedStatus(statusOf(t))) ?? tabList[0];
        if (first) {
          switchTo(first.id);
        }
      }

      // One press does not reliably arrive as one activation (two POSTs 0-3 ms
      // apart from a single "+" tap were measured), and sharing the in-flight
      // promise needs no threshold: a duplicate lands while the POST is open and
      // collapses into it, while a deliberate second tap still opens a second
      // terminal. It also stops "+" mashing from queueing sessions across the
      // server's retry window. The coalesced second caller's target is ignored.
      let creating: Promise<void> | null = null;
      function create(target?: PaneSide): Promise<void> {
        creating ??= openNewSession(target).finally(() => {
          creating = null;
        });
        return creating;
      }

      async function openNewSession(target?: PaneSide): Promise<void> {
        // The handle faces the pane the new tab is headed for from the start,
        // not from the POST's answer.
        if (target !== undefined && ctx.shell.split.isOpen() && !anyShown()) {
          ctx.shell.select(target);
        }
        let info: SessionInfo;
        try {
          info = await createSessionHonouringRetry(api, ctx, lifetime.signal);
        } catch (err) {
          if (tornDown()) {
            return;
          }
          // A create can still fail transiently (network, server error); tell
          // the user rather than throwing. A 503 has already been retried on the
          // server's own schedule by this point, so reaching here means it never
          // became ready: say so with the server's own words when it gave any.
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
        // new row in (animateRowIn) rather than rotate. showIn still slides the
        // terminal content and updates the shown chip.
        creatingTab = true;
        // The asked-for side holds only while that pane is still empty: the split
        // may have closed or the pane been filled during the round trip.
        const side =
          target !== undefined && ctx.shell.pane(target)?.state() === "empty"
            ? target
            : ctx.shell.targetFor(tab.id);
        showIn(side, tab.id);
        creatingTab = false;
      }

      // dropTab removes a tab's chrome + cache and, for a shown tab, decides what
      // its pane shows next. remote=true also DELETEs the server session (a user
      // close); remote=false is a local drop for a session the server already
      // ended (an SSE removed event or a poll that no longer lists it), so no
      // redundant DELETE is sent.
      async function dropTab(id: string, remote: boolean): Promise<void> {
        const idx = tabList.findIndex((t) => t.id === id);
        if (idx < 0) {
          return;
        }
        // Closing the only remaining tab: spawn its replacement BEFORE removing
        // this one, so the strip never empties and the "+" never teleports to the
        // far left while the create POST is in flight. The replacement lands where
        // a click would (the other pane, while the split is open), and dropping
        // the old tab is then an ordinary non-last close, so this intercept does
        // not re-fire. A user close only.
        if (remote && tabList.length === 1 && tabList[0]?.id === id) {
          await create();
          // A failed create adds nothing (and toasts): keep the existing tab
          // rather than stranding the user on an empty strip.
          if (tabList.some((t) => t.id !== id)) {
            await dropTab(id, true);
          }
          return;
        }
        // Which pane shows the tab decides the transaction below; read before
        // anything moves.
        const side = sideOf(id);
        const splitOpen = ctx.shell.split.isOpen();
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
        ctx.shell.notifications.forget(id);
        tab.aria.remove();
        // Remove immediately (no exit animation): a lingering element made the
        // "+" teleport after a delay, and made a last-tab replacement appear in
        // the second slot before shifting left. The strip reflows in one frame.
        // A live desktop drag holds references to chips, so tell it first: this
        // element may be the one it is dragging or the one it means to insert
        // before, and both stop existing on the next line.
        abortReorderFor(tab.el);
        tab.el.remove();
        // Each connection forgets the session exactly once: the showing pane's
        // through clearActiveSession (which closes its socket and empties the
        // pane), every other through dropSessionExcept.
        if (side !== null && splitOpen) {
          ctx.shell.pane(side)?.clearActiveSession();
          ctx.shell.dropSessionExcept(id, side);
        } else {
          ctx.dropSession(id);
        }
        // A close that empties the expanded list collapses the switcher FIRST, so
        // the tray animates shut with the last row still in it; `expanded` going off
        // makes the syncChrome below leave that row for the collapse to sweep away.
        if (expanded && tabList.length < 2) {
          collapseSwitcher();
        }
        syncChrome(); // reflect the drop immediately (count, position)
        // What the panes show next is decided here, before the server's answer:
        // selection must not sit on an emptied pane for a DELETE round trip.
        let replacement: Promise<void> | undefined;
        if (side !== null && !splitOpen) {
          // One pane: switch to a neighbor, or spawn a fresh session if this was
          // the last.
          const neighbor = tabList[idx] ?? tabList[idx - 1];
          if (neighbor) {
            switchTo(neighbor.id);
          } else {
            replacement = create();
          }
        } else if (side !== null) {
          // While the split is open the pane stays empty and a new tab lands in
          // the other pane, so a close never promotes a tab nobody clicked.
          const other = otherSide(side);
          if (shownIn(other) !== null) {
            ctx.shell.select(other);
            focusAfterSwitch();
          } else if (!anyShown()) {
            replacement = create(other);
          }
          scheduleLayoutWrite();
        }
        if (remote) {
          try {
            await api.close(id);
          } catch {
            if (!tornDown()) {
              ctx.toast("Couldn't close the terminal on the server");
            }
          }
        }
        await replacement;
      }

      async function close_(id: string): Promise<void> {
        await dropTab(id, true);
      }

      // Each tab is a running agent, so closing two or more asks first. This path
      // drops tabs itself, so every per-tab state dropTab releases is released here.
      async function closeMany(ids: readonly string[]): Promise<void> {
        const victims = tabList.filter((t) => ids.includes(t.id));
        if (victims.length === 0) {
          return;
        }
        if (victims.length >= 2 && !win.confirm(`Close ${String(victims.length)} terminals?`)) {
          return;
        }
        const selectedBefore = selectedId();
        const closingSelected = selectedBefore !== null && ids.includes(selectedBefore);
        const splitOpen = ctx.shell.split.isOpen();
        // An editor left open on a removed tab keeps editingId alive past its chip
        // and suppresses focus-on-switch for good.
        if (editingId !== null && ids.includes(editingId)) {
          endEdit();
        }
        let emptiedPane = false;
        for (const t of victims) {
          const idx = tabList.indexOf(t);
          if (idx >= 0) {
            tabList.splice(idx, 1);
          }
          // A stale status snapshot that predates the server's reap must not
          // re-adopt a just-closed tab.
          tombstones.add(t.id);
          acknowledgeSwitchNotify(t.id);
          forgetCueSeen(t.id);
          ctx.shell.notifications.forget(t.id);
          t.aria.remove();
          abortReorderFor(t.el); // a live drag holds this node
          t.el.remove();
          const side = sideOf(t.id);
          if (side !== null && splitOpen) {
            ctx.shell.pane(side)?.clearActiveSession();
            ctx.shell.dropSessionExcept(t.id, side);
            emptiedPane = true;
          } else {
            ctx.dropSession(t.id);
          }
        }
        // Re-home before the DELETEs: selection must not sit on an emptied pane for
        // a round trip. Split open, the emptied panes stay empty (no promotion).
        if (!splitOpen && closingSelected && tabList[0]) {
          switchTo(tabList[0].id);
        } else {
          syncChrome();
          if (splitOpen && closingSelected) {
            const shownSide = ctx.shell.panes().find((p) => p.state() === "shown")?.side;
            if (shownSide !== undefined) {
              ctx.shell.select(shownSide);
            }
          }
          if (emptiedPane) {
            scheduleLayoutWrite();
          }
        }
        // One terminal always stays open, and an open split always shows one tab.
        let replacement: Promise<void> | undefined;
        if (tabList.length === 0 || (splitOpen && !anyShown())) {
          replacement = create(ctx.shell.panes().find((p) => p.state() === "empty")?.side);
        }
        // The person asked for these closes, so every DELETE still goes out past a
        // teardown; only what the page shows for them stops.
        for (const t of victims) {
          try {
            await api.close(t.id);
          } catch {
            if (!tornDown()) {
              ctx.toast("Couldn't close a terminal on the server");
            }
          }
        }
        await replacement;
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

      // The edit surface is the label's OWN box, so the width the user types into
      // is the width the label will have. editingId is also the stand-down flag
      // for every chip handler that would otherwise fight the field.
      let editingId: string | null = null;
      let editInput: HTMLInputElement | null = null;
      // Recorded at entry because the exit paths cannot tell a keyboard-started
      // edit (focus returns to the chip) from a pointer one (to the terminal).
      let editFrom: "keyboard" | "pointer" = "pointer";
      // Pinned-name requests in flight, COUNTED per id: two renames of one tab can
      // be out at once, and a bare Set let the first completion clear the marker
      // while the second's PUT was still open, so that rename failed silently.
      const namesInFlight = new Map<string, number>();

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
        t.aria.setEditing(false, isShown(t.id));
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
        const request = name === "" ? api.clearPinnedTitle(id) : api.setPinnedTitle(id, name);
        // Counted only once the request exists: an api implementation that throws
        // instead of rejecting would otherwise leave a count behind that no
        // .finally ever releases, and the id would read as in flight forever.
        namesInFlight.set(id, (namesInFlight.get(id) ?? 0) + 1);
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
            const left = (namesInFlight.get(id) ?? 0) - 1;
            if (left > 0) {
              namesInFlight.set(id, left);
            } else {
              namesInFlight.delete(id);
            }
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
        const input = doc.createElement("input");
        input.type = "text";
        input.className = "wt-tab-rename";
        input.setAttribute("aria-label", "Rename terminal");
        // The PIN, never the rendered label: a blur commits a non-empty value, so a
        // prefilled automatic title or de-dup suffix would be pinned by a click-away.
        // An unpinned tab starts EMPTY with the label as its placeholder.
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
        t.aria.setEditing(true, isShown(t.id));
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

      /** Close the open edit under the rules for HOW it was closed. `"confirm"`
       *  (Enter) is the only mode that may CLEAR a pin from an emptied field;
       *  `"blur"` commits a non-empty value and reverts an empty one, because a
       *  blur is loss of focus rather than destructive intent, and dismissing a
       *  tablet's soft keyboard IS a blur; `"cancel"` applies nothing. `focus` is
       *  opt-out for a caller that is not the user finishing an edit. */
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

      // A long-press raises `contextmenu` mid-press and emits a click on release,
      // which onDocClickMenu would read as a click-away. The swallow window is
      // fixed, so arming it at `contextmenu` missed a release held a beat longer;
      // menuOpenedInPress carries the fact through to pointerup, which re-arms on
      // the release edge, and keeps that re-arm off an unrelated later tap.
      const menuSwallow = createClickSwallow(win);
      let menuTouch = false;
      let menuOpenedInPress = false;
      // One listener on the bar: both facts recorded belong to the gesture, not to
      // a chip, and chips come and go with sessions.
      bar.addEventListener(
        "pointerdown",
        (e) => {
          menuTouch = e.pointerType === "touch";
          menuOpenedInPress = false;
          noteChromePress();
          ctx.shell.notifications.gesture();
        },
        { passive: true },
      );
      // The release edge of the press that opened the menu. pointercancel counts:
      // iPadOS cancels the pointer when it takes the gesture over for its own
      // long-press handling, and that release still emits the trailing click.
      const onBarPointerRelease = (): void => {
        if (menuOpenedInPress) {
          menuOpenedInPress = false;
          menuSwallow.arm();
        }
      };
      bar.addEventListener("pointerup", onBarPointerRelease, { passive: true });
      bar.addEventListener("pointercancel", onBarPointerRelease, { passive: true });
      // The switcher's half of that snapshot (its rows and the x are buttons, so
      // pressing one focuses it and blurs the terminal exactly as a chip does).
      // It is also the mobile half of the notification-permission gesture.
      switcher.addEventListener(
        "pointerdown",
        () => {
          noteChromePress();
          ctx.shell.notifications.gesture();
        },
        { passive: true },
      );
      function hideTabMenu(): void {
        tabMenu.classList.remove("visible");
        tabMenu.replaceChildren();
      }
      function tabMenuItem(label: string, disabled: boolean, run: () => void): void {
        const b = doc.createElement("button");
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
        const hr = doc.createElement("div");
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
        if (ctx.shell.split.enabled) {
          const shownOn = sideOf(id);
          const fits = rowFitsSplit();
          tabMenuItem("Snap to left", !fits || shownOn === "left", () => {
            snap(id, "left");
          });
          tabMenuItem("Snap to right", !fits || shownOn === "right", () => {
            snap(id, "right");
          });
          tabMenuSeparator();
        }
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
          // A floor for the case where no pointerup follows (the release edge is
          // where onBarPointerRelease re-arms it).
          menuSwallow.arm();
          menuOpenedInPress = true;
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
          seen = win.localStorage.getItem(SWIPE_HINT_KEY) === "1";
        } catch {
          /* storage unavailable; show once per session via hintShown */
        }
        if (seen) {
          return;
        }
        try {
          win.localStorage.setItem(SWIPE_HINT_KEY, "1");
        } catch {
          /* ignore */
        }
        ctx.toast("Swipe to switch terminals");
      }

      // Takes the record whole: its title fields are interchangeable strings that
      // as positional parameters would be swappable. `reports` travels separately
      // because it is normalised (reportsOf) first.
      function applyStatus(rec: StatusRecord, reports: boolean): void {
        const t = tabList.find((tab) => tab.id === rec.id);
        if (!t) {
          return;
        }
        t.reports = reports;
        // The server's shared position. Only an explicitly PRESENT value updates
        // the tab, for the same reason as progressValue below: an engine that
        // keeps no order sends no field, and reading that absence as "position 0"
        // would drag every tab to the front of the strip on every status tick.
        // syncChrome's applyServerOrder then moves the chip if this changed.
        if (rec.order !== undefined) {
          t.order = rec.order;
        }
        paintStatusDot(t.dot, rec.status, reports);
        // Only a PRESENT percentage updates the tab: the polling fallback lists
        // SessionInfo, which carries none, and reading absence as cleared would
        // blank a live bar every tick. A clear arrives as an explicit -1.
        if (rec.progressValue !== undefined) {
          t.progress = normalizeProgress(rec.progressValue);
        }
        paintProgress(t.progressEl, shownProgress(t));
        // The host's secondary activity, read with the same PRESENT-only guard and
        // for the same reason: the polling fallback lists SessionInfo, and a
        // pre-release server carries neither field at all, so reading absence as
        // "no background task" would blank a live mark on every tick. An empty
        // string IS the withdrawal, and it arrives explicitly.
        if (rec.activity !== undefined) {
          t.activity = normalizeActivity(rec.activity);
        }
        if (rec.activityCount !== undefined) {
          t.activityCount = normalizeActivityCount(rec.activityCount);
        }
        paintActivityMark(t.activityEl, t.activity, t.activityCount);
        // A program that speaks OSC 9 may also post a notification: arm the
        // permission request for the next user gesture.
        if (reports) {
          ctx.shell.notifications.arm();
        }
        // The switch button's latest-wins dot. Cue statuses are LATCHED server-side
        // and re-delivered on every snapshot, so cueSeen is what makes a dismissal
        // stick. The acknowledgement reads the RAW status (a non-cue must reach the
        // forget below); the raise and the forget read the FOLDED one.
        const raw = statusOf(t);
        const cue = cueStatusOf(t);
        if (isShown(rec.id) && pageVisible() && isCueStatus(raw)) {
          // BOTH halves: keyed on the shown tabs alone, this swallowed the cue of
          // the one session the user left running on a hidden page, the case the
          // out-of-page surfaces exist for.
          markCueSeen(rec.id, raw);
        } else if (cue === "") {
          // NO INFORMATION: forgetting here would re-raise the cue from scratch
          // the moment the background task ended.
        } else if (!isCueStatus(cue)) {
          forgetCueSeen(rec.id);
        } else if (isUnseenCue(cue, rec.id, cueSeen)) {
          switchNotify = cue;
          switchNotifyId = rec.id;
          paintSwitchDot();
        }
        // A BLANK title (a status sweep, or the process clearing its OSC 0/2
        // title) must not drop an idle tab back to "New tab". The typeof check is
        // live: rec is unvalidated server JSON, and a missing title would abort
        // the caller's whole reconcile loop.
        if (typeof rec.title === "string" && rec.title.trim() !== "") {
          t.title = rec.title;
        }
        // "" is meaningful here: it is how a clear made in ANOTHER browser reaches
        // this one. The bump is gated on a DIFFERING value because the wire echoes
        // pinnedTitle on every event, and an unconditional bump would mark an
        // in-flight local rename as superseded by its own echo.
        if (rec.pinnedTitle !== undefined && rec.pinnedTitle !== (t.pinnedTitle ?? "")) {
          t.pinnedTitle = rec.pinnedTitle;
          // SSE delivery and REST mutation are not one total order: during a
          // pending request the record may predate our own PUT, and bumping would
          // suppress that request's rollback and its failure toast.
          if (!namesInFlight.has(rec.id)) {
            t.nameSeq++;
          }
        }
      }

      // One list reconcile for both status sources: adopt every session the
      // server lists, then drop tabs it no longer lists. The SSE path runs it on
      // every (re)open because a RESTARTED manager's snapshot carries no
      // tombstones for sessions it never knew, so those tabs would otherwise spin
      // "Reconnecting…" forever. An overlapping call joins the run in flight
      // rather than starting another, so a caller that awaits it sees a listing.
      let reconciling: Promise<void> | null = null;
      const reconcileOnce = (): Promise<void> => {
        reconciling ??= reconcileNow().finally(() => {
          reconciling = null;
        });
        return reconciling;
      };
      async function reconcileNow(): Promise<void> {
        // The listing is authoritative only for tabs that existed when it was
        // requested: a tab adopted while the GET was in flight is invisible to
        // it, and dropping it here cascaded into a duplicate replacement session.
        const epochAtList = tabEpoch;
        let list: SessionInfo[];
        try {
          list = await api.list();
        } catch {
          return; // transient; try again on the next trigger
        }
        if (tornDown()) {
          return;
        }
        const seen = new Set(list.map((s) => s.id));
        for (const info of list) {
          adoptSession(info); // add sessions created elsewhere (no local tab)
          applyStatus(info, reportsOf(info.reportsActivity));
        }
        // Already gone server-side, so no DELETE; tabs born after the snapshot
        // wait for the next reconcile.
        const gone = tabList
          .filter((t) => !seen.has(t.id) && t.born <= epochAtList)
          .map((t) => t.id);
        for (const id of gone) {
          await dropTab(id, false);
        }
        ensureActive();
        syncChrome();
      }
      function warnLayoutOnce(what: string, err?: unknown): void {
        if (warnedLayout) {
          return;
        }
        warnedLayout = true;
        console.warn(`web-terminal-ui: ${what}; the pane layout is not persisted`, err);
      }
      function currentLayout(): PaneLayout | null {
        const left = ctx.shell.pane("left")?.session.id ?? null;
        const right = ctx.shell.pane("right")?.session.id ?? null;
        if (left === null && right === null) {
          return null;
        }
        const split = ctx.shell.split.state();
        return {
          left,
          right,
          handle: split.committedRatio,
          selected: split.selected,
          open: split.open,
        };
      }
      async function writeLayout(layout: PaneLayout, retryOnStale: boolean): Promise<void> {
        try {
          await api.setLayout(layout);
        } catch (err) {
          if (tornDown()) {
            return;
          }
          if (err instanceof SessionAPIError && err.status === 409 && retryOnStale) {
            // A side names a session the server no longer has: this client's view
            // is behind, so re-list and write the reconciled row once more. The
            // reconcile's own change is folded into that one write.
            await reconcileOnce();
            const reconciled = tornDown() ? null : currentLayout();
            if (reconciled !== null) {
              layoutDirty = false;
              await writeLayout(reconciled, false);
            }
            return;
          }
          if (err instanceof SessionAPIError && err.status === 404) {
            warnLayoutOnce("this server has no GET/PUT /api/sessions/layout route");
            return;
          }
          warnLayoutOnce("could not write the pane layout", err);
        }
      }
      function flushLayout(): void {
        layoutDirty = false;
        const layout = currentLayout();
        if (layout === null || tornDown()) {
          return;
        }
        layoutInFlight = writeLayout(layout, true).finally(() => {
          layoutInFlight = null;
          if (layoutDirty && !tornDown()) {
            flushLayout();
          }
        });
      }
      // Every change of the shown tab writes the record; coalesced so a switch
      // that clears and shows sends one PUT, and held while no tab is shown.
      function scheduleLayoutWrite(): void {
        if (tornDown() || applyingRecord) {
          return;
        }
        if (layoutInFlight !== null) {
          layoutDirty = true;
          return;
        }
        if (layoutWrite !== null) {
          return;
        }
        layoutWrite = win.setTimeout(() => {
          layoutWrite = null;
          flushLayout();
        }, 0);
      }
      // Of the split's state, `open`, the remembered handle share and the selected
      // pane are the record's; a drag preview and a resize clamp are not.
      let lastSplit = ctx.shell.split.state();
      ctx.defer(
        ctx.shell.split.onChange((s) => {
          const changed =
            s.open !== lastSplit.open ||
            s.committedRatio !== lastSplit.committedRatio ||
            s.selected !== lastSplit.selected;
          lastSplit = s;
          if (changed) {
            scheduleLayoutWrite();
          }
        }),
      );
      // The shell empties a pane on a close of the split, drops a failed pane's
      // tab from the shown set and moves selection on its own drivers; the chrome
      // and the record read the panes, so both follow.
      ctx.defer(
        ctx.shell.onPanesChange(() => {
          markSurfaces();
          syncCatchups();
          syncChrome();
          scheduleLayoutWrite();
        }),
      );
      ctx.defer(ctx.shell.onSelectionChange(syncChrome));
      if (ctx.shell.split.enabled) {
        // The controller reports a resize only while the split is open; the
        // buttons' width rule holds while it is closed too.
        const rowResize = new win.ResizeObserver(paintSplitButtons);
        rowResize.observe(ctx.shell.root);
        ctx.defer(() => {
          rowResize.disconnect();
        });
      }
      if (monitor) {
        const offStatus = monitor.onStatus((s) => {
          if (s.removed) {
            void dropTab(s.id, false); // already gone server-side; no DELETE
            return;
          }
          adoptSession(s);
          applyStatus(s, reportsOf(s.reportsActivity));
          ensureActive();
          syncChrome();
          // A notification is an EVENT delivered once, so it is handled here and
          // not in applyStatus, which also runs on re-delivered STATE. After
          // syncChrome, so its title is the label the user would see.
          ctx.shell.notifications.deliver(s, {
            sessionIsActive: isShown(s.id),
            label: tabList.find((t) => t.id === s.id)?.display ?? s.title,
            // switchTo no-ops on an id that is gone, which is the case that
            // matters: the tab may have closed between post and click.
            activate: () => {
              switchTo(s.id);
            },
          });
        });
        ctx.defer(offStatus);
        const offStreamOpen = monitor.onStreamOpen?.(() => {
          void reconcileOnce();
        });
        if (offStreamOpen) {
          ctx.defer(offStreamOpen);
        }
      } else {
        const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
        const pollTimer = win.setInterval(() => {
          void reconcileOnce();
        }, pollMs);
        ctx.defer(() => {
          win.clearInterval(pollTimer);
        });
      }

      // A hardware-only key latches sawHardwareKey, which upgrades focus-on-switch
      // for a keyboard folio with no trackpad.
      ctx.registerKeydown((ev) => {
        if (!sawHardwareKey && looksLikeHardwareKey(ev)) {
          sawHardwareKey = true;
        }
        return false;
      });
      bar.addEventListener("dragover", (e) => {
        if (!draggingEl) {
          return;
        }
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "move";
        }
        trackRest(e.clientX);
      });
      // The preventDefault is load-bearing: WebKit's default for an uncancelled
      // drop is to LOAD the payload as a URL, so dropping a tab on iPadOS
      // navigated the page to /<session-id>.
      bar.addEventListener("drop", (e) => {
        const moved = draggingEl;
        if (!moved) {
          return;
        }
        e.preventDefault();
        dropped = true;
        // A release decides by POSITION, not by whatever slot a timer had pending.
        endRestNet();
        commitSlot(dropTargetBefore(e.clientX));
        syncOrderFromDom();
        announceMoved(moved);
      });
      // The strip is docked at the viewport EDGE, so a pointer can leave it by
      // leaving the window, and then no document dragover fires to withdraw the
      // pending slot; the rest window would open a slot the pointer abandoned.
      // dragleave fires on every child-to-child transition inside the bar, and a
      // null relatedTarget is the pointer leaving the window.
      bar.addEventListener("dragleave", (e) => {
        if (!draggingEl) {
          return;
        }
        const next = e.relatedTarget;
        if (next === null || !bar.contains(next as Node)) {
          endRestNet();
        }
      });
      // The half of the pane row a drag is over, or null off the row, over the
      // switcher, or while the row is too narrow for two panes (the strip is the
      // caller's early return). An empty pane is `inert`, so a tab dragged over it
      // hits the shell root underneath.
      function dropHalf(e: DragEvent): PaneSide | null {
        const root = ctx.shell.root;
        const target = e.target as Node;
        if (
          !ctx.shell.split.enabled ||
          !rowFitsSplit() ||
          !root.contains(target) ||
          switcher.contains(target)
        ) {
          return null;
        }
        const rect = root.getBoundingClientRect();
        return e.clientX < rect.left + rect.width / 2 ? "left" : "right";
      }
      function paintDropHalf(half: PaneSide | null): void {
        ctx.shell.root.classList.toggle("wt-drop-left", half === "left");
        ctx.shell.root.classList.toggle("wt-drop-right", half === "right");
      }
      // A tab released anywhere OTHER than the strip must be inert, not a
      // navigation, so the whole document is a drop target for the life of a tab
      // drag; over a half of the pane row it is a snap. Gated on draggingEl so a
      // file dropped on the page is the browser's.
      const onDocTabDrop = (e: DragEvent): void => {
        if (!draggingEl) {
          return;
        }
        e.preventDefault();
        if (bar.contains(e.target as Node)) {
          paintDropHalf(null);
          return;
        }
        const half = dropHalf(e);
        if (e.type === "drop") {
          // A release off the strip CANCELS the reorder: `dropped` stays false and
          // dragend runs the revert. Committing a slot here would persist an
          // arrangement chosen at a position the user visibly left, and would
          // depend on whether the browser emitted `drop` at all.
          endRestNet();
          paintDropHalf(null);
          if (half !== null) {
            const id = tabList.find((t) => t.el === draggingEl)?.id;
            if (id !== undefined) {
              snap(id, half);
            }
          }
          return;
        }
        if (e.dataTransfer && half !== null) {
          e.dataTransfer.dropEffect = "move";
        }
        paintDropHalf(half);
        // No candidate slot exists off the strip; a COMMITTED slot stays put.
        endRestNet();
      };
      doc.addEventListener("dragover", onDocTabDrop);
      doc.addEventListener("drop", onDocTabDrop);
      ctx.defer(() => {
        doc.removeEventListener("dragover", onDocTabDrop);
        doc.removeEventListener("drop", onDocTabDrop);
      });
      // Active-row close (x): closes the current tab (mirrors a listed row's x).
      // stopPropagation so it is not read as a tap/swipe on the row surface.
      swClose.addEventListener("click", (e) => {
        e.stopPropagation();
        const current = selectedId();
        if (current !== null) {
          void close_(current);
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
      doc.addEventListener("click", onDocClickMenu);
      ctx.defer(() => {
        doc.removeEventListener("click", onDocClickMenu);
      });
      // A right-click anywhere other than a tab (the terminal content, elsewhere,
      // or a native browser menu) dismisses the tab menu. A right-click ON a tab
      // is handled by that tab's own contextmenu handler (which reopens it), and
      // fires before this one, so the menu is not immediately re-hidden.
      const onDocContextMenu = (e: MouseEvent): void => {
        if (!(e.target as HTMLElement).closest(".wt-tab")) {
          hideTabMenu();
        }
      };
      doc.addEventListener("contextmenu", onDocContextMenu);
      ctx.defer(() => {
        doc.removeEventListener("contextmenu", onDocContextMenu);
      });
      // Only a scroll of the strip's own scroller moves the menu's anchor. The
      // target check is load-bearing: this capture-phase listener sees EVERY
      // scroll, and without it the terminal auto-scrolling on each chunk of
      // output closed the menu within a frame of it opening.
      const onScrollMenu = (e: Event): void => {
        const target = e.target;
        if (target instanceof win.Element && target.closest(".wt-tab-scroll")) {
          hideTabMenu();
        }
      };
      win.addEventListener("scroll", onScrollMenu, true);
      ctx.defer(() => {
        win.removeEventListener("scroll", onScrollMenu, true);
      });
      ctx.registerKeydown((ev) => {
        if (ev.key === "Escape" && tabMenu.classList.contains("visible")) {
          ev.preventDefault();
          hideTabMenu();
          return true;
        }
        return false;
      });
      // A tap on the terminal dismisses an open mobile overlay (the expanded tab
      // list or the key grid) rather than opening the keyboard. Capture phase with
      // stopPropagation, so the surface tap-to-focus never fires for that tap.
      const onDocTapDismiss = (e: PointerEvent): void => {
        // A swipe owns the pointer and resolves in the window-level pointerup;
        // swallowing that here (when setPointerCapture failed and the finger
        // released outside the switcher) stranded gActive and bricked every swipe.
        if (gActive) {
          return;
        }
        const kb = opts.keyboardToggle ? ctx.use(opts.keyboardToggle) : undefined;
        const gridOpen = kb?.isOpen() ?? false;
        if (!expanded && !gridOpen) {
          return;
        }
        const target = e.target as HTMLElement | null;
        // The strip counts as chrome: the desktop keyboard button's own pointerup
        // otherwise closed the grid here and its click re-opened it.
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
      doc.addEventListener("pointerup", onDocTapDismiss, true);
      ctx.defer(() => {
        doc.removeEventListener("pointerup", onDocTapDismiss, true);
      });

      // The bar's drag follows the finger live: after the axis lock it previews a
      // tab switch (horizontal) or grows the tab list (vertical), and snaps on
      // release past a quarter-width or the halfway point. The pointer is captured
      // so a drag that leaves the bar still delivers its move/up here.
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
        frame(() => {
          for (const el of rows) {
            el.style.transition = "transform 0.2s ease-out";
            el.style.transform = "translateY(0)";
          }
        });
        if (reelTimer !== null) {
          win.clearTimeout(reelTimer);
        }
        reelTimer = win.setTimeout(endReelNow, 220);
      }
      function endHorizontal(dx: number, releaseT: number, canceled: boolean): void {
        const width = ctx.surface().clientWidth || win.innerWidth;
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
          after(220, () => {
            for (const el of swipeEls) {
              el.style.transition = "";
            }
          });
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
        frame(() => {
          for (const el of swipeEls) {
            el.style.transition = "transform 0.25s cubic-bezier(0.2, 0, 0, 1)";
            el.style.transform = "translateX(0)";
          }
        });
        after(320, () => {
          for (const el of swipeEls) {
            el.style.transition = "";
            el.style.transform = "";
          }
        });
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
        const visH = win.visualViewport?.height ?? win.innerHeight;
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
          ctx.modes.getMouseMode() === 0
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
            if (ctx.modes.getMouseMode() !== 0) {
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
          win.addEventListener("pointermove", onGestureMove, opts);
          win.addEventListener("pointerup", endOnUp, opts);
          win.addEventListener("pointercancel", endOnCancel, opts);
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

      // The bootstrap (paneLayoutOwner.resolveInitialLayout): list existing
      // sessions or create the first one, adopt them, pick the start tab from the
      // server's layout record, and show it. A false return (nothing could be
      // listed or spawned) keeps the chrome up with the "+" retry alive, and the
      // terminal dismisses the loading overlay over it. The record is read once
      // and never written back by a read.
      const resolveInitialLayout = async (): Promise<boolean> => {
        const [listed, layoutRead] = await Promise.allSettled([api.list(), api.getLayout()]);
        if (tornDown()) {
          return false;
        }
        let sessions: SessionInfo[] = listed.status === "fulfilled" ? listed.value : [];
        let layout: PaneLayout | null = null;
        if (layoutRead.status === "fulfilled") {
          layout = layoutRead.value;
          if (layout === null) {
            warnLayoutOnce("this server has no GET/PUT /api/sessions/layout route");
          }
        } else {
          warnLayoutOnce("could not read the pane layout", layoutRead.reason);
        }
        // A fresh session unless a LIVE one is listed: an ended session is viewable
        // history, not a working terminal, and a boot onto one would hang the
        // loading state. The dead ones are still adopted below.
        if (!sessions.some((s) => !isEndedStatus(s.status))) {
          try {
            sessions = [...sessions, await createSessionHonouringRetry(api, ctx, lifetime.signal)];
          } catch (err) {
            if (tornDown()) {
              return false;
            }
            // The give-up path (a 503 was already retried on the server's schedule):
            // toast with the server's explanation and leave the chrome up so "+"
            // can retry, as the runtime create() does.
            ctx.toast(
              err instanceof SessionAPIError && err.serverMessage !== undefined
                ? `Couldn't open a terminal: ${err.serverMessage}`
                : "Couldn't open a terminal",
            );
          }
        }
        // Adopt rather than push: the status stream's open snapshot may already
        // have given a listed session its tab, since the subscription precedes
        // this list.
        for (const info of sessions) {
          adoptSession(info);
        }
        // From here on, tabs added at runtime (create / adopt) animate in.
        started = true;
        // A tap on a chip while the list was in flight outranks the record;
        // ensureActive is deliberately NOT one of these callers during boot (see
        // its bootShowedNothing gate), or the SSE snapshot would win this race on
        // every load.
        if (anyShown()) {
          return true;
        }
        // The record's sessions where they still exist, else the oldest LIVE tab:
        // a reload must not restore onto the corpse of a session that died while
        // away. Only when nothing is live does a dead tab start, a frozen final
        // screen beating a blank page.
        const liveIds = new Set(sessions.filter((s) => !isEndedStatus(s.status)).map((s) => s.id));
        const oldestLive = tabList.find((t) => liveIds.has(t.id));
        const saved = (id: string | null): Tab | undefined => {
          const tab = id === null ? undefined : tabList.find((x) => x.id === id);
          return tab && (liveIds.has(tab.id) || oldestLive === undefined) ? tab : undefined;
        };
        // Shown directly rather than through showIn: a boot announces no switch
        // and no selection, animates none, and writes no record.
        const showAtBoot = (side: PaneSide, tab: Tab): boolean => {
          const pane = ctx.shell.pane(side);
          if (pane === null) {
            return false;
          }
          pane.render.bind(tab.store);
          pane.notifySwitch({ id: tab.id });
          return true;
        };
        let shown = false;
        if (layout?.open === true) {
          const sides: Record<PaneSide, Tab | undefined> = {
            left: saved(layout.left),
            right: saved(layout.right),
          };
          // The record's side while it still has a tab to show, else the side that has one.
          const selected: PaneSide = sides[layout.selected]
            ? layout.selected
            : sides.left
              ? "left"
              : "right";
          applyingRecord = true;
          try {
            if ((sides.left || sides.right) && ctx.shell.restoreSplit(layout.handle, selected)) {
              for (const side of ["left", "right"] as const) {
                const tab = sides[side];
                if (tab) {
                  shown = showAtBoot(side, tab) || shown;
                }
              }
            }
          } finally {
            applyingRecord = false;
          }
        }
        if (!shown) {
          const startTab =
            saved(
              layout === null ? null : layout.selected === "right" ? layout.right : layout.left,
            ) ??
            oldestLive ??
            tabList[0];
          shown = startTab !== undefined && showAtBoot(ctx.shell.targetFor(startTab.id), startTab);
        }
        if (!shown) {
          bootShowedNothing = true;
          return false;
        }
        syncChrome();
        focusInput();
        return true;
      };
      live = { resolveInitialLayout, shownIn, showIn };

      return {
        api: {
          create,
          close: close_,
          switchTo,
          snap,
          list: () => tabList.map((t) => ({ id: t.id, title: t.display, active: isShown(t.id) })),
        },
        teardown() {
          live = null;
          if (layoutWrite !== null) {
            win.clearTimeout(layoutWrite);
            layoutWrite = null;
          }
          varRoot.style.removeProperty("--wt-tabbar-h");
          root.classList.remove("wt-tabbed");
          varRoot.style.removeProperty("--wt-reserve-bottom");
          endSwitchAnim();
          if (collapseClearTimer !== null) {
            win.clearTimeout(collapseClearTimer);
          }
          endReelNow();
          gestureAbort?.abort(); // drop any in-flight gesture's window listeners
          endEdit(); // abandon an open rename without issuing a request
          clearDragGhost();
          paintDropHalf(null);
          endReorderPreview();
          endShift(); // leave no inline style on a chip this feature no longer owns
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
        },
      };
    },
  };
}
