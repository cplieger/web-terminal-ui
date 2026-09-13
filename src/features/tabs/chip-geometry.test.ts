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
  unmount();
  sizeOverride.textContent = "";
});

/** The secondary activity mark, as chipContent emits it at every chip site: no
 *  `hidden` attribute and no per-site class, so its absence is expressed by having
 *  no `data-activity` and its footprint is cancelled in CSS. */
const MARK = `<span class="wt-activity-mark" aria-hidden="true"></span>`;
/** The mark's declared box and the per-site flex gap its footprint cancel spans
 *  (css/30-tabs.css --wt-mark-size, and --wt-mark-gap which 31-switcher.css
 *  re-points at --sp-2 for the two mobile chips). */
const MARK_SIZE_PX = 9;
const MARK_GAP_PX = { strip: 4, mobile: 8 } as const;

/** Drops the mounted fixture, so one test can measure two mounts. */
function unmount(): void {
  stop?.();
  stop = undefined;
  root?.remove();
  root = undefined;
}

/** The real chip chrome at all three label sites, as strip.ts and switcher.ts
 *  build it. The progress bar each site also carries is omitted, exactly as the
 *  script's fixture omits it: it is position: absolute and starts `hidden`, so it
 *  is not in this geometry, and a divergence from the script is worth more than
 *  the line.
 *
 *  The activity mark IS in it by default, because every shipped chip carries one:
 *  measuring a chip without it would measure a shape this package no longer
 *  builds. `withMark: false` is the pre-mark chip, which is the baseline the
 *  footprint assertions below compare against. */
function mount(withMark = true): void {
  unmount();
  const mark = withMark ? MARK : "";
  root = document.createElement("div");
  root.className = "wt-root";
  root.innerHTML = `
  <div class="wt-tab-bar" id="strip"><div class="wt-tab-scroll">
    <div class="wt-tab wt-tab-active" id="strip-chip"><span class="wt-tab-dot wt-status-dot wt-reports" id="strip-dot" aria-hidden="true"></span>${mark}<span class="wt-tab-label" id="strip-label">${CHIP_TEXT}</span><button class="wt-tab-close" type="button"></button></div>
  </div></div>
  <div class="wt-switcher wt-switcher-expanded" id="switcher"><div class="wt-switcher-bar"><div class="wt-switcher-current-wrap">
    <button type="button" class="wt-switcher-current" id="switcher-chip"><span class="wt-switcher-current-inner"><span class="wt-switcher-dot wt-status-dot wt-reports" id="switcher-dot" aria-hidden="true"></span>${mark}<span class="wt-switcher-label" id="switcher-label">${CHIP_TEXT}</span></span></button>
  </div></div><ul class="wt-switcher-list" role="list">
    <li class="wt-switcher-row"><button type="button" class="wt-switcher-row-select" id="row-chip"><span class="wt-switcher-row-dot wt-status-dot wt-reports" id="row-dot" aria-hidden="true"></span>${mark}<span class="wt-switcher-row-label" id="row-label">${CHIP_TEXT}</span></button><button type="button" class="wt-switcher-row-close wt-btn"></button></li>
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
    markGap: MARK_GAP_PX.strip,
  },
  {
    name: "switcher",
    host: "switcher",
    chip: "switcher-chip",
    dot: "switcher-dot",
    label: "switcher-label",
    font: ".wt-switcher-current",
    markGap: MARK_GAP_PX.mobile,
  },
  {
    name: "overview row",
    host: "switcher",
    chip: "row-chip",
    dot: "row-dot",
    label: "row-label",
    font: ".wt-switcher-row-select",
    markGap: MARK_GAP_PX.mobile,
  },
] as const;

/** A site's mark element, which carries no id of its own. */
function markOf(site: (typeof SITES)[number]): HTMLElement {
  const el = document.getElementById(site.chip)!.querySelector<HTMLElement>(".wt-activity-mark");
  if (el === null) {
    throw new Error(`${site.name} chip has no .wt-activity-mark`);
  }
  return el;
}

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

// The secondary activity mark's layout contract. It rides chipContent, so it is in
// EVERY chip whether or not the session has a background task — which makes "an
// absent mark costs nothing" a claim about the chip every user sees, at all three
// sites, with a per-site gap token behind it (css/31-switcher.css re-points
// --wt-mark-gap for the two mobile chips). Nothing else in this package renders a
// stylesheet, so this file is the only place the claim is measurable.
describe("the activity mark's footprint", () => {
  it.each(SITES)("leaves $name's geometry untouched while no state is set", (site) => {
    // The pre-mark chip is the baseline: same fixture, same sizes, the element
    // simply not in the DOM. A wrong --wt-mark-gap at this site shows up here as a
    // label shifted by the difference, which is exactly the drift the one
    // duplicated per-site value invites.
    mount(false);
    const bare = {
      label: document.getElementById(site.label)!.getBoundingClientRect(),
      chip: document.getElementById(site.chip)!.getBoundingClientRect().width,
    };
    expect(bare.chip, `${site.name} chip has a box`).toBeGreaterThan(0);

    mount(true);
    const withMark = {
      label: document.getElementById(site.label)!.getBoundingClientRect(),
      chip: document.getElementById(site.chip)!.getBoundingClientRect().width,
    };

    expect(markOf(site).hasAttribute("data-activity"), "the mark reports nothing").toBe(false);
    expect(withMark.label.left, `${site.name} label's left edge`).toBe(bare.label.left);
    expect(withMark.label.width, `${site.name} label's width`).toBe(bare.label.width);
    expect(withMark.chip, `${site.name} chip's width`).toBe(bare.chip);
  });

  it.each(SITES)("shifts $name's label by exactly the box plus the gap when lit", async (site) => {
    mount(true);
    const before = document.getElementById(site.label)!.getBoundingClientRect().left;
    const mark = markOf(site);
    mark.dataset["activity"] = "working";
    // The margin SLIDES, so the total is only measurable once it has landed —
    // awaiting the element's own animations rather than a duration keeps this off
    // the token's current value. Every frame in between is a partial shift.
    await Promise.all(mark.getAnimations().map((a) => a.finished));
    const after = document.getElementById(site.label)!.getBoundingClientRect().left;

    // The settled reveal is the whole of it: the mark takes up its own box plus one
    // of the chip's flex gaps, and nothing else moves.
    expect(after - before, `${site.name} label shift`).toBe(MARK_SIZE_PX + site.markGap);
  });

  it.each(SITES)("keeps $name's mark a 9x9 box at every band width", (site) => {
    // box-sizing: border-box is global under .wt-root, which is what lets the band
    // carry the state without any state moving layout. Asserted per state rather
    // than reasoned about, because a single `box-sizing` regression would move the
    // label on every state change.
    mount(true);
    const mark = markOf(site);
    for (const state of ["working", "waiting", "input"]) {
      mark.dataset["activity"] = state;
      const box = mark.getBoundingClientRect();
      expect.soft(box.width, `${site.name} mark width @${state}`).toBe(MARK_SIZE_PX);
      expect.soft(box.height, `${site.name} mark height @${state}`).toBe(MARK_SIZE_PX);
    }
  });
});

// Whether the mark's reveal transition APPLIES is a cascade question, and only a
// rendered bundle answers it: css/40-animations.css declares `transition` on every
// .wt-tab child for the drag dissolve, at equal specificity and later in the
// manifest, so before it excluded the mark the desktop chip resolved the dissolve's
// timing while the two mobile chips resolved the intended one. Both sheets read
// correctly on their own, which is why the declaration's presence proves nothing.
describe("the activity mark's reveal transition", () => {
  /** With motion on, which is what the animations feature stamps on the root and
   *  what makes the drag-dissolve rule live. */
  const mountAnimated = (): void => {
    mount(true);
    root!.classList.add("wt-animate");
  };
  /** A duration token as the root resolves it, so this pins the CASCADE rather
   *  than the token's current value. */
  const tokenOf = (name: string): string => getComputedStyle(root!).getPropertyValue(name).trim();

  /** The resolved transition list keyed by property, so an assertion names the
   *  property instead of a position in the shorthand — the two lists put the same
   *  two properties in OPPOSITE order, which is the whole subject here. */
  const legsOf = (el: HTMLElement): Map<string, { duration: string; delay: string }> => {
    const cs = getComputedStyle(el);
    const durations = cs.transitionDuration.split(", ");
    const delays = cs.transitionDelay.split(", ");
    return new Map(
      cs.transitionProperty
        .split(", ")
        .map((prop, i) => [prop, { duration: durations[i] ?? "", delay: delays[i] ?? "" }]),
    );
  };

  it.each(SITES)("resolves $name's own two-legged reveal, not the drag dissolve's", (site) => {
    mountAnimated();
    const mark = markOf(site);

    // AT REST this is the EXIT list: the mark fades out, and the space closes
    // behind it on a delay equal to that fade. The dissolve declares `opacity`
    // alone with no delay, so a single leg here means that rule won.
    const rest = legsOf(mark);
    const restFade = rest.get("opacity");
    const restSpace = rest.get("margin-inline-start");
    expect.soft(rest.size, `${site.name} at rest transitions two properties`).toBe(2);
    expect
      .soft(restFade?.duration, `${site.name} fades out over --dur-exit`)
      .toBe(tokenOf("--dur-exit"));
    expect.soft(restFade?.delay, `${site.name} starts fading out at once`).toBe("0s");
    expect
      .soft(restSpace?.duration, `${site.name} closes over --dur-standard`)
      .toBe(tokenOf("--dur-standard"));
    expect
      .soft(restSpace?.delay, `${site.name} closes the space only after the fade`)
      .toBe(tokenOf("--dur-exit"));

    // LIT this is the ENTRY list, and it is the reverse: the space opens first and
    // the fade waits out that whole duration.
    mark.dataset["activity"] = "working";
    const lit = legsOf(mark);
    const litSpace = lit.get("margin-inline-start");
    const litFade = lit.get("opacity");
    expect.soft(lit.size, `${site.name} lit transitions two properties`).toBe(2);
    expect
      .soft(litSpace?.duration, `${site.name} opens over --dur-standard`)
      .toBe(tokenOf("--dur-standard"));
    expect.soft(litSpace?.delay, `${site.name} opens the space immediately`).toBe("0s");
    expect
      .soft(litFade?.duration, `${site.name} fades in over --dur-enter`)
      .toBe(tokenOf("--dur-enter"));
    // The asymmetry itself: the fade's delay IS the space's duration, so the mark
    // arrives in the room the label just made rather than racing it.
    expect
      .soft(litFade?.delay, `${site.name} fades in only after the space has opened`)
      .toBe(litSpace?.duration);
    expect
      .soft(Number.parseFloat(litFade?.delay ?? "0"), `${site.name} entry delay is non-zero`)
      .toBeGreaterThan(0);
  });

  it("keeps the chip's other children on the dissolve's timing", () => {
    // The other half of the exemption: excluding the mark must not exempt anything
    // else, or the chip's content stops leaving as one motion.
    mountAnimated();
    for (const selector of [".wt-tab-label", ".wt-tab-dot", ".wt-tab-close"]) {
      const cs = getComputedStyle(document.querySelector<HTMLElement>(`.wt-tab ${selector}`)!);
      expect
        .soft(cs.transitionDuration, `${selector} dissolves over --dur-micro`)
        .toBe(tokenOf("--dur-micro"));
      expect.soft(cs.transitionDelay, `${selector} dissolves immediately`).toBe("0s");
    }
  });
});
