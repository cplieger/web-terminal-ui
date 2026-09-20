// IME / composition support, after xterm.js's CompositionHelper: the browser
// fires compositionstart, compositionupdate(s) and compositionend while an IME
// (CJK, Vietnamese, dictation, an autocorrect bar) is active, and without a
// handler the user sees nothing until the phrase is finalised. The in-progress
// text is mirrored into a floating view at the cursor; the textarea is moved
// there too because the IME's candidate popup anchors on it. compositionend's
// `data` is unreliable on Chromium, so the textarea value is read one tick later.

import { resetToPlaceholder } from "./input-placeholder.js";

/** A composition that never ends would gate every later keystroke out, and it
 *  happens: Android Chrome with SwiftKey fires no compositionend until a word
 *  suggestion is tapped (crbug 446714223 is adjacent evidence). So the latch is
 *  read against a STALENESS clock refreshed by compositionupdate alone, never by
 *  `input` (in this failure the user IS typing). Five seconds is Slate's
 *  composition-gone-quiet bound; the residual risk is one duplicated character
 *  after a pause, against losing all input until an unrelated event fires. */
const COMPOSITION_IDLE_MS = 5000;

export interface CompositionOptions {
  textarea: HTMLTextAreaElement;
  compositionView: HTMLElement;
  getCursorPx: () => { left: number; top: number; cellH: number };
  send: (bytes: string) => void;
  /** The kernel's single bracketed-paste+normalize funnel; the native iOS-callout
   *  paste routes through it rather than re-composing the funnel here. */
  paste: (text: string) => void;
}

/** One pane's IME state: the latch every input listener gates on, the floating
 *  view, and the textarea placement. */
export interface Composition {
  /** True while an IME composition is in progress, reconciled first: a
   *  composition quiet for COMPOSITION_IDLE_MS is expired here. */
  isComposing(): boolean;
  /** The RAW latch: is a composition open at all, regardless of staleness. Read
   *  before `isComposing()` by the keydown guard, because keyCode 229 means "an
   *  IME claimed this key" only while a composition is genuinely open. */
  isCompositionOpen(): boolean;
  /** Abort any in-flight composition without sending, and clear the textarea.
   *  Also neutralizes a just-fired compositionend whose deferred send is still
   *  pending, so it cannot land on whoever is active after a switch. */
  cancelComposition(): void;
  /** Place the view and the textarea at the terminal cursor. */
  positionCompositionView(): void;
  /** Release the listeners and any pending send. */
  teardown(): void;
}

export function createComposition(opts: CompositionOptions): Composition {
  const { textarea, compositionView, getCursorPx, send, paste } = opts;
  let composing = false;
  let sendingComposition = false;
  let compositionStart = 0;
  let compositionSuffix = "";
  let lastCompositionActivity = 0;
  let torndown = false;

  function expireComposition(): void {
    composing = false;
    lastCompositionActivity = 0;
    compositionView.textContent = "";
    compositionView.classList.remove("active");
  }

  function isComposing(): boolean {
    if (sendingComposition) {
      return true;
    }
    if (!composing) {
      return false;
    }
    if (Date.now() - lastCompositionActivity <= COMPOSITION_IDLE_MS) {
      return true;
    }
    expireComposition();
    return false;
  }

  function cancelComposition(): void {
    composing = false;
    sendingComposition = false;
    lastCompositionActivity = 0;
    compositionView.textContent = "";
    compositionView.classList.remove("active");
    resetToPlaceholder(textarea);
  }

  function positionCompositionView(): void {
    const { left, top, cellH } = getCursorPx();
    compositionView.style.left = `${left}px`;
    compositionView.style.top = `${top}px`;
    compositionView.style.height = `${cellH}px`;
    compositionView.style.lineHeight = `${cellH}px`;
    // The textarea shares the view's content coordinates and .term is pinned to
    // the visual viewport, so this keeps the focused input at the VISIBLE cursor,
    // above the keyboard, where iOS wants it and does not scroll the page.
    textarea.style.left = `${left}px`;
    textarea.style.top = `${top}px`;
    textarea.style.height = `${cellH}px`;
  }

  function onStart(): void {
    composing = true;
    lastCompositionActivity = Date.now();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    compositionStart = Math.min(start, end);
    const compositionEnd = Math.max(start, end);
    compositionSuffix = textarea.value.substring(compositionEnd);
    compositionView.textContent = "";
    compositionView.classList.add("active");
    positionCompositionView();
  }

  function onUpdate(ev: CompositionEvent): void {
    lastCompositionActivity = Date.now();
    // LTR marks plus direction:rtl on the view show a long composition's tail
    // instead of clipping its start (xterm.js's pattern).
    compositionView.textContent = `\u200E${ev.data}\u200E`;
    positionCompositionView();
  }

  function onEnd(): void {
    compositionView.classList.remove("active");
    composing = false;
    lastCompositionActivity = 0;
    sendingComposition = true;
    const startSnapshot = compositionStart;
    const suffixSnapshot = compositionSuffix;
    setTimeout(() => {
      if (!sendingComposition || torndown) {
        return;
      }
      sendingComposition = false;
      const value = textarea.value;
      const valueEnd =
        suffixSnapshot.length > 0 && value.endsWith(suffixSnapshot)
          ? value.length - suffixSnapshot.length
          : value.length;
      const composed = value
        .substring(startSnapshot, Math.max(startSnapshot, valueEnd))
        .replace(/\u00A0/g, " ");
      if (composed.length > 0) {
        send(composed);
      }
      resetToPlaceholder(textarea);
    }, 0);
  }

  function onPaste(ev: ClipboardEvent): void {
    // iOS has no Ctrl+Shift+V; its callout menu fires this on the focused textarea.
    if (!ev.clipboardData) {
      return;
    }
    const raw = ev.clipboardData.getData("text/plain");
    if (raw === "") {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    paste(raw);
    resetToPlaceholder(textarea);
  }

  textarea.addEventListener("compositionstart", onStart);
  textarea.addEventListener("compositionupdate", onUpdate);
  textarea.addEventListener("compositionend", onEnd);
  textarea.addEventListener("paste", onPaste);

  return {
    isComposing,
    isCompositionOpen: () => composing || sendingComposition,
    cancelComposition,
    positionCompositionView,
    teardown() {
      torndown = true;
      cancelComposition();
      textarea.removeEventListener("compositionstart", onStart);
      textarea.removeEventListener("compositionupdate", onUpdate);
      textarea.removeEventListener("compositionend", onEnd);
      textarea.removeEventListener("paste", onPaste);
    },
  };
}
