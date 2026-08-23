// Optical centring for the three chip labels (desktop strip, mobile switcher
// chip, overview rows), measured in the engine instead of predicted from the
// font's tables.
//
// Flex centring centres a label's LINE BOX. A font's metrics box reaches much
// further above the baseline than below (the bundled Monaspace Neon NF: 0.995em
// over, 0.250em under), so the visible text sits low inside the box it is
// centred by, and the correction is the gap between the box's centre and the
// text's own.
//
// WHICH BAND is the text's own is the load-bearing decision, and the first
// version of this got it wrong. It centred cap-top-to-DESCENDER-bottom, which
// reserves descender room below the letters and reads high: measured on the real
// chip in Blink, the title's cap band sat 1.320px above the chip's centre while
// the status dot and the close glyph beside it sat at exactly 0.000px, and a
// title is judged against those two neighbours. So the band is cap-top to
// BASELINE — the visible mass of a UI label, and the same pair of edges CSS
// spells `text-box-edge: cap alphabetic`. Descenders overhang it deliberately;
// the label's `padding-block` (30-tabs.css) is the allowance that keeps them
// clear of `overflow: hidden`, so nothing is clipped by the choice.
//
// The correction is NOT a font-relative constant, which is what four earlier
// fixes assumed. Engines round the font's ascent and descent to whole CSS pixels
// before building the line box, so the ideal shift jumps whenever a size crosses
// a rounding boundary: 0.25em x 13 = 3.25 rounds to 3 (a 16px box) while
// 0.25em x 14 = 3.5 rounds to 4 (an 18px box), and the shift moves with it.
// Engines disagree with each other too (Gecko makes that same 14px box 17px, not
// 18px), and so do platforms within one engine: iOS resolves metrics through
// CoreText, Linux WebKit through FreeType, which is why the strip read correct
// in every local check and high on an iPad. Measured across 11-20px the cap-band
// shift sawtooths between about -0.010em and +0.028em — small, but still wider
// than the 0.33px error that was reported as a defect, so it stays measured.
//
// So nothing here predicts. Each measurement asks the engine for the line box
// and baseline it actually produced, asks the font for its actual cap ink, and
// writes the difference to --label-ink-shift as pixels. The CSS keeps an em
// default for the pre-measurement paint (see 00-tokens.css); this only ever
// narrows the error.
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

let ctx2d: CanvasRenderingContext2D | null | undefined;

function canvas2d(): CanvasRenderingContext2D | null {
  ctx2d ??= document.createElement("canvas").getContext("2d");
  return ctx2d;
}

/** The font's own cap ink, in em. Canvas rather than the DOM because only
 *  TextMetrics reports where the glyphs' ink actually starts and stops; a DOM
 *  rect only ever reports the box around it. */
function inkExtents(font: string): Pick<InkMetrics, "capInkEm"> | null {
  const ctx = canvas2d();
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
  const line = document.createElement("span");
  line.style.position = "absolute";
  line.style.whiteSpace = "pre";
  line.style.font = "inherit";
  line.textContent = PROBE_TEXT;
  const strut = document.createElement("span");
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
 *  to. Returns null when the resolved font is unchanged since `cached` (the
 *  resize path, which then does no ink or line-box work at all) and when the
 *  site cannot be measured at all (no layout, no canvas, a display: none
 *  probe) — callers leave the CSS default in place either way rather than
 *  writing a wrong number.
 *
 *  The probe lives only for the duration of this synchronous call, deliberately.
 *  Keeping a permanent hidden one would save a DOM mutation per resize, and it
 *  would also put a second `.wt-tab` inside the root forever — which the strip's
 *  test suite counts as a tab (`root.querySelectorAll(".wt-tab")`). Transient
 *  means no other code, and no assertion, can ever observe it. */
function measureSite(
  varRoot: HTMLElement,
  probeHTML: string,
  cached: string | undefined,
): { shiftPx: number; signature: string } | null {
  const wrap = document.createElement("div");
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.position = "absolute";
  wrap.style.top = "0";
  wrap.style.left = "0";
  wrap.style.visibility = "hidden";
  wrap.style.pointerEvents = "none";
  wrap.appendChild(fromHTML(probeHTML));
  varRoot.appendChild(wrap);
  try {
    const label = wrap.querySelector<HTMLElement>(`.${PROBE_CLASS}`);
    if (!label) {
      return null;
    }
    const cs = getComputedStyle(label);
    const signature = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (signature === cached) {
      return null;
    }
    const fontSizePx = Number.parseFloat(cs.fontSize);
    if (!(fontSizePx > 0)) {
      return null;
    }
    const ink = inkExtents(`${cs.fontStyle} ${cs.fontWeight} ${REF_PX}px ${cs.fontFamily}`);
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

/**
 * Writes a measured --label-ink-shift onto the tab strip and the mobile
 * switcher, and keeps it current.
 *
 * Re-measures on two kinds of event, which need two different policies:
 *
 * - A font finishing (or failing) to load. The first pass can run inside
 *   `font-display: block`, where the line box is still the fallback's, and the
 *   real face can change every number here. These FORCE a re-measure, because
 *   the signature below cannot see them: computed style reports the DECLARED
 *   font-family list whether or not the webfont ever arrived, so a cached
 *   signature would match and pin the fallback's shift permanently. (It did,
 *   until scripts/verify-chip-geometry.mjs caught it.)
 * - A resize. rem-relative label sizes move with Safari's per-site page zoom,
 *   and a new size means new rounding; but most resizes change neither, so this
 *   path keeps the signature check and costs one computed-style read per site
 *   when nothing moved.
 *
 * @returns teardown that drops the listeners and the written properties.
 */
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
  // The DOM lib types document.fonts as always present; an engine without the CSS
  // Font Loading API ships no FontFaceSet at all, so the honest type is the
  // optional one.
  const fonts = document.fonts as FontFaceSet | undefined;
  // `ready` settles the initial load (including a failed one); `loadingdone`
  // covers a face the host page adds afterwards, which `ready` never reports.
  void fonts?.ready.then(onFontsDone);
  fonts?.addEventListener("loadingdone", onFontsDone);
  window.addEventListener("resize", onResize);

  return () => {
    disposed = true;
    fonts?.removeEventListener("loadingdone", onFontsDone);
    window.removeEventListener("resize", onResize);
    for (const site of sites) {
      site.host.style.removeProperty("--label-ink-shift");
    }
  };
}
