// The layout breakpoints, in ROOT pixels: root dimensions rather than viewport
// dimensions, so an embedded terminal in a narrow panel counts as narrow. For
// every full-page consumer root size equals viewport size, so the width half
// matches the old (max-width: 600px) media queries exactly.

import type { PaneSide } from "./types.js";

/** A root at or under this width is narrow (a portrait phone, a narrow panel). */
const NARROW_MAX_PX = 600;
/** A root at or under this height is narrow: a landscape phone (an iPhone 14 Pro
 *  Max is 932x430) is wider than NARROW_MAX_PX but still a phone in the hand,
 *  and the smallest iPad is 744 CSS px tall in landscape, so 500 separates the
 *  two with margin on both sides. */
const SHORT_MAX_PX = 500;

/** Whether a root of this size takes the compact (phone) layout. */
export function isNarrow(width: number, height: number): boolean {
  return width <= NARROW_MAX_PX || height <= SHORT_MAX_PX;
}

/** Whether an untyped caller's value names a pane side. */
export function isPaneSide(value: unknown): value is PaneSide {
  return value === "left" || value === "right";
}

/** The narrowest pane the split keeps: the narrowest common phone width. */
export const MIN_PANE_PX = 360;
/** The grid column between the two panes, showing the shell root's background. */
export const SPLIT_GUTTER_PX = 10;
/** The pane-row width two panes need: two minimum panes and the gutter. Under
 *  it the split buttons hide and an open split collapses to the selected pane. */
export const MIN_SPLIT_AREA_PX = 2 * MIN_PANE_PX + SPLIT_GUTTER_PX;

/** The EFFECTIVE left share a remembered `committed` share yields on a pane row
 *  `width` px wide: both panes are kept at or over MIN_PANE_PX without the
 *  remembered value being rewritten, the two bounds meet at 0.5 at exactly
 *  MIN_SPLIT_AREA_PX, and a narrower row (a collapsed split) reads 0.5. */
export function clampRatio(committed: number, width: number): number {
  if (width <= MIN_SPLIT_AREA_PX) {
    return 0.5;
  }
  const min = MIN_PANE_PX / (width - SPLIT_GUTTER_PX);
  return Math.min(Math.max(committed, min), 1 - min);
}
