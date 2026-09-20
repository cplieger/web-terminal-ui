import {
  createTerminalEngine,
  keyboard,
  LineStore,
  type Connection,
  type TerminalEngine,
} from "@cplieger/web-terminal-engine";
import { createComposition } from "../composition.js";
import { createViewport } from "../viewport.js";
import { INPUT_PLACEHOLDER, resetToPlaceholder } from "../input-placeholder.js";
import { createBus } from "./bus.js";
import { TAP_MAX_MS, TAP_MOVEMENT_PX, isLinkTarget } from "./gesture.js";
import { createRegions } from "./regions.js";
import { createAnnouncer, createPaneTablist, type PaneTablist } from "./a11y.js";
import { createConnState } from "./conn-state.js";
import { selectionTextWithin } from "./selection.js";
import { windowOf } from "./realm.js";
import {
  createCleanupScope,
  createFeatureHost,
  type CleanupScope,
  type FeatureSetupOutcome,
} from "./feature-host.js";
import type {
  CreateTerminalOptions,
  PaneHandle,
  PaneSide,
  SessionRef,
  ShellContext,
  TablistController,
  TerminalContext,
  TerminalEvents,
  TerminalFeature,
  Unsubscribe,
} from "./types.js";

const { mapKeyboardEvent, bracketTextForPaste, prepareTextForTerminal } = keyboard;

const DEFAULT_WS_PATH = "/ws";
// The family that carries the CELL METRICS, alone, never --font-mono's list:
// WebKit settles load() over a list as soon as the FIRST family covering the
// sample has loaded, so naming the tiling overlay (11 KB, no "M" glyph) would
// open the gate while the companion the metrics come from is still loading.
const DEFAULT_FONT_READY = '14px "Monaspace Neon NF"';
// Neither document.fonts.load nor document.fonts.ready carries a deadline, and a
// response held open leaves both pending. 3s is the block period font-display:
// block buys; once the engine has painted the fallback, the cell on screen IS
// the fallback cell.
const FONT_READY_TIMEOUT_MS = 3000;
const TOAST_MS = 3000;
// Paged-in history is disposable by construction (recovery is one fetch), so it
// is evicted by INACTIVITY, never eagerly, to keep rapid scrolling instant.
const BROWSE_CACHE_TTL_MS = 5 * 60_000;

// Kernel-owned core subtree: the display-only output, the hidden textarea (the
// single keyboard target), and the IME composition view. Static, trusted markup.
const CORE_TEMPLATE = `
<div class="term">
  <div class="term-output" role="log" aria-live="off" aria-roledescription="Terminal" aria-label="Terminal"></div>
  <textarea class="term-input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Terminal input" tabindex="-1"></textarea>
  <div class="composition-view" aria-hidden="true"></div>
</div>`;

/**
 * The single character this key types, or null when it types none. `codePointAt`
 * consumes a surrogate pair whole, so a key whose first scalar is the whole
 * string is exactly one character; "Shift", "Dead", "F5" and "Process" are not.
 * A key "associated with multiple characters" (macros, some dead-key sequences)
 * returns null and is not recovered, a stated limitation.
 */
function typedChar(ev: KeyboardEvent): string | null {
  const first = ev.key.codePointAt(0);
  return first !== undefined && String.fromCodePoint(first) === ev.key ? ev.key : null;
}

/** iOS sends U+00A0 where a space was typed; shared by every send path so one
 *  physical key cannot produce two byte sequences. */
function normalizeTypedText(text: string): string {
  return text.replace(/\u00A0/g, " ");
}

/** `KeyboardEvent.keyCode` for a key an IME has claimed (VK_PROCESS). Deprecated
 *  and the only carrier of this fact: for the key that commits a composition both
 *  Blink and WebKit report `key` as the ordinary "Enter", and Safari reports
 *  `isComposing` false. Read only while a composition is open, because Android
 *  reports 229 for nearly every soft-keyboard key. */
const IME_COMMIT_KEYCODE = 229;

function pick(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`web-terminal-ui: createTerminal failed to build ${selector}`);
  }
  return el;
}

/** The overlay service the shell gives each pane. */
interface PaneLoading {
  reason(message: string): void;
  /** The first frame from ANY pane dismisses the overlay. */
  firstFrame(): void;
  /** Dismisses the overlay once every built pane has failed. */
  failed(): void;
}

/** The shell-owned store registry every pane's stores go through: a tab's store
 *  belongs to the tab and follows it into whichever pane shows it. */
export interface StoreRegistry {
  /** Whether the consumer supplied scrollback persistence. */
  readonly persisting: boolean;
  /** `ctx.newLineStore`: a store hydrated from persistence when one exists,
   *  tracked for saving and for the browse-cache sweep. */
  newLineStore(sessionId: string | undefined): LineStore;
  /** The unmanaged pane's implicit store: the hydrated store when persistence
   *  holds a usable entry (registered under `sessionId`), else null after
   *  tracking `current` under that id. */
  implicitStore(sessionId: string, current: LineStore): LineStore | null;
  /** A resume answered under a known epoch verified this session's restore. */
  verified(sessionId: string): void;
  /** Drop restored scrollback that will never be confirmed: one session's (a 4001
   *  says one process is gone) or every unverified one (a wire refusal). The
   *  renderer holding the store is reconciled; a background store is reset; an
   *  unknown id is the calling pane's implicit store. */
  discardUnverified(scope: { session: string } | "page", caller: PaneSide): void;
  /** Every live tracked store except `bound`. */
  backgroundStores(bound: LineStore): LineStore[];
  /** Save every tracked store whose content advanced (the page-lifecycle hooks). */
  flush(): void;
}

/** What the shell hands `buildPane` beyond the consumer's options: the members a
 *  feature must not see. */
export interface PaneServices {
  readonly side: PaneSide;
  readonly shell: ShellContext;
  /** The `sessionStorage` key of this pane's unmanaged session id. */
  readonly sessionIdKey: string;
  /** A session owner or a pane layout owner exists, so no bare startup connect. */
  readonly managed: boolean;
  /** The resolved retained-line cap (`CreateTerminalOptions.scrollbackLines`),
   *  honored by the renderer's implicit store and every `ctx.newLineStore()`. */
  readonly scrollbackLines: number | undefined;
  /** The narrow classification for this pane (the shell root's width, this
   *  pane's height). */
  narrowProbe(): boolean;
  /** This pane's base title (the served `<title>`, or its program's OSC 0/2). */
  titleBase(text: string): void;
  readonly loading: PaneLoading;
  onSessionEnded(): void;
  /** This pane's tabpanel half of the ARIA seam, as soon as the panel exists. */
  registerTablist(controller: PaneTablist): void;
  /** The tab row's half, for `ctx.tablist()`. */
  tablist(): TablistController;
  /** The shell's keydown chain, run before this pane's own. */
  onKeydown(ev: KeyboardEvent): boolean;
  /** The two selection drivers. */
  onPointerDown(): void;
  onFocusIn(): void;
  /** This pane attached a session or became empty. */
  onSessionChange(): void;
  /** The server epoch this pane's connection knew for a session it is about to
   *  forget, so the pane that shows the session next can be seeded with it. */
  noteEpoch(sessionId: string, epoch: number): void;
  /** The epoch a pane recorded for `sessionId` before forgetting it; 0 when none. */
  knownEpoch(sessionId: string): number;
  /** This pane's connection, registered as soon as the engine exists so the
   *  shell's store registry can seed it before the pane's first connect. */
  registerConnection(connection: PaneKernel["connection"]): void;
  readonly stores: StoreRegistry;
  /** `ctx.dropSession`: forget the session on every pane and in the keeper. */
  dropSession(id: string): void;
  /** The terminal's one feature-error channel. */
  reportError(feature: string, err: unknown): void;
  onError(fn: (feature: string, err: unknown) => void): Unsubscribe;
}

/** The pane as the shell drives it: the feature-facing handle plus the members
 *  only the shell calls. */
export interface PaneKernel extends PaneHandle {
  readonly connection: Pick<
    Connection,
    "forgetSession" | "serverEpochOf" | "adoptPersistedEpoch" | "currentSessionId"
  >;
  setupFeature(feature: TerminalFeature<unknown>): Promise<FeatureSetupOutcome>;
  /** `PaneHandle.on` with the feature the handler belongs to, for error attribution. */
  busOn<K extends keyof TerminalEvents>(
    featureName: string,
    e: K,
    fn: (p: TerminalEvents[K]) => void,
  ): Unsubscribe;
  connectionInitiated(): boolean;
  isDestroyed(): boolean;
  layout(): { narrow: boolean; coarse: boolean };
  toast(message: string, ms?: number): void;
  announce(message: string, politeness?: "polite" | "assertive"): void;
  paste(text: string): void;
  addInputTransform(fn: (bytes: Uint8Array) => Uint8Array): Unsubscribe;
  addInputObserver(fn: (bytes: Uint8Array) => void): Unsubscribe;
  updateNarrow(): void;
  /** Drop the LOCAL display: the client-side scrollback and screen. */
  reset(): void;
  reattach(): void;
  /** Release the live runtime, the engine included, leaving the root's boundary
   *  classes for a recovery surface. */
  cleanupRuntime(): void;
  /** Record that this pane's startup failed, so `state()` reads `failed`. */
  markFailed(): void;
  /** Record whether a closed split hides this pane, so `state()` reads `hidden`
   *  from the moment the split closes rather than from the class the display
   *  gets when the closing transition ends. */
  setHidden(value: boolean): void;
  /** Whether this pane's input is a stop in the document's Tab order. On while
   *  the split is open and the pane shows a tab, so Tab runs left input, divider,
   *  right input, chrome; off otherwise, where typing or a click enters the one
   *  pane and Tab from outside lands on the chrome. */
  setTabStop(value: boolean): void;
  /** `cleanupRuntime()` plus the root's classes and children. */
  destroy(): void;
}

/** The consumer's theme as custom properties on `root`, so the whole subtree
 *  inherits them over the token defaults of css/00-tokens.css. */
export function applyTheme(root: HTMLElement, theme: CreateTerminalOptions["theme"]): void {
  if (!theme) {
    return;
  }
  for (const [key, value] of Object.entries(theme)) {
    if (key.startsWith("--")) {
      root.style.setProperty(key, value);
    }
  }
}

/** Build one pane kernel inside `root`: the output surface, the hidden textarea
 *  that owns the keyboard, one engine instance, and the pane's regions and
 *  primitives; everything visible above the raw terminal is an opt-in feature.
 *  The pane REPORTS focus and blur to the transport and never writes DEC 1004
 *  bytes itself, because the server derives the answer from every attached
 *  client's report plus its own hold. Synchronous and transactional: every
 *  acquisition pushes its release onto one disposer stack, which a throw drains
 *  before it propagates and `cleanupRuntime()` drains on the way out. */
export function buildPane(
  root: HTMLElement,
  opts: CreateTerminalOptions,
  services: PaneServices,
): PaneKernel {
  // One list of what this pane holds, drained by the throw path and the destroy
  // path alike, so a half-built pane cannot leak.
  const held = createCleanupScope((err) => {
    console.error("web-terminal-ui: release failed during teardown", err);
  });
  try {
    return buildPaneInto(root, opts, services, held);
  } catch (err) {
    held.drain();
    throw err;
  }
}

function buildPaneInto(
  root: HTMLElement,
  opts: CreateTerminalOptions,
  services: PaneServices,
  held: CleanupScope,
): PaneKernel {
  const acquire = (release: () => void): void => {
    held.push(release);
  };
  const wsPath = opts.wsPath ?? DEFAULT_WS_PATH;
  const fontReady = opts.fontReady ?? DEFAULT_FONT_READY;
  const scrollbackLines = services.scrollbackLines;
  const encoder = new TextEncoder();
  // The root's realm, never the importing one: a pane in another document reads
  // and listens to that document.
  const doc = root.ownerDocument;
  const win = windowOf(doc);
  // `destroyed` means the runtime is no longer usable, whether through destroy()
  // or a rollback; `rootReleased` (below) is narrower: the boundary classes are
  // gone too. The flag is the stack's own, so a callback the build already armed
  // (the fonts wait) finds it set after a throw as after destroy().
  let destroyed = false;
  acquire(() => {
    destroyed = true;
  });
  const kernelAbort = new AbortController();
  const { signal } = kernelAbort;
  acquire(() => {
    kernelAbort.abort();
  });

  applyTheme(root, opts.theme);

  // .wt-root scopes every library token and style rule to this subtree; the
  // layout-mode class decides how the root claims space (the full viewport, or
  // the parent element). All chrome positions against the root, never the page.
  const layoutMode = opts.layout ?? "viewport";
  root.classList.add("wt-root", layoutMode === "container" ? "wt-container" : "wt-viewport");

  const tpl = doc.createElement("template");
  tpl.innerHTML = CORE_TEMPLATE;
  root.replaceChildren(tpl.content);
  acquire(() => {
    root.classList.remove("wt-narrow");
    root.replaceChildren();
  });
  const termWrap = pick(root, ".term");
  const outputEl = pick(root, ".term-output");
  const input = pick(root, ".term-input") as HTMLTextAreaElement;
  const compositionViewEl = pick(root, ".composition-view");

  const regions = createRegions(root);
  acquire(() => {
    regions.destroy();
  });
  const bus = createBus();
  acquire(() => {
    bus.clear();
  });
  const announcer = createAnnouncer(root);
  acquire(() => {
    announcer.destroy();
  });
  services.registerTablist(createPaneTablist(outputEl));

  // Narrow = compact in EITHER dimension: skinny (a portrait phone, a narrow
  // panel) or short (a landscape phone). ResizeObserver is a hard requirement
  // of this library, so it is constructed with no guard.
  function updateNarrow(): void {
    root.classList.toggle("wt-narrow", services.narrowProbe());
  }
  updateNarrow();
  const narrowObserver = new win.ResizeObserver(updateNarrow);
  narrowObserver.observe(root);
  acquire(() => {
    narrowObserver.disconnect();
  });

  const toastEl = doc.createElement("div");
  toastEl.className = "wt-toast";
  toastEl.setAttribute("role", "status");
  regions.region("banner", "toast").appendChild(toastEl);
  let toastTimer: number | null = null;
  function toast(message: string, ms = TOAST_MS): void {
    toastEl.textContent = message;
    toastEl.classList.add("visible");
    if (toastTimer !== null) {
      win.clearTimeout(toastTimer);
    }
    toastTimer = win.setTimeout(() => {
      toastTimer = null;
      toastEl.classList.remove("visible");
      toastEl.textContent = "";
    }, ms);
  }
  acquire(() => {
    if (toastTimer !== null) {
      win.clearTimeout(toastTimer);
      toastTimer = null;
    }
  });

  const reportError = (feature: string, err: unknown): void => {
    services.reportError(feature, err);
  };

  const inputTransforms: ((b: Uint8Array) => Uint8Array)[] = [];
  const inputObservers: ((b: Uint8Array) => void)[] = [];
  const keydownHandlers: ((ev: KeyboardEvent) => boolean)[] = [];
  acquire(() => {
    inputTransforms.length = 0;
    inputObservers.length = 0;
    keydownHandlers.length = 0;
  });
  function removeFrom<T>(list: T[], item: T): () => void {
    return () => {
      const i = list.indexOf(item);
      if (i >= 0) {
        list.splice(i, 1);
      }
    };
  }

  function sendBytes(bytes: Uint8Array): void {
    // A managed pane with no session (before its first attach, or emptied) sends
    // nothing: the connection would mint an unmanaged session id and park the
    // bytes in its outbox for whatever attaches next.
    if (services.managed && activeSession === null) {
      return;
    }
    let out = bytes;
    for (const t of inputTransforms) {
      out = t(out);
      if (out.length === 0) {
        return;
      }
    }
    // sendBinary buffers while disconnected and returns false only when the
    // outbox is full; observers see accepted input only, so predictive echo never
    // paints a character that never reached the server.
    if (!engine.connection.sendBinary(out)) {
      return;
    }
    // User input re-engages follow and snaps to the bottom (GNOME/xterm), and is
    // the ONLY thing that scrolls a held view down; mouse reports bypass this
    // funnel or the view would snap on every motion report.
    engine.scroll.scrollToBottom();
    for (const obs of inputObservers) {
      obs(out);
    }
  }
  function sendText(text: string): void {
    sendBytes(encoder.encode(text));
  }
  function paste(text: string): void {
    sendText(bracketTextForPaste(prepareTextForTerminal(text), engine.modes));
  }

  let activeSession: SessionRef | null = null;
  // The wake handlers (visibilitychange/pageshow/online) must not open a socket
  // before the first connect: a bare wsPath on a session-gated server 404s, and
  // pageshow fires on the initial load.
  let connectionInitiated = false;
  let failed = false;
  let hidden = false;
  let rootReleased = false;

  let ready = false;
  let firstFrameRendered = false;
  let fontsLoaded = false;
  let wsOpen = false;
  function markReady(): void {
    if (ready) {
      return;
    }
    ready = true;
    connState.setLoaded();
    services.loading.firstFrame();
  }

  const connState = createConnState({
    onState: (s) => {
      bus.emit("connection:state", s);
    },
    onGiveUp: () => {
      services.loading.failed();
    },
    timers: win,
  });
  acquire(() => {
    connState.destroy();
  });

  // The functions above and below read `engine` from a DOM event, a socket
  // message or a timer, none of which fires before createTerminalEngine returns.
  function updateMousePointer(): void {
    termWrap.classList.toggle("wt-mouse-app", engine.modes.getMouseMode() !== 0);
  }
  function measurableSize(): { cols: number; rows: number } | null {
    if (!fontsLoaded || viewport.isInTransition()) {
      return null;
    }
    engine.renderer.updateFontMetrics();
    return engine.renderer.computeSize();
  }
  function maybeSendFirstResize(): void {
    if (!wsOpen || measurableSize() === null) {
      return;
    }
    engine.connection.sendResize();
  }

  const engine: TerminalEngine = createTerminalEngine({
    output: outputEl,
    termWrap,
    wsPath,
    sessionIdKey: services.sessionIdKey,
    ...(scrollbackLines !== undefined ? { maxLines: scrollbackLines } : {}),
    onCursorMove: () => {
      composition.positionCompositionView();
      bus.emit("render:cursor", undefined);
    },
    onUserScrollChange: (scrolledUp) => {
      bus.emit("scroll:state", { scrolledUp });
    },
    callbacks: {
      computeSize: () => engine.renderer.computeSize(),
      getReplayMax: () => engine.renderer.replayMaxForResume(),
      onResumeBounds() {
        // A resume VERIFIES the restored store of the socket's OWN session: the
        // server answered under a known epoch. One ack cannot vouch for a tab it
        // never talked to.
        services.stores.verified(engine.connection.currentSessionId());
      },
      initialSize: measurableSize,
      onMessage(msg) {
        if (msg.type === "screen") {
          firstFrameRendered = true;
          if (fontsLoaded) {
            markReady();
          }
          bus.emit("wire:screen", msg);
        } else if (msg.type === "title") {
          // A shell clears its window title when it redraws its prompt after
          // idling, so a blank OSC 0/2 keeps the last good title.
          if (msg.title.trim() !== "") {
            services.titleBase(msg.title);
          }
          bus.emit("wire:title", { session: activeSession?.id ?? "", title: msg.title });
        } else if (msg.type === "modes") {
          updateMousePointer();
          bus.emit("wire:modes", msg);
        } else if (msg.type === "clipboard") {
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
        // The definitive 4001 close. markReady() first, so an exit that lands
        // before any screen frame still lowers the overlay; then the end state
        // (no reconnect is coming); the host's turn LAST, so a throwing handler
        // cannot leave the page without its banner.
        services.stores.discardUnverified(
          { session: engine.connection.currentSessionId() },
          services.side,
        );
        markReady();
        connState.ended();
        services.onSessionEnded();
      },
      onWireIncompatible() {
        services.stores.discardUnverified("page", services.side);
        markReady();
        connState.incompatible();
      },
      onServerRestart() {
        engine.renderer.resetScrollback();
        engine.renderer.resetScreen();
        connState.restarted();
      },
    },
  });
  acquire(() => {
    engine.dispose();
  });
  services.registerConnection(engine.connection);
  engine.renderer.updateFontMetrics();
  // Derived at build as well as from the two triggers, so a pane created over a
  // mode state that already tracks the mouse shows the right pointer at once.
  updateMousePointer();

  // A press over the display-only output takes focus off the hidden textarea and
  // the click handler puts it back; that blur/focus pair is an artifact of this
  // input model, not a focus change the application should be told about (xterm.js
  // never emits one). So a blur raised inside a press is withheld and the
  // gesture's REAL end state is reported once it resolves.
  let pressHoldsFocus = false;
  let focusResolve: number | null = null;
  function reportFocusNow(): void {
    engine.connection.setClientFocus(
      doc.activeElement !== null && termWrap.contains(doc.activeElement),
    );
  }
  // The focus restore happens in the `click` handler, dispatched after pointerup
  // within the same task, so a task boundary is the first settled point.
  function endPressFocusGesture(): void {
    if (focusResolve !== null) {
      win.clearTimeout(focusResolve);
    }
    focusResolve = win.setTimeout(() => {
      focusResolve = null;
      pressHoldsFocus = false;
      reportFocusNow();
    }, 0);
  }
  acquire(() => {
    if (focusResolve !== null) {
      win.clearTimeout(focusResolve);
      focusResolve = null;
    }
  });
  termWrap.addEventListener(
    "focusin",
    () => {
      engine.connection.setClientFocus(true);
    },
    { signal },
  );
  // Any focus move into the pane selects it, a control in the pane's own regions
  // included, not only the textarea.
  root.addEventListener(
    "focusin",
    () => {
      services.onFocusIn();
    },
    { signal },
  );
  termWrap.addEventListener(
    "focusout",
    (ev) => {
      if (ev.relatedTarget instanceof win.Node && termWrap.contains(ev.relatedTarget)) {
        return;
      }
      if (pressHoldsFocus) {
        return;
      }
      engine.connection.setClientFocus(false);
    },
    { signal },
  );
  reportFocusNow();

  const composition = createComposition({
    textarea: input,
    compositionView: compositionViewEl,
    getCursorPx: () => engine.renderer.getCursorPx(),
    send: sendText,
    paste,
  });
  acquire(() => {
    composition.teardown();
  });

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
      } else if (inputType === "insertReplacementText") {
        // A spellcheck, autocorrect or system-substitution REWRITE of text the pty
        // already has. A terminal cannot retract bytes, and applying the rewrite
        // forward duplicates (xterm.js #3600: `helo` corrected to `hello` puts
        // `helohello` on the wire), so drop it and leave the typed text standing.
        resetToPlaceholder(input);
        return;
      } else if (typeof ev.data === "string" && ev.data.length > 0) {
        if (inputType === "insertFromPaste") {
          paste(ev.data);
        } else {
          sendText(normalizeTypedText(ev.data));
        }
      } else {
        const v = input.value;
        if (v.length > INPUT_PLACEHOLDER.length && v.startsWith(INPUT_PLACEHOLDER)) {
          sendText(normalizeTypedText(v.slice(INPUT_PLACEHOLDER.length)));
        } else if (v !== INPUT_PLACEHOLDER && v.length > 0) {
          sendText(normalizeTypedText(v));
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
      // cancelComposition, not just resetToPlaceholder: `composing` gates both
      // input listeners, so a composition abandoned by losing focus would keep
      // the gate shut when focus came back.
      composition.cancelComposition();
      termWrap.classList.remove("focus");
    },
    { signal },
  );

  /** Applies a `mapKeyboardEvent` result identically on BOTH keydown paths (the
   *  focused textarea and the document-level type-to-focus fallback), so the two
   *  cannot drift: handling only "send" in the fallback silently dropped
   *  Shift+PageUp, which is what a reader who just selected scrollback presses. */
  function applyMappedKey(ev: KeyboardEvent, result: keyboard.KeyboardResult): void {
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
        // The maximum offset, not scrollHeight, which is one clientHeight past the
        // end; WebKit does not reliably clamp an out-of-range offset.
        const max = Math.max(0, termWrap.scrollHeight - h);
        termWrap.scrollTop = Math.min(max, termWrap.scrollTop + h);
        return;
      }
      case "ignore":
        return;
    }
  }
  /** The shell's chain first, then this pane's features'. */
  function runKeydownChain(ev: KeyboardEvent): boolean {
    if (services.onKeydown(ev)) {
      return true;
    }
    for (const h of keydownHandlers) {
      if (h(ev)) {
        return true;
      }
    }
    return false;
  }

  input.addEventListener(
    "keydown",
    (ev: KeyboardEvent) => {
      // Three gates, in this order. `isComposing` covers every engine except the
      // key that COMMITS a composition (keyCode 229, Safari reports isComposing
      // false), read against the RAW latch before the reconciling read clears it:
      // a CJK user past the idle bound is still committing a real composition.
      if (ev.isComposing) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only carrier of the IME-commit fact; see IME_COMMIT_KEYCODE
      if (composition.isCompositionOpen() && ev.keyCode === IME_COMMIT_KEYCODE) {
        return;
      }
      if (composition.isComposing()) {
        return;
      }
      if (runKeydownChain(ev)) {
        return;
      }
      // An "ignore" needs nothing more: the `input` listener delivers the character.
      applyMappedKey(ev, mapKeyboardEvent(ev, engine.modes));
    },
    { signal },
  );

  // On touch the output is the native text-selection surface, so this does the
  // MINIMUM: it opens the keyboard on a clean tap and otherwise gets out of the
  // browser's way. `any-pointer: fine` rather than pointerType because iPadOS
  // reports a COARSE primary pointer even with a trackpad attached.
  const hasFinePointer = (): boolean =>
    typeof win.matchMedia === "function" && win.matchMedia("(any-pointer: fine)").matches;
  let lastPointerType = "mouse";
  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerDownTime = 0;
  function focusTerminal(): void {
    if (destroyed) {
      return;
    }
    input.focus({ preventScroll: true });
  }
  // A passive listener on the pane root: a touch that starts a native selection
  // never focuses the textarea, so focus alone would leave the touched pane
  // unselected.
  root.addEventListener(
    "pointerdown",
    () => {
      services.onPointerDown();
    },
    { passive: true, signal },
  );
  termWrap.addEventListener(
    "pointerdown",
    (e) => {
      lastPointerType = e.pointerType;
      pointerDownX = e.clientX;
      pointerDownY = e.clientY;
      pointerDownTime = e.timeStamp;
      pressHoldsFocus = true;
    },
    { passive: true, signal },
  );
  for (const end of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    termWrap.addEventListener(end, endPressFocusGesture, { passive: true, signal });
  }
  termWrap.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType !== "touch") {
        return;
      }
      if (isLinkTarget(win, e.target)) {
        return;
      }
      const dx = Math.abs(e.clientX - pointerDownX);
      const dy = Math.abs(e.clientY - pointerDownY);
      // A drag or a long-press is not a tap-to-focus.
      if (dx > TAP_MOVEMENT_PX || dy > TAP_MOVEMENT_PX) {
        return;
      }
      if (e.timeStamp - pointerDownTime > TAP_MAX_MS) {
        return;
      }
      // A clean tap while text is selected means "done selecting": iOS otherwise
      // leaves the selection stuck, because the synthetic mousedown cancelled
      // below also suppresses the platform's own tap-to-deselect. A deselect tap
      // must not pop the soft keyboard, unless a hardware keyboard is present.
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) {
        sel.removeAllRanges();
        if (hasFinePointer()) {
          focusTerminal();
        }
        return;
      }
      focusTerminal();
    },
    { passive: true, signal },
  );
  termWrap.addEventListener(
    "mousedown",
    (e) => {
      if (lastPointerType === "touch") {
        // Cancel the synthetic mousedown after a touch tap so iOS keeps the
        // keyboard up, except with a fine pointer, where suppressing it defeated
        // the native focus.
        if (!hasFinePointer()) {
          e.preventDefault();
        }
        return;
      }
      // A bare left press INSIDE the current selection starts a native
      // drag-and-drop of the selected text in Blink and Gecko, and a real mouse
      // always moves a pixel, so the selection would be stuck. Collapsing it
      // before the browser resolves the gesture keeps it on the select path; a
      // modified or non-left press keeps the selection for its own purpose.
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
        return;
      }
      const pressSel = doc.getSelection();
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
        win.open(link.href, "_blank", "noopener,noreferrer");
        return;
      }
      if (lastPointerType === "touch" && !hasFinePointer()) {
        return;
      }
      const sel = doc.getSelection();
      if (sel && sel.toString().length > 0) {
        return;
      }
      focusTerminal();
    },
    { signal },
  );

  // A mouse gesture over `.term-output` leaves focus on the body, so typing
  // silently does nothing (and the two shortcuts on the keydown chain with it).
  // Focusing on the press would collapse the selection, so the browser's model
  // stands and typing takes the keyboard back, as Windows Terminal does.
  const ownsSelection = (): boolean => selectionTextWithin(outputEl) !== "";
  doc.addEventListener(
    "keydown",
    (ev: KeyboardEvent) => {
      // Reachable in one window: the feature teardowns run before the abort that
      // removes this listener.
      if (destroyed) {
        return;
      }
      // A host that handled the key marked it; the platform's own convention.
      if (ev.defaultPrevented) {
        return;
      }
      // Nobody owns the keyboard: focus in a shadow root, a dialog or an ARIA
      // widget all report non-body and all bail.
      if (doc.activeElement !== null && doc.activeElement !== doc.body) {
        return;
      }
      if (composition.isComposing()) {
        return;
      }
      if (!ownsSelection()) {
        return;
      }
      // Features while the selection is STILL INTACT and before the modifier
      // gate: clipboard's Ctrl+Shift+C is a modified key that reads the selection.
      if (runKeydownChain(ev)) {
        return;
      }
      // Decided before taking focus, because a bare modifier press (Shift on its
      // way to Shift+click) must leave the selection alone. Computed only for an
      // "ignore", so the encoder always wins a key it maps.
      const result = mapKeyboardEvent(ev, engine.modes);
      const char = result.kind === "ignore" ? typedChar(ev) : null;
      if (result.kind === "ignore" && char === null) {
        return;
      }
      // Modified keys stay with the browser except an AltGr CHARACTER, the way
      // some layouts type it; AltGraph alone is not a reliable signal (Firefox
      // reports it for plain Option on macOS), and Alt+ArrowLeft is browser back.
      const altGraphChar = char !== null && ev.getModifierState("AltGraph");
      if ((ev.ctrlKey || ev.metaKey || ev.altKey) && !altGraphChar) {
        return;
      }
      if (ev.key === "Tab") {
        return;
      }
      doc.getSelection()?.removeAllRanges();
      focusTerminal();
      // Fail closed: bytes whose effect the user cannot see do not belong in a
      // shell.
      if (doc.activeElement !== input) {
        return;
      }
      if (char !== null) {
        // No `input` event is coming for a key that targeted the body, so send it
        // here; preventDefault makes that exactly once BY SPEC.
        ev.preventDefault();
        sendText(normalizeTypedText(char));
        return;
      }
      applyMappedKey(ev, result);
    },
    { signal },
  );

  const viewport = createViewport({
    termWrap,
    root,
    scroll: engine.scroll,
    suppressKeyboardInset: hasFinePointer,
    onSettled() {
      // The settle is the one resize a keyboard slide or rotation should cost;
      // sendResize deduplicates.
      if (measurableSize() !== null) {
        engine.connection.sendResize();
      }
      composition.positionCompositionView();
    },
  });
  acquire(() => {
    viewport.teardown();
  });

  // Both handles are owned so a pane destroyed inside the font wait fires
  // nothing afterwards: the settled callback would fade the consumer's overlay
  // and measure a disposed renderer.
  let fontDeadline: number | null = null;
  let firstResizeFrame: number | null = null;
  acquire(() => {
    if (fontDeadline !== null) {
      win.clearTimeout(fontDeadline);
      fontDeadline = null;
    }
    if (firstResizeFrame !== null) {
      win.cancelAnimationFrame(firstResizeFrame);
      firstResizeFrame = null;
    }
  });
  const onFontSettled = (): void => {
    if (destroyed) {
      return;
    }
    fontsLoaded = true;
    if (firstFrameRendered) {
      markReady();
    }
    firstResizeFrame = win.requestAnimationFrame(() => {
      firstResizeFrame = null;
      maybeSendFirstResize();
    });
  };
  try {
    // The race covers the whole wait: a stalled request leaves load() itself
    // pending, so a deadline armed on the rejection alone would bound one of the
    // ways a font can hang.
    const landed: Promise<boolean> = doc.fonts.load(fontReady).then(
      () => false,
      (err: unknown) => {
        console.warn(`web-terminal-ui: web font ${fontReady} failed to load`, err);
        // One load() over a stack rejects as a UNIT, so the families that ARE
        // served still land before the first resize is measured.
        return doc.fonts.ready.then(() => false);
      },
    );
    const deadline = new Promise<boolean>((resolve) => {
      fontDeadline = win.setTimeout(() => {
        fontDeadline = null;
        resolve(true);
      }, FONT_READY_TIMEOUT_MS);
    });
    void Promise.race([landed, deadline]).then((timedOut) => {
      onFontSettled();
      if (destroyed || !timedOut) {
        return;
      }
      // The gate opened on fallback metrics and the swap period is infinite, so
      // one corrective announce once the bytes land; sendResize deduplicates.
      void doc.fonts.ready.then(() => {
        if (destroyed || measurableSize() === null) {
          return;
        }
        engine.connection.sendResize();
      });
    }, onFontSettled);
  } catch (err) {
    console.warn(`web-terminal-ui: invalid fontReady ${fontReady}`, err);
    onFontSettled();
  }

  const browseSweep = win.setInterval(() => {
    // The BOUND store has a reader, so its drop is conditional and goes through
    // the renderer; every other store belongs to a background tab. The engine
    // stamps browse activity with its own module's Date.now, so the age is read
    // off that clock and not the mounted window's.
    const bound = engine.renderer.boundStore();
    if (
      engine.renderer.browseCacheSize() > 0 &&
      Date.now() - engine.renderer.lastBrowseActivityMs() >= BROWSE_CACHE_TTL_MS
    ) {
      engine.renderer.dropBrowseCache(doc.visibilityState === "visible");
    }
    for (const store of services.stores.backgroundStores(bound)) {
      if (
        store.browseCacheSize() > 0 &&
        Date.now() - store.lastBrowseActivityMs() >= BROWSE_CACHE_TTL_MS
      ) {
        store.dropBrowseCache(-1, false);
      }
    }
  }, 60_000);
  acquire(() => {
    win.clearInterval(browseSweep);
  });
  // Unconditional, for the page about to stop executing: a frozen page runs no
  // code, so its caches would stay resident for the whole freeze. Wrong on the
  // return transition, where a reader is arriving.
  const dropEveryBrowseCache = (): void => {
    const bound = engine.renderer.boundStore();
    engine.renderer.dropBrowseCache(false);
    for (const store of services.stores.backgroundStores(bound)) {
      store.dropBrowseCache(-1, false);
    }
  };
  // `freeze` is Chrome's Page Lifecycle signal; `pagehide` with `persisted` is
  // the Safari bfcache path. Either can fire without the other.
  doc.addEventListener(
    "freeze",
    () => {
      // Persist BEFORE dropping: a hidden page's socket keeps delivering, and
      // `freeze` is the last code that runs.
      services.stores.flush();
      dropEveryBrowseCache();
    },
    { signal },
  );

  doc.addEventListener(
    "visibilitychange",
    () => {
      if (doc.visibilityState === "visible") {
        if (connectionInitiated) {
          engine.connection.reconnectNow();
        }
        if (services.shell.selected() === services.side) {
          focusTerminal();
        }
        return;
      }
      services.stores.flush();
    },
    { signal },
  );
  win.addEventListener(
    "pageshow",
    () => {
      if (connectionInitiated) {
        engine.connection.reconnectNow();
      }
      if (services.shell.selected() === services.side) {
        focusTerminal();
      }
    },
    { signal },
  );
  win.addEventListener(
    "pagehide",
    (event) => {
      services.stores.flush();
      if (event.persisted) {
        dropEveryBrowseCache();
      }
    },
    { signal },
  );
  win.addEventListener(
    "online",
    () => {
      if (connectionInitiated) {
        engine.connection.reconnectNow();
      }
    },
    { signal },
  );

  const host = createFeatureHost(reportError);
  acquire(() => {
    host.teardownAll();
  });

  function detachSession(): void {
    // Make input safe before the socket is re-pointed: end any in-flight IME
    // composition, clear the textarea, forget a held mouse gesture (the incoming
    // session's application never saw the press), and let every feature disarm
    // latched input state (mobileToolbar's sticky-Ctrl).
    composition.cancelComposition();
    resetToPlaceholder(input);
    engine.mouse.disarmGesture();
    for (const instance of host.instances()) {
      instance.onDetach?.();
    }
  }

  function performSwitch(session: SessionRef): void {
    // A feature's un-cancelled async can request a switch after destroy().
    if (destroyed) {
      return;
    }
    detachSession();
    activeSession = session;
    // A session another pane forgot arrives with the epoch that pane knew, or the
    // first resumeAck has nothing to compare against and a server restart between
    // the two attaches goes undetected.
    const epoch = services.knownEpoch(session.id);
    if (epoch !== 0) {
      engine.connection.adoptPersistedEpoch(session.id, epoch);
    }
    engine.connection.setSession(session.id);
    // setSession restores the incoming session's mode mirror synchronously and
    // delivers no modes frame.
    updateMousePointer();
    connectionInitiated = true;
    for (const instance of host.instances()) {
      instance.onSwitch?.(session);
    }
    bus.emit("session:switch", session);
    services.onSessionChange();
  }

  function clearActiveSession(): void {
    if (destroyed || activeSession === null) {
      return;
    }
    const outgoing = activeSession.id;
    detachSession();
    services.noteEpoch(outgoing, engine.connection.serverEpochOf(outgoing));
    engine.connection.forgetSession(outgoing);
    activeSession = null;
    // `connectionInitiated` must go false here or the wake handlers reconnect a
    // pane that holds no session, under a fresh id the server has never seen.
    connectionInitiated = false;
    engine.renderer.bind(new LineStore(scrollbackLines));
    engine.renderer.resetScreen();
    connState.idle();
    services.onSessionChange();
  }

  const modes = engine.modes;
  const session = {
    get id() {
      return activeSession?.id ?? null;
    },
    size: () => engine.renderer.computeSize(),
    highestIndex: () => engine.renderer.getHighestIndex(),
  };
  const layout = (): { narrow: boolean; coarse: boolean } => ({
    narrow: services.narrowProbe(),
    coarse: typeof win.matchMedia === "function" && win.matchMedia("(pointer: coarse)").matches,
  });
  function busOn<K extends keyof TerminalEvents>(
    featureName: string,
    e: K,
    fn: (p: TerminalEvents[K]) => void,
  ): Unsubscribe {
    // Wrapped so a throwing feature handler is isolated and attributed.
    return bus.on(e, (p) => {
      try {
        fn(p);
      } catch (err) {
        reportError(featureName, err);
      }
    });
  }

  function makeContext(featureName: string, scope: CleanupScope): TerminalContext {
    const track = (off: Unsubscribe): Unsubscribe => {
      scope.push(off);
      return off;
    };
    return {
      region: (name, slot) => regions.region(name, slot),
      surface: () => termWrap,
      send: sendBytes,
      paste,
      registerInputTransform(fn) {
        inputTransforms.push(fn);
        return track(removeFrom(inputTransforms, fn));
      },
      registerInputObserver(fn) {
        inputObservers.push(fn);
        return track(removeFrom(inputObservers, fn));
      },
      registerKeydown(fn) {
        keydownHandlers.push(fn);
        return track(removeFrom(keydownHandlers, fn));
      },
      render: engine.renderer,
      scroll: engine.scroll,
      modes,
      session,
      shell: services.shell,
      on: (e, fn) => track(busOn(featureName, e, fn)),
      defer(release) {
        scope.push(release);
      },
      use<A>(feature: TerminalFeature<A>): A | undefined {
        return host.use(feature) as A | undefined;
      },
      toast,
      announce: (message, politeness) => {
        announcer.announce(message, politeness);
      },
      loadingReason: (message) => {
        services.loading.reason(message);
      },
      tablist: () => services.tablist(),
      newLineStore: (sessionId) => services.stores.newLineStore(sessionId),
      layout,
      notifySwitch(s) {
        performSwitch(s);
      },
      dropSession(id) {
        services.dropSession(id);
      },
      onError: (fn) => track(services.onError(fn)),
    };
  }

  function cleanupRuntime(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    // A pane torn down while showing a tab hands the tab's epoch on as an emptied
    // one does: the tab lives on, and the next pane to show it is seeded from it.
    if (activeSession !== null) {
      services.noteEpoch(activeSession.id, engine.connection.serverEpochOf(activeSession.id));
    }
    activeSession = null;
    held.drain();
  }

  engine.renderer.updateFontMetrics();
  composition.positionCompositionView();
  if (!services.managed) {
    // A single unmanaged pane has no feature to own its store, so the shell
    // hydrates the renderer's implicit one here, before connect(), because the
    // resume announces what this client already holds. Restored content does not
    // dismiss the overlay: it is last session's output until the resume confirms
    // it.
    if (services.stores.persisting) {
      const sessionId = engine.connection.currentSessionId();
      const restored = services.stores.implicitStore(sessionId, engine.renderer.boundStore());
      if (restored !== null) {
        engine.renderer.bind(restored);
      }
    }
    engine.connection.connect();
    connectionInitiated = true;
  }
  if (services.shell.selected() === services.side) {
    focusTerminal();
  }

  return {
    get side() {
      return services.side;
    },
    root,
    surface: () => termWrap,
    render: engine.renderer,
    scroll: engine.scroll,
    modes,
    session,
    state() {
      if (failed) {
        return "failed";
      }
      if (hidden) {
        return "hidden";
      }
      return activeSession === null ? "empty" : "shown";
    },
    region: (name, slot) => regions.region(name, slot),
    on: (e, fn) => busOn("shell", e, fn),
    busOn,
    notifySwitch: performSwitch,
    clearActiveSession,
    announceSize() {
      if (!destroyed && fontsLoaded) {
        engine.connection.sendResize();
      }
    },
    focus: focusTerminal,
    send(bytes) {
      if (destroyed) {
        return;
      }
      sendBytes(bytes);
    },
    connection: engine.connection,
    setupFeature: (feature) =>
      host.setup(
        feature,
        (scope) => makeContext(feature.name, scope),
        () => destroyed,
      ),
    connectionInitiated: () => connectionInitiated,
    isDestroyed: () => destroyed,
    layout,
    toast,
    announce: (message, politeness) => {
      announcer.announce(message, politeness);
    },
    paste,
    addInputTransform(fn) {
      inputTransforms.push(fn);
      return removeFrom(inputTransforms, fn);
    },
    addInputObserver(fn) {
      inputObservers.push(fn);
      return removeFrom(inputObservers, fn);
    },
    updateNarrow,
    reset() {
      if (destroyed) {
        return;
      }
      engine.renderer.resetScrollback();
      engine.renderer.resetScreen();
    },
    reattach() {
      if (destroyed) {
        return;
      }
      // The old session's content goes first: holding it would put a
      // `haveThrough` on the resume that claims lines the replacement has never
      // reached. Off `ended`, or the banner would contradict the blanked screen.
      engine.renderer.resetScrollback();
      engine.renderer.resetScreen();
      connState.reconnecting();
      engine.connection.reconnectNow();
    },
    cleanupRuntime,
    markFailed() {
      failed = true;
    },
    setHidden(value) {
      hidden = value;
    },
    setTabStop(value) {
      input.tabIndex = value ? 0 : -1;
    },
    destroy() {
      if (rootReleased) {
        return;
      }
      rootReleased = true;
      cleanupRuntime();
      root.classList.remove("wt-root", "wt-viewport", "wt-container", "wt-narrow");
      // A fatal handler may have rendered replacement UI after the drain.
      root.replaceChildren();
    },
  };
}
