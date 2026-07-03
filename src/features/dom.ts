// Small shared helper for features: build a chrome element from a static,
// trusted HTML string (icons, buttons) via a <template> clone, the same pattern
// the kernel uses for its core subtree. No interpolation ever passes through
// here, so it carries no injection surface.

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
