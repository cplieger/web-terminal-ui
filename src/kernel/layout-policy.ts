// The layout breakpoints, in ROOT pixels: root dimensions rather than viewport
// dimensions, so an embedded terminal in a narrow panel counts as narrow. For
// every full-page consumer root size equals viewport size, so the width half
// matches the old (max-width: 600px) media queries exactly.

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
