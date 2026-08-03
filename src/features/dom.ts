// Small shared helpers for features: building a chrome element from a static,
// trusted HTML string (icons, buttons) via a <template> clone, the same pattern
// the kernel uses for its core subtree, and the press wiring the bar buttons
// share. No interpolation ever passes through here, so it carries no injection
// surface.

/** Parse a static HTML string and return its first element. */
export function fromHTML(html: string): HTMLElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const el = tpl.content.firstElementChild;
  if (!(el instanceof HTMLElement)) {
    throw new Error("web-terminal-ui: fromHTML produced no element");
  }
  return el;
}

/** The press class the chrome buttons wired by holdFocusOnPress paint on
 *  themselves. Every `:active` press rule for such a button pairs with it (see
 *  the CSS contract test), because those buttons never enter `:active` in
 *  Firefox. */
export const PRESSED_CLASS = "wt-pressed";

/** holdFocusOnPress wires a chrome button that must NOT take the keyboard off
 *  the terminal, and paints its own press state because of it.
 *
 *  Focus: the hidden terminal textarea stays focused. A bar button needs no
 *  focus of its own, and letting the press shift focus makes iOS/iPadOS consume
 *  the FIRST tap to blur the input (so "+" only fired on the second tap — the
 *  reported double-tap), while on a desktop it parks the keyboard on the button,
 *  where the strip's own keydown handling eats arrows as "switch tab" and Delete
 *  as "close tab". Cancelling pointerdown's default prevents both.
 *
 *  Press feedback: cancelling that default is also what suppresses the browser's
 *  OWN activation state — Firefox ties `:active` to the mousedown default action,
 *  and preventDefault on pointerdown suppresses the compatibility mousedown
 *  entirely (measured on Firefox 140: no mousedown event, `matches(":active")`
 *  false, background unchanged for as long as the button is held; Chromium and
 *  WebKit still apply it). So these buttons — and ONLY these — carry the press
 *  class, and their CSS press rules match either. That is why the two jobs live
 *  in one helper: a caller that cancels the default without painting the class
 *  ships a control with no press feedback in one engine, which is exactly the
 *  defect this replaced.
 *
 *  The class is dropped on release, on cancel, and when the pointer leaves while
 *  held (a press dragged off the button is not an activation), mirroring what
 *  `:active` does on its own. A non-primary button press paints nothing, also
 *  matching it. The release listeners live on `window` for the life of the press
 *  (an `AbortController`, the pattern the switcher gesture uses) rather than on
 *  the button: `.wt-scroll-bottom` acts on the press and hides itself, so by the
 *  time the release lands the button is `display: none` and receives no
 *  `pointerup` at all — bound to the button, the class would stay painted and the
 *  control would come back already lit. */
export function holdFocusOnPress(btn: HTMLElement): void {
  let release: (() => void) | null = null;
  btn.addEventListener("pointerdown", (e) => {
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
    window.addEventListener("pointerup", end, { signal: held.signal });
    window.addEventListener("pointercancel", end, { signal: held.signal });
    btn.addEventListener("pointerleave", end, { signal: held.signal });
  });
}
