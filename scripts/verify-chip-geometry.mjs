#!/usr/bin/env node
// Cross-engine verification of chip label geometry: the label's optical
// centring, and the two gaps flanking the activity dot.
//
// Four successive fixes to the centring shipped a hardcoded correction constant,
// and each was correct only in the engine, at the size and on the platform it was
// tuned against — the fourth read correct on a 13px desktop strip in Blink and sat
// 0.33px high on a 14px mobile chip in WebKit. Defects in this area are invisible
// to every other gate in this repo: they are sub-pixel or single-pixel, they need
// real layout (happy-dom has none), and they only appear at a size or in an engine
// the author did not happen to look at. This script is the gate that closes that
// hole. Run it before changing anything about label geometry, the label font
// sizes, the chip's spacing, or the bundled font.
//
// It drives the REAL src/features/tabs/ink-centre.ts (compiled, not
// reimplemented) against the repo's own CSS bundle in WebKit, Blink and Gecko,
// sweeping the label size across the ascent/descent rounding boundaries that broke
// every previous fix, and asserts two things in all of them:
//
//   1. ink centring — the label's visible ink centres on its chip
//   2. dot gaps — the run from the chip's inner edge to the activity dot equals
//      the run from the dot to the label, at both chip sites
//
//   node scripts/verify-chip-geometry.mjs
//   node scripts/verify-chip-geometry.mjs --font /path/to/MonaspiceNeNerdFontMono-Regular.otf
//   node scripts/verify-chip-geometry.mjs --engines webkit,chromium
//
// Not wired into CI: it needs three browser engines (~300 MB) and the repo's
// validate gate is deliberately cheap. Playwright is resolved from a sibling
// checkout rather than added as a devDependency here, the same way
// scripts/verify.sh reaches for the local engine. Point PLAYWRIGHT_DIR at any
// node_modules that has playwright-core installed, then once:
//   npx playwright install webkit chromium firefox
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");

// Sub-pixel, but not arbitrary: the measured worst case of the shipped
// implementation across this sweep is 0.011px in the loosest engine, and the
// defect this replaced was 0.33px. Anything above this is a real regression, not
// float noise.
const TOLERANCE_PX = 0.05;

// 11 through 20 covers both label sizes in production (13px strip, 14px
// switcher) and, more importantly, every ascent/descent rounding outcome between
// them: this font's line box goes 14, 15, 16, 18, 19, 20, 21, 23, 24, 25 px, so
// the sweep crosses the discontinuity four times.
const SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const die = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

// --- Playwright, from wherever it is installed -------------------------------
const playwrightDir =
  process.env["PLAYWRIGHT_DIR"] ?? join(REPO, "..", "web-terminal-engine", "web", "node_modules");
let pw;
try {
  const mod = await import(pathToFileURL(join(playwrightDir, "playwright-core", "index.js")).href);
  // playwright-core is CJS: named exports may or may not survive interop
  // depending on Node's static analysis, so take whichever object has them.
  pw = "webkit" in mod ? mod : mod.default;
} catch {
  die(
    `error: playwright-core not found under ${playwrightDir}\n` +
      `       set PLAYWRIGHT_DIR to a node_modules containing it, then run\n` +
      `       npx playwright install webkit chromium firefox`,
  );
}
if (!pw || !("webkit" in pw)) {
  die(`error: playwright-core under ${playwrightDir} exposed no browser types`);
}

const engines = (arg("engines", "webkit,chromium,firefox") ?? "").split(",").filter(Boolean);
for (const name of engines) {
  if (!(name in pw)) {
    die(`error: unknown engine "${name}" (expected webkit, chromium or firefox)`);
  }
}

// --- Build the fixture ------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "wt-ui-ink-"));

// The CSS bundle, concatenated in the manifest's order because the order IS the
// cascade. Reading the manifest rather than hardcoding the list keeps this
// honest when a stylesheet is added.
const manifest = readFileSync(join(REPO, "css", "MANIFEST"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const bundle = manifest.map((f) => readFileSync(join(REPO, "css", f), "utf8")).join("\n");
writeFileSync(join(work, "bundle.css"), bundle);

// The real module, compiled. Reimplementing the measurement here would verify a
// copy of the logic instead of the logic, which is the failure this script
// exists to prevent.
execFileSync(
  "npx",
  [
    "tsc",
    "--ignoreConfig",
    "src/features/tabs/ink-centre.ts",
    "src/features/dom.ts",
    "--outDir",
    join(work, "mod"),
    "--rootDir",
    "src/features",
    "--module",
    "es2022",
    "--moduleResolution",
    "bundler",
    "--target",
    "es2022",
    "--strict",
    "--skipLibCheck",
    "--lib",
    "es2022,dom",
  ],
  { cwd: REPO, stdio: "inherit" },
);

const fontPath = arg("font");
const fontFace = fontPath
  ? `@font-face{font-family:"MonaspiceNe NFM";src:url("./probe-font${extname(fontPath)}");font-weight:400;font-display:block}`
  : "";
if (fontPath) {
  writeFileSync(join(work, `probe-font${extname(fontPath)}`), readFileSync(fontPath));
}

const CHIP_TEXT = "Hxp Agent jay";
writeFileSync(
  join(work, "index.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ink centring</title>
<link rel="stylesheet" href="./bundle.css">
<style>${fontFace}
/* .wt-switcher is display:none off a coarse pointer and .wt-tab-bar is
   display:none on a narrow root; the fixture measures both layouts at once, so
   it forces both visible rather than emulating two devices. */
#switcher{display:block}</style>
</head><body>
<div class="wt-root">
  <div class="wt-tab-bar" id="strip"><div class="wt-tab-scroll">
    <div class="wt-tab wt-tab-active" id="strip-chip"><span class="wt-tab-dot wt-status-dot wt-reports" id="strip-dot" aria-hidden="true"></span><span class="wt-tab-label" id="strip-label">${CHIP_TEXT}</span><button class="wt-tab-close" type="button"></button></div>
  </div></div>
  <div class="wt-switcher" id="switcher"><div class="wt-switcher-bar"><div class="wt-switcher-current-wrap">
    <button type="button" class="wt-switcher-current" id="switcher-chip"><span class="wt-switcher-current-inner"><span class="wt-switcher-dot wt-status-dot wt-reports" id="switcher-dot" aria-hidden="true"></span><span class="wt-switcher-label" id="switcher-label">${CHIP_TEXT}</span></span></button>
  </div></div></div>
</div>
<script type="module">
import { centreChipLabels } from "./mod/tabs/ink-centre.js";
globalThis.__stop = centreChipLabels(document.querySelector(".wt-root"), {
  strip: document.getElementById("strip"),
  switcher: document.getElementById("switcher"),
});
globalThis.__ready = true;
</script>
</body></html>`,
);

// --- Serve it (ES modules and @font-face both need a real origin) ------------
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};
const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const file = join(work, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(work + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    // Read and THEN write the header: no stat-first check, both because a
    // check-then-use pair is a file-system race and because the read is the only
    // thing that has to succeed. A directory or a missing file throws here.
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // The bundle's own @font-face URLs (/vendor/fonts/...) are served by the
    // product, not by this fixture. A prompt 404 lets document.fonts.ready
    // settle instead of waiting out the block period.
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${server.address().port}/`;

// --- Measure ----------------------------------------------------------------
// Runs in the page. Ink extents come from canvas at 400px and are scaled back:
// WebKit and Blink quantise TextMetrics ink to whole pixels, which at 13px is
// 4% of error in a number this halves — measuring big is what makes a 0.05px
// tolerance meaningful rather than a measurement artefact.
const measure = (sizes) => {
  const REF = 400;
  const out = [];
  const sites = [
    ["strip", "strip-chip", "strip-label", ".wt-tab"],
    ["switcher", "switcher-chip", "switcher-label", ".wt-switcher-current"],
  ];

  const sample = (px) => {
    for (const [name, chipId, labelId, fontSelector] of sites) {
      const chip = document.getElementById(chipId);
      const label = document.getElementById(labelId);
      const host = document.getElementById(name);
      const cs = getComputedStyle(document.querySelector(fontSelector));
      const sizePx = Number.parseFloat(cs.fontSize);
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${REF}px ${cs.fontFamily}`;
      const capEm = ctx.measureText("H").actualBoundingBoxAscent / REF;
      const descEm = ctx.measureText("p").actualBoundingBoxDescent / REF;

      const strut = document.createElement("span");
      strut.style.cssText = "display:inline-block;width:0;height:0";
      label.appendChild(strut);
      const baselineY = strut.getBoundingClientRect().bottom;
      strut.remove();

      const rect = chip.getBoundingClientRect();
      const inkCentre = baselineY + ((descEm - capEm) * sizePx) / 2;
      out.push({
        site: name,
        px: sizePx,
        label: px === null ? "default" : `${px}px`,
        // The property the module wrote. Blank or em-valued means the
        // measurement never ran, and a passing delta would be luck.
        shift: host.style.getPropertyValue("--label-ink-shift"),
        delta: +(inkCentre - (rect.top + rect.height / 2)).toFixed(3),
      });
    }
  };

  // The production configuration FIRST, and unmodified: the strip and the
  // switcher carry two different sizes at once, which is the exact case a single
  // shared constant could not satisfy. A sweep that forces both to one size
  // would not reproduce it.
  sample(null);

  const override = document.createElement("style");
  document.head.appendChild(override);
  for (const px of sizes) {
    // Drive the size through the same selectors that carry it in production, so
    // the module's probe and the real label move together.
    override.textContent = `:where(.wt-root) .wt-tab,:where(.wt-root) .wt-switcher-current,:where(.wt-root) .wt-switcher-row-select{font-size:${px}px}`;
    // The module re-measures on resize; a size change that did not go through a
    // resize is not a case production has, so exercise the real trigger.
    window.dispatchEvent(new Event("resize"));
    sample(px);
  }
  override.remove();
  return out;
};

// The two gaps flanking the activity dot must read as one gap: the chip's own
// padding on the dot's left, and the run to the label on its right. Measured on
// the layout boxes, which is the title-independent definition — a monospace
// glyph is centred in a fixed advance, so a title's first letter starts about a
// pixel inside its box by an amount that depends on the letter, and the engines
// do not even agree on that measurement (reported below for information only).
const measureGaps = () => {
  const out = [];
  for (const [name, chipId, dotId, labelId] of [
    ["strip", "strip-chip", "strip-dot", "strip-label"],
    ["switcher", "switcher-chip", "switcher-dot", "switcher-label"],
  ]) {
    const chip = document.getElementById(chipId);
    const dot = document.getElementById(dotId);
    const label = document.getElementById(labelId);
    const cs = getComputedStyle(chip);
    const ls = getComputedStyle(label);
    const chipR = chip.getBoundingClientRect();
    const dotR = dot.getBoundingClientRect();
    const labelR = label.getBoundingClientRect();

    const REF = 400;
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${ls.fontStyle} ${ls.fontWeight} ${REF}px ${ls.fontFamily}`;
    const first = ctx.measureText(label.textContent.charAt(0));
    const bearing = (-first.actualBoundingBoxLeft / REF) * Number.parseFloat(ls.fontSize);

    const innerLeft =
      chipR.left + Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.paddingLeft);
    out.push({
      site: name,
      dotVisible: dotR.width > 0,
      before: +(dotR.left - innerLeft + Number.parseFloat(cs.paddingLeft)).toFixed(3),
      after: +(labelR.left - dotR.right).toFixed(3),
      inkBearing: +bearing.toFixed(3),
    });
  }
  return out;
};

// Which face actually rendered. Computed style reports the declared family list
const resolvedFace = () => {
  const el = document.createElement("span");
  el.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  el.style.font = getComputedStyle(document.querySelector(".wt-tab")).font;
  el.textContent = "MMMMMMMMMMWWWWWWWWWW";
  document.body.appendChild(el);
  const declared = getComputedStyle(document.querySelector(".wt-tab")).fontFamily.split(",")[0];
  const bundled = el.getBoundingClientRect().width;
  el.style.fontFamily = "monospace";
  const generic = el.getBoundingClientRect().width;
  el.remove();
  return Math.abs(bundled - generic) > 0.5
    ? declared.replaceAll('"', "")
    : "platform monospace (bundled face not served)";
};

let failures = 0;
for (const name of engines) {
  const browser = await pw[name].launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.__ready === true);
  await page.evaluate(() => document.fonts.ready);
  const face = await page.evaluate(resolvedFace);
  const rows = await page.evaluate(measure, SIZES);

  process.stdout.write(`\n${name} ${browser.version()}  font=${face}\n`);
  for (const r of rows) {
    const measured = /^-?\d+(\.\d+)?px$/.test(r.shift);
    const ok = measured && Math.abs(r.delta) <= TOLERANCE_PX;
    if (!ok) {
      failures += 1;
    }
    process.stdout.write(
      `  ${ok ? "ok  " : "FAIL"} ${r.site.padEnd(9)} ${r.label.padStart(7)} @${String(r.px).padStart(4)}px  ` +
        `delta=${String(r.delta).padStart(7)}px  shift=${r.shift || "(unset)"}` +
        `${measured ? "" : "  <- no measured shift: the module did not run"}\n`,
    );
  }

  for (const g of await page.evaluate(measureGaps)) {
    // Whole layout pixels on both sides, so they must match exactly; a tolerance
    // here would only hide a token drifting apart from the chip's padding.
    const ok = g.dotVisible && g.before === g.after;
    if (!ok) {
      failures += 1;
    }
    process.stdout.write(
      `  ${ok ? "ok  " : "FAIL"} ${g.site.padEnd(9)} dot gaps  before=${String(g.before).padStart(6)}px  ` +
        `after=${String(g.after).padStart(6)}px  (first-glyph ink bearing ${g.inkBearing}px, not compensated)` +
        `${g.dotVisible ? "" : "  <- dot has no box: the gap check proves nothing"}\n`,
    );
  }
  await browser.close();
}

server.close();
rmSync(work, { recursive: true, force: true });

if (failures > 0) {
  process.stderr.write(
    `\n${failures} check(s) failed.\n` +
      `Chip label geometry has regressed. For a centring failure, do NOT tune a\n` +
      `constant by eye — the correction is measured at runtime\n` +
      `(src/features/tabs/ink-centre.ts), so it means the measurement is wrong,\n` +
      `not the number. For a dot-gap failure, the chip's padding and the dot's\n` +
      `own margin have drifted apart (see .wt-tab-dot in css/30-tabs.css).\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `\nlabels centred within +/-${TOLERANCE_PX}px and dot gaps equal in ${engines.join(", ")}\n`,
);
