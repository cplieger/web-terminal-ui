// A box that starts between device pixels draws every edge of a filled shape
// as a partial pixel. Layout decides where the box starts, and CSS cannot round
// a position to the device grid, so the correction is measured and written.

import { windowOf } from "../../kernel/realm.js";

/** CSS px that move `v` onto the nearest whole device pixel. `v` is read to
 *  1/1000 of a device pixel first: subtracting an applied offset leaves float
 *  residue, which would tip a half-pixel position either way. */
function toWholeDevicePx(v: number, dpr: number): number {
  const device = Math.round(v * dpr * 1000) / 1000;
  return (Math.round(device) - device) / dpr;
}

/** Keeps `el`'s box on whole device pixels, moved by at most half of one
 *  through its `translate`, which it owns from then on. Re-measured when `el`
 *  or an ancestor up to `root` changes size and when the device pixel ratio
 *  changes; a move that resizes nothing on that chain is not followed.
 *  @returns the release, which stops following and keeps the last offset. */
export function snapToDevicePixels(el: SVGElement, root: HTMLElement): () => void {
  const win = windowOf(el.ownerDocument);
  let applied = { x: 0, y: 0 };
  const snap = (): void => {
    const box = el.getBoundingClientRect();
    const dpr = win.devicePixelRatio;
    const x = toWholeDevicePx(box.left - applied.x, dpr);
    const y = toWholeDevicePx(box.top - applied.y, dpr);
    applied = { x, y };
    el.style.translate = x === 0 && y === 0 ? "" : `${String(x)}px ${String(y)}px`;
  };

  const resize = new win.ResizeObserver(snap);
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    resize.observe(node);
    if (node === root) {
      break;
    }
  }
  // A ratio change resizes nothing in CSS px, and each query matches one ratio.
  let ratio: MediaQueryList | undefined;
  const onRatio = (): void => {
    watchRatio();
    snap();
  };
  function watchRatio(): void {
    ratio?.removeEventListener("change", onRatio);
    ratio = win.matchMedia(`(resolution: ${String(win.devicePixelRatio)}dppx)`);
    ratio.addEventListener("change", onRatio);
  }
  watchRatio();

  return () => {
    resize.disconnect();
    ratio?.removeEventListener("change", onRatio);
  };
}
