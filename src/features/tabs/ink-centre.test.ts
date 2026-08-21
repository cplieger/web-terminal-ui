// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import { centreChipLabels, inkShiftPx, type InkMetrics } from "./ink-centre.js";

// The numbers below are not invented: each row's fontBox, baseline and capInk are
// what the named engine actually reported for the bundled Monaspace Neon NF
// against the deployed bundle, read via Playwright (fontBox and baseline from a
// strut probe, cap ink from canvas TextMetrics at 400px). They exist to pin the
// arithmetic to observed reality, and to document WHY a single em constant could
// not work — the last column is the shift as a ratio of font size, and it is not
// constant down any of them, nor even of one sign.
const OBSERVED: readonly (InkMetrics & { engine: string; expectedEm: number })[] = [
  // WebKit 26.5 (the engine behind Safari 26). 13px rounds descent down to a
  // 16px box; 14px rounds it up to 18px, which is the whole bug.
  {
    engine: "webkit",
    fontSizePx: 13,
    fontBoxPx: 16,
    baselinePx: 13,
    capInkEm: 0.7344,
    expectedEm: 0.0174,
  },
  {
    engine: "webkit",
    fontSizePx: 14,
    fontBoxPx: 18,
    baselinePx: 14,
    capInkEm: 0.7344,
    expectedEm: -0.0101,
  },
  {
    engine: "webkit",
    fontSizePx: 18,
    fontBoxPx: 23,
    baselinePx: 18,
    capInkEm: 0.7344,
    expectedEm: -0.0061,
  },
  // Blink agrees with WebKit on the boxes and differs slightly on ink extents.
  {
    engine: "chromium",
    fontSizePx: 13,
    fontBoxPx: 16,
    baselinePx: 13,
    capInkEm: 0.735,
    expectedEm: 0.0171,
  },
  {
    engine: "chromium",
    fontSizePx: 14,
    fontBoxPx: 18,
    baselinePx: 14,
    capInkEm: 0.735,
    expectedEm: -0.0104,
  },
  // Gecko makes the 14px box 17px, not 18px, so it needs a different shift again
  // at the size the other two share.
  {
    engine: "firefox",
    fontSizePx: 13,
    fontBoxPx: 16,
    baselinePx: 13,
    capInkEm: 0.73,
    expectedEm: 0.0196,
  },
  {
    engine: "firefox",
    fontSizePx: 14,
    fontBoxPx: 17,
    baselinePx: 14,
    capInkEm: 0.73,
    expectedEm: 0.0279,
  },
];

describe("inkShiftPx", () => {
  it.each(OBSERVED)(
    "reproduces the shift $engine measured at $fontSizePx px ($expectedEm em)",
    (m) => {
      expect(inkShiftPx(m) / m.fontSizePx).toBeCloseTo(m.expectedEm, 4);
    },
  );

  it("disagrees across sizes by more than the defect that was reported, which is why the constant was replaced", () => {
    const at13 = OBSERVED.find((m) => m.engine === "webkit" && m.fontSizePx === 13);
    const at14 = OBSERVED.find((m) => m.engine === "webkit" && m.fontSizePx === 14);
    if (!at13 || !at14) {
      throw new Error("fixture rows missing");
    }
    // The retired constant sat between the two ideals; the gap it had to span is
    // wider than the 0.33px error that made the mobile chip read high.
    const spanPx = Math.abs(inkShiftPx(at13) / 13 - inkShiftPx(at14) / 14) * 14;
    expect(spanPx).toBeGreaterThan(0.33);
  });

  it("centres the CAP band, not the cap-to-descender band", () => {
    // The regression this replaced: with descender ink in the band, a title's
    // visible mass is lifted by half the descender and reads high. Same metrics,
    // both definitions, so the difference is exactly that half.
    const m: InkMetrics = { fontBoxPx: 16, baselinePx: 13, capInkEm: 0.7344, fontSizePx: 13 };
    const descInkEm = 0.2031;
    const capBand = inkShiftPx(m);
    const withDescender = capBand + (descInkEm * m.fontSizePx) / 2;
    expect(withDescender - capBand).toBeCloseTo(1.32, 2);
    // And the cap band's own correction is the small one.
    expect(Math.abs(capBand)).toBeLessThan(0.5);
  });

  it("is zero for a font whose cap band is already centred in its line box", () => {
    // Cap ink of a full em with the baseline one half-em below the box's centre
    // puts the cap band's centre ON that centre: nothing to correct.
    expect(inkShiftPx({ fontBoxPx: 20, baselinePx: 15, capInkEm: 1, fontSizePx: 10 })).toBe(0);
  });

  it("centres the cap band by construction, for any metrics an engine can report", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 200, noNaN: true }),
        fc.double({ min: 4, max: 400, noNaN: true }),
        fc.double({ min: 0, max: 1.5, noNaN: true }),
        fc.double({ min: 0.5, max: 400, noNaN: true }),
        (fontSizePx, fontBoxPx, capInkEm, baselinePx) => {
          const shift = inkShiftPx({ fontBoxPx, baselinePx, capInkEm, fontSizePx });
          // Lifting the box by `shift` puts the cap band's centre on the box's
          // centre, which is the whole contract. Stated as the invariant rather
          // than a repeat of the formula: the cap-band centre measured from the
          // LIFTED box's over edge must be half the box.
          const capCentreAfterLift = baselinePx - (capInkEm * fontSizePx) / 2 - shift;
          expect(capCentreAfterLift).toBeCloseTo(fontBoxPx / 2, 6);
        },
      ),
    );
  });
});

describe("centreChipLabels", () => {
  const mount = (): { root: HTMLElement; strip: HTMLElement; switcher: HTMLElement } => {
    const root = document.createElement("div");
    root.className = "wt-root";
    const strip = document.createElement("div");
    strip.className = "wt-tab-bar";
    const switcher = document.createElement("div");
    switcher.className = "wt-switcher";
    root.append(strip, switcher);
    document.body.appendChild(root);
    return { root, strip, switcher };
  };

  it("leaves the CSS default in place when the environment reports no layout", () => {
    // happy-dom has no layout engine, so every rect is zero — the same shape as a
    // display: none probe or a canvas-less environment. Writing a number derived
    // from zeros would be worse than the em default the stylesheet already has.
    const { root, strip, switcher } = mount();
    const stop = centreChipLabels(root, { strip, switcher });
    expect(strip.style.getPropertyValue("--label-ink-shift")).toBe("");
    expect(switcher.style.getPropertyValue("--label-ink-shift")).toBe("");
    stop();
  });

  it("leaves no probe element behind", () => {
    const { root, strip, switcher } = mount();
    const before = root.childElementCount;
    const stop = centreChipLabels(root, { strip, switcher });
    expect(root.childElementCount).toBe(before);
    stop();
  });

  it("stops re-measuring on resize after teardown", () => {
    const { root, strip, switcher } = mount();
    const stop = centreChipLabels(root, { strip, switcher });
    stop();
    // A resize after teardown must not touch the DOM: if the listener survived,
    // the probe would be appended and removed again inside the dispatch.
    let sawProbe = false;
    const watch = new MutationObserver(() => {
      sawProbe = true;
    });
    watch.observe(root, { childList: true });
    window.dispatchEvent(new Event("resize"));
    watch.disconnect();
    expect(sawProbe).toBe(false);
  });

  it("does not throw where document.fonts is absent", () => {
    // happy-dom ships no FontFaceSet, which is also the shape of any environment
    // without the CSS Font Loading API — the module must degrade to the
    // measurement it can already make rather than fail to mount the chrome.
    const { root, strip, switcher } = mount();
    expect(() => centreChipLabels(root, { strip, switcher })()).not.toThrow();
  });

  it("stops re-measuring on a late font load after teardown", () => {
    // The font path FORCES a measurement (it must, because a loaded webfont is
    // invisible to the signature cache), so a leaked listener here would probe
    // and write against a torn-down chrome rather than no-op.
    const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    try {
      const { root, strip, switcher } = mount();
      const stop = centreChipLabels(root, { strip, switcher });
      stop();
      let sawProbe = false;
      const watch = new MutationObserver(() => {
        sawProbe = true;
      });
      watch.observe(root, { childList: true });
      fonts.dispatchEvent(new Event("loadingdone"));
      watch.disconnect();
      expect(sawProbe).toBe(false);
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });

  it("clears the properties it wrote on teardown", () => {
    const { root, strip, switcher } = mount();
    // Seed the properties so teardown has something to clear regardless of
    // whether this environment could measure anything.
    strip.style.setProperty("--label-ink-shift", "1px");
    switcher.style.setProperty("--label-ink-shift", "1px");
    centreChipLabels(root, { strip, switcher })();
    expect(strip.style.getPropertyValue("--label-ink-shift")).toBe("");
    expect(switcher.style.getPropertyValue("--label-ink-shift")).toBe("");
  });
});

// Everything above runs in the environment as it is: happy-dom has no canvas 2d
// context and reports a zero rect for every element, so the measurement pipeline
// bails at its first guard and the module's whole reason for existing goes
// untested. The block below supplies the two readings the module takes FROM the
// engine — the font's ink extents (canvas TextMetrics) and the line box plus
// baseline (two rects) — and then asserts on what the module DERIVES from them:
// the pixel value written to --label-ink-shift, and when it is re-derived.
//
// Both stubs are inputs, not subjects. The rect stub answers zero for a detached
// element, which is what a real engine reports, so the probe's own DOM wiring
// stays under test rather than being assumed.
describe("centreChipLabels — a site the engine can measure", () => {
  // ink-centre caches the first non-null getContext() result in a module-level
  // variable, so this object outlives any one test's spy and the per-test knob
  // has to be the ASCENT it reports rather than the context itself.
  let capInkAscentPx = 300; // 0.750em at the module's 400px reference size
  const fakeCtx2d = {
    font: "",
    measureText: () => ({ actualBoundingBoxAscent: capInkAscentPx }),
  };

  // The resolved font of the probe label, i.e. what the site's CSS produced.
  let computed = {
    fontStyle: "normal",
    fontWeight: "400",
    fontSize: "16px",
    fontFamily: '"Monaspace Neon NF"',
  };
  // The line box the engine produced for it, and where the baseline sits in it.
  // boxTop is deliberately non-zero: the baseline is read as a DISTANCE from the
  // box's over edge, and a box at the viewport's origin cannot tell that from an
  // absolute coordinate.
  let boxTop = 100;
  let boxHeight = 19;
  let baselineFromBoxTop = 16;

  /** 0.750em cap ink at 16px in a 19px box with the baseline 16px down:
   *  the cap band's centre sits 16 - 6 = 10px down, the box's centre 9.5px, so
   *  the ink is 0.5px low and the CSS lifts the box by exactly that. */
  const EXPECTED_SHIFT = "0.500px";

  const rect = (over: Partial<DOMRect>): DOMRect =>
    ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
      ...over,
    }) as DOMRect;

  beforeEach(() => {
    capInkAscentPx = 300;
    computed = {
      fontStyle: "normal",
      fontWeight: "400",
      fontSize: "16px",
      fontFamily: '"Monaspace Neon NF"',
    };
    boxTop = 100;
    boxHeight = 19;
    baselineFromBoxTop = 16;
    document.body.replaceChildren();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      fakeCtx2d as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () => computed as unknown as CSSStyleDeclaration,
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      // A detached element has no box, in this environment and in every engine.
      if (!this.isConnected) {
        return rect({});
      }
      // The strut is the zero-height inline-block whose bottom margin edge sits
      // ON the baseline; everything else measured here is the line box itself.
      if ((this as HTMLElement).style.display === "inline-block") {
        return rect({ top: boxTop + baselineFromBoxTop, bottom: boxTop + baselineFromBoxTop });
      }
      return rect({ top: boxTop, bottom: boxTop + boxHeight, height: boxHeight });
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
  });

  const mount = (): { root: HTMLElement; strip: HTMLElement; switcher: HTMLElement } => {
    const root = document.createElement("div");
    root.className = "wt-root";
    const strip = document.createElement("div");
    strip.className = "wt-tab-bar";
    const switcher = document.createElement("div");
    switcher.className = "wt-switcher";
    root.append(strip, switcher);
    document.body.appendChild(root);
    return { root, strip, switcher };
  };

  /** A FontFaceSet stand-in: happy-dom ships none, so the module's font-load
   *  path is unreachable without one. `settle` resolves `ready`. */
  const stubFonts = (): { fonts: EventTarget; settle: () => void } => {
    let settle = (): void => undefined;
    const ready = new Promise<void>((r) => {
      settle = () => {
        r();
      };
    });
    const fonts = Object.assign(new EventTarget(), { ready });
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    return { fonts, settle };
  };

  const shiftOn = (host: HTMLElement): string => host.style.getPropertyValue("--label-ink-shift");

  it("writes the shift it measured to both label hosts, in pixels", () => {
    const { root, strip, switcher } = mount();

    const stop = centreChipLabels(root, { strip, switcher });

    // The correction is per host, not per root: the two sites carry different
    // label sizes, so one value on the root could only ever be right for one.
    expect(shiftOn(strip)).toBe(EXPECTED_SHIFT);
    expect(shiftOn(switcher)).toBe(EXPECTED_SHIFT);
    stop();
  });

  it("leaves the CSS default in place when the font reports no cap ink", () => {
    // A font whose glyphs report no ink (a missing face, an empty glyph) gives
    // nothing to centre by, and a shift derived from zero ink would lift every
    // label by half its baseline.
    capInkAscentPx = 0;
    const { root, strip, switcher } = mount();

    const stop = centreChipLabels(root, { strip, switcher });

    expect(shiftOn(strip)).toBe("");
    expect(shiftOn(switcher)).toBe("");
    stop();
  });

  it("leaves the CSS default in place when the line box has no height", () => {
    // A display:none host, or a paint before layout. The em default in the
    // stylesheet is a better answer than a number derived from a zero box.
    boxHeight = 0;
    const { root, strip, switcher } = mount();

    const stop = centreChipLabels(root, { strip, switcher });

    expect(shiftOn(strip)).toBe("");
    stop();
  });

  it("leaves the CSS default in place when the site resolves to no font size", () => {
    computed = { ...computed, fontSize: "0px" };
    const { root, strip, switcher } = mount();

    const stop = centreChipLabels(root, { strip, switcher });

    expect(shiftOn(strip)).toBe("");
    stop();
  });

  it("does not re-measure on a resize that left the resolved font alone", () => {
    // The resize path exists for Safari's per-site page zoom, where a rem-sized
    // label really does change size. Most resizes change nothing, and this is
    // the check that keeps them free: one computed-style read per site.
    const { root, strip, switcher } = mount();
    const stop = centreChipLabels(root, { strip, switcher });
    expect(shiftOn(strip)).toBe(EXPECTED_SHIFT);

    // A different face's metrics behind an unchanged signature. Nothing may pick
    // this up on a resize, or the check is not doing its job.
    capInkAscentPx = 400;
    window.dispatchEvent(new Event("resize"));

    expect(shiftOn(strip)).toBe(EXPECTED_SHIFT);
    stop();
  });

  it("re-measures on a resize that changed the label's size", () => {
    // Page zoom: a new size means new rounding in the engine's line box, and the
    // shift moves with it (see the module header's sawtooth).
    const { root, strip, switcher } = mount();
    const stop = centreChipLabels(root, { strip, switcher });

    computed = { ...computed, fontSize: "20px" };
    window.dispatchEvent(new Event("resize"));

    // 0.750em cap ink at 20px in the same 19px box: 16 - 7.5 - 9.5.
    expect(shiftOn(strip)).toBe("-1.000px");
    stop();
  });

  it("re-measures when a font finishes loading, which the signature cannot see", () => {
    // The trap this pins, and the one scripts/verify-chip-geometry.mjs caught:
    // computed style reports the DECLARED family list whether or not the webfont
    // ever arrived, so the signature matches before and after the real face
    // lands. Only a forced re-measure can replace the fallback's shift.
    const { fonts } = stubFonts();
    const { root, strip, switcher } = mount();
    const stop = centreChipLabels(root, { strip, switcher });
    expect(shiftOn(strip)).toBe(EXPECTED_SHIFT);

    capInkAscentPx = 400; // the real face, with 1.000em cap ink
    fonts.dispatchEvent(new Event("loadingdone"));

    expect(shiftOn(strip)).toBe("-1.500px");
    stop();
  });

  it("writes nothing for a font that settles after teardown", async () => {
    // `ready` is a promise, so its callback cannot be unsubscribed the way the
    // listeners can: a terminal torn down while a face is still loading gets its
    // measurement callback anyway, and it must not write onto dead chrome.
    const { settle } = stubFonts();
    const { root, strip, switcher } = mount();

    const stop = centreChipLabels(root, { strip, switcher });
    stop();
    settle();
    await Promise.resolve();
    await Promise.resolve();

    expect(shiftOn(strip)).toBe("");
    expect(shiftOn(switcher)).toBe("");
  });
});
