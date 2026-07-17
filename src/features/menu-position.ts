// menu-position.ts — shared point-anchored placement for the fixed-position
// menus (the terminal context menu and the tab-strip menu), which previously
// carried two hand-synced copies of this exact clamp/flip math.
//
// position:fixed means x/y are viewport coordinates; the VISUAL viewport
// (when present) is the area above the on-screen keyboard, so clamping to it
// keeps a menu off the keyboard too.

/** Clamp margin from the visible viewport edges (px). */
const EDGE_MARGIN = 8;

/** Gap between the pointer and a flipped-above menu (px), so the menu is not
 *  hidden under the fingertip that long-pressed near the bottom edge. */
const FLIP_GAP = 16;

/** Place an already-visible `menu` at viewport point (x, y): open just below
 *  the point, flip above it when that would overflow the visible bottom, and
 *  clamp into the visual viewport on both axes. The menu is absolute-positioned
 *  against the terminal root (.wt-root), so the viewport-space result is
 *  rebased onto its offsetParent's box — placement is identical whether the
 *  root fills the viewport (wt-viewport) or an embedder's panel
 *  (wt-container). The menu must be measurable (rendered, not display:none)
 *  when called. */
export function placeMenuAt(menu: HTMLElement, x: number, y: number): void {
  const vv = window.visualViewport;
  const viewLeft = vv ? vv.offsetLeft : 0;
  const viewTop = vv ? vv.offsetTop : 0;
  const viewWidth = vv ? vv.width : window.innerWidth;
  const viewHeight = vv ? vv.height : window.innerHeight;
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  const left = Math.max(
    viewLeft + EDGE_MARGIN,
    Math.min(x, viewLeft + viewWidth - menuW - EDGE_MARGIN),
  );
  let top = y;
  if (y + menuH + EDGE_MARGIN > viewTop + viewHeight) {
    top = y - menuH - FLIP_GAP;
  }
  top = Math.max(viewTop + EDGE_MARGIN, Math.min(top, viewTop + viewHeight - menuH - EDGE_MARGIN));
  // Rebase from viewport coordinates onto the positioned ancestor's box: left/
  // top on an absolute element are offsets from the offsetParent's padding box,
  // which for all terminal chrome is .wt-root (getBoundingClientRect is its
  // viewport-space position; the root has no border, so border/padding offsets
  // do not enter). A missing offsetParent (display:none ancestor — the menu is
  // visible when called, so not in practice) falls back to (0,0) viewport base.
  const base = menu.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
  menu.style.left = `${String(Math.round(left - base.left))}px`;
  menu.style.top = `${String(Math.round(top - base.top))}px`;
}
