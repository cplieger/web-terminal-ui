// @cplieger/web-terminal-ui — reference touch-first browser terminal UI.
//
// mount(root) builds the entire terminal subtree inside a single host-provided
// container element and owns the touch-first input model: a display-only
// terminal output, a hidden <textarea> that owns the keyboard + IME + local
// typing buffer, a mobile key toolbar, a viewport-clamped context menu,
// predictive echo, and viewport/keyboard-inset handling. The consumer's HTML
// is just <head> + one empty root element (+ an optional loading overlay) +
// the importmap; mount creates everything else, so there is no shared
// element-id contract to keep in sync. A consumer that wants a different UI
// builds on the engine directly instead.
//
// Single-instance per page: the module holds the one terminal's DOM refs and
// state, matching a terminal-per-page model. Call mount() exactly once.

import { render, keyboard, scroll, connection, modes } from "@cplieger/web-terminal-engine";
import * as viewport from "./viewport.js";
import * as composition from "./composition.js";
import * as status from "./status.js";
import * as predict from "./predict.js";
import { INPUT_PLACEHOLDER, resetToPlaceholder } from "./input-placeholder.js";

const { mapKeyboardEvent, bracketTextForPaste, prepareTextForTerminal } = keyboard;

export interface MountOptions {
  /** WebSocket endpoint path the engine connects to. Default "/ws"
   *  (vibekit serves the shell at "/api/shell/ws", vibecli at "/ws"). */
  wsPath?: string;
  /** CSS font shorthand awaited before the first resize is sent, so the
   *  server is sized against the real web font's cell metrics rather than a
   *  fallback. Default '14px "MonaspiceNe NFM"'. */
  fontReady?: string;
  /** Optional pre-JS loading overlay element (lives in the served HTML so it
   *  paints before this module loads). mount fades it out and removes it once
   *  the first screen frame renders. The consumer owns the element; mount only
   *  dismisses it. */
  loading?: HTMLElement;
}

export interface TerminalUI {
  /** Focus the terminal input (opens the soft keyboard on touch). */
  focus(): void;
}

const DEFAULT_WS_PATH = "/ws";
const DEFAULT_FONT_READY = '14px "MonaspiceNe NFM"';

const TAP_MOVEMENT_PX = 10;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD_PX = 10;

const encoder = new TextEncoder();

// --- DOM refs (picked by class from the subtree mount() builds) ---
let outputEl!: HTMLElement;
let termWrap!: HTMLElement;
let input!: HTMLTextAreaElement;
let ctxMenu!: HTMLElement;

// --- Mutable UI state ---
// Sticky-Ctrl state + the C0 mapping table + the toolbar button wiring all
// live in the engine's keyboard.bindMobileToolbar; mount() binds it against
// the built .key-toolbar element and keeps the controller so the input handler
// can route typed text through its applyStickyCtrl.
let toolbarCtrl!: keyboard.MobileToolbarController;
let fontsLoaded = false;
let wsOpen = false;
let lastPointerType = "mouse";
let pointerDownX = 0;
let pointerDownY = 0;
let longPressTimer = 0;
let longPressOrigin = { x: 0, y: 0 };

// iOS Safari shows a system "Paste" permission toast every time
// navigator.clipboard.readText() is called — by design, and unavoidable
// from JavaScript. iOS users get a one-tap paste via the native
// long-press callout (which routes through the textarea's paste event
// handler in composition.ts without ever calling readText), so we omit
// the Paste button from our custom menu on iOS to steer them there.
let isIOS = false;

// The terminal subtree mount() builds inside the host-provided root. Static,
// trusted markup (no interpolation) parsed once via a <template>. Element refs
// are then picked out by class with scoped queries — no global getElementById,
// no element-id contract the consumer must reproduce. The only ids are on the
// kb-* toolbar buttons, which the engine's bindMobileToolbar resolves with a
// scoped `toolbar.querySelector('#id')` (not a document-global lookup). The
// predicted-cursor overlay is created and owned by the engine renderer; the
// loading overlay stays in the consumer's served HTML (it must paint before
// this module loads).
const TERMINAL_TEMPLATE = `
<div class="term">
  <div class="term-output" role="log" aria-live="off" aria-roledescription="Terminal" aria-label="Terminal"></div>
  <textarea class="term-input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Terminal input" tabindex="-1"></textarea>
  <div class="composition-view" aria-hidden="true"></div>
</div>
<div class="conn-banner" role="status" aria-live="polite"></div>
<div class="key-toolbar collapsed no-transition" aria-label="Navigation keys" role="toolbar">
  <button type="button" id="kb-toggle" class="kb-toggle" aria-label="Toggle key toolbar"><svg class="icon-hamburger" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg><svg class="icon-close" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
  <button type="button" id="kb-tab" class="kb-key kb-r1c1" aria-label="Tab">TAB</button>
  <button type="button" id="kb-esc" class="kb-key kb-r1c2" aria-label="Escape">ESC</button>
  <button type="button" id="kb-up" class="kb-key kb-r1c3" aria-label="Up"><svg viewBox="0 0 24 24"><polyline points="6 15 12 9 18 15"/></svg></button>
  <button type="button" id="kb-enter" class="kb-key kb-r1c4" aria-label="Enter"><svg viewBox="0 0 24 24"><polyline points="9 10 4 15 9 20"/><polyline points="20 4 20 15 4 15"/></svg></button>
  <button type="button" class="kb-scroll-bottom" aria-label="Scroll to bottom"><svg viewBox="0 0 24 24"><path fill="none" d="M7 13l5 5 5-5M7 6l5 5 5-5"/></svg></button>
  <button type="button" id="kb-ctrl" class="kb-key kb-r2c1" aria-label="Sticky Ctrl modifier" aria-pressed="false">CTRL</button>
  <button type="button" id="kb-left" class="kb-key kb-r2c2" aria-label="Left"><svg viewBox="0 0 24 24"><polyline points="15 6 9 12 15 18"/></svg></button>
  <button type="button" id="kb-down" class="kb-key kb-r2c3" aria-label="Down"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></button>
  <button type="button" id="kb-right" class="kb-key kb-r2c4" aria-label="Right"><svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg></button>
</div>
<div class="ctx-menu"></div>`;

// Pick a freshly-built element out of the root by class. Throws if the
// template and the selector ever drift apart (a build-time invariant, not a
// host-scaffold dependency).
function pick(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`web-terminal-ui: mount() failed to build element ${selector}`);
  }
  return el;
}

function send(bytes: string): void {
  // Suppress a lone Backspace (DEL) ONLY at the true origin (row 0, col 0):
  // there's nothing left to delete on an empty line, and this preserves the
  // brake iOS's textarea provided (stops held-Backspace key-repeat when empty).
  // The row check matters: predict.applyInput models a col-0 DEL on a WRAPPED
  // continuation row (row > 0) by wrapping to the end of the previous row, so a
  // continuation-row backspace must cross that wrap and reach the server rather
  // than being braked here (braking it would make backspace silently stick
  // mid-line on a wrapped command line).
  const p = predict.get();
  if (bytes === "\x7f" && p.col === 0 && p.row === 0 && p.active) {
    return;
  }
  const buf = encoder.encode(bytes);
  // sendBinary buffers while disconnected (resume layer) and returns false ONLY when the
  // 1 MiB outbox is full -- the engine has already surfaced that via onOutboxFull ->
  // status.closed(). Advancing the prediction for a dropped byte would paint a phantom
  // char that never reaches the server, so only advance on accepted input.
  if (!connection.sendBinary(buf)) {
    return;
  }
  predict.applyInput(buf);
}

// Normalize iOS's NBSP-for-space quirk, apply sticky-Ctrl, then send.
function sendTyped(text: string): void {
  send(toolbarCtrl.applyStickyCtrl(text.replace(/\u00A0/g, " ")));
}

// Read the current predicted-cursor state and push it to the renderer.
// Shared by render.init's onCursorMove (server cursor moved) and
// predict.subscribe (prediction changed) so both push identically.
function pushPredictedCursor(): void {
  const p = predict.get();
  render.setPredictedCursor(p.row, p.col, p.active);
}

// Clipboard helpers. navigator.clipboard is UNDEFINED outside a secure context
// (plain-HTTP on a non-loopback host — a supported web-terminal-server
// deployment), where a property access such as navigator.clipboard.writeText
// throws a SYNCHRONOUS TypeError before any .then/.catch can guard it. Feature-
// detect first so Copy/Paste surface a "Clipboard unavailable" toast instead of
// throwing out of the handler (on Ctrl+Shift+C an uncaught throw would also skip
// preventDefault and let the browser's native devtools shortcut fire).
function copyToClipboard(text: string): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- navigator.clipboard is undefined outside secure contexts (plain-HTTP host)
  if (!navigator.clipboard) {
    status.toast("Clipboard unavailable");
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => {
      status.toast("Copied");
    })
    .catch(() => {
      status.toast("Copy failed");
    });
}

function pasteFromClipboard(): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- navigator.clipboard is undefined outside secure contexts (plain-HTTP host)
  if (!navigator.clipboard) {
    status.toast("Clipboard unavailable");
    return;
  }
  navigator.clipboard
    .readText()
    .then((text) => {
      send(bracketTextForPaste(prepareTextForTerminal(text)));
    })
    .catch(() => {
      status.toast("Paste blocked");
    });
}

// Keydown handler — attached to the textarea (the single keyboard target,
// desktop and touch alike); .term-output is display-only and never focused.
function handleKeydown(ev: KeyboardEvent): void {
  // While composing (IME), let the browser pump composition events;
  // keydown bytes during composition would duplicate the composed text.
  if (composition.isComposing()) {
    return;
  }

  // When the context menu is open, Escape dismisses it WITHOUT also sending an
  // ESC byte to the PTY -- matching the no-side-effect outside-click dismiss
  // (the document-level handler frames this as "parity"). This textarea keydown
  // fires before that document-level handler bubbles, so without this guard
  // mapKeyboardEvent would send ESC to the shell first (e.g. dropping vim out of
  // insert mode) while the menu also closes. The document-level handler still
  // covers the case where focus is on a menu button rather than the textarea.
  if (ev.key === "Escape" && ctxMenu.classList.contains("visible")) {
    ev.preventDefault();
    hideCtxMenu();
    return;
  }

  // Ctrl+Shift+C / Ctrl+Shift+V — desktop clipboard shortcuts. Handled
  // before the generic mapper because they take browser-side selection
  // and clipboard, not server-bound key sequences.
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
    if (ev.code === "KeyC") {
      const sel = window.getSelection()?.toString();
      if (sel) {
        copyToClipboard(sel);
      }
      ev.preventDefault();
      return;
    }
    if (ev.code === "KeyV") {
      pasteFromClipboard();
      ev.preventDefault();
      return;
    }
  }

  const result = mapKeyboardEvent(ev, modes);
  switch (result.kind) {
    case "send":
      ev.preventDefault();
      send(result.bytes);
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
      // Defer to the browser; the `input` listener will pick up any
      // printable character produced by the keystroke.
      return;
  }
}

// Focus the textarea (on page load and after visibility changes).
function focusTerminal(): void {
  input.focus({ preventScroll: true });
}

// Send the first resize only when BOTH fonts are loaded AND the WS is
// open. Either can happen first depending on network/cache conditions.
function maybeSendFirstResize(): void {
  if (!fontsLoaded || !wsOpen) {
    return;
  }
  render.updateFontMetrics();
  connection.sendResize(); // sends only if size changed
  const sz = render.computeSize();
  predict.setDimensions(sz.cols, sz.rows);
}

function hideCtxMenu(): void {
  // If focus is inside the menu (a keyboard user activated an item or pressed
  // Escape on a focused button), return focus to the terminal input -- otherwise
  // removing the focused button drops focus to <body> and the keyboard user can no
  // longer type. On a pointer/outside-click dismiss focus is not in the menu, so
  // this is a no-op and does not steal focus.
  const refocus = ctxMenu.contains(document.activeElement);
  ctxMenu.classList.remove("visible");
  ctxMenu.replaceChildren();
  if (refocus) {
    focusTerminal();
  }
}

function showCtxMenu(x: number, y: number): void {
  hideCtxMenu();

  const sel = window.getSelection()?.toString();
  if (sel) {
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      copyToClipboard(sel);
      hideCtxMenu();
    });
    ctxMenu.appendChild(copyBtn);
  }

  const selectAllBtn = document.createElement("button");
  selectAllBtn.textContent = "Select All";
  selectAllBtn.addEventListener("click", () => {
    const s = window.getSelection();
    if (s) {
      s.selectAllChildren(outputEl);
    }
    hideCtxMenu();
  });
  ctxMenu.appendChild(selectAllBtn);

  if (!isIOS || lastPointerType !== "touch") {
    const pasteBtn = document.createElement("button");
    pasteBtn.textContent = "Paste";
    pasteBtn.addEventListener("click", () => {
      pasteFromClipboard();
      hideCtxMenu();
    });
    ctxMenu.appendChild(pasteBtn);
  }

  // Don't show an empty menu (iOS without selection has nothing to offer).
  if (ctxMenu.childElementCount === 0) {
    return;
  }

  // Make it visible (so it has measurable dimensions) then clamp it
  // inside the viewport, so it never opens off-screen near the right or
  // bottom edge. position:fixed means x/y are already viewport
  // coordinates. Setting left/top after adding the class is flash-free:
  // it is all one synchronous task, so the browser paints only the
  // clamped position.
  ctxMenu.classList.add("visible");
  const margin = 8;
  const left = Math.max(margin, Math.min(x, window.innerWidth - ctxMenu.offsetWidth - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - ctxMenu.offsetHeight - margin));
  ctxMenu.style.left = `${left}px`;
  ctxMenu.style.top = `${top}px`;
}

export function mount(root: HTMLElement, opts: MountOptions = {}): TerminalUI {
  const wsPath = opts.wsPath ?? DEFAULT_WS_PATH;
  const fontReady = opts.fontReady ?? DEFAULT_FONT_READY;

  // --- Build the terminal subtree inside the host-provided root ---
  const tpl = document.createElement("template");
  tpl.innerHTML = TERMINAL_TEMPLATE;
  root.replaceChildren(tpl.content);

  // --- DOM refs (picked from the just-built subtree by class) ---
  termWrap = pick(root, ".term");
  outputEl = pick(root, ".term-output");
  input = pick(root, ".term-input") as HTMLTextAreaElement;
  const compositionViewEl = pick(root, ".composition-view");
  ctxMenu = pick(root, ".ctx-menu");
  const banner = pick(root, ".conn-banner");
  const toolbar = pick(root, ".key-toolbar");

  isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // markReady fires once: when the first screen frame has rendered AND the web
  // font is loaded. It tells the status banner the initial load is over (so it
  // may show reconnect state from here on) and fades out the consumer's
  // loading overlay if one was passed.
  let ready = false;
  let firstFrameRendered = false;
  let overlayDismissed = false;
  // Fade out and remove the consumer-owned loading overlay (if one was passed).
  // Extracted from markReady() so status.ts can also drive it via its give-up
  // signal: on a socket that never connects no first screen frame ever arrives,
  // so markReady never runs and nothing else would remove the opaque
  // z-index:200 overlay -- it would occlude the "Offline" banner forever.
  // status fires its onGiveUp on EVERY post-limit unloaded close against an
  // unbounded reconnect loop, so the overlayDismissed one-shot guard makes the
  // fade/remove and its transitionend listener + fallback timer register exactly
  // once; later calls early-return rather than piling listeners and timers onto
  // the (soon-detached) overlay node.
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
    // transitionend fires on the consumer-owned fade, but their overlay CSS may have
    // no opacity transition (or it can be interrupted): then transitionend never fires
    // and the now opacity:0 overlay -- still inset:0 / z-index:200 with no
    // pointer-events:none in the reference scaffold -- keeps swallowing every tap and
    // click over the terminal. Remove on a bounded fallback too.
    ld.addEventListener("transitionend", removeOverlay, { once: true });
    window.setTimeout(removeOverlay, 1500);
  }
  function markReady(): void {
    if (ready) {
      return;
    }
    ready = true;
    status.setLoaded();
    dismissLoadingOverlay();
  }

  // --- Initialize layers ---
  status.init({ banner, onGiveUp: dismissLoadingOverlay });

  render.init({
    output: outputEl,
    termWrap,
    // Keep the helper textarea + IME composition view glued to the
    // cursor on every render so iOS keyboard focus and IME candidate
    // popups target the right area. Also re-render the predicted-cursor
    // overlay so its position stays consistent with the just-drawn
    // server cursor.
    onCursorMove: () => {
      composition.positionCompositionView();
      pushPredictedCursor();
    },
  });
  render.updateFontMetrics();

  // predict redraws on every change to its predicted-cursor state.
  predict.subscribe(pushPredictedCursor);

  composition.init({
    textarea: input,
    compositionView: compositionViewEl,
    getCursorPx: render.getCursorPx,
    send,
  });

  scroll.init({
    scrollEl: termWrap,
    onUserScrollChange(scrolledUp) {
      // Toggle .scrolled-up on the toolbar so CSS can show/hide the
      // scroll-bottom button and grow the pill vertically.
      toolbar.classList.toggle("scrolled-up", scrolledUp);
    },
  });

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
        predict.onScreenFrame(msg.cursor[0], msg.cursor[1], msg.cursorHidden);
      } else if (msg.type === "scroll") {
        render.handleScroll(msg);
      } else if (msg.type === "title") {
        document.title = msg.title;
      } else if (msg.type === "modes") {
        render.updateReverseVideo();
      } else if (msg.type === "clipboard") {
        // An app copied via OSC 52; mirror it to the system clipboard. This is
        // an async push (not a user gesture), so Safari/Firefox may reject
        // writeText — copyToClipboard surfaces that as a "Copy failed" toast.
        copyToClipboard(msg.text);
      }
    },
    onOpen() {
      status.open();
      // Do NOT call render.resetScreen() here. resetScreen flips the
      // firstScreen flag, which causes the next screen frame to wipe
      // the entire .term-output DOM (including all scrollback above
      // the live viewport). On reconnect (e.g. iPad screen dim/wake)
      // that destroys history the user could otherwise scroll up to.
      // The server forces a full repaint via builder.Reset() on resume,
      // which the client renders as row replacements within the live
      // zone — scrollback DOM stays intact. The very first onOpen of
      // page load still wipes correctly because firstScreen defaults
      // to true at module load (only resetScrollback + resetScreen on
      // onServerRestart explicitly trigger a full reset).
      wsOpen = true;
      maybeSendFirstResize();
    },
    onConnecting() {
      status.reconnecting();
    },
    onClose() {
      status.closed();
    },
    onOutboxFull() {
      // The user kept typing through a long disconnect and we've
      // capped the buffer. Surface visibly so they don't keep typing
      // into the void.
      status.closed();
    },
    onServerRestart() {
      // Wipe the now-stale scrollback DOM and the live viewport so the
      // user doesn't see ghost input from the previous server boot;
      // the next screen frame from the fresh server populates the
      // viewport. Banner explains why.
      render.resetScrollback();
      render.resetScreen();
      predict.reset();
      status.restarted();
    },
  });

  // --- Input handling ---
  resetToPlaceholder(input);

  input.addEventListener("input", (e: Event) => {
    // While IME composition is in progress, the textarea fires `input`
    // events for each composing keystroke. composition.ts owns sending
    // the final composed text in compositionend; we must NOT send the
    // intermediate input value (it would duplicate the composition).
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
      // Deletion is handled by keydown — just re-pad the placeholder so iOS
      // key-repeat keeps firing (it needs content to delete).
      resetToPlaceholder(input);
      return;
    } else if (typeof ev.data === "string" && ev.data.length > 0) {
      // insertText / insertFromPaste / insertReplacementText etc. The
      // `data` property carries exactly the new content; using it
      // sidesteps having to diff against the placeholder.
      //
      // iOS Safari can deliver U+00A0 (NBSP) instead of U+0020 for the
      // spacebar/autocorrect. Normalize so the shell receives an honest
      // space byte. (Native paste is bracketed in composition.ts's paste
      // handler before this fires; the insertFromPaste data here is a
      // fallback for browsers that don't raise a separate paste event.)
      if (inputType === "insertFromPaste") {
        // Paste arriving through `input` without a preceding `paste` event
        // (composition.ts's onPaste handles + preventDefaults the normal
        // case). Bracket + sanitize it exactly like the Ctrl+Shift+V,
        // context-menu Paste, and composition.onPaste paths so embedded
        // newlines / control bytes arrive as an inert bracketed paste
        // instead of executing as typed shell commands (paste-jacking).
        send(bracketTextForPaste(prepareTextForTerminal(ev.data)));
      } else {
        sendTyped(ev.data);
      }
    } else {
      // Fallback: anything in the textarea past the placeholder is new
      // content. Covers browsers that don't populate inputType / data
      // (older WebKit).
      const v = input.value;
      if (v.length > INPUT_PLACEHOLDER.length && v.startsWith(INPUT_PLACEHOLDER)) {
        sendTyped(v.slice(INPUT_PLACEHOLDER.length));
      } else if (v !== INPUT_PLACEHOLDER && v.length > 0) {
        sendTyped(v);
      }
    }
    resetToPlaceholder(input);
  });

  // Focus state on the terminal element, for CSS targeting (e.g. dimming
  // the cursor when focus is elsewhere). Pattern from xterm.js.
  input.addEventListener("focus", () => {
    termWrap.classList.add("focus");
  });
  input.addEventListener("blur", () => {
    // Restore the placeholder so the held-Backspace iOS path stays
    // primed for the next focus. Also clears any leftover screen-reader
    // text (xterm.js convention).
    resetToPlaceholder(input);
    termWrap.classList.remove("focus");
  });

  // The textarea is the single keyboard target (desktop and touch alike);
  // .term-output is display-only and never focused.
  input.addEventListener("keydown", handleKeydown);

  // --- Focus strategy ---
  // One element, one job. .term-output is display + native selection only
  // and is NEVER focused; the textarea owns the keyboard, the local typing
  // buffer, and IME. Because the editable element is never the scroll
  // content, the first touch-drag scrolls instead of placing a caret and a
  // tap on a sparse screen still lands on the full-viewport scroll surface;
  // because the display is not re-rendered as editable, a selection
  // survives a redraw. Typed text, paste, and IME all arrive through the
  // textarea's own input / paste / composition listeners (the latter two
  // live in composition.ts).

  // Touch tap: focus the hidden textarea to trigger iOS keyboard.
  // On iOS Safari, focusing a hidden textarea from a `click` handler
  // only opens the virtual keyboard if the click event arrives within
  // iOS's user-gesture window. During heavy DOM mutations (streaming),
  // the click event timing slips past that window — symptom: "while the
  // agent is thinking I can't open the keyboard; only when the turn ends
  // does tap work." `pointerup` fires synchronously with the user's
  // finger lift and captures the gesture before iOS layout work can defer
  // it, so focus() lands while the gesture is still "live". We track the
  // start position from pointerdown and only treat the pointerup as a tap
  // (vs scroll) when total movement is sub-threshold.
  termWrap.addEventListener(
    "pointerdown",
    (e) => {
      lastPointerType = e.pointerType;
      pointerDownX = e.clientX;
      pointerDownY = e.clientY;
    },
    { passive: true },
  );
  termWrap.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType !== "touch") {
        return; // mouse/trackpad handled by the click listener below
      }
      // A tap on a terminal link is opened by the click listener below; don't
      // also focus the textarea (which pops the iOS soft keyboard) on the way.
      if ((e.target as HTMLElement).closest(".term-link")) {
        return;
      }
      const dx = Math.abs(e.clientX - pointerDownX);
      const dy = Math.abs(e.clientY - pointerDownY);
      if (dx > TAP_MOVEMENT_PX || dy > TAP_MOVEMENT_PX) {
        return; // user was scrolling, not tapping
      }
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) {
        return; // preserve selection (long-tap selected text)
      }
      // Synchronous focus inside pointerup keeps us inside iOS's
      // user-gesture window even when the streaming flush queue is busy.
      focusTerminal();
    },
    { passive: true },
  );
  // After a touch tap, iOS/WebKit dispatches a synthetic `mousedown` (following
  // the `pointerup` above). Its default action moves focus to the nearest
  // focusable ancestor of the tap point — but the input-model contract keeps
  // `.term-output` and `.term` deliberately non-focusable (display-only) and the
  // hidden textarea is `pointer-events: none`, so the tap never lands on a
  // focusable node. With nothing focusable under the tap, that default blurs the
  // textarea we just focused in `pointerup`, so iOS immediately dismisses the
  // soft keyboard the tap had only just opened — the "keyboard flashes open then
  // instantly closes" symptom on touch. Cancelling the synthetic mousedown's
  // default keeps focus on the textarea, so the keyboard stays up. This is the
  // xterm.js focus-preservation pattern, scoped to touch: a real mouse mousedown
  // must keep its default so desktop drag-to-select text still works, and iOS
  // text selection is long-press-driven (not this tap mousedown), so it is
  // unaffected. Not passive — preventDefault must take effect.
  termWrap.addEventListener("mousedown", (e) => {
    if (lastPointerType === "touch") {
      e.preventDefault();
    }
  });
  termWrap.addEventListener("click", (e) => {
    // Terminal links: URLs rendered by the engine are wrapped in
    // <a class="term-link" target="_blank" rel="noopener noreferrer">. The
    // output is display-only (never contenteditable -- see the input-model
    // contract), so intercept the click to open with explicit
    // noopener/noreferrer and to keep the focus handler below from running
    // on a link tap.
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(".term-link");
    if (link) {
      e.preventDefault();
      window.open(link.href, "_blank", "noopener,noreferrer");
      return;
    }

    if (lastPointerType === "touch") {
      // Touch path is handled by pointerup above. The click listener
      // is kept so non-pointer-event environments (very old iOS
      // builds without PointerEvent support) still get a focus hook.
      return;
    }
    // Mouse/trackpad: a plain click focuses the textarea so the user can
    // type. Never steal focus mid-selection though — a drag-select ends
    // with a click, and grabbing focus would collapse the selection the
    // user just made and still wants to copy.
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) {
      return;
    }
    focusTerminal();
  });

  // --- Viewport ---
  // Centralized handling of iOS keyboard, window resize, and font-load
  // reflows. Whenever the viewport settles, font metrics are remeasured
  // and a resize is sent to the server. Snap-back-to-bottom (if the user
  // was at the bottom before the transition) is handled inside viewport.ts.
  viewport.init({
    termWrap,
    onSettled() {
      render.updateFontMetrics();
      // Only send resize if fonts are loaded — otherwise we'd send the
      // wrong size (fallback font metrics) which causes the snap.
      if (fontsLoaded) {
        connection.sendResize();
      }
      composition.positionCompositionView();
      const sz = render.computeSize();
      predict.setDimensions(sz.cols, sz.rows);
    },
  });

  // Only wait for the Regular weight — it determines cell size.
  // Bold/Italic load lazily when first used; style pop is barely noticeable.
  // A missing/slow font, or a malformed `fontReady` (FontFaceSet.load can throw
  // synchronously on a bad shorthand), must NOT leave the terminal permanently
  // unsized: degrade to fallback-font metrics so the first resize still fires
  // and the loading overlay still dismisses.
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
        console.warn(
          `web-terminal-ui: web font ${fontReady} failed to load; using fallback metrics`,
          err,
        );
        onFontSettled();
      });
  } catch (err) {
    console.warn(`web-terminal-ui: invalid fontReady ${fontReady}; using fallback metrics`, err);
    onFontSettled();
  }

  // Connect immediately — the WS open triggers maybeSendFirstResize.
  render.updateFontMetrics();
  composition.positionCompositionView();
  connection.connect();
  focusTerminal();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      connection.reconnectNow();
      focusTerminal();
    }
  });
  window.addEventListener("pageshow", () => {
    connection.reconnectNow();
    focusTerminal();
  });
  // Network came back (cellular↔wifi handoff, tunnel reconnect): re-establish
  // at once rather than waiting out the reconnect backoff. reconnectNow tears
  // down any zombie socket first, and resume-by-index backfills what was missed.
  window.addEventListener("online", () => {
    connection.reconnectNow();
  });

  // --- Scroll-to-bottom (inside toolbar grid) ---
  const scrollBtn = pick(root, ".kb-scroll-bottom");
  // pointerdown (like the other toolbar keys) so touch devices enter
  // :active and show press feedback; preventDefault keeps focus on the
  // terminal. click is kept for keyboard activation of the desktop FAB.
  // scrollToBottom() is idempotent, so the pointerdown+click pair on a
  // mouse press is harmless.
  scrollBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    scroll.scrollToBottom();
  });
  scrollBtn.addEventListener("click", () => {
    scroll.scrollToBottom();
  });

  // --- Context menu ---
  termWrap.addEventListener("contextmenu", (e: MouseEvent) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY);
  });

  // Long-press to trigger the same menu on touch devices that don't
  // already provide a native callout. iOS Safari shows its own
  // long-press selection callout (Select / Copy / Paste) which fully
  // covers the use case AND would race our custom menu (two stacked
  // menus appear if the user long-presses an existing selection), so
  // we skip our timer on iOS and let the native callout do its job.
  // Android Chrome fires `contextmenu` on long-press release, but the
  // timer also helps on browsers that don't, e.g. some Windows touch
  // devices.
  if (!isIOS) {
    termWrap.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (e.touches.length !== 1) {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = 0;
          }
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- touches.length checked above
        const t = e.touches[0]!;
        longPressOrigin = { x: t.clientX, y: t.clientY };
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0;
          showCtxMenu(longPressOrigin.x, longPressOrigin.y);
        }, LONG_PRESS_MS);
      },
      { passive: true },
    );

    termWrap.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (!longPressTimer || e.touches.length !== 1) {
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- touches.length checked above
        const t = e.touches[0]!;
        const dx = t.clientX - longPressOrigin.x;
        const dy = t.clientY - longPressOrigin.y;
        if (dx * dx + dy * dy > LONG_PRESS_MOVE_THRESHOLD_PX * LONG_PRESS_MOVE_THRESHOLD_PX) {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      },
      { passive: true },
    );

    termWrap.addEventListener(
      "touchend",
      () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      },
      { passive: true },
    );

    termWrap.addEventListener(
      "touchcancel",
      () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      },
      { passive: true },
    );
  }

  document.addEventListener("click", () => {
    hideCtxMenu();
  });

  // Escape dismisses the context menu (keyboard parity with the outside-click
  // dismiss; the menu can be opened via the keyboard Menu key, which fires
  // `contextmenu`). Without this an AT/keyboard user has no keyboard way to close it.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ctxMenu.classList.contains("visible")) {
      hideCtxMenu();
    }
  });

  // --- Mobile key toolbar ---
  // The engine's keyboard.bindMobileToolbar wires the collapse toggle, the
  // arrows (DECCKM-aware — SS3 under application-cursor mode, matching
  // mapKeyboardEvent), Tab / Enter / Esc, and the sticky-Ctrl button on the
  // built toolbar. It returns the controller whose applyStickyCtrl the input
  // handler above applies to typed text. The no-transition priming below
  // stays local (a UI-specific concern).
  toolbarCtrl = keyboard.bindMobileToolbar({ toolbar, send });
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      toolbar.classList.remove("no-transition");
    }),
  );

  // --- Copy feedback toast ---
  document.addEventListener("copy", () => {
    status.toast("Copied");
  });

  return { focus: focusTerminal };
}
