// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
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
