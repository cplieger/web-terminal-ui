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

export function createTerminal(root: HTMLElement, opts: CreateTerminalOptions = {}): TerminalHandle {
  const wsPath = opts.wsPath ?? DEFAULT_WS_PATH;
  const fontReady = opts.fontReady ?? DEFAULT_FONT_READY;
  const featureList = opts.features ?? [];
  const encoder = new TextEncoder();
  const kernelAbort = new AbortController();
  const { signal } = kernelAbort;

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
        document.title = msg.title;
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
  let lastPointerType = "mouse";
  let pointerDownX = 0;
  let pointerDownY = 0;
  function focusTerminal(): void {
    input.focus({ preventScroll: true });
  }
  termWrap.addEventListener(
    "pointerdown",
    (e) => {
      lastPointerType = e.pointerType;
      pointerDownX = e.clientX;
      pointerDownY = e.clientY;
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
      if (dx > TAP_MOVEMENT_PX || dy > TAP_MOVEMENT_PX) {
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) {
        return;
      }
      focusTerminal();
    },
    { passive: true, signal },
  );
  termWrap.addEventListener(
    "mousedown",
    (e) => {
      // Cancel the synthetic mousedown after a touch tap so iOS keeps the
      // keyboard up (xterm.js focus-preservation pattern, scoped to touch).
      if (lastPointerType === "touch") {
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
      if (lastPointerType === "touch") {
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
        connection.reconnectNow();
        focusTerminal();
      }
    },
    { signal },
  );
  window.addEventListener(
    "pageshow",
    () => {
      connection.reconnectNow();
      focusTerminal();
    },
    { signal },
  );
  window.addEventListener(
    "online",
    () => {
      connection.reconnectNow();
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
        activeSession = session;
        for (const { instance } of instances) {
          if (instance.onSwitch) {
            instance.onSwitch(session);
          }
        }
        bus.emit("session:switch", session);
      },
      onError(fn) {
        errorHandlers.add(fn);
        return () => errorHandlers.delete(fn);
      },
    };
  }

  // --- Feature lifecycle ---
  let destroyed = false;
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
  // Features set up in the background; first paint is never gated on them.
  void setupFeatures();

  // --- Connect + focus ---
  render.updateFontMetrics();
  composition.positionCompositionView();
  connection.connect();
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
