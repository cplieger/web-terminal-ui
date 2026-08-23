// Rendered chip geometry: the two invariants scripts/verify-chip-geometry.mjs
// asserts, narrowed to the one engine the gate has.
//
// LIMIT, stated because a green run here is easy to over-read. This runs in
// Blink only, at one viewport, against whatever monospace the machine resolves
// for --font-ui (this package ships no font). The correction each engine needs
// differs by up to 0.535px at the two production label sizes, which is more
// than the 0.33px defect that produced ink-centre.ts, so cross-engine coverage
// is NOT here: it is scripts/verify-chip-geometry.mjs, run by hand with --font,
// and even that reaches Linux WebKit rather than the iOS CoreText path the
// original defect came from.
//
// What this file does own, and nothing else in the suite does: the CSS wiring
// (margin-block: 0 calc(2 * var(--label-ink-shift)) is never executed by any
// other test, because no other test loads a stylesheet), all THREE label sites at
// two different sizes at once — including the overview row (css/31-switcher.css:512),
// the third --label-ink-shift consumer, which the script does not measure either —
// and the dot-gap equality, which has no coverage anywhere.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { centreChipLabels } from "./ink-centre.js";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// Both the manifest and the sheets arrive through Vite's raw glob rather than a
// static `?raw` import, which would need an ambient `declare module "*?raw"` —
// and this package publishes its TypeScript source, so that wildcard would ship.
// `import.meta.glob` needs only the local ImportMeta augmentation above, which
// tsconfig.json (source, tests excluded) never sees. A glob pattern must carry
// magic: the extensionless `css/MANIFEST` alone throws inside vite:import-glob,
// so the manifests are reached by prefix and the one wanted is keyed out.
const MANIFESTS = import.meta.glob("../../../css/MANIFEST*", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHEETS = import.meta.glob("../../../css/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const byName = (mods: Record<string, string>): Map<string | undefined, string> =>
  new Map(Object.entries(mods).map(([path, text]) => [path.split("/").pop(), text]));

// The manifest order IS the cascade, so it is read rather than restated. This is
// the FULL-PAGE manifest, the same one the script concatenates; the three
// per-preset manifests beside it are not this fixture's subject.
const BUNDLE = ((): string => {
  const manifest = byName(MANIFESTS).get("MANIFEST");
  if (manifest === undefined) {
    throw new Error("css/MANIFEST is missing");
  }
  const sheets = byName(SHEETS);
  const order = manifest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return order
    .map((name) => {
      const text = sheets.get(name);
      if (text === undefined) {
        throw new Error(`css/MANIFEST names ${name}, which css/ does not contain`);
      }
      return text;
    })
    .join("\n");
})();

// Matches scripts/verify-chip-geometry.mjs:49. The script measures a worst case
// of 0.013px in Blink with the bundled Monaspace Neon NF; this package ships no
// font, so here the platform monospace resolves and every offset reads exactly
// 0.000 — the tolerance is slack and tightening it cannot make this file red.
// What CAN, measured: consuming the shift once instead of twice
// (`margin-block: 0 var(--label-ink-shift)`) puts every offset at half the
// shift, 0.31px to 0.75px, which is the wiring class this file exists to catch.
const TOLERANCE_PX = 0.05;
// Crosses this font's ascent/descent rounding boundaries several times, which is
// the discontinuity every constant-based fix fell off.
const SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] as const;
const CHIP_TEXT = "Hxp Agent jay";

let styles: HTMLStyleElement;
let sizeOverride: HTMLStyleElement;
let root: HTMLElement | undefined;
let stop: (() => void) | undefined;

beforeAll(() => {
  styles = document.createElement("style");
  // .wt-switcher is display:none off a coarse pointer and .wt-tab-bar is
  // display:none on a narrow root, so the fixture forces both visible rather
  // than emulating two devices; measuring both at once is the whole point. The
  // overview list is collapsed to max-height 0 until the switcher carries
  // .wt-switcher-expanded, so the markup below carries that class too.
  styles.textContent = `${BUNDLE}\n#switcher{display:block}`;
  document.head.appendChild(styles);
  sizeOverride = document.createElement("style");
  document.head.appendChild(sizeOverride);
});
afterAll(() => {
  styles.remove();
  sizeOverride.remove();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  root?.remove();
  root = undefined;
  sizeOverride.textContent = "";
});

/** The real chip chrome at all three label sites, as strip.ts and switcher.ts
 *  build it. The progress bar each site also carries is omitted, exactly as the
 *  script's fixture omits it: it is position: absolute and starts `hidden`, so it
 *  is not in this geometry, and a divergence from the script is worth more than
 *  the line. */
function mount(): void {
  root = document.createElement("div");
  root.className = "wt-root";
  root.innerHTML = `
  <div class="wt-tab-bar" id="strip"><div class="wt-tab-scroll">
    <div class="wt-tab wt-tab-active" id="strip-chip"><span class="wt-tab-dot wt-status-dot wt-reports" id="strip-dot" aria-hidden="true"></span><span class="wt-tab-label" id="strip-label">${CHIP_TEXT}</span><button class="wt-tab-close" type="button"></button></div>
  </div></div>
  <div class="wt-switcher wt-switcher-expanded" id="switcher"><div class="wt-switcher-bar"><div class="wt-switcher-current-wrap">
    <button type="button" class="wt-switcher-current" id="switcher-chip"><span class="wt-switcher-current-inner"><span class="wt-switcher-dot wt-status-dot wt-reports" id="switcher-dot" aria-hidden="true"></span><span class="wt-switcher-label" id="switcher-label">${CHIP_TEXT}</span></span></button>
  </div></div><ul class="wt-switcher-list" role="list">
    <li class="wt-switcher-row"><button type="button" class="wt-switcher-row-select" id="row-chip"><span class="wt-switcher-row-dot wt-status-dot wt-reports" id="row-dot" aria-hidden="true"></span><span class="wt-switcher-row-label" id="row-label">${CHIP_TEXT}</span></button><button type="button" class="wt-switcher-row-close wt-btn"></button></li>
  </ul></div>`;
  document.body.appendChild(root);
  stop = centreChipLabels(root, {
    strip: document.getElementById("strip")!,
    switcher: document.getElementById("switcher")!,
  });
}

const REF = 400;

/** How far the label's cap band sits from its chip's centre, in px.
 *  Ink extents come from canvas at 400px and scale back: Blink quantises
 *  TextMetrics ink to whole pixels, which at 13px is 4% of error in a number
 *  this halves. */
function bandOffset(chipId: string, labelId: string, fontSelector: string): number {
  const chip = document.getElementById(chipId)!;
  const label = document.getElementById(labelId)!;
  const cs = getComputedStyle(document.querySelector(fontSelector)!);
  const sizePx = Number.parseFloat(cs.fontSize);
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${REF}px ${cs.fontFamily}`;
  const capEm = ctx.measureText("H").actualBoundingBoxAscent / REF;

  // A zero-height inline-block's bottom margin edge sits ON the baseline; it is
  // the only thing in the DOM that reports a baseline position.
  const strut = document.createElement("span");
  strut.style.cssText = "display:inline-block;width:0;height:0";
  label.appendChild(strut);
  const baselineY = strut.getBoundingClientRect().bottom;
  strut.remove();

  const rect = chip.getBoundingClientRect();
  return baselineY - (capEm * sizePx) / 2 - (rect.top + rect.height / 2);
}

/** Every site's chip, dot and label, plus the host whose --label-ink-shift its
 *  labels resolve. The overview row has no host of its own: it lives inside the
 *  switcher and inherits that host's shift, which is only the right number
 *  because the two share one label size (both 0.875rem — css/31-switcher.css:149
 *  and :482). Asserting the row is what turns that inference into a check. */
const SITES = [
  {
    name: "strip",
    host: "strip",
    chip: "strip-chip",
    dot: "strip-dot",
    label: "strip-label",
    font: ".wt-tab",
  },
  {
    name: "switcher",
    host: "switcher",
    chip: "switcher-chip",
    dot: "switcher-dot",
    label: "switcher-label",
    font: ".wt-switcher-current",
  },
  {
    name: "overview row",
    host: "switcher",
    chip: "row-chip",
    dot: "row-dot",
    label: "row-label",
    font: ".wt-switcher-row-select",
  },
] as const;

/** The measured shift on a site's host, asserted to BE measured: blank or
 *  em-valued means the module never ran, and a passing offset would then be
 *  luck. Returns it for the offset assertion's message.
 *
 *  Soft, like every per-site assertion here: three sites share one `it` per size,
 *  and a hard failure on the first would hide the other two. */
function measuredShift(site: (typeof SITES)[number], at: string): string {
  const shift = document.getElementById(site.host)!.style.getPropertyValue("--label-ink-shift");
  expect.soft(shift, `${site.name}${at} has a measured px shift`).toMatch(/^-?\d+\.\d{3}px$/);
  // A chip with no box makes the offset meaningless rather than wrong — the
  // overview row is inside a container that collapses to max-height 0 when the
  // switcher is not expanded, so this is a live way to pass vacuously.
  expect
    .soft(
      document.getElementById(site.chip)!.getBoundingClientRect().height,
      `${site.name}${at} chip has a box`,
    )
    .toBeGreaterThan(0);
  return shift;
}

describe("rendered chip geometry", () => {
  it("centres every label's cap band on its chip at the production sizes", () => {
    // The unmodified product first: the strip is 13px and the switcher 14px at
    // the same instant, which is the case one shared constant cannot satisfy.
    mount();
    for (const site of SITES) {
      const shift = measuredShift(site, "");
      expect
        .soft(
          Math.abs(bandOffset(site.chip, site.label, site.font)),
          `${site.name} cap band is centred (shift=${shift})`,
        )
        .toBeLessThanOrEqual(TOLERANCE_PX);
    }
  });

  it.each(SIZES)("centres every label's cap band at %ipx", (px) => {
    mount();
    // Drive the size through the same selectors that carry it in production, so
    // the module's probe and the real label move together. The module
    // re-measures on resize, so exercise the real trigger rather than calling in.
    sizeOverride.textContent = `:where(.wt-root) .wt-tab,:where(.wt-root) .wt-switcher-current,:where(.wt-root) .wt-switcher-row-select{font-size:${px}px}`;
    window.dispatchEvent(new Event("resize"));
    for (const site of SITES) {
      const shift = measuredShift(site, ` @${px}px`);
      expect
        .soft(
          Math.abs(bandOffset(site.chip, site.label, site.font)),
          `${site.name} @${px}px cap band is centred (shift=${shift})`,
        )
        .toBeLessThanOrEqual(TOLERANCE_PX);
    }
  });

  it.each(SITES)("gives $name's activity dot equal gaps on both sides", (site) => {
    // Whole layout pixels on both sides, so they must match exactly; a tolerance
    // would only hide a token drifting apart from the chip's padding. This
    // equalises LAYOUT gaps, not ink gaps: css/30-tabs.css:313-319 records why.
    mount();
    const chip = document.getElementById(site.chip)!;
    const dot = document.getElementById(site.dot)!;
    const label = document.getElementById(site.label)!;
    const cs = getComputedStyle(chip);
    const chipR = chip.getBoundingClientRect();
    const dotR = dot.getBoundingClientRect();

    // A dot with no box makes the comparison vacuous.
    expect(dotR.width, `${site.name} dot has a box`).toBeGreaterThan(0);
    const innerLeft =
      chipR.left + Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.paddingLeft);
    const before = dotR.left - innerLeft + Number.parseFloat(cs.paddingLeft);
    const after = label.getBoundingClientRect().left - dotR.right;
    expect(after, `${site.name} dot: chip edge -> dot equals dot -> label`).toBe(before);
  });
});
