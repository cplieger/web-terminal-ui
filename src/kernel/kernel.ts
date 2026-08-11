// The v3 kernel: createTerminal (design section 22.3, 22.6).
//
// The kernel is the irreducible core that makes it a terminal at all: the
// display-only output surface and the hidden textarea that owns the keyboard,
// IME/composition, the engine wiring (render/connection/scroll), viewport and
// keyboard-inset handling, the single sanitizing input funnel, the
// connection-state machine + loading lifecycle, the shared primitives (toast,
// announce, tablist), and the named layout regions. Everything visible above
// the raw terminal (toolbar, menu, banner text, tabs) is an opt-in feature.
//
// State is closure-scoped per createTerminal call (not module singletons), so
// destroy() can tear it down; the engine's render/connection/scroll modules are
// still single-instance, so createTerminal is called once per page (tabs
// multiplex sessions over the one kernel, section 22.5).
//
// Mouse tracking (engine `mouse` module) is intentionally NOT wired here yet:
// the design adds it (section 22.3), but wiring it also brings DEC 1004 focus
// emission, which must be suppressed under the keep-unfocused model (section
// 7.2). Not wiring it keeps the client emitting no focus bytes (the safe
// default the previous UI already had); adding mouse tracking with focus
// suppression is a tracked follow-up.

import {
  render,
  scroll,
  connection,
  keyboard,
  modes,
  LineStore,
} from "@cplieger/web-terminal-engine";
import * as composition from "../composition.js";
import * as viewport from "../viewport.js";
import { INPUT_PLACEHOLDER, resetToPlaceholder } from "../input-placeholder.js";
import { createBus } from "./bus.js";
import { optionalPositiveIntOption } from "./options.js";
import { TAP_MAX_MS, TAP_MOVEMENT_PX, isLinkTarget } from "./gesture.js";
import { createRegions } from "./regions.js";
import { createAnnouncer, createTablist } from "./a11y.js";
import { createConnState } from "./conn-state.js";
import { createScrollbackKeeper } from "./scrollback.js";
import { STARTUP_FAILURE_COPY } from "./startup-copy.js";
import { attachLoadingStatus, DEFAULT_LOADING_MESSAGES } from "./loading-status.js";
import type {
  CreateTerminalOptions,
  FeatureInstance,
  SessionRef,
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
  Unsubscribe,
} from "./types.js";

const { mapKeyboardEvent, bracketTextForPaste, prepareTextForTerminal } = keyboard;

const DEFAULT_WS_PATH = "/ws";
const DEFAULT_FONT_READY = '14px "Monaspace Neon NF"';

const TOAST_MS = 3000;
// A touch that focuses the input (opens the soft keyboard) must be a genuine
// tap: short and low-movement. A longer hold is a long-press, which belongs to
// native text selection / the context menu — so tap-to-focus bows out above
// this duration and never steals a long-press or a selection. The thresholds
// live in gesture.ts because the contextMenu feature classifies the other side
// of the same boundary from them.
// The narrow-layout breakpoints, in ROOT pixels. The single source of the
// numbers: the kernel mirrors the resulting fact into the .wt-narrow root
// class for CSS (paired there with pointer-coarseness media queries where
// touch matters) and features read the same fact via ctx.layout(). Root
// dimensions — not viewport dimensions — so an embedded terminal in a narrow
// panel counts as narrow. For every full-page consumer root size equals
// viewport size, so the width half matches the old (max-width: 600px) media
// queries exactly.
const NARROW_MAX_PX = 600;
// A root can be compact by HEIGHT as well as width: a large phone rotated to
// landscape (e.g. an iPhone 14 Pro Max at 932x430) is wider than
// NARROW_MAX_PX, but its short viewport is still a phone in the hand — the
// thumb-reach switcher bar is the right UX and the desktop strip wastes
// scarce rows. Tablets are never this short (the smallest iPad is 744 CSS px
// tall in landscape), so height <= 500 cleanly separates "landscape phone"
// from "tablet/desktop" with margin on both sides (the tallest current
// phones are ~440 in landscape, less with browser chrome).
const SHORT_MAX_PX = 500;

// Kernel-owned core subtree: the display-only output, the hidden textarea (the
// single keyboard target), and the IME composition view. No chrome; features
// build that into regions. Static, trusted markup parsed once via a template.
const CORE_TEMPLATE = `
<div class="term">
  <div class="term-output" role="log" aria-live="off" aria-roledescription="Terminal" aria-label="Terminal"></div>
  <textarea class="term-input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Terminal input" tabindex="-1"></textarea>
  <div class="composition-view" aria-hidden="true"></div>
</div>`;

function pick(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`web-terminal-ui: createTerminal failed to build ${selector}`);
  }
  return el;
}

/** Fade out and remove a consumer-supplied loading overlay.
 *
 *  Module scope because BOTH startup-failure phases need it and they live on
 *  opposite sides of createTerminal's closure: the async `feature-setup` path
 *  reaches it through dismissLoadingOverlay (which adds the once-only guard),
 *  the synchronous `kernel-init` path calls it directly from the catch, where
 *  no kernel state exists yet. */
function fadeOutOverlay(ld: HTMLElement | undefined): void {
  if (!ld) {
    return;
  }
  ld.classList.add("fade");
  const removeOverlay = (): void => {
    ld.remove();
  };
  ld.addEventListener("transitionend", removeOverlay, { once: true });
  window.setTimeout(removeOverlay, 1500);
}

/** Render the kernel-owned "Terminal failed to start" recovery surface into root.
 *
 *  Module scope for the same reason as fadeOutOverlay: it is the ONE
 *  implementation of this surface, shared by the async `feature-setup` phase and
 *  the synchronous `kernel-init` phase, so the two can never drift apart. It
 *  depends on nothing but its two arguments. */
function renderFatalStartupInto(
  root: HTMLElement,
  layoutMode: "viewport" | "container",
  message: string = STARTUP_FAILURE_COPY.message,
): void {
  const surface = document.createElement("section");
  surface.className = "wt-fatal";
  surface.setAttribute("role", "alertdialog");
  surface.setAttribute("aria-labelledby", "wt-fatal-title");
  surface.setAttribute("aria-describedby", "wt-fatal-message");
  if (layoutMode === "viewport") {
    // A full-page terminal has no usable host UI behind it, so this is the
    // page's modal recovery state. An embedded terminal is only one panel in
    // a larger app and must not claim that the rest of the app is inert.
    surface.setAttribute("aria-modal", "true");
  }

  const card = document.createElement("div");
  card.className = "wt-fatal-card";
  const title = document.createElement("h2");
  title.id = "wt-fatal-title";
  title.className = "wt-fatal-title";
  title.textContent = STARTUP_FAILURE_COPY.title;
  const messageEl = document.createElement("p");
  messageEl.id = "wt-fatal-message";
  messageEl.className = "wt-fatal-message";
  messageEl.textContent = message;
  const reloadButton = document.createElement("button");
  reloadButton.className = "wt-btn wt-fatal-reload";
  reloadButton.type = "button";
  reloadButton.textContent = STARTUP_FAILURE_COPY.reloadLabel;
  reloadButton.addEventListener("click", () => {
    window.location.reload();
  });
  card.append(title, messageEl, reloadButton);
  surface.appendChild(card);
  root.replaceChildren(surface);

  // The terminal input held focus before setup failed. Move that focus to the
  // only recovery action; container mode remains non-modal because no trap or
  // aria-modal claim prevents the user from leaving the terminal panel.
  reloadButton.focus();
}

/** Build the terminal. See createTerminal, which wraps this to give a
 *  SYNCHRONOUS failure the same recovery surface an async one already gets. */
function buildTerminal(
  root: HTMLElement,
  opts: CreateTerminalOptions,
  featureList: readonly TerminalFeature<unknown>[],
): TerminalHandle {
  const wsPath = opts.wsPath ?? DEFAULT_WS_PATH;
  const fontReady = opts.fontReady ?? DEFAULT_FONT_READY;
  // The one resolved retained-line cap: the engine renderer's implicit store
  // and every ctx.newLineStore() (the tabs switching cache) both honor it, so
  // a consumer sets its memory budget in exactly one place.
  // Invalid reads as OMITTED, so the engine's own default applies — and the engine
  // additionally floors the cap at the live screen, so even a tiny valid value
  // cannot truncate the visible window.
  const scrollbackLines = optionalPositiveIntOption(opts.scrollbackLines, "scrollbackLines");
  // Scrollback persistence (off unless the consumer supplied storage). One
  // keeper serves the whole terminal: the kernel's implicit store below and
  // every per-session store a session-owning feature creates through
  // ctx.newLineStore(sessionId).
  const scrollbackKeeper =
    opts.persistScrollback !== undefined
      ? createScrollbackKeeper(opts.persistScrollback, scrollbackLines)
      : null;
  // At most one feature owns session selection (fail fast, before any DOM
  // work): the kernel drives the first connect through its registration.
  const owners = featureList.filter((f) => f.sessionOwner !== undefined);
  if (owners.length > 1) {
    throw new Error(
      `web-terminal-ui: multiple session-owning features: ${owners.map((f) => f.name).join(", ")}`,
    );
  }
  const sessionOwner = owners[0]?.sessionOwner;
  const sessionOwnerName = owners[0]?.name ?? "";
  const encoder = new TextEncoder();
  const kernelAbort = new AbortController();
  const { signal } = kernelAbort;

  // Apply consumer theme overrides as CSS custom properties on the root, so the
  // whole terminal subtree inherits them. The library ships the token defaults
  // (css/00-tokens.css); these override them for this instance. Only custom
  // properties (leading "--") are set.
  if (opts.theme) {
    for (const [key, value] of Object.entries(opts.theme)) {
      if (key.startsWith("--")) {
        root.style.setProperty(key, value);
      }
    }
  }

  // Stamp the boundary classes: .wt-root scopes every library token and style
  // rule to this subtree, and the layout-mode class decides how the root claims
  // space — wt-viewport pins the root itself to the full viewport (the
  // full-page product), wt-container fills the parent element (the embedded
  // case). All chrome positions against the root, never the page. destroy()
  // removes them.
  const layoutMode = opts.layout ?? "viewport";
  root.classList.add("wt-root", layoutMode === "container" ? "wt-container" : "wt-viewport");

  // --- Build the core subtree ---
  const tpl = document.createElement("template");
  tpl.innerHTML = CORE_TEMPLATE;
  root.replaceChildren(tpl.content);
  const termWrap = pick(root, ".term");
  const outputEl = pick(root, ".term-output");
  const input = pick(root, ".term-input") as HTMLTextAreaElement;
  const compositionViewEl = pick(root, ".composition-view");

  // --- Regions + shared primitives ---
  const regions = createRegions(root);
  const bus = createBus();
  const announcer = createAnnouncer(root);
  const tablistController = createTablist(outputEl);

  // --- Narrow-layout driver (.wt-narrow mirrors root size for CSS) ---
  // Narrow = compact in EITHER dimension: skinny (a phone in portrait, a
  // narrow embedded panel) or short (a phone in landscape). The one
  // ResizeObserver below fires on both width and height changes.
  const isNarrow = (): boolean =>
    root.clientWidth <= NARROW_MAX_PX || root.clientHeight <= SHORT_MAX_PX;
  function updateNarrow(): void {
    root.classList.toggle("wt-narrow", isNarrow());
  }
  updateNarrow();
  let narrowObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    narrowObserver = new ResizeObserver(updateNarrow);
    narrowObserver.observe(root);
  }

  // Toast surface (kernel-owned shared primitive, section 22.3).
  const toastEl = document.createElement("div");
  toastEl.className = "wt-toast";
  toastEl.setAttribute("role", "status");
  regions.region("banner", "toast").appendChild(toastEl);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function toast(message: string, ms = TOAST_MS): void {
    toastEl.textContent = message;
    toastEl.classList.add("visible");
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toastEl.classList.remove("visible");
      toastEl.textContent = "";
    }, ms);
  }

  // --- Feature error routing ---
  const errorHandlers = new Set<(feature: string, err: unknown) => void>();
  function reportError(feature: string, err: unknown): void {
    if (errorHandlers.size === 0) {
      console.error(`web-terminal-ui: feature "${feature}" error`, err);
      return;
    }
    for (const fn of [...errorHandlers]) {
      try {
        fn(feature, err);
      } catch (handlerErr) {
        // Error reporting must never turn the original feature failure into an
        // unhandled rejection or prevent fatal-startup cleanup from running.
        console.error("web-terminal-ui: feature error handler failed", handlerErr);
      }
    }
  }

  // --- Input funnel (the single sanitizing, session-routed send path) ---
  const inputTransforms: ((b: Uint8Array) => Uint8Array)[] = [];
  const inputObservers: ((b: Uint8Array) => void)[] = [];

  function sendBytes(bytes: Uint8Array): void {
    let out = bytes;
    for (const t of inputTransforms) {
      out = t(out);
      if (out.length === 0) {
        return; // a transform dropped it (e.g. the col-0 backspace brake)
      }
    }
    // sendBinary buffers while disconnected (resume layer) and returns false
    // only when the outbox is full (already surfaced via onOutboxFull). Only
    // notify observers on accepted input, so predictive echo never paints a
    // phantom char that never reached the server.
    if (!connection.sendBinary(out)) {
      return;
    }
    // Classic-terminal behavior (GNOME/xterm): user input re-engages follow and
    // snaps to the bottom, so typing while scrolled up jumps to the input line.
    // Instant (not the jump-button's smooth scroll), so it isn't janky per
    // keystroke. This is the ONLY thing that scrolls a held view down — program
    // output never does (the scroll controller's follow/hold job is unchanged),
    // so scrolling up to read while output streams is preserved. A no-op on the
    // alt screen (no scrollback) and when already following. NOTE: every caller
    // of sendBytes today is genuine user input (typed keys, paste, mobile
    // toolbar); if mouse tracking is ever wired through ctx.send, its motion
    // bytes must NOT come through here or the view would snap on every move.
    scroll.scrollToBottom();
    for (const obs of inputObservers) {
      obs(out);
    }
  }
  function sendText(text: string): void {
    sendBytes(encoder.encode(text));
  }
  function paste(text: string): void {
    // The one bracketed-paste + newline-normalize funnel; every feature and the
    // kernel's own paste paths route through here (paste-jacking defense).
    sendText(bracketTextForPaste(prepareTextForTerminal(text)));
  }

  // --- Keydown intercept chain (clipboard shortcuts, contextMenu Escape) ---
  const keydownHandlers: ((ev: KeyboardEvent) => boolean)[] = [];

  // --- Active session (SessionView + onSwitch fan-out) ---
  let activeSession: SessionRef | null = null;
  // Whether the first connection has been kicked off. The wake-reconnect
  // handlers (visibilitychange/pageshow/online) must not open a socket before
  // it has: under a session owner the kernel drives the first connect only
  // once resolveInitialSession() returns a session id, and connecting to the
  // bare wsPath before then hits a session-gated endpoint (the SessionManager
  // 404s a /ws with no ?session=). pageshow fires on the initial load, so
  // without this gate a slow session list lets pageshow's reconnectNow open a
  // bare /ws that 404s (seen in Firefox, where the list loses the race). Flips
  // true on the startup connect (no owner) or the first setSession (owned).
  let connectionInitiated = false;

  // --- Loading lifecycle ---
  let ready = false;
  /**
   * Every LineStore this kernel hands out, held WEAKLY and keyed by session. A
   * closed tab's store must stay collectable, and a weak registry cannot leak or
   * go stale the way a strong map paired with an unregister call can — the store
   * outlives the tab record in more than one teardown order.
   *
   * Keyed rather than a bare set because two features need to reach a SPECIFIC
   * session's store, not just "all of them": the restore guard below, and the
   * browse-cache sweep. The implicit store (a bare kernel with no session owner)
   * has no id, so it takes a reserved key no session can collide with.
   */
  const knownStores = new Map<string, WeakRef<LineStore>>();
  const IMPLICIT_STORE_KEY = "\u0000implicit";
  /** The live stores, pruning entries whose store has been collected. */
  function liveStores(): LineStore[] {
    const out: LineStore[] = [];
    for (const [key, ref] of knownStores) {
      const store = ref.deref();
      if (store === undefined) {
        knownStores.delete(key); // the tab closed and its store was collected
        continue;
      }
      out.push(store);
    }
    return out;
  }

  // Which restored scrollbacks have not yet been confirmed against the live
  // server. A session enters when its snapshot is hydrated and leaves on the
  // first resumeAck for THAT session; in between, the content is last session's —
  // plausible but unconfirmed.
  //
  // Per SESSION, and that is the whole point. Two booleans stood here, and under
  // the tabs preset (which every reference app uses) they could not do the job:
  // N sessions are hydrated at boot and all set the same flag, the active
  // session's first ack cleared it for everyone, and the reset reached only the
  // renderer-BOUND store. So tabs 2..N were neither verified nor discardable for
  // the life of the page, and the exact failure this guard exists to prevent —
  // the previous run's output under a "Session ended" banner — stayed reachable
  // by switching tabs. The claimed invariant ("only ever discards a restore,
  // never live content") also did not hold: a background tab's restore
  // authorised a reset of the bound tab's store.
  const unverifiedRestores = new Set<string>();
  /** Drop restored scrollback that will never be confirmed.
   *
   *  The epoch check makes a stale restore self-correcting ONLY when a resumeAck
   *  arrives: that is what compares the seeded epoch and fires the restart reset.
   *  Two closes reach `markReady` without one — a process-exited 4001 (the session
   *  is gone, which is what a container restart leaves behind) and a wire-revision
   *  refusal (a cached client one revision behind, which is what an image update
   *  leaves behind). Both are exactly the restart case, and without this the
   *  overlay lifts over the PREVIOUS run's output under a "Session ended" banner —
   *  the one path where the design's stated worst case was reachable.
   *
   *  SCOPE matters because the two triggers differ: a 4001 says one session's
   *  process is gone, so only that session's restore is condemned; a wire refusal
   *  says this client cannot talk to this server at all, so every unverified
   *  restore is. Discarding page-wide on a 4001 would wipe restores for sessions
   *  that are perfectly alive.
   *
   *  Only ever discards a restore, never live content: a session leaves the set
   *  the moment its resume is served, and a session that was never hydrated never
   *  enters it. */
  function discardUnverifiedRestore(scope: { session: string } | "page"): void {
    const ids = scope === "page" ? [...unverifiedRestores] : [scope.session];
    const bound = render.boundStore();
    for (const id of ids) {
      if (!unverifiedRestores.delete(id)) {
        continue; // never hydrated, or already verified
      }
      const store = knownStores.get(id)?.deref();
      if (store === undefined || store === bound) {
        // The BOUND store goes through the renderer so the DOM is reconciled;
        // an unknown id can only be the implicit store, which is also bound.
        render.resetScrollback();
        render.resetScreen();
        continue;
      }
      // A background store has no DOM: resetting it is enough, and the next
      // bind rebuilds from whatever it then holds.
      store.reset();
    }
  }
  let firstFrameRendered = false;
  let fontsLoaded = false;
  let wsOpen = false;
  let overlayDismissed = false;
  // Progressive status text on the consumer's overlay. Attached unconditionally
  // (inert when no overlay was supplied) and torn down by the same function that
  // lowers the overlay, so there is exactly one place where the loading screen's
  // life ends and no timer can outlive the thing it was writing into.
  const loadingStatus = attachLoadingStatus(opts.loading, {
    ...DEFAULT_LOADING_MESSAGES,
    ...opts.loadingMessages,
  });
  function dismissLoadingOverlay(): void {
    loadingStatus.stop();
    const ld = opts.loading;
    if (!ld || overlayDismissed) {
      return;
    }
    overlayDismissed = true;
    fadeOutOverlay(ld);
  }
  function markReady(): void {
    if (ready) {
      return;
    }
    ready = true;
    connState.setLoaded();
    dismissLoadingOverlay();
  }

  // --- Connection-state machine ---
  const connState = createConnState({
    onState: (s) => {
      bus.emit("connection:state", s);
    },
    onGiveUp: dismissLoadingOverlay,
  });

  // --- Engine wiring ---
  render.init({
    output: outputEl,
    termWrap,
    onCursorMove: () => {
      composition.positionCompositionView();
      bus.emit("render:cursor", undefined);
    },
    // Demand-paged scrollback (engine docs/paged-scrollback.md §5.4). The
    // renderer owns the DECISION (which gap the reader is approaching, and how
    // much to ask for); the transport owns the request. Wrapped rather than
    // passed by reference so neither module's identity leaks into the other's
    // options object.
    requestHistory: (fromAbs, maxLines) => connection.requestHistory(fromAbs, maxLines),
    historyBudget: () => connection.historyBudget(),
    ...(scrollbackLines !== undefined ? { maxLines: scrollbackLines } : {}),
  });
  render.updateFontMetrics();

  composition.init({
    textarea: input,
    compositionView: compositionViewEl,
    getCursorPx: render.getCursorPx,
    send: sendText,
    paste,
  });

  scroll.init({
    scrollEl: termWrap,
    onUserScrollChange(scrolledUp) {
      bus.emit("scroll:state", { scrolledUp });
    },
    // Every position change, not only a follow/hold toggle: a reader scrolling
    // WITHIN history never toggles follow, and that is exactly when paging has
    // to work. The trigger re-evaluates its own guards, so firing for the
    // browser's own clamps as well as gestures costs nothing.
    onScrollPosition: () => {
      render.maybeFetchHistory();
    },
  });

  // The size this client would announce right now, or null when it cannot
  // measure trustworthily yet. Both the resume-time announce (the engine's
  // Callbacks.initialSize) and the open-time send below read it, so there is one
  // definition of "measurable" rather than two that can disagree.
  //
  // Unmeasurable means either web fonts are still loading (cell metrics would be
  // wrong, so cols/rows would be) or a viewport transition is in flight (an iOS
  // keyboard slide or rotation, whose intermediate geometry is provisional). In
  // both cases announcing costs a second resize once the real size is known, and
  // therefore a second redraw from any program that repaints on SIGWINCH.
  function measurableSize(): { cols: number; rows: number } | null {
    if (!fontsLoaded || viewport.isInTransition()) {
      return null;
    }
    render.updateFontMetrics();
    return render.computeSize();
  }

  function maybeSendFirstResize(): void {
    if (!wsOpen || measurableSize() === null) {
      return;
    }
    connection.sendResize();
  }

  connection.init({
    computeSize: render.computeSize,
    getHaveThrough: render.getHighestIndex,
    // --- Demand-paged scrollback (engine docs/paged-scrollback.md §4-5) ---
    // The transport is store-blind and viewport-blind by design, so every one of
    // these forwards a decision only the renderer can make. Without them the
    // engine's paging machinery is inert: the server still declares the
    // capability and still bounds its replay, but nothing ever asks for a page.
    //
    // How much replay this client wants on attach: no more than it intends to
    // keep resident. The server bounds the replay regardless, and the client
    // sends the same number, so its replay-jump prediction and the server's
    // actual start agree.
    getReplayMax: render.replayMaxForResume,
    onHistoryReply: render.handleHistoryReply,
    // ONE transition per ack, carrying the values this socket SENT. It must not
    // be split into separate callbacks: the store's five steps (epoch reset,
    // bounds, cap flip, replay-jump prediction, budget pass) are ordered against
    // each other, and an implementer with five hooks can interleave them.
    onResumeTransition: render.applyResumeTransition,
    // The solicited window: the store's permission to admit lines below its
    // stale-re-send watermark, opened for exactly the range in flight and closed
    // when the reply lands.
    noteSolicited: render.noteSolicited,
    clearSolicited: render.clearSolicited,
    // A denied request (paced by the token bucket, or a data timeout) re-runs the
    // FULL trigger rather than replaying the denied range: by the time the bucket
    // refills the gap may have healed, or the session may have entered alt.
    onHistoryRetry: () => {
      render.maybeFetchHistory();
    },
    onResumeBounds(committed, oldest) {
      // A resume VERIFIES the restored store of the session it belongs to: the
      // server has answered under a known epoch, so that content is confirmed
      // rather than merely plausible. Recorded here because onResumeBounds rides
      // every resumeAck, which is also where the epoch comparison happens. Scoped
      // to the socket's OWN session — one ack cannot vouch for a tab it never
      // talked to.
      unverifiedRestores.delete(connection.currentSessionId());
      render.noteResumeBounds(committed, oldest);
    },
    // Announced BEFORE the resume so the server's snapshot and history replay
    // come back at this client's geometry (engine Callbacks.initialSize).
    initialSize: measurableSize,
    wsPath,
    onMessage(msg) {
      if (msg.type === "screen") {
        render.handleScreen(msg);
        firstFrameRendered = true;
        if (fontsLoaded) {
          markReady();
        }
        bus.emit("wire:screen", msg);
      } else if (msg.type === "scroll") {
        render.handleScroll(msg);
      } else if (msg.type === "title") {
        // Match the app's own title policy (tabs.ts wire:title / applyStatus,
        // which ignore a blank OSC 0/2 title): a shell clears its window title
        // when it redraws its prompt after idling, so hold the last-good browser
        // title instead of flickering blank.
        if (msg.title.trim() !== "") {
          document.title = msg.title;
        }
        bus.emit("wire:title", { session: activeSession?.id ?? "", title: msg.title });
      } else if (msg.type === "modes") {
        render.updateReverseVideo();
        bus.emit("wire:modes", msg);
      } else if (msg.type === "clipboard") {
        // Inbound OSC 52. With no clipboard feature subscribed this is a no-op
        // (section 22.4).
        bus.emit("wire:clipboard", msg.text);
      }
    },
    onOpen() {
      connState.open();
      wsOpen = true;
      maybeSendFirstResize();
    },
    onConnecting() {
      connState.reconnecting();
    },
    onClose() {
      connState.closed();
    },
    onOutboxFull() {
      connState.closed();
    },
    onProcessExit() {
      // The engine's definitive 4001 close: the session's process has exited
      // and the engine will not reconnect it. Two jobs here. markReady()
      // guarantees the page is usable even when the exit lands before any
      // screen frame (attaching to an already-dead session on a server that
      // races the replay) — without it the loading overlay would sit on top of
      // the tabs chrome forever, which is exactly the reported stuck-loading
      // wedge. Then surface the end state: "Session ended", not a flapping
      // "Reconnecting…", since no reconnect is coming. The final screen (when
      // the server delivered it) stays rendered behind the banner.
      discardUnverifiedRestore({ session: connection.currentSessionId() });
      markReady();
      connState.ended();
    },
    onWireIncompatible() {
      // Compatibility refusal is terminal for this page instance. Lower the
      // pre-JS overlay even if no screen frame arrived, then leave the
      // actionable banner visible while the engine suppresses reconnects.
      discardUnverifiedRestore("page");
      markReady();
      connState.incompatible();
    },
    onServerRestart() {
      render.resetScrollback();
      render.resetScreen();
      connState.restarted();
    },
  });

  // --- Input handling ---
  resetToPlaceholder(input);

  input.addEventListener(
    "input",
    (e: Event) => {
      if (composition.isComposing()) {
        return;
      }
      const ev = e as InputEvent;
      const inputType = ev.inputType;
      if (
        inputType === "deleteContentBackward" ||
        inputType === "deleteContentForward" ||
        inputType === "deleteWordBackward" ||
        inputType === "deleteWordForward"
      ) {
        resetToPlaceholder(input);
        return;
      } else if (typeof ev.data === "string" && ev.data.length > 0) {
        if (inputType === "insertFromPaste") {
          paste(ev.data);
        } else {
          // Normalize iOS's NBSP-for-space quirk, then send through the funnel.
          sendText(ev.data.replace(/\u00A0/g, " "));
        }
      } else {
        const v = input.value;
        if (v.length > INPUT_PLACEHOLDER.length && v.startsWith(INPUT_PLACEHOLDER)) {
          sendText(v.slice(INPUT_PLACEHOLDER.length).replace(/\u00A0/g, " "));
        } else if (v !== INPUT_PLACEHOLDER && v.length > 0) {
          sendText(v.replace(/\u00A0/g, " "));
        }
      }
      resetToPlaceholder(input);
    },
    { signal },
  );

  input.addEventListener(
    "focus",
    () => {
      termWrap.classList.add("focus");
    },
    { signal },
  );
  input.addEventListener(
    "blur",
    () => {
      resetToPlaceholder(input);
      termWrap.classList.remove("focus");
    },
    { signal },
  );

  input.addEventListener(
    "keydown",
    (ev: KeyboardEvent) => {
      if (composition.isComposing()) {
        return;
      }
      // Features intercept first (clipboard Ctrl+Shift+C/V, contextMenu Escape).
      for (const h of keydownHandlers) {
        if (h(ev)) {
          return;
        }
      }
      const result = mapKeyboardEvent(ev, modes);
      switch (result.kind) {
        case "send":
          ev.preventDefault();
          sendText(result.bytes);
          return;
        case "scroll-up": {
          ev.preventDefault();
          const h = termWrap.clientHeight;
          termWrap.scrollTop = Math.max(0, termWrap.scrollTop - h);
          return;
        }
        case "scroll-down": {
          ev.preventDefault();
          const h = termWrap.clientHeight;
          termWrap.scrollTop = Math.min(termWrap.scrollHeight, termWrap.scrollTop + h);
          return;
        }
        case "ignore":
          return;
      }
    },
    { signal },
  );

  // --- Focus strategy (the touch focus dance; see the input-model contract) ---
  // On touch, the terminal output is the native text-selection surface, so this
  // handler deliberately does the MINIMUM: it opens the keyboard on a clean tap
  // and otherwise gets out of the browser's way. It never preventDefaults a
  // touch and never clears a selection — a long-press to select a word, the OS
  // copy/paste callout, and drag-to-scroll are all left to the platform (the
  // research consensus: over text, allow the default and emit nothing).
  // A fine pointer (mouse / trackpad) is available: a desktop, or a tablet with
  // a trackpad / Magic Keyboard. Such a device has a hardware keyboard, so there
  // is no soft keyboard to protect — focus should be eager and land in one tap.
  // The bare-touch guards below bow out of focusing (to avoid popping the soft
  // keyboard or stealing a selection); they are relaxed when a fine pointer
  // exists. This is keyed off `any-pointer: fine` rather than the event's
  // pointerType because iPadOS reports a COARSE primary pointer even with a
  // trackpad attached, and its trackpad taps arrive inconsistently as "mouse" or
  // "touch" — so pointerType alone made the terminal take several taps to focus.
  const hasFinePointer = (): boolean =>
    typeof window.matchMedia === "function" && window.matchMedia("(any-pointer: fine)").matches;
  let lastPointerType = "mouse";
  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerDownTime = 0;
  function focusTerminal(): void {
    // The public handle can outlive a fatal startup or explicit destroy. Never
    // focus the detached textarea after the runtime has been released.
    if (destroyed) {
      return;
    }
    input.focus({ preventScroll: true });
  }
  termWrap.addEventListener(
    "pointerdown",
    (e) => {
      lastPointerType = e.pointerType;
      pointerDownX = e.clientX;
      pointerDownY = e.clientY;
      pointerDownTime = e.timeStamp;
    },
    { passive: true, signal },
  );
  termWrap.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType !== "touch") {
        return;
      }
      if (isLinkTarget(e.target)) {
        return;
      }
      const dx = Math.abs(e.clientX - pointerDownX);
      const dy = Math.abs(e.clientY - pointerDownY);
      // A drag (scroll / selection-extend) or a long-press (native word-select /
      // context menu) is not a tap-to-focus: bow out and let the browser own it.
      if (dx > TAP_MOVEMENT_PX || dy > TAP_MOVEMENT_PX) {
        return;
      }
      if (e.timeStamp - pointerDownTime > TAP_MAX_MS) {
        return;
      }
      // A clean tap while text is selected means "done selecting": clear the
      // selection (and dismiss the OS callout with it). This is our deselect —
      // iOS otherwise leaves the selection stuck, because the synthetic mousedown
      // we preventDefault to preserve the keyboard also suppresses the platform's
      // own tap-to-deselect. Do NOT also focus: a deselect tap should not pop the
      // keyboard; the next clean tap (nothing selected) opens it. The long-press
      // that MADE the selection is filtered out above by the duration/movement
      // guards, so only a deliberate later tap reaches here.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        sel.removeAllRanges();
        // On a bare touchscreen a deselect tap must NOT also focus: that would
        // pop the soft keyboard right after a copy. But with a fine pointer
        // (a hardware keyboard is present) there is no soft keyboard to pop, so
        // focus in the same tap rather than forcing the user to tap again — this
        // is a large part of the "2-3 taps to focus" on an iPad + Magic Keyboard.
        if (hasFinePointer()) {
          focusTerminal();
        }
        return;
      }
      // A clean tap with nothing selected focuses the input, synchronously (an
      // async focus would not raise the iOS soft keyboard).
      focusTerminal();
    },
    { passive: true, signal },
  );
  termWrap.addEventListener(
    "mousedown",
    (e) => {
      // Touch is the platform's press, start to finish: its own selection UI
      // (long-press word select, the drag handles, the OS callout) owns a press
      // that lands on a selection, and it never uses HTML5 drag-and-drop. So a
      // touch press gets nothing here but the keyboard preservation below, and
      // the selection policy that follows is deliberately mouse-and-pen only.
      if (lastPointerType === "touch") {
        // Cancel the synthetic mousedown after a touch tap so iOS keeps the
        // keyboard up (xterm.js focus-preservation pattern, scoped to touch).
        // Skip it when a fine pointer is present (iPad + trackpad / Magic
        // Keyboard): there is no soft keyboard to protect, and suppressing the
        // mousedown was defeating the native focus, so the terminal needed
        // several taps to focus.
        if (!hasFinePointer()) {
          e.preventDefault();
        }
        return;
      }
      // Terminal text is display-only, never draggable content — but a browser
      // does not know that, and a bare left press that lands INSIDE the current
      // selection is the one gesture where it matters: Blink and Gecko both read
      // it as the start of a native drag-and-drop of the selected text, so the
      // press neither collapses the selection nor begins a new one, and the
      // release drops nothing (there is no drop target). Drag over text you just
      // selected and the selection is stuck: no new selection, and not even a
      // click clears it, because a real mouse always moves a pixel or two and
      // that is enough to re-enter the drag path. Collapsing the selection here,
      // before the browser resolves the gesture, is what keeps it out: with
      // nothing selected under the press both engines take their ordinary select
      // path and the drag is never considered. A press OUTSIDE the selection
      // collapses it natively anyway, so this only ever pre-empts the browser,
      // never contradicts it — no hit test against the selection needed.
      // Non-left and modified presses are left alone: a right-click has to keep
      // the selection for the context menu's Copy, a middle-click for the
      // primary selection it pastes, Shift-click extends a selection, and
      // Ctrl-drag adds a second range in Firefox.
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
        return;
      }
      const pressSel = window.getSelection();
      if (pressSel && !pressSel.isCollapsed) {
        pressSel.removeAllRanges();
      }
    },
    { signal },
  );
  termWrap.addEventListener(
    "click",
    (e) => {
      const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(".term-link");
      if (link) {
        e.preventDefault();
        window.open(link.href, "_blank", "noopener,noreferrer");
        return;
      }
      if (lastPointerType === "touch" && !hasFinePointer()) {
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) {
        return;
      }
      focusTerminal();
    },
    { signal },
  );

  // --- Viewport ---
  viewport.init({
    termWrap,
    root,
    suppressKeyboardInset: hasFinePointer,
    onSettled() {
      // The settle is the authoritative size for this geometry: measurableSize
      // re-measures the font metrics and now reports a viewport that has stopped
      // moving, so this is the one resize a keyboard slide or rotation should
      // cost. sendResize deduplicates, so a settle that changed nothing is free.
      if (measurableSize() !== null) {
        connection.sendResize();
      }
      composition.positionCompositionView();
    },
  });

  // --- Fonts ---
  const onFontSettled = (): void => {
    fontsLoaded = true;
    if (firstFrameRendered) {
      markReady();
    }
    requestAnimationFrame(() => {
      maybeSendFirstResize();
    });
  };
  try {
    void document.fonts
      .load(fontReady)
      .then(onFontSettled)
      .catch((err: unknown) => {
        console.warn(`web-terminal-ui: web font ${fontReady} failed to load`, err);
        onFontSettled();
      });
  } catch (err) {
    console.warn(`web-terminal-ui: invalid fontReady ${fontReady}`, err);
    onFontSettled();
  }

  // --- Browse-cache TTL (engine docs/paged-scrollback.md §5.6) ---
  //
  // Paged-in history is disposable by construction: recovery is one fetch. The
  // ENGINE provides the mechanism and this layer owns the clock, because the
  // engine has no notion of a page or a tab. Eviction is by INACTIVITY, never
  // eagerly, so that rapid scrolling in any direction stays instant.
  //
  // The visible-page drop is CONDITIONAL inside the store: a reader parked on
  // cached rows is inactive while looking straight at them, so the store skips
  // and this timer retries. A hidden page has no reader, so its drop is
  // unconditional.
  const BROWSE_CACHE_TTL_MS = 5 * 60_000;
  /**
   * Every store EXCEPT the renderer-bound one, pruning refs whose store has been
   * collected. A background tab has no reader, which is what lets both callers
   * below drop its cache without a position to protect.
   */
  const backgroundStores = (bound: LineStore): LineStore[] => {
    const out: LineStore[] = [];
    for (const store of liveStores()) {
      if (store !== bound) {
        out.push(store);
      }
    }
    return out;
  };
  const browseSweep = window.setInterval(() => {
    // The BOUND store is the one with a reader, so its drop is conditional and
    // goes through the renderer — the only layer that knows where that reader is.
    const bound = render.boundStore();
    if (
      render.browseCacheSize() > 0 &&
      Date.now() - render.lastBrowseActivityMs() >= BROWSE_CACHE_TTL_MS
    ) {
      render.dropBrowseCache(document.visibilityState === "visible");
    }
    // Every OTHER store belongs to a background tab. Without this pass the sweep
    // only ever reached the visible tab and every background tab's cache was
    // immortal for the life of the page — up to the engine's whole cache budget
    // per tab, on the phone this feature exists for.
    for (const store of backgroundStores(bound)) {
      if (
        store.browseCacheSize() > 0 &&
        Date.now() - store.lastBrowseActivityMs() >= BROWSE_CACHE_TTL_MS
      ) {
        store.dropBrowseCache(-1, false); // no reader: no position to exempt
      }
    }
  }, 60_000);

  /**
   * Drop every cache unconditionally, TTL ignored. The LAST CHANCE handler: it
   * runs when the page is about to stop executing entirely, which is the one
   * state the sweep above cannot cover — a frozen page runs no code at all, so
   * without this its caches stay resident for as long as the freeze lasts, and a
   * discard then throws them away unread. Ten to twenty megabytes (estimate), for
   * an unbounded time, for nobody.
   *
   * Unconditional is right HERE and wrong on the return transition, and the
   * difference is which way the reader is walking. `visibilitychange` to visible
   * fires as a reader ARRIVES, so dropping there deletes the rows they are about
   * to look at (that drop existed and was removed). `freeze` fires as the page
   * stops being a running program, with no reader and none imminent — and the
   * cache is disposable by construction, so the cost of being wrong is one fetch
   * on a return that may never come.
   */
  const dropEveryBrowseCache = (): void => {
    const bound = render.boundStore();
    render.dropBrowseCache(false); // through the renderer: it schedules the reconcile
    for (const store of backgroundStores(bound)) {
      store.dropBrowseCache(-1, false);
    }
  };
  // Two hooks for one state, because no single one covers both engines: `freeze`
  // is Chrome's Page Lifecycle signal, and `pagehide` with `persisted` is entry
  // into the back/forward cache — the Safari path, on the platform this feature
  // is for. Either can fire without the other.
  document.addEventListener(
    "freeze",
    () => {
      // Persist BEFORE dropping. The keeper already wrote on `visibilitychange`
      // to hidden, but a hidden page's socket keeps delivering, so the tail can
      // have advanced since — and `freeze` is the last code that runs, so a write
      // skipped here is a write that never happens. The order matters only in that
      // direction: the snapshot excludes browse cache by classification, so
      // flushing first costs nothing and dropping first could lose a page of live
      // tail on a page that never wakes.
      scrollbackKeeper?.flush();
      dropEveryBrowseCache();
    },
    { signal },
  );
  signal.addEventListener("abort", () => {
    clearInterval(browseSweep);
  });

  // --- Reconnect-on-wake ---
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") {
        // No cache drop on the RETURN transition. An earlier version enforced the
        // TTL the throttled hidden period owed, with hidden-page semantics
        // (unconditional) — which deleted the rows the returning reader was
        // parked on, in the one moment they are certain to look at them. The page
        // is visible again the instant this fires, so the visible-page rule
        // applies, and that is exactly what the periodic sweep does within its
        // next tick. There is nothing left for this branch to add.
        if (connectionInitiated) {
          connection.reconnectNow();
        }
        focusTerminal();
        return;
      }
      // Hidden. This and pagehide are the last callbacks that reliably run
      // before a discard, and a discard is the case scrollback persistence
      // exists for, so write now rather than waiting for the background pass.
      scrollbackKeeper?.flush();
    },
    { signal },
  );
  window.addEventListener(
    "pageshow",
    () => {
      if (connectionInitiated) {
        connection.reconnectNow();
      }
      focusTerminal();
    },
    { signal },
  );
  window.addEventListener(
    "pagehide",
    (event) => {
      // Both halves of the last-chance write: visibilitychange fires when the
      // page is backgrounded, pagehide when it is unloaded or frozen into
      // bfcache. Chrome's page-lifecycle guidance is explicit that pagehide is
      // not guaranteed to run, which is why the keeper also saves on a timer.
      scrollbackKeeper?.flush();
      if (event.persisted) {
        // Into the back/forward cache: the page is frozen, so this is the last
        // code that runs until it is restored — if it ever is.
        dropEveryBrowseCache();
      }
    },
    { signal },
  );
  window.addEventListener(
    "online",
    () => {
      if (connectionInitiated) {
        connection.reconnectNow();
      }
    },
    { signal },
  );

  // --- Feature context ---
  const subscriptions: Unsubscribe[] = [];
  const apiMap = new Map<TerminalFeature<unknown>, unknown>();
  const instances: { feature: TerminalFeature<unknown>; instance: FeatureInstance<unknown> }[] = [];

  // The one switch path: ctx.notifySwitch (tab switches) and the kernel's own
  // owner-resolved first connect both land here.
  function performSwitch(session: SessionRef): void {
    // A feature's un-cancelled async (tabs create()/pollOnce()) can resolve
    // after destroy() and request a switch; ignore it so a torn-down terminal
    // never re-points or reopens the socket (connection.setSession below).
    if (isDestroyed()) {
      return;
    }
    // Detach (design 5.1): make input safe before the socket is re-pointed.
    // End any in-flight IME composition and clear the textarea so
    // half-composed text is not delivered to either session, and let every
    // feature disarm latched input state (mobileToolbar's sticky-Ctrl) so it
    // cannot fire against the incoming session. This all runs before
    // setSession, and the switch is synchronous, so input is inert between
    // detach here and the onSwitch attach below.
    composition.cancelComposition();
    resetToPlaceholder(input);
    for (const { instance } of instances) {
      instance.onDetach?.();
    }
    activeSession = session;
    // Reconnect the terminal WS to this session using its per-tab resume
    // state; the renderer was already pointed at its store by the owner.
    connection.setSession(session.id);
    // The owned first connect has happened (session id is now on the WS URL);
    // wake-reconnect handlers may fire from here on.
    connectionInitiated = true;
    for (const { instance } of instances) {
      if (instance.onSwitch) {
        instance.onSwitch(session);
      }
    }
    bus.emit("session:switch", session);
  }

  function makeContext(featureName: string): TerminalContext {
    return {
      region: (name, slot) => regions.region(name, slot),
      surface: () => termWrap,
      send: sendBytes,
      paste,
      registerInputTransform(fn) {
        inputTransforms.push(fn);
        return () => {
          const i = inputTransforms.indexOf(fn);
          if (i >= 0) {
            inputTransforms.splice(i, 1);
          }
        };
      },
      registerInputObserver(fn) {
        inputObservers.push(fn);
        return () => {
          const i = inputObservers.indexOf(fn);
          if (i >= 0) {
            inputObservers.splice(i, 1);
          }
        };
      },
      registerKeydown(fn) {
        keydownHandlers.push(fn);
        return () => {
          const i = keydownHandlers.indexOf(fn);
          if (i >= 0) {
            keydownHandlers.splice(i, 1);
          }
        };
      },
      render,
      scroll,
      session: {
        get id() {
          return activeSession?.id ?? null;
        },
        size: () => render.computeSize(),
        highestIndex: () => render.getHighestIndex(),
      },
      on(e, fn) {
        // Wrap so a throwing feature handler is isolated and attributed.
        const wrapped = (p: Parameters<typeof fn>[0]): void => {
          try {
            fn(p);
          } catch (err) {
            reportError(featureName, err);
          }
        };
        const off = bus.on(e, wrapped);
        subscriptions.push(off);
        return off;
      },
      use<A>(feature: TerminalFeature<A>): A | undefined {
        return apiMap.get(feature) as A | undefined;
      },
      toast,
      announce: (message, politeness) => {
        announcer.announce(message, politeness);
      },
      loadingReason: (message) => {
        // No overlayDismissed guard needed: loadingStatus.stop() runs in
        // dismissLoadingOverlay and every method is inert afterwards, so the
        // "a late retry cannot resurrect the overlay" contract holds in ONE
        // place rather than at each caller.
        loadingStatus.reason(message);
      },
      tablist: () => tablistController,
      newLineStore: (sessionId) => {
        // Registered on EVERY path, because this factory is the only way a store
        // enters the app and the browse-cache sweep has to be able to reach a
        // background tab's store (the renderer only ever sees the bound one).
        const track = (store: LineStore, key: string): LineStore => {
          knownStores.set(key, new WeakRef(store));
          return store;
        };
        if (scrollbackKeeper !== null) {
          if (sessionId !== undefined) {
            // Hydrated from storage when a usable entry exists, and tracked for
            // saving either way. Necessarily before this session connects: the
            // caller is building the tab, and the kernel's switch (which opens
            // the socket) happens afterwards.
            const store = scrollbackKeeper.storeFor(sessionId);
            if (store.highestIndex() >= 0) {
              unverifiedRestores.add(sessionId);
            }
            return track(store, sessionId);
          }
          scrollbackKeeper.noteMissingSessionId();
        }
        return track(new LineStore(scrollbackLines), sessionId ?? IMPLICIT_STORE_KEY);
      },
      layout: () => ({
        narrow: isNarrow(),
        coarse:
          typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches,
      }),
      notifySwitch(session) {
        performSwitch(session);
      },
      dropSession(id) {
        connection.forgetSession(id);
        // A closed tab's scrollback should not outlive it. This is also the only
        // collection path that runs promptly; the keeper's age bound covers the
        // case this one cannot see, which is a tab the browser discarded without
        // ever running a close.
        scrollbackKeeper?.forget(id);
      },
      onError(fn) {
        errorHandlers.add(fn);
        return () => errorHandlers.delete(fn);
      },
    };
  }

  // --- Feature lifecycle ---
  // `destroyed` means the terminal runtime is no longer usable, whether that
  // happened through the public destroy() handle or a fatal startup rollback.
  // `rootReleased` is narrower: destroy() has also removed the recovery surface
  // and boundary classes. Keeping the two facts separate lets a fatal terminal
  // remain visible and still be explicitly destroyed later.
  let destroyed = false;
  let rootReleased = false;
  let runtimeCleaned = false;
  // Live read of `destroyed` for post-await re-checks: a plain variable read is
  // narrowed to always-false by TS CFA because it cannot model destroy() firing
  // while feature setup or session resolution is awaiting.
  const isDestroyed = (): boolean => destroyed;

  function teardownFeatures(): void {
    for (let i = instances.length - 1; i >= 0; i--) {
      const entry = instances[i];
      if (!entry) {
        continue;
      }
      try {
        entry.instance.teardown();
      } catch (err) {
        reportError(entry.feature.name, err);
      }
    }
    instances.length = 0;
  }

  // Release the complete live runtime while leaving the root boundary classes
  // intact. Fatal startup uses the root for its recovery surface; destroy()
  // follows this cleanup by removing the classes and any recovery UI.
  function cleanupRuntime(): void {
    if (runtimeCleaned) {
      return;
    }
    runtimeCleaned = true;
    // Before anything is torn down: a deliberate teardown (a host closing an
    // embedded panel, a reload path calling destroy()) is still a page the user
    // may come back to, and the tracked stores are about to become unreachable.
    scrollbackKeeper?.flush();
    scrollbackKeeper?.stop();
    teardownFeatures();
    kernelAbort.abort();
    narrowObserver?.disconnect();
    narrowObserver = null;
    viewport.teardown();
    // Reset the composition singleton: a failure during an IME cycle must not
    // leave module state or a deferred send alive for a later terminal mount.
    composition.teardown();
    connection.disconnect();
    connState.destroy();
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    for (const off of subscriptions) {
      off();
    }
    subscriptions.length = 0;
    inputTransforms.length = 0;
    inputObservers.length = 0;
    keydownHandlers.length = 0;
    errorHandlers.clear();
    apiMap.clear();
    activeSession = null;
    bus.clear();
    announcer.destroy();
    regions.destroy();
    root.classList.remove("wt-narrow");
    root.replaceChildren();
  }

  function renderFatalStartup(): void {
    renderFatalStartupInto(root, layoutMode);
  }

  function enterFatalStartup(feature: string, cause: unknown): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    cleanupRuntime();
    dismissLoadingOverlay();

    let handled = false;
    try {
      handled =
        opts.onFatalError?.({ phase: "feature-setup", feature, cause, surface: root }) === true;
    } catch (handlerErr) {
      console.error("web-terminal-ui: onFatalError handler failed", handlerErr);
    }
    // A handler may call destroy() while taking over, so do not recreate the
    // default surface after the root has explicitly been released.
    if (!handled && !rootReleased) {
      renderFatalStartup();
    }
  }

  type FeatureSetupOutcome =
    | { readonly status: "ready" }
    | { readonly status: "aborted" }
    | {
        readonly status: "failed";
        readonly feature: string;
        readonly cause: unknown;
      };

  // Distinguish intentional cancellation from a fatal feature failure. A
  // boolean collapsed both into the same "not ready" outcome, which is why a
  // failed setup previously left a half-live terminal and only wrote a log.
  async function setupFeatures(): Promise<FeatureSetupOutcome> {
    for (const feature of featureList) {
      if (destroyed) {
        return { status: "aborted" };
      }
      try {
        const instance = await feature.setup(makeContext(feature.name));
        // destroy() may have run during the await above; cleanupRuntime() has
        // already swept `instances`, and destroy() is one-shot, so a straight
        // push here would leave this instance's listeners/timers/observers alive
        // forever. Tear it down instead of registering it.
        if (isDestroyed()) {
          try {
            instance.teardown();
          } catch (err) {
            reportError(feature.name, err);
          }
          return { status: "aborted" };
        }
        instances.push({ feature, instance });
        // Populate the feature value's readonly api (consumer pattern:
        // tabs.api?.create()) via a narrow cast, and the ctx.use lookup map.
        (feature as { api?: unknown }).api = instance.api;
        apiMap.set(feature, instance.api);
      } catch (cause) {
        if (isDestroyed()) {
          return { status: "aborted" };
        }
        reportError(feature.name, cause);
        console.error(`web-terminal-ui: feature "${feature.name}" setup failed`, cause);
        if (isDestroyed()) {
          return { status: "aborted" };
        }
        return { status: "failed", feature: feature.name, cause };
      }
    }
    return { status: "ready" };
  }

  // Features set up in the background; first paint is never gated on them.
  // Under a session owner the kernel then drives the first connect itself:
  // await the owner's resolveInitialSession() and switch to the session it
  // returns through the same path a tab switch uses. Connecting to the bare
  // wsPath first would open a /ws that a SessionManager 404s (no ?session=),
  // flashing a disconnect banner and churning the reconnect backoff — hence no
  // startup connect below when an owner is registered. A null (or thrown)
  // resolution means the bootstrap failed: the owner keeps its retry chrome
  // alive, and the kernel — which now SEES the failure instead of inferring it
  // from a missing side effect — dismisses the loading overlay so that chrome
  // is visible instead of an eternal spinner.
  void setupFeatures().then(async (outcome) => {
    if (outcome.status === "failed") {
      enterFatalStartup(outcome.feature, outcome.cause);
      return;
    }
    if (outcome.status === "aborted") {
      return;
    }
    if (!sessionOwner || isDestroyed()) {
      return;
    }
    let resolved: SessionRef | null = null;
    try {
      resolved = await sessionOwner.resolveInitialSession();
    } catch (err) {
      reportError(sessionOwnerName, err);
    }
    if (isDestroyed()) {
      return;
    }
    if (resolved) {
      performSwitch(resolved);
    } else if (!connectionInitiated) {
      dismissLoadingOverlay();
    }
  });

  // --- Connect + focus ---
  render.updateFontMetrics();
  composition.positionCompositionView();
  if (!sessionOwner) {
    // A single unmanaged terminal has no feature to own its store, so the kernel
    // hydrates the renderer's implicit one here — before connect(), because the
    // resume announces what this client already holds (Callbacks.getHaveThrough)
    // and a store hydrated afterwards has already asked for everything.
    //
    // The session id comes from the engine rather than from this library: an
    // unmanaged terminal's identity is a per-tab, sessionStorage-backed id minted
    // inside the connection layer, with exactly the semantics a persistence key
    // needs (stable across a reload and an iOS tab restore, fresh in a genuinely
    // new tab). Under a session owner the same work happens per session, through
    // ctx.newLineStore(sessionId).
    //
    // Note what is deliberately NOT done: restored content does not dismiss the
    // loading overlay. It is last session's output until the resume confirms it,
    // and showing it as live is the same mistake the persisted epoch exists to
    // prevent. The overlay still lifts on the first real frame — which now
    // arrives sooner, because the replay behind it is a delta instead of a
    // refill.
    if (scrollbackKeeper !== null) {
      const sessionId = connection.currentSessionId();
      const restored = scrollbackKeeper.storeFor(sessionId);
      if (restored.highestIndex() >= 0) {
        render.bind(restored);
        // Registered under the SAME id the resumeAck will report, so the guard
        // can both verify and discard it. This store does not come through
        // `newLineStore` — an unmanaged terminal has no feature to own it.
        knownStores.set(sessionId, new WeakRef(restored));
        unverifiedRestores.add(sessionId);
      } else {
        // Nothing usable was stored. Keep the renderer's own store and track
        // that one instead of swapping in an empty replacement, so this path
        // changes nothing about a terminal with no snapshot to restore.
        scrollbackKeeper.track(sessionId, render.boundStore());
      }
    }
    connection.connect();
    connectionInitiated = true;
  }
  focusTerminal();

  return {
    focus: focusTerminal,
    send(bytes) {
      if (destroyed) {
        return;
      }
      sendBytes(bytes);
    },
    reset() {
      if (destroyed) {
        return;
      }
      render.resetScrollback();
      render.resetScreen();
    },
    destroy() {
      if (rootReleased) {
        return;
      }
      rootReleased = true;
      destroyed = true;
      cleanupRuntime();
      root.classList.remove("wt-root", "wt-viewport", "wt-container", "wt-narrow");
      // cleanupRuntime() removed the live subtree. A fatal handler may have
      // rendered replacement UI afterward, so destroy() clears once more.
      root.replaceChildren();
    },
  };
}

/** Build the terminal UI inside `root`. Call exactly once.
 *
 *  Wraps buildTerminal so that a SYNCHRONOUS startup failure gets the same
 *  treatment an asynchronous one already got. Before this, the two halves of
 *  "the terminal did not start" were handled inconsistently: an async
 *  feature-setup rejection ran enterFatalStartup (overlay dismissed,
 *  onFatalError delivered, recovery surface rendered), while a synchronous throw
 *  propagated bare, leaving the consumer's loading overlay spinning forever over
 *  a page with no terminal and no explanation. Consumers were left hand-building
 *  their own surface to cover the gap, diverging from this one in shape and copy.
 *
 *  The error still propagates: a consumer with its own handling sees it exactly
 *  as before, only now against a page that is no longer stuck on a spinner. A
 *  handler returning `true` suppresses the built-in surface, same contract as the
 *  async phase. */
/** Resolve the mount target. A selector is looked up here, INSIDE
 *  createTerminal's try, which is the whole point: a consumer that passed
 *  `document.getElementById("terminal")` had to null-check it first (tsc forces
 *  that), and the only thing it could do in the null branch was hand-build a
 *  startup-failure surface this library already owns. Taking the selector moves
 *  that failure inside the boundary and deletes the consumer's branch.
 *
 *  An element is still accepted, because an embedder that CREATED the element
 *  already holds a non-null reference and asking it to invent a selector for its
 *  own div would be worse. The trap was never "passing an element", it was
 *  "passing the result of a lookup". */
function resolveRoot(target: HTMLElement | string): HTMLElement {
  if (typeof target !== "string") {
    return target;
  }
  const found = document.querySelector(target);
  if (found === null) {
    throw new Error(`web-terminal-ui: no element matches the mount selector ${target}`);
  }
  if (!(found instanceof HTMLElement)) {
    // An SVG or MathML element can match a selector but cannot host the terminal
    // (no style/classList contract this kernel relies on). Fail with the reason
    // rather than crashing later on a missing property.
    throw new Error(`web-terminal-ui: the mount selector ${target} matched a non-HTML element`);
  }
  return found;
}

/** Build the feature list. `features` is a FUNCTION so a preset that throws does
 *  so inside createTerminal's try. As an eagerly-evaluated array argument
 *  (`features: presetTabbed()`) the throw happened at the CALL SITE, before this
 *  function's boundary existed, which is why a consumer had to wrap the preset
 *  call in its own try/catch and render its own surface. One character of
 *  laziness moves that failure inside. */
function resolveFeatures(
  features: CreateTerminalOptions["features"],
): readonly TerminalFeature<unknown>[] {
  return features === undefined ? [] : features();
}

/** Create the host element the recovery surface uses when the mount target could
 *  not be resolved at all.
 *
 *  It is a NEW element appended to the body, never the body itself: .wt-root
 *  carries the token defaults, box-sizing, color-scheme and scrollbar treatment,
 *  and .wt-viewport carries `position: fixed; inset: 0` — stamping those on a
 *  host application's own body would reformat a page that is otherwise perfectly
 *  healthy. A dedicated element gets the styling boundary the surface needs
 *  without touching anything the consumer owns. */
function createFallbackHost(): HTMLElement {
  const host = document.createElement("div");
  host.className = "wt-root wt-viewport";
  document.body.appendChild(host);
  return host;
}

export function createTerminal(
  target: HTMLElement | string,
  opts: CreateTerminalOptions = {},
): TerminalHandle {
  const layoutMode = opts.layout ?? "viewport";
  // Declared outside the try so the catch can tell "we never resolved a root"
  // from "we had one and the build failed". The old code read the root straight
  // from its parameter, so a caller who passed a null root (reachable from any
  // untyped call site — an inline <script type="module"> never sees tsc) threw a
  // SECOND error out of the catch itself, losing the real cause and rendering no
  // surface at all. There is no null root to pass now, and the unresolved case
  // has an explicit branch below.
  let root: HTMLElement | undefined;
  try {
    root = resolveRoot(target);
    return buildTerminal(root, opts, resolveFeatures(opts.features));
  } catch (cause) {
    // Container mode declines the fallback on purpose. An embedded terminal is
    // one panel inside someone else's working application; if its mount target
    // is missing, claiming the viewport to say so would break a page that is
    // otherwise fine — strictly worse than the host app reporting the failure in
    // the space it owns. The failure is still delivered and still rethrown, so an
    // embedder is informed, just not overruled. A full-page consumer is the
    // opposite case: the page IS the terminal, so a blank page with nothing but a
    // console error is the worst outcome available.
    const surface = root ?? (layoutMode === "viewport" ? createFallbackHost() : undefined);
    if (surface !== undefined) {
      // Stamp the boundary classes before rendering. buildTerminal normally does
      // this early, but a throw can precede it (the multiple-session-owner guard
      // fires before any DOM work by design), and every .wt-fatal rule is scoped
      // :where(.wt-root) -- so without this the recovery surface would render
      // completely unstyled exactly when it matters most. Idempotent when
      // buildTerminal already stamped them, and when createFallbackHost did.
      surface.classList.add("wt-root", layoutMode === "container" ? "wt-container" : "wt-viewport");
    }
    // The overlay must come down even though nothing was built: it is the
    // consumer's pre-JS spinner, and leaving it up hides the surface below it.
    // This runs even when no surface is rendered — a spinner over an embedder's
    // broken panel is a lie either way.
    fadeOutOverlay(opts.loading);

    let handled = false;
    try {
      handled = opts.onFatalError?.({ phase: "kernel-init", cause, surface }) === true;
    } catch (handlerErr) {
      // Same posture as the async phase: a reporting failure must not leave the
      // page blank, so fall through to the built-in surface.
      console.error("web-terminal-ui: onFatalError handler failed", handlerErr);
    }
    if (!handled && surface !== undefined) {
      renderFatalStartupInto(surface, layoutMode);
    }
    throw cause;
  }
}
