// tabs/switcher.ts — the mobile bottom-switcher's chrome vocabulary: its
// templates, the swipe/flick gesture constants, and the closure-free row
// enter/leave animations. The gesture STATE MACHINE (axis lock, live preview,
// the release reel) stays in index.ts: it mutates drag state shared with the
// switch/expand paths, so extracting it would spread one interaction across two
// files. The desktop chrome vocabulary lives in strip.ts; the session model in
// model.ts.

import { chipContent } from "./strip.js";

// Swipe recognition on the mobile switcher bar: a mostly-horizontal drag past
// this distance switches; a near-stationary release is a tap (opens overview).
export const SWIPE_MIN_PX = 40;
// Movement (px) before an in-progress bar drag commits to a horizontal
// (tab-switch preview) or vertical (expand/collapse) axis.
export const AXIS_LOCK_PX = 8;
// Flick-to-commit thresholds (from @use-gesture's drag defaults, MIT): a release
// counts as a flick when the gesture was quick, fast, and travelled enough, so a
// short fast swipe commits the switch/expand even below the halfway distance.
export const SWIPE_VELOCITY = 0.5; // px/ms at release
export const SWIPE_DURATION = 250; // ms, whole-gesture cap for a flick
// If the finger paused longer than this before lifting, the release velocity is
// stale (pointerup usually repeats the last pointermove position -> reads ~0),
// so ignore it and commit by distance instead (@use-gesture issue #332).
export const VELOCITY_STALE_MS = 32;
// Live drag preview: while an open list is being swiped, it peeks in the swipe
// direction by this fraction of the finger's horizontal travel, capped at this
// many pixels — a hint of the coming rotation, not the full shift (the incoming
// row only appears on release, so a large move looked wrong). The release reel
// continues from wherever the peek left the rows.
export const PREVIEW_DRAG_RATIO = 0.1;
export const PREVIEW_PEEK_MAX = 10;

// Mobile bottom bar. One element, two parts stacked in a column: the always-
// visible bar row (active tab as a tap/swipe surface + keyboard + "+") on top,
// and a list of the OTHER tabs BELOW it. On swipe-up / tap the whole bar slides
// up and the list fills in beneath it (down to the safe area); swipe-down /
// tap collapses it back to the bottom. Selecting a listed tab swaps it into the
// active row. This replaces the old separate modal overview sheet ("one element"
// per the user): the bar itself lifts rather than opening a distinct surface.
// The bar is the FIRST child and the list the SECOND: the switcher is bottom-
// anchored, so a column with the list last grows the container upward, lifting
// the bar and revealing the list below it (DOM order = visual order top-to-bottom).
//   - .wt-switcher-current-wrap: the active-tab row — a select/swipe surface
//     (.wt-switcher-current with dot + label) plus a close (x) overlaid at the
//     right, mirroring the listed rows. No "n / m" counter: the list below is a
//     rotating circular queue, so an absolute position number is meaningless.
//   - The keyboard button (.wt-switcher-kb, opens the key grid above the bar,
//     only wired + shown when a keyboardToggle feature is provided) and the
//     accent "+" (.wt-switcher-new, spawns a terminal) are appended to the bar
//     row from the shared factories in index.ts (see makeKbButton / makeNewButton).
const CURRENT_CHIP = chipContent({
  dot: "wt-switcher-dot",
  label: "wt-switcher-label",
  close: "wt-switcher-current-close wt-btn",
});
export const SWITCHER_HTML = `
<div class="wt-switcher" role="group" aria-label="Terminal tabs">
  <div class="wt-switcher-bar">
    <div class="wt-switcher-current-wrap">
      <button type="button" class="wt-switcher-current" aria-haspopup="true" aria-expanded="false">
        <span class="wt-switcher-current-inner">${CURRENT_CHIP.dotLabel}</span>
      </button>
      ${CURRENT_CHIP.close}
    </div>
  </div>
  <ul class="wt-switcher-list" role="list"></ul>
</div>`;

// One row per OTHER tab in the expanded list: a stretched select target (dot +
// label) with the close (x) laid inside it at the right (two buttons can't nest,
// so the x is a sibling overlapping the select's reserved right padding).
const ROW_CHIP = chipContent({
  dot: "wt-switcher-row-dot",
  label: "wt-switcher-row-label",
  close: "wt-switcher-row-close wt-btn",
});
export const SWITCHER_ROW_HTML = `
<li class="wt-switcher-row">
  <button type="button" class="wt-switcher-row-select">${ROW_CHIP.dotLabel}</button>
  ${ROW_CHIP.close}
</li>`;

// animateRowIn / animateRowOut give a listed tab an enter / leave motion:
// the row's own max-height grows from 0 (fading in) on add, and collapses
// to 0 (fading out, then removed) on close. The flex list's height follows
// the row, so adding/closing a tab animates the tray height rather than
// snapping. Inline-driven (cleared when done); the caller gates motion.
const ROW_ANIM_MS = 220;
const ROW_ANIM_EASE = "cubic-bezier(0.2, 0, 0, 1)";

export function animateRowIn(row: HTMLElement): void {
  const h = row.getBoundingClientRect().height;
  if (h <= 0) {
    return;
  }
  row.style.overflow = "hidden";
  row.style.transition = "none";
  row.style.maxHeight = "0";
  row.style.opacity = "0";
  requestAnimationFrame(() => {
    row.style.transition = `max-height ${String(ROW_ANIM_MS)}ms ${ROW_ANIM_EASE}, opacity ${String(ROW_ANIM_MS)}ms ${ROW_ANIM_EASE}`;
    row.style.maxHeight = `${String(Math.ceil(h))}px`;
    row.style.opacity = "1";
  });
  window.setTimeout(() => {
    row.style.transition = "";
    row.style.maxHeight = "";
    row.style.opacity = "";
    row.style.overflow = "";
  }, ROW_ANIM_MS + 60);
}

export function animateRowOut(row: HTMLElement): void {
  const h = row.getBoundingClientRect().height;
  row.style.overflow = "hidden";
  row.style.pointerEvents = "none";
  row.style.transition = "none";
  row.style.maxHeight = `${String(Math.ceil(h))}px`;
  row.style.opacity = "1";
  requestAnimationFrame(() => {
    row.style.transition = `max-height ${String(ROW_ANIM_MS)}ms ${ROW_ANIM_EASE}, opacity ${String(ROW_ANIM_MS)}ms ${ROW_ANIM_EASE}`;
    row.style.maxHeight = "0";
    row.style.opacity = "0";
  });
  window.setTimeout(() => {
    row.remove();
  }, ROW_ANIM_MS + 60);
}
