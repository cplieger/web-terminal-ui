// Closure-free markup and pure helpers only; element construction with event
// wiring stays in index.ts, where it closes over the feature state.

// The status vocabulary itself (which statuses reveal a dot, and how each one is
// worded for a human) lives in the DOM-free model, so the painters here and the
// accessible names index.ts builds read one definition.
import { activityPhrase, normalizeActivity, statusPhrase, statusRevealsDot } from "./model.js";

// Every chip in this strip is the same width (see .wt-tab in 30-tabs.css: a
// definite 300px with flex-grow 0, so a title changes the label and never the
// box). That is what makes a reorder hard to read: the chip a release would
// displace looks exactly like the one beside it, so the only thing that can say
// where the drag will land is the strip's own motion. These are the numbers that
// motion is spelled in — index.ts owns the mechanism, strip.ts owns the values,
// the same split switcher.ts keeps for the mobile swipe.

/** How long (ms) the pointer must have been un-moved before a stationary `dragover` is
 *  believed as "stopped". Small, because a `dragover` at an UNCHANGED position is
 *  positive evidence of rest (the drag loop keeps delivering events while the pointer
 *  is held still); this only filters the coincidence where one event of a sweep lands
 *  within REORDER_MOVE_EPS_PX of the previous one. */
export const REORDER_STILL_MS = 50;

/** Fallback guard (ms): commit the pending slot this long after the last MOVEMENT, for
 *  the case where `dragover` stops arriving altogether. Its floor is the platform's:
 *  HTML5 drag-and-drop only guarantees a `dragover` every 350ms, so a guard at or
 *  below it can expire BETWEEN two events of a fast sweep and commit every slot the
 *  pointer crosses (measured: at 120ms a quick pass over five tabs moved all five).
 *  Rest DETECTION is the stationary event above, so this net can stay slow. */
export const REORDER_REST_MS = 450;

/** Movement (px) between two dragover events below which the pointer counts as still.
 *  A hand resting on a mouse is never perfectly still, and treating a 1px tremor as a
 *  sweep would keep pushing the commit out for as long as someone held the tab. */
export const REORDER_MOVE_EPS_PX = 3;

/** The one transition both preview stages use (the lean, and the slide that
 *  commits it): --dur-standard and --ease-standard as literals, since JS-driven
 *  motion here reads no token back out of the cascade (mirror a token edit by
 *  hand). The property is `translate`, NOT `transform`: declarations from a
 *  running CSS animation out-rank inline style, so a chip mid `wt-slot-in` or
 *  `wt-tab-in` (both animate `transform: scale`) would ignore an inline
 *  `transform`; `translate` composes with it instead of competing for it. */
export const REORDER_SHIFT_TRANS = "translate 0.2s cubic-bezier(0.2, 0, 0, 1)";

/** When (ms after the slide starts) the inline transform and transition come off
 *  the chips and the stylesheet has them back.
 *
 *  A margin past the 200ms transition, not a race with its own end event: an
 *  interrupted transition fires no transitionend, and the strip must not be left
 *  holding inline styles because a second drag arrived mid-slide. Mirrors the
 *  switcher reel's 300ms net over a 250ms transition. */
export const REORDER_SETTLE_MS = 300;

/** How long (ms) the .wt-tab-slotted class stays on, one margin past the
 *  --dur-enter fade the stylesheet runs with it.
 *
 *  A timer rather than animationend for the same reason .wt-tab-enter uses one:
 *  the class must also come off when no animation ran at all — the animations
 *  feature is optional, reduced motion flattens it, and a consumer stylesheet can
 *  drop the rule. */
export const REORDER_SLOT_FADE_MS = 300;

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
// Two rectangles side by side, the same glyph whether the split is open or
// closed: the button's state is its aria-expanded, not its icon.
const SPLIT_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="8" height="14" rx="2"/><rect x="13" y="5" width="8" height="14" rx="2"/></svg>`;

/** The ONE builder for a tab chip's content (status dot, label, progress bar,
 *  close), shared by the strip chip, the mobile active row and each mobile list
 *  row. Two fragments, because the mobile chips place the close as a SIBLING of
 *  their button (a button cannot nest in a button). The bar starts `hidden` (no
 *  percentage renders no bar); the activity mark carries no `hidden`, since an
 *  element out of layout cannot animate into it, and its absence is the absence
 *  of `data-activity`, which the CSS answers by cancelling its footprint. */
export function chipContent(v: { dot: string; label: string; close: string; closeAttr?: string }): {
  dotLabel: string;
  close: string;
} {
  return {
    dotLabel:
      `<span class="${v.dot} wt-status-dot" aria-hidden="true"></span>` +
      `<span class="wt-activity-mark" aria-hidden="true"></span>` +
      `<span class="${v.label}"></span>` +
      `<span class="wt-progress-bar" aria-hidden="true" hidden></span>`,
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
/** The split-view toggle: a stable label with `aria-expanded` as its state, the
 *  keyboard button's pattern, so a screen reader hears the change on the focused
 *  button after a keyboard toggle. */
export function splitButtonHTML(cls: string): string {
  return `<button type="button" class="${cls}" aria-label="Split view" aria-expanded="false">${SPLIT_SVG}</button>`;
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

/** A status dot's three orthogonal bits: data-status drives its appearance, the
 *  .wt-reports class its visibility, and `title` a tooltip worded by statusPhrase,
 *  the source the tab's accessible name uses, so hover and announced text cannot
 *  drift. Hidden until the session reports activity, so a plain shell's tabs stay
 *  label-only; FLOORED by the status itself for the states that are news on their
 *  own, since a plain shell that crashes never reported activity in its life. */
export function paintStatusDot(el: HTMLElement, status: string, reports: boolean): void {
  const value = status || "idle";
  el.dataset["status"] = value;
  el.classList.toggle("wt-reports", reports || statusRevealsDot(value));
  el.title = statusPhrase(value);
}

/** The secondary mark's two bits: data-activity drives its appearance and `title`
 *  a tooltip worded by activityPhrase. No state REMOVES the attribute, which is
 *  what collapses the mark's footprint to zero. The reveal is the mark's OWN
 *  state, not the status dot's reportsActivity gate: a background run is a fact
 *  independent of whether the program ever spoke OSC 9. */
export function paintActivityMark(el: HTMLElement, state: string, count: number): void {
  const phrase = activityPhrase(state, count);
  if (phrase === "") {
    delete el.dataset["activity"];
    el.removeAttribute("title");
    return;
  }
  el.dataset["activity"] = normalizeActivity(state);
  el.title = phrase;
}

/** paintProgress renders one chip's determinate progress bar from a percentage.
 *
 *  An absent percentage (PROGRESS_ABSENT / any negative) renders NO bar: the
 *  element is `hidden` and its width is cleared, rather than left as a
 *  zero-width or empty bar that would read as "0%, stalled". The width is the
 *  only inline style — the percentage is data, and everything about how the bar
 *  looks stays in .wt-progress-bar. */
export function paintProgress(el: HTMLElement, progress: number): void {
  if (progress < 0) {
    el.hidden = true;
    el.style.removeProperty("width");
    return;
  }
  el.hidden = false;
  el.style.width = `${String(progress)}%`;
}

/** pick returns a required descendant element or throws (static chrome only). */
export function pick(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`web-terminal-ui: tabs chrome missing ${selector}`);
  }
  return el;
}
