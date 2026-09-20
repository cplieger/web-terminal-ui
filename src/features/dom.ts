// Small shared helpers for features: building a chrome element from a static,
// trusted HTML string (icons, buttons) via a <template> clone, the same pattern
// the kernel uses for its core subtree, and the press wiring the bar buttons
// share. No interpolation ever passes through here, so it carries no injection
// surface.

import { windowOf } from "../kernel/realm.js";

/** Parse a static HTML string in `doc` and return its first element. */
export function fromHTML(doc: Document, html: string): HTMLElement {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html.trim();
  const el = tpl.content.firstElementChild;
  if (!(el instanceof windowOf(doc).HTMLElement)) {
    throw new Error("web-terminal-ui: fromHTML produced no element");
  }
  return el;
}

/** The press class the chrome buttons wired by holdFocusOnPress paint on
 *  themselves. Every `:active` press rule for such a button pairs with it (see
 *  the CSS contract test), because those buttons never enter `:active` in
 *  Firefox. */
export const PRESSED_CLASS = "wt-pressed";

/** Wire a chrome button that must NOT take the keyboard off the terminal, and
 *  paint its own press state because of it: cancelling pointerdown's default
 *  keeps the hidden textarea focused (iOS otherwise spends the first tap on a
 *  blur; a desktop parks the arrows on the button) and suppresses Firefox's
 *  `:active` (tied to the mousedown default, measured on Firefox 140), so the
 *  press class replaces it. The release listeners live on the window because
 *  `.wt-scroll-bottom` hides itself on press and never sees its own `pointerup`.
 *  Returns the release that unwires the button and ends a held press. */
export function holdFocusOnPress(btn: HTMLElement): () => void {
  const wired = new AbortController();
  let release: (() => void) | null = null;
  btn.addEventListener(
    "pointerdown",
    (e) => {
      e.preventDefault();
      if (e.button !== 0 || release !== null) {
        return;
      }
      btn.classList.add(PRESSED_CLASS);
      const held = new AbortController();
      release = () => {
        held.abort();
        release = null;
        btn.classList.remove(PRESSED_CLASS);
      };
      const end = (): void => {
        release?.();
      };
      const win = windowOf(btn.ownerDocument);
      win.addEventListener("pointerup", end, { signal: held.signal });
      win.addEventListener("pointercancel", end, { signal: held.signal });
      btn.addEventListener("pointerleave", end, { signal: held.signal });
    },
    { signal: wired.signal },
  );
  return () => {
    wired.abort();
    release?.();
  };
}
