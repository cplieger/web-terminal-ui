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

import { render, scroll, connection, keyboard, modes } from "@cplieger/web-terminal-engine";
import * as composition from "../composition.js";
import * as viewport from "../viewport.js";
import { INPUT_PLACEHOLDER, resetToPlaceholder } from "../input-placeholder.js";
import { createBus } from "./bus.js";
import { createRegions } from "./regions.js";
import { createAnnouncer, createTablist } from "./a11y.js";
import { createConnState } from "./conn-state.js";
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
const DEFAULT_FONT_READY = '14px "MonaspiceNe NFM"';
const TOAST_MS = 3000;
const TAP_MOVEMENT_PX = 10;
// A touch that focuses the input (opens the soft keyboard) must be a genuine
// tap: short and low-movement. A longer hold is a long-press, which belongs to
// native text selection / the context menu — so tap-to-focus bows out above
// this duration and never steals a long-press or a selection.
const TAP_MAX_MS = 500;

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

export function createTerminal(
  root: HTMLElement,
  opts: CreateTerminalOptions = {},
): TerminalHandle {
  const wsPath = opts.wsPath ?? DEFAULT_WS_PATH;
  const fontReady = opts.fontReady ?? DEFAULT_FONT_READY;
  const featureList = opts.features ?? [];
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
      fn(feature, err);
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
  // it has: a session-managing feature (tabs) drives the first connect via
  // notifySwitch once it resolves a session id, and connecting to the bare
  // wsPath before then hits a session-gated endpoint (the SessionManager 404s a
  // /ws with no ?session=). pageshow fires on the initial load, so without this
  // gate a slow session list lets pageshow's reconnectNow open a bare /ws that
  // 404s (seen in Firefox, where the list loses the race). Flips true on the
  // startup connect (unmanaged) or the first setSession (managed).
  let connectionInitiated = false;

  // --- Loading lifecycle ---
  let ready = false;
  let firstFrameRendered = false;
  let fontsLoaded = false;
  let wsOpen = false;
  let overlayDismissed = false;
  function dismissLoadingOverlay(): void {
    const ld = opts.loading;
    if (!ld || overlayDismissed) {
      return;
    }
    overlayDismissed = true;
    ld.classList.add("fade");
    const removeOverlay = (): void => {
      ld.remove();
    };
    ld.addEventListener("transitionend", removeOverlay, { once: true });
    window.setTimeout(removeOverlay, 1500);
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
  });

  function maybeSendFirstResize(): void {
    if (!fontsLoaded || !wsOpen) {
      return;
    }
    render.updateFontMetrics();
    connection.sendResize();
  }

  connection.init({
    computeSize: render.computeSize,
    getHaveThrough: render.getHighestIndex,
    onResumeBounds: render.noteResumeBounds,
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
      markReady();
      connState.ended();
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
      if ((e.target as HTMLElement).closest(".term-link")) {
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
      // Cancel the synthetic mousedown after a touch tap so iOS keeps the
      // keyboard up (xterm.js focus-preservation pattern, scoped to touch). Skip
      // it when a fine pointer is present (iPad + trackpad / Magic Keyboard):
      // there is no soft keyboard to protect, and suppressing the mousedown was
      // defeating the native focus, so the terminal needed several taps to focus.
      if (lastPointerType === "touch" && !hasFinePointer()) {
        e.preventDefault();
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
    suppressKeyboardInset: hasFinePointer,
    onSettled() {
      render.updateFontMetrics();
      if (fontsLoaded) {
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

  // --- Reconnect-on-wake ---
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") {
        if (connectionInitiated) {
          connection.reconnectNow();
        }
        focusTerminal();
      }
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
      tablist: () => tablistController,
      notifySwitch(session) {
        // A feature's un-cancelled async (tabs bootstrap/create()/pollOnce()) can
        // resolve after destroy() and call this; ignore it so a torn-down terminal
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
        // state; the renderer was already pointed at its store by tabs.
        connection.setSession(session.id);
        // The managed first connect has happened (session id is now on the WS
        // URL); wake-reconnect handlers may fire from here on.
        connectionInitiated = true;
        for (const { instance } of instances) {
          if (instance.onSwitch) {
            instance.onSwitch(session);
          }
        }
        bus.emit("session:switch", session);
      },
      dropSession(id) {
        connection.forgetSession(id);
      },
      onError(fn) {
        errorHandlers.add(fn);
        return () => errorHandlers.delete(fn);
      },
    };
  }

  // --- Feature lifecycle ---
  let destroyed = false;
  // Live read of `destroyed` for the post-await re-check in setupFeatures():
  // a plain `if (destroyed)` there is narrowed to always-false by TS CFA
  // (it cannot model destroy() firing during the await), tripping
  // @typescript-eslint/no-unnecessary-condition. A call defeats the stale
  // narrowing with identical runtime behavior.
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

  async function setupFeatures(): Promise<void> {
    for (const feature of featureList) {
      if (destroyed) {
        return;
      }
      try {
        const instance = await feature.setup(makeContext(feature.name));
        // destroy() may have run during the await above; teardownFeatures() has already
        // swept `instances`, and destroy() is one-shot, so a straight push here would
        // leave this instance's listeners/timers/observers (tabs' SSE + poll + window/
        // document listeners + ResizeObservers) alive forever. Tear it down instead of
        // registering it.
        if (isDestroyed()) {
          try {
            instance.teardown();
          } catch (err) {
            reportError(feature.name, err);
          }
          return;
        }
        instances.push({ feature, instance });
        // Populate the feature value's readonly api (consumer pattern:
        // tabs.api?.create()) via a narrow cast, and the ctx.use lookup map.
        (feature as { api?: unknown }).api = instance.api;
        apiMap.set(feature, instance.api);
      } catch (err) {
        // Fail fast: roll back the already-set-up features in reverse and
        // surface a composed, named error (section 22.4).
        reportError(feature.name, err);
        teardownFeatures();
        console.error(
          `web-terminal-ui: feature "${feature.name}" setup failed; terminal has no chrome`,
          err,
        );
        return;
      }
    }
  }
  // A session-managing feature (tabs) drives the first connect itself once it
  // has resolved a session id (ctx.notifySwitch -> connection.setSession, which
  // adds ?session=<id>). Connecting here first would open a bare /ws that a
  // SessionManager 404s (no ?session=), flashing a disconnect banner and
  // churning the reconnect backoff until the feature sets a session. So skip the
  // startup connect when managed; the single-terminal presets leave it to us.
  const sessionManaged = featureList.some((f) => f.managesSessions === true);

  // Features set up in the background; first paint is never gated on them.
  void setupFeatures().then(() => {
    // A session-managing feature that finished setup WITHOUT initiating a
    // connection means its bootstrap failed (no session could be listed or
    // spawned) or its setup threw. markReady (needs a screen frame) and onGiveUp
    // (needs the connect to be attempted and fail) then never fire, so the
    // loading overlay would stay up forever, hiding the retry chrome the feature
    // keeps alive (tabs' "+"). Dismiss it so the page shows its real state.
    if (sessionManaged && !connectionInitiated && !destroyed) {
      dismissLoadingOverlay();
    }
  });

  // --- Connect + focus ---
  render.updateFontMetrics();
  composition.positionCompositionView();
  if (!sessionManaged) {
    connection.connect();
    connectionInitiated = true;
  }
  focusTerminal();

  return {
    focus: focusTerminal,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      teardownFeatures();
      kernelAbort.abort();
      viewport.teardown();
      // Reset the composition singleton (kernel-driven, no feature teardown): a
      // destroy() mid-IME-composition otherwise leaves module-level `composing`
      // stuck true, so a remounted terminal swallows every keydown until an IME
      // cycle resets it; also neutralizes a pending compositionend setTimeout.
      composition.teardown();
      connection.disconnect();
      connState.destroy();
      if (toastTimer !== null) {
        clearTimeout(toastTimer);
      }
      for (const off of subscriptions) {
        off();
      }
      subscriptions.length = 0;
      bus.clear();
      announcer.destroy();
      regions.destroy();
      root.replaceChildren();
    },
  };
}
