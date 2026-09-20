// Optical centring for the chip labels, MEASURED in the engine: flex centring
// centres the LINE BOX, whose font reaches further above the baseline than below,
// so text sits low, and the correction is the gap from the box's centre to the cap
// band's. Measured because engines round ascent and descent to whole CSS pixels
// before building the line box, differently per engine and platform.
import { windowOf } from "../../kernel/realm.js";
import { fromHTML } from "../dom.js";

/** Ink extents are measured at this size and scaled back to em: WebKit and Blink
 *  quantise canvas TextMetrics ink values to whole pixels, which at 13px leaves
 *  4% of error in a number the correction halves. At 400px the same quantisation
 *  is worth 0.00125em. */
const REF_PX = 400;

/** Marks the deepest element of a probe chain — the one whose resolved font is
 *  the thing being measured. */
const PROBE_CLASS = "wt-ink-probe";

/** Cap ink, x-height ink and descender ink in one string, so the DOM probe's
 *  line box is the one a real mixed-case title produces. */
const PROBE_TEXT = "Hxp";
/** Class chains that resolve each site's label font. Deliberately the shortest
 *  chain that carries the font-size (`.wt-tab` and `.wt-switcher-current`) and
 *  not the real ancestry: `.wt-switcher` is `display: none` off a coarse pointer
 *  and `.wt-tab-bar` is `display: none` on a narrow one, so a probe reproducing
 *  the full chain would measure zeros in exactly one of the two layouts. */
const STRIP_PROBE = `<div class="wt-tab"><span class="wt-tab-label ${PROBE_CLASS}">${PROBE_TEXT}</span></div>`;
const SWITCHER_PROBE = `<div class="wt-switcher-current"><span class="wt-switcher-label ${PROBE_CLASS}">${PROBE_TEXT}</span></div>`;

/** What an engine and a font report about one label's typography. */
export interface InkMetrics {
  /** The line box the engine produced for this font at this size. */
  readonly fontBoxPx: number;
  /** Baseline offset from the line box's over edge. */
  readonly baselinePx: number;
  /** Cap ink above the baseline, em. */
  readonly capInkEm: number;
  readonly fontSizePx: number;
}

/** How far a label's visible ink sits BELOW its line box's centre, where
 *  "visible ink" is the cap band (cap top to baseline). Positive is the normal
 *  case (ink low), and the CSS lifts the box by exactly this much.
 *
 *  Descender ink is deliberately NOT part of the band; see the header. */
export function inkShiftPx(m: InkMetrics): number {
  const capCentre = m.baselinePx - (m.capInkEm * m.fontSizePx) / 2;
  return capCentre - m.fontBoxPx / 2;
}

// One measuring canvas per document: a canvas resolves font families against
// its own document's faces, so an outer canvas would not see a face the terminal's
// document loaded.
const canvases = new WeakMap<Document, CanvasRenderingContext2D | null>();

function canvas2d(doc: Document): CanvasRenderingContext2D | null {
  let ctx = canvases.get(doc);
  if (ctx === undefined) {
    ctx = doc.createElement("canvas").getContext("2d");
    canvases.set(doc, ctx);
  }
  return ctx;
}

/** The font's own cap ink, in em. Canvas rather than the DOM because only
 *  TextMetrics reports where the glyphs' ink actually starts and stops; a DOM
 *  rect only ever reports the box around it. */
function inkExtents(doc: Document, font: string): Pick<InkMetrics, "capInkEm"> | null {
  const ctx = canvas2d(doc);
  if (!ctx) {
    return null;
  }
  ctx.font = font;
  const capInk = ctx.measureText("H").actualBoundingBoxAscent;
  if (!(capInk > 0)) {
    return null;
  }
  return { capInkEm: capInk / REF_PX };
}

/** The engine's line box and baseline for a laid-out element's own font. The
 *  baseline is read off a zero-height inline-block, whose bottom margin edge
 *  sits ON the baseline by definition — the only thing in the DOM that reports
 *  a baseline position. */
function lineBox(label: HTMLElement): Pick<InkMetrics, "fontBoxPx" | "baselinePx"> | null {
  const doc = label.ownerDocument;
  const line = doc.createElement("span");
  line.style.position = "absolute";
  line.style.whiteSpace = "pre";
  line.style.font = "inherit";
  line.textContent = PROBE_TEXT;
  const strut = doc.createElement("span");
  strut.style.display = "inline-block";
  strut.style.width = "0";
  strut.style.height = "0";
  line.appendChild(strut);
  label.appendChild(line);
  const box = line.getBoundingClientRect();
  const baselinePx = strut.getBoundingClientRect().bottom - box.top;
  line.remove();
  if (!(box.height > 0) || !Number.isFinite(baselinePx)) {
    return null;
  }
  return { fontBoxPx: box.height, baselinePx };
}

/** Measures one site and returns its shift plus the font signature it belongs
 *  to; null when the resolved font is unchanged since `cached` or the site
 *  cannot be measured (no layout, no canvas, a display: none probe), and callers
 *  then leave the CSS default in place. The probe lives only for this
 *  synchronous call: a permanent hidden one would be a second `.wt-tab` inside
 *  the root that every `querySelectorAll(".wt-tab")` counts. */
function measureSite(
  varRoot: HTMLElement,
  probeHTML: string,
  cached: string | undefined,
): { shiftPx: number; signature: string } | null {
  const doc = varRoot.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.position = "absolute";
  wrap.style.top = "0";
  wrap.style.left = "0";
  wrap.style.visibility = "hidden";
  wrap.style.pointerEvents = "none";
  wrap.appendChild(fromHTML(doc, probeHTML));
  varRoot.appendChild(wrap);
  try {
    const label = wrap.querySelector<HTMLElement>(`.${PROBE_CLASS}`);
    if (!label) {
      return null;
    }
    const cs = windowOf(doc).getComputedStyle(label);
    const signature = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (signature === cached) {
      return null;
    }
    const fontSizePx = Number.parseFloat(cs.fontSize);
    if (!(fontSizePx > 0)) {
      return null;
    }
    const ink = inkExtents(doc, `${cs.fontStyle} ${cs.fontWeight} ${REF_PX}px ${cs.fontFamily}`);
    const box = lineBox(label);
    if (!ink || !box) {
      return null;
    }
    const shiftPx = inkShiftPx({ ...box, ...ink, fontSizePx });
    if (!Number.isFinite(shiftPx)) {
      return null;
    }
    return { shiftPx, signature };
  } finally {
    wrap.remove();
  }
}

/** The element a measured shift is written to, and the probe that resolves its
 *  font. --label-ink-shift is scoped per host rather than set once on the root
 *  because the two label sizes need two different pixel values, and every label
 *  inside a host shares one size. */
interface Site {
  readonly host: HTMLElement;
  readonly probeHTML: string;
}

/** Writes a measured --label-ink-shift onto the tab strip and the mobile
 *  switcher, and keeps it current. A font load or failure FORCES a re-measure:
 *  the first pass can run inside `font-display: block` on the fallback's line
 *  box, and computed style reports the DECLARED font-family list either way, so
 *  a cached signature would pin the fallback's shift for good. A resize keeps
 *  the signature check (rem sizes move with Safari's per-site zoom, but most
 *  resizes change nothing) and costs one computed-style read per site.
 *  @returns teardown that drops the listeners and the written properties. */
export function centreChipLabels(
  varRoot: HTMLElement,
  hosts: { readonly strip: HTMLElement; readonly switcher: HTMLElement },
): () => void {
  const sites: readonly Site[] = [
    { host: hosts.strip, probeHTML: STRIP_PROBE },
    { host: hosts.switcher, probeHTML: SWITCHER_PROBE },
  ];
  const measured = new WeakMap<HTMLElement, string>();
  let disposed = false;

  const remeasure = (force: boolean): void => {
    if (disposed) {
      return;
    }
    for (const site of sites) {
      const result = measureSite(
        varRoot,
        site.probeHTML,
        force ? undefined : measured.get(site.host),
      );
      if (!result) {
        continue;
      }
      site.host.style.setProperty("--label-ink-shift", `${result.shiftPx.toFixed(3)}px`);
      measured.set(site.host, result.signature);
    }
  };

  const onResize = (): void => {
    remeasure(false);
  };
  const onFontsDone = (): void => {
    remeasure(true);
  };

  remeasure(false);
  const doc = varRoot.ownerDocument;
  const win = windowOf(doc);
  // The DOM lib types document.fonts as always present; an engine without the CSS
  // Font Loading API ships no FontFaceSet at all, so the honest type is the
  // optional one.
  const fonts = doc.fonts as FontFaceSet | undefined;
  // `ready` settles the initial load (including a failed one); `loadingdone`
  // covers a face the host page adds afterwards, which `ready` never reports.
  void fonts?.ready.then(onFontsDone);
  fonts?.addEventListener("loadingdone", onFontsDone);
  win.addEventListener("resize", onResize);

  return () => {
    disposed = true;
    fonts?.removeEventListener("loadingdone", onFontsDone);
    win.removeEventListener("resize", onResize);
    for (const site of sites) {
      site.host.style.removeProperty("--label-ink-shift");
    }
  };
}
