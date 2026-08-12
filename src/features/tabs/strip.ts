// tabs/strip.ts — the desktop tab strip's chrome vocabulary: the reorder-preview
// constants, the shared SVG glyphs, the one chip-content builder every chip site
// reuses, the strip tab template, the shared control markup factories, the
// status-dot painter, and the required-descendant picker. Everything here is
// closure-free markup + tiny pure helpers; element construction with event wiring
// stays in index.ts (it closes over the feature state). The mobile chrome
// templates and its gesture constants live in switcher.ts; the session model in
// model.ts.

// The status vocabulary itself (which statuses reveal a dot, and how each one is
// worded for a human) lives in the DOM-free model, so the painters here and the
// accessible names index.ts builds read one definition.
import { statusPhrase, statusRevealsDot } from "./model.js";

// --- Reorder preview -------------------------------------------------------
// Every chip in this strip is the same width (see .wt-tab in 30-tabs.css: a
// definite 300px with flex-grow 0, so a title changes the label and never the
// box). That is what makes a reorder hard to read: the chip a release would
// displace looks exactly like the one beside it, so the only thing that can say
// where the drag will land is the strip's own motion. These are the numbers that
// motion is spelled in — index.ts owns the mechanism, strip.ts owns the values,
// the same split switcher.ts keeps for the mobile swipe.

/** The quiet window (ms) that means the pointer has STOPPED. When it elapses with no
 *  movement, the strip opens the slot the pointer is over.
 *
 *  This is a rest detector, not a hold: it is re-armed by MOVEMENT, so it expires a
 *  rest window after the last movement rather than a fixed time after a decision.
 *  Sweeping the strip rearranges nothing; stopping is what commits.
 *
 *  **The floor is set by the drag loop, not by taste.** HTML5 drag-and-drop only
 *  guarantees a `dragover` every 350ms — the processing model runs on that cadence,
 *  not per mouse movement — so any window at or below it expires BETWEEN two events
 *  of a fast sweep, and the strip commits every slot the pointer crosses. That is
 *  exactly what 120ms did in production: a quick pass over five tabs moved all five.
 *  500ms clears the cadence with margin and is the reason this number is not smaller.
 *
 *  It costs a decisive user nothing, which is what makes the margin affordable: a
 *  release commits whatever slot is pending at once (flushRest), so the window is only
 *  ever felt by a pointer that has stopped and is waiting to see the gap open. */
export const REORDER_REST_MS = 500;

/** Movement (px) between two dragover events below which the pointer counts as still.
 *  A hand resting on a mouse is never perfectly still, and treating a 1px tremor as a
 *  sweep would keep pushing the commit out for as long as someone held the tab. */
export const REORDER_MOVE_EPS_PX = 3;

/** The one transition both preview stages use (the lean, and the slide that
 *  commits it).
 *
 *  --dur-standard and --ease-standard written out as literals. JS-driven motion
 *  in this package does not read tokens back out of the cascade; the switcher's
 *  release reel spells its own transition the same way. Keep the two in step: a
 *  token edit has to be mirrored here by hand.
 *
 *  The property is `translate`, NOT `transform`, and that is load-bearing rather
 *  than stylistic. Declarations from a running CSS animation out-rank every normal
 *  author declaration, inline style included, so a chip in the middle of
 *  `wt-slot-in` or `wt-tab-in` (both animate `transform: scale`) would ignore an
 *  inline `transform` outright and refuse to move. `translate` is a separate
 *  property that composes with `transform` instead of competing for it. */
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

// chipContent is the ONE builder for a tab chip's content — a status dot, a
// label, a determinate progress bar, and a close (x) — shared by all three chip
// sites: the desktop strip (.wt-tab), the mobile active row
// (.wt-switcher-current), and each expanded mobile list row (.wt-switcher-row).
// Each site passes its OWN class set (never renamed) so every existing selector
// — and thus all CSS and all tests — still matches. The one structural
// difference is WHERE the close sits: the desktop
// chip nests it flat inside .wt-tab, while the two mobile chips place it as a
// sibling of the select/swipe button (a button can't nest in a button). So the
// builder returns two fragments — the dot+label pair and the close — that each
// site drops into its own structure.
//
// The progress bar rides in the dotLabel fragment rather than taking a per-site
// class: it is positioned against the chip, not laid out in its flex row, so one
// class (.wt-progress-bar) styles it everywhere and every chip site gets it for
// free. It starts `hidden` — a session with no percentage must render NO bar
// (paintProgress).
export function chipContent(v: { dot: string; label: string; close: string; closeAttr?: string }): {
  dotLabel: string;
  close: string;
} {
  return {
    dotLabel:
      `<span class="${v.dot} wt-status-dot" aria-hidden="true"></span>` +
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

/** paintStatusDot applies a status dot's three orthogonal bits: data-status
 *  drives its appearance (idle / working / warning / failed / done / input /
 *  exited / crashed via CSS), the .wt-reports class controls its visibility, and
 *  `title` gives it a hover tooltip naming the state — the dots are decoration
 *  (aria-hidden), and a colour vocabulary that grew to eight states needs a way
 *  to be read rather than memorised. The tooltip wording is statusPhrase, the
 *  same source the tab's accessible name uses, so hover text and announced text
 *  cannot drift.
 *
 *  Visibility: the dot is hidden by default and shown once the session has
 *  reported activity (OSC 9;4 progress or a classified OSC 9 notification), so a
 *  plain shell's tabs stay clean and label-only while an agent's light up. The
 *  reveal is FLOORED by the status itself (statusRevealsDot) for the states that
 *  are self-evidently news — a plain shell that crashes never reported activity
 *  in its life, and hiding its red dot would hide the only signal it ever
 *  produced. */
export function paintStatusDot(el: HTMLElement, status: string, reports: boolean): void {
  const value = status || "idle";
  el.dataset["status"] = value;
  el.classList.toggle("wt-reports", reports || statusRevealsDot(value));
  el.title = statusPhrase(value);
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
