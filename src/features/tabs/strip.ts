// tabs/strip.ts — the desktop tab strip's chrome vocabulary: the shared SVG
// glyphs, the one chip-content builder every chip site reuses, the strip tab
// template, the shared control markup factories, the status-dot painter, and
// the required-descendant picker. Everything here is closure-free markup +
// tiny pure helpers; element construction with event wiring stays in index.ts
// (it closes over the feature state). The mobile chrome templates live in
// switcher.ts; the session model in model.ts.

// The +/x/keyboard glyphs are inline SVG (not font glyphs) so they center
// exactly in their flex-centered buttons and stay symmetric regardless of the UI
// font's metrics. Each is defined ONCE here and shared by every chip site and
// control (rather than duplicated across the desktop and mobile markup).
const CLOSE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg>`;
const NEW_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
const KB_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M15 15 9.5 9.5M9.5 13V9.5H13"/></svg>`;
// Two-overlapping-windows glyph for the mobile switcher's dedicated open/close
// button: the browser-style "tab switcher" icon, more recognisable than the
// prior swap-arrows (which read like a keyboard Tab key). A latest-wins
// background-tab notification dot rides on it (see switchButtonHTML). Same
// viewBox + stroke=currentcolor treatment as the others.
const SWITCH_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="13" height="13" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3"/></svg>`;

// chipContent is the ONE builder for a tab chip's content — a status dot, a
// label, and a close (x) — shared by all three chip sites: the desktop strip
// (.wt-tab), the mobile active row (.wt-switcher-current), and each expanded
// mobile list row (.wt-switcher-row). Each site passes its OWN class set (never
// renamed) so every existing selector — and thus all CSS and all tests — still
// matches. The one structural difference is WHERE the close sits: the desktop
// chip nests it flat inside .wt-tab, while the two mobile chips place it as a
// sibling of the select/swipe button (a button can't nest in a button). So the
// builder returns two fragments — the dot+label pair and the close — that each
// site drops into its own structure.
export function chipContent(v: { dot: string; label: string; close: string; closeAttr?: string }): {
  dotLabel: string;
  close: string;
} {
  return {
    dotLabel:
      `<span class="${v.dot} wt-status-dot" aria-hidden="true"></span>` +
      `<span class="${v.label}"></span>`,
    close: `<button type="button" class="${v.close}" aria-label="Close terminal"${v.closeAttr ?? ""}>${CLOSE_SVG}</button>`,
  };
}

// The ONE "+" (new-terminal) and keyboard button markup factories, shared by
// the desktop strip and the mobile switcher — only the class set differs. These
// build the markup; element construction + event wiring live in makeNewButton /
// makeKbButton (index.ts), which close over create() and the key-grid toggle.
export function newButtonHTML(cls: string): string {
  return `<button type="button" class="${cls}" aria-label="New terminal">${NEW_SVG}</button>`;
}
export function kbButtonHTML(cls: string): string {
  return `<button type="button" class="${cls}" aria-label="Keyboard keys" aria-expanded="false" hidden>${KB_SVG}</button>`;
}
// The mobile switcher's dedicated open/close button. It toggles the tab list and
// carries a latest-wins notification dot (a child span) — amber when a background
// terminal needs input, green when a background turn finished — cleared when the
// list opens. Only the mobile switcher builds it (element construction + event
// wiring live in makeSwitchButton in index.ts); the desktop strip already shows
// every tab's own status dot, so it needs no aggregate cue.
export function switchButtonHTML(cls: string): string {
  return (
    `<button type="button" class="${cls}" aria-label="Open tab switcher">${SWITCH_SVG}` +
    `<span class="wt-status-dot wt-switcher-switch-dot" aria-hidden="true"></span></button>`
  );
}

// Desktop strip chip: dot + label + close all flat inside .wt-tab (the whole
// chip is the click/switch target; the close is a nested button). tabindex="-1"
// keeps the close out of the tab order.
const TAB_CHIP = chipContent({
  dot: "wt-tab-dot",
  label: "wt-tab-label",
  close: "wt-tab-close",
  closeAttr: ' tabindex="-1"',
});
export const TAB_HTML = `
<div class="wt-tab">
  ${TAB_CHIP.dotLabel}
  ${TAB_CHIP.close}
</div>`;

/** paintStatusDot applies a status dot's two orthogonal bits: data-status drives
 *  its appearance (idle / working / done / input / exited via CSS), and the
 *  .wt-reports class controls its visibility — the dot is hidden by default and
 *  shown only once the session has reported activity (OSC 9;4 progress or a
 *  classified OSC 9 notification), so a plain shell's tabs stay clean and
 *  label-only while an agent's light up. */
export function paintStatusDot(el: HTMLElement, status: string, reports: boolean): void {
  el.dataset["status"] = status || "idle";
  el.classList.toggle("wt-reports", reports);
}

/** pick returns a required descendant element or throws (static chrome only). */
export function pick(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`web-terminal-ui: tabs chrome missing ${selector}`);
  }
  return el;
}
