// CSS contract tests: rules the ENGINE depends on by class name. The engine
// toggles these classes (render.ts) and ships no CSS of its own, so the pairing
// is an implicit cross-package contract — a rule silently deleted from the
// bundle breaks a terminal behavior with no compile-time or unit-test signal
// anywhere else (DECSCNM reverse video shipped broken for exactly this reason:
// the engine toggled .term-reverse-video and no stylesheet ever styled it).
// happy-dom applies no real CSS, so these assert on the stylesheet TEXT — a
// deliberate grep-level guard, not a rendering test (the engine's Playwright
// e2e covers pixels).
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LOADING_OVERLAY_CLASSES, PUBLIC_THEME_TOKENS } from "./kernel/style-contract.js";
import { SWITCH_ANIMATIONS } from "./features/tabs/switch-anim.js";
import { CUE_SEVERITY } from "./features/tabs/model.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssDir = path.join(packageDir, "css");
const tokens = readFileSync(path.join(cssDir, "00-tokens.css"), "utf8");
const terminal = readFileSync(path.join(cssDir, "02-terminal.css"), "utf8");
const tabs = readFileSync(path.join(cssDir, "30-tabs.css"), "utf8");
const switcher = readFileSync(path.join(cssDir, "31-switcher.css"), "utf8");
const primitives = readFileSync(path.join(cssDir, "10-primitives.css"), "utf8");
const scrollToBottomCss = readFileSync(path.join(cssDir, "21-scroll-to-bottom.css"), "utf8");
const page = readFileSync(path.join(cssDir, "page.css"), "utf8");
const animations = readFileSync(path.join(cssDir, "40-animations.css"), "utf8");

describe("engine-toggled class contract", () => {
  it("styles DECSCNM reverse video (.term-reverse-video) as a default-pair swap", () => {
    // The rule must exist...
    const rule = /\.term\.term-reverse-video\s*\{([^}]*)\}/.exec(terminal);
    expect(rule, ".term.term-reverse-video rule exists in 02-terminal.css").not.toBeNull();
    // ...and swap the pair via the captured copies (a direct --text: var(--bg)
    // swap is a custom-property cycle that invalidates both, i.e. no-ops).
    const body = rule![1];
    expect(body).toContain("--text: var(--bg-default)");
    expect(body).toContain("--bg: var(--text-default)");
    // The captured copies must be declared where the tokens live.
    expect(tokens).toContain("--text-default: var(--text)");
    expect(tokens).toContain("--bg-default: var(--bg)");
  });

  it("styles the caret overlay (.term-cursor-overlay) the engine positions", () => {
    expect(terminal).toContain(".term-cursor-overlay");
    expect(terminal).toContain(".term-cursor-overlay:not(.visible)");
  });

  it("gives app-declared links (.term-link) an affordance where nothing can hover", () => {
    // The engine anchors OSC 8 runs as .term-link and auto-detected URLs as
    // .term-autolink. .term-link's underline is hover-only, so on a touch device
    // an app-declared link renders as plain text: kiro-cli emits OSC 8 for every
    // markdown link, which made a phone session full of tappable invisible links.
    // A `hover: none` block restores the affordance; deleted, mobile silently
    // regresses with no other signal anywhere.
    const block = /@media \(hover: none\) \{([\s\S]*?)\n\}/.exec(terminal);
    expect(block, "a (hover: none) block exists in 02-terminal.css").not.toBeNull();
    const body = block![1];
    expect(body).toContain(".term-link");
    expect(body).toContain("underline dotted");
    // The pressed state stays distinguishable without hover.
    expect(body).toContain(".term-link:active");
    // And the hover rule survives for pointers that have one.
    expect(terminal).toContain(".term-link:hover");
  });
});

// ---------------------------------------------------------------------------
// The cell-height contract: does the bundled font paint a WHOLE cell?
//
// A cell's background is an inline span, and an inline box paints its FONT's
// content area — ascent + descent — never the line box. So a font whose metrics
// are shorter than the terminal's line-height leaves an unpainted stripe at
// every row boundary, and an application drawing a solid column of background
// (kiro-cli's green and purple block gutters) renders as dashes.
//
// This shipped once, in 5.3.0, when the nerd-fonts OTFs were swapped for
// GitHub's own WOFF2 faces: the swap was gated on horizontal advances, and the
// new faces declare 0.945em + 0.200em against a 17px cell at 14px — a 1px gap on
// every row. The fix is the ascent-override/descent-override pair on each face
// (page.css); this test is what makes the pairing CHECKED rather than
// remembered, because the two halves live in different files and each looks
// self-consistent alone. Text-level, like its neighbours: happy-dom applies no
// CSS, so a rendering assertion is not available here.
describe("bundled-font cell coverage", () => {
  /** Reads one declaration out of a rule body as a float, dropping its unit. */
  const decl = (body: string, prop: string): number | null => {
    const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([\\d.]+)`).exec(body);
    return m ? Number.parseFloat(m[1]!) : null;
  };

  const termRule = /:where\(\.wt-root\)\s*\.term\s*\{([\s\S]*?)\n\}/.exec(terminal);
  const fontFaces = [...page.matchAll(/@font-face\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]!);

  it("declares the cell geometry the override is measured against", () => {
    expect(termRule, ":where(.wt-root) .term rule exists in 02-terminal.css").not.toBeNull();
    expect(decl(termRule![1]!, "font-size")).toBe(14);
    expect(decl(termRule![1]!, "line-height")).toBe(17);
    // Four faces: regular, bold, italic, bold-italic. A face added without the
    // override is a weight whose backgrounds gap while the others do not.
    expect(fontFaces).toHaveLength(4);
  });

  it.each([0, 1, 2, 3])("face %i paints at least a full cell", (i) => {
    const body = fontFaces[i]!;
    const fontSize = decl(termRule![1]!, "font-size");
    const lineHeight = decl(termRule![1]!, "line-height");
    const ascent = decl(body, "ascent-override");
    const descent = decl(body, "descent-override");
    // Read the cell geometry FIRST and refuse a missing value: a null here would
    // coerce to 0 in the comparison below and pass the assertion vacuously, so
    // the guard would report green on a stylesheet it never actually read.
    expect(fontSize, ".term declares font-size").not.toBeNull();
    expect(lineHeight, ".term declares line-height").not.toBeNull();
    expect(ascent, "face declares ascent-override").not.toBeNull();
    expect(descent, "face declares descent-override").not.toBeNull();
    // Both descriptors are percentages of font-size.
    const painted = ((ascent! + descent!) / 100) * fontSize!;
    expect(painted).toBeGreaterThanOrEqual(lineHeight!);
  });
});

// Same implicit contract, one layer in: the chrome buttons that cancel their
// pointerdown default (holdFocusOnPress, features/dom.ts) paint .wt-pressed on
// themselves because Firefox gives them no :active, so a press rule written for
// :active alone is a control with no press feedback in that engine — silently,
// since happy-dom applies no CSS and the other engines look fine. Assert the
// pairing for every such control.
describe("press-class contract for the focus-holding buttons", () => {
  const PRESS_RULES: [name: string, css: string, selector: string][] = [
    ["the shared .wt-btn primitive (keyboard + switcher buttons)", primitives, ".wt-btn"],
    ["the desktop strip's +", tabs, ".wt-tab-new"],
    ["the mobile switcher's +", switcher, ".wt-switcher-new"],
    ["the scroll-to-bottom control", scrollToBottomCss, ".wt-scroll-bottom"],
  ];

  it.each(PRESS_RULES)("pairs %s press rule with .wt-pressed", (_name, css, selector) => {
    const escaped = selector.replace(".", "\\.");
    expect(new RegExp(`${escaped}:active`).test(css), `${selector}:active exists`).toBe(true);
    expect(
      new RegExp(`${escaped}\\.wt-pressed`).test(css),
      `${selector}.wt-pressed accompanies it`,
    ).toBe(true);
  });
});

// The desktop reorder preview is CSS-only where it is visible (happy-dom applies
// no styles and reports zero geometry, so the feature's own suite can prove the
// state machine but not one pixel of the result). These are grep-level guards on
// the three decisions that would fail silently.
describe("reorder drop-slot contract", () => {
  it("renders the dragged chip as a dashed outline, not a dimmed copy of the tab", () => {
    // The whole point of the slot: one solid thing under the pointer, one hollow
    // thing where it will land. An opacity-dimmed chip is what this replaced, and
    // it is the shape a future edit would most plausibly regress to.
    const slot = /\.wt-tab\.wt-tab-dragging\s*\{[^}]*\}/.exec(tabs)?.[0] ?? "";
    expect(slot, ".wt-tab.wt-tab-dragging rule exists").not.toBe("");
    expect(/border-style:\s*dashed/.test(slot), "the slot is dashed").toBe(true);
    expect(/opacity/.test(slot), "the slot does not dim the chip itself").toBe(false);
    // ...and its content is what goes, so the dashes keep full strength.
    expect(
      /\.wt-tab\.wt-tab-dragging\s*>\s*\*\s*\{[^}]*opacity:\s*0/.test(tabs),
      "the chip's content fades instead",
    ).toBe(true);
  });

  it("scopes the slot through .wt-tab-scroll so it out-ranks the press rung", () => {
    // A mousedown that starts a drag leaves the chip :active for the whole gesture
    // in Blink, and .wt-tab:not(.wt-tab-active):active is (0,3,0). Without the
    // extra compound the slot paints as a pressed tab under the dashes.
    expect(/\.wt-tab-scroll\s+\.wt-tab\.wt-tab-dragging/.test(tabs)).toBe(true);
  });

  it("gates the slot's fade on .wt-animate and defines the keyframes it names", () => {
    expect(/:where\(\.wt-root\.wt-animate\)\s+\.wt-tab-slotted/.test(animations)).toBe(true);
    // stylelint's no-unknown-animations covers this too; asserted here because the
    // keyframe name is the only link between the class and the motion.
    expect(/@keyframes\s+wt-slot-in/.test(animations)).toBe(true);
  });

  it("carries no dwell progress bar", () => {
    // Deliberately a NEGATIVE assertion. The first version of the preview gated
    // every commit behind a fixed hold and drew a filling rail on the target edge
    // to explain the wait; both were removed because the wait itself was the
    // defect (the reorder now commits when the pointer comes to rest). A rail is
    // the natural thing to re-add when someone reintroduces a delay, so this fails
    // the moment the class comes back and points at the reason.
    expect(/wt-tab-dwell/.test(tabs), "no .wt-tab-dwell rail in the tabs CSS").toBe(false);
  });
});

// The activity-dot vocabulary is CSS-only (happy-dom applies no styles), so the
// visual decisions the OSC 9 states rest on have no other automated guard. Same
// grep-level posture as the rules above, plus one genuinely computed check: the
// lightness spread between the three animated hues is a correctness requirement,
// not a taste one, so it is measured rather than described.
describe("activity-dot vocabulary (the OSC 9 states)", () => {
  /** Relative-luminance-and-OKLab-L pair for a #rrggbb token: the greyscale read
   *  and the perceptual-lightness read of the same colour. */
  function lightness(hex: string): { L: number; Y: number } {
    const lin = (i: number): number => {
      const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = [lin(0), lin(1), lin(2)];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
      L: (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * 100,
      Y: (0.2126 * r + 0.7152 * g + 0.0722 * b) * 100,
    };
  }
  const token = (name: string): string => {
    const m = new RegExp(`--status-${name}:\\s*(#[0-9a-f]{6})`).exec(tokens);
    expect(m, `--status-${name} declared as a hex in 00-tokens.css`).not.toBeNull();
    return m?.[1] ?? "";
  };

  it("spreads the three animated hues across lightness (deuteranopia + greyscale)", () => {
    // warning / working / failed differ ONLY in hue, so hue is the one channel a
    // colour-blind user may not have. Ordered, well-separated lightness is what
    // keeps them three states instead of one: yellow brightest, blue mid, red
    // darkest, in both the perceptual and the greyscale read.
    const warning = lightness(token("warning"));
    const working = lightness(token("working"));
    const failed = lightness(token("failed"));
    expect(warning.L).toBeGreaterThan(working.L + 8);
    expect(working.L).toBeGreaterThan(failed.L + 8);
    expect(warning.Y).toBeGreaterThan(working.Y + 8);
    expect(working.Y).toBeGreaterThan(failed.Y + 8);
  });

  it("gives warning and failed working's exact animation, and no ring", () => {
    // One progress indicator with several states: one shared rule, one shared
    // overlay, one shared pair of keyframes, hue the only difference. A ring
    // would be a lie — the frozen ring is input's exclusive "blocked, waiting
    // on you".
    const shared =
      /\[data-status="working"\],\s*:where\(\.wt-root\) \.wt-status-dot\[data-status="warning"\],\s*:where\(\.wt-root\) \.wt-status-dot\[data-status="failed"\]\s*\{([^}]*)\}/.exec(
        tabs,
      );
    expect(shared, "working/warning/failed share one paint rule").not.toBeNull();
    // The disc is STATIC and promoted to its own compositing layer (nested
    // overlay/wave layers snap to device pixels WITH it, not independently —
    // the off-centre-pulse bug); the beat lives on the ::before overlay.
    expect(shared![1]).toContain("transform: translateZ(0)");
    expect(shared![1]).not.toContain("animation");
    expect(shared![1]).not.toContain("box-shadow");
    for (const state of ["warning", "failed"]) {
      // The ONE difference, as its own single-declaration rule.
      expect(tabs).toContain(
        `:where(.wt-root) .wt-status-dot[data-status="${state}"] {\n  --dot-color: var(--status-${state});\n}`,
      );
    }
    // The glow beat: a shared compositor-only overlay — opacity keyframes on a
    // pre-painted bright radial whose edge is FEATHERED (a hard edge shows any
    // half-pixel layer snap as an off-centre pulse at 9px).
    const overlay =
      /\[data-status="working"\]::before,\s*:where\(\.wt-root\) \.wt-status-dot\[data-status="warning"\]::before,\s*:where\(\.wt-root\) \.wt-status-dot\[data-status="failed"\]::before\s*\{([^}]*)\}/.exec(
        tabs,
      );
    expect(overlay, "working/warning/failed share one glow overlay").not.toBeNull();
    expect(overlay![1]).toContain("animation: wt-working-glow");
    expect(overlay![1]).toContain("radial-gradient");
    expect(overlay![1]).toContain("color-mix(in oklch, var(--dot-color) 78%, #fff)");
    // The keyframes animate OPACITY only — never a paint property, which would
    // silently reintroduce the per-frame repaint this shape exists to remove.
    const beat = /@keyframes wt-working-glow\s*\{([\s\S]*?)\n\}/.exec(tabs);
    expect(beat, "wt-working-glow keyframes exist").not.toBeNull();
    expect(beat![1]).toContain("opacity");
    expect(beat![1]).not.toContain("background");
    expect(beat![1]).not.toContain("border");
    // The travelling wave is shared too, and takes its hue from the same variable.
    expect(tabs).toContain('[data-status="warning"]::after');
    expect(tabs).toContain('[data-status="failed"]::after');
    expect(tabs).toContain("var(--dot-color) 76%");
  });

  it("paints crashed as a SOLID static red disc", () => {
    // Solid, not hollow: there is no "hollow means no process" invariant (idle is
    // hollow with a live process). It separates from failed — the same red — by
    // MOTION, so it must carry no animation of its own.
    const rule = /\[data-status="crashed"\]\s*\{([^}]*)\}/.exec(tabs);
    expect(rule, ".wt-status-dot[data-status=crashed] rule exists").not.toBeNull();
    expect(rule![1]).toContain("background: var(--status-failed)");
    expect(rule![1]).toContain("border-color: var(--status-failed)");
    expect(rule![1]).not.toContain("transparent");
    expect(rule![1]).not.toContain("animation");
    expect(rule![1]).not.toContain("box-shadow");
  });

  it("extends the reveal gate and reduced-motion to the new animated states", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(tabs);
    expect(reduced).not.toBeNull();
    const body = reduced?.[1] ?? "";
    for (const state of ["working", "warning", "failed"]) {
      // All three halves: the donut treatment (the state appears in the rule's
      // selector list) and the removal of BOTH animated layers — the glow
      // overlay (::before) and the wave (::after).
      expect(new RegExp(`\\[data-status="${state}"\\](,|\\s*\\{)`).test(body), state).toBe(true);
      expect(body, state).toContain(`[data-status="${state}"]::before`);
      expect(body, state).toContain(`[data-status="${state}"]::after`);
    }
    // The dot is invisible without .wt-reports, whatever its status.
    expect(tabs).toContain(".wt-status-dot.wt-reports");
  });

  it("draws the percentage bar in the ACCENT colour, not a per-state tint", () => {
    const rule = /\.wt-progress-bar\s*\{([^}]*)\}/.exec(tabs);
    expect(rule, ".wt-progress-bar rule exists").not.toBeNull();
    expect(rule![1]).toContain("background: var(--accent)");
    expect(rule![1]).not.toContain("--status-");
    expect(rule![1]).toContain("height: 2px");
    // It is positioned against a chip, so every chip site must be a containing
    // block (the desktop chip, the mobile bar row, an expanded list row)...
    expect(/\.wt-tab\s*\{[^}]*position: relative/.test(tabs)).toBe(true);
    expect(/\.wt-switcher-current\s*\{[^}]*position: relative/.test(switcher)).toBe(true);
    expect(/\.wt-switcher-row-select\s*\{[^}]*position: relative/.test(switcher)).toBe(true);
    // ...and must CLIP, or the bar's square ends poke out through the chip's
    // rounded bottom corners. The bar carries no radius of its own (a 2px box
    // scales every radius to 2px), so the clip is the only thing rounding it.
    expect(/\.wt-tab\s*\{[^}]*overflow: hidden/.test(tabs)).toBe(true);
    expect(/\.wt-switcher-current\s*\{[^}]*overflow: hidden/.test(switcher)).toBe(true);
    expect(/\.wt-switcher-row-select\s*\{[^}]*overflow: hidden/.test(switcher)).toBe(true);
    expect(rule![1]).not.toContain("border-radius");
  });
});

// ---------------------------------------------------------------------------
// The theme-token contract: is the API this package DOCUMENTS actually wired?
//
// `theme` is an open Record, so a consumer's override is a string this library
// copies onto the root and never validates. Two ways that goes silently wrong,
// and only the second needs generated data to catch:
//
//   1. The consumer names a token this library does not declare. Its brand color
//      lands in a dead custom property and the terminal renders in the library's
//      neutral defaults. A consumer can catch this itself by asserting its keys
//      against PUBLIC_THEME_TOKENS.
//   2. This library declares a public token that no rule ever READS. Then the
//      override is accepted, applies to nothing, and BOTH sides are green: the
//      consumer's key is on the documented list, and the list is on the
//      library's declared list. The token looks supported and is dead.
//
// (2) is why the declared/referenced inventory below is generated from the
// stylesheets instead of hand-listed: a hand-maintained list of "tokens we
// support" cannot notice that a rule stopped reading one. web-terminal-kiro's
// app.test.ts used to derive this by reaching into node_modules for this
// package's css/MANIFEST and regexing its comment-stripped text — coupling a
// consumer's suite to this package's file layout and comment syntax, and able to
// silently cover nothing while still passing. The scrape belongs here, where the
// layout is owned.
//
// Scope, deliberately: ONE bundle (css/MANIFEST, the full-page superset) and two
// flat token sets. Not a per-file or per-preset schema. A `presetTouch` embedder
// serves MANIFEST.touch, which has no tab chrome, so it can pass --status-* and
// see nothing — that is a property of what it chose to serve, not a broken
// promise by the tokens, and modelling it would cost more than the bug it finds.

/** Schema revision of the inventory FILE, independent of what it reports. A
 *  reader must reject a version it does not understand rather than guess. */
const CSS_TOKEN_INVENTORY_SCHEMA_VERSION = 1;

/** The checked-in artifact, relative to the package root. Deliberately NOT
 *  under css/ or src/: both are published wholesale, and this file is
 *  verification data, not a contract a consumer may build against. */
const CSS_TOKEN_INVENTORY_PATH = "css-token-inventory.json";

/** Which manifest's bundle the inventory is extracted from. */
const INVENTORY_BUNDLE = "css/MANIFEST";

interface CssTokenInventory {
  readonly schemaVersion: number;
  readonly generatedBy: string;
  readonly bundle: string;
  /** Custom properties some rule DECLARES (`--x: value`), sorted. */
  readonly declared: readonly string[];
  /** Custom properties some rule READS (`var(--x)`), sorted. */
  readonly referenced: readonly string[];
}

/** The manifest's member list, in cascade order. */
function bundleMembers(manifest: string): string[] {
  return manifest
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The bundle as served, with CSS comments stripped so a token that survives
 *  only in PROSE — a doc comment naming a token that was removed from the rule
 *  below it — can never satisfy either assertion. */
function readBundle(): string {
  const members = bundleMembers(readFileSync(path.join(cssDir, "MANIFEST"), "utf8"));
  return members
    .map((name) => readFileSync(path.join(cssDir, name), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Custom properties DECLARED in comment-stripped CSS. Anchored to a line start,
 *  a `{` or a `;` so a name inside `var(...)` cannot be read as a declaration. */
function declaredTokens(css: string): string[] {
  return [...new Set([...css.matchAll(/(?:^|[{;])\s*(--[\w-]+)\s*:/gm)].map((m) => m[1] ?? ""))]
    .filter((name) => name !== "")
    .sort();
}

/** Custom properties READ in comment-stripped CSS. Matches every occurrence, so
 *  nested and `color-mix()`-embedded references count like any other. */
function referencedTokens(css: string): string[] {
  return [...new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] ?? ""))]
    .filter((name) => name !== "")
    .sort();
}

function buildCssTokenInventory(): CssTokenInventory {
  const bundle = readBundle();
  return {
    schemaVersion: CSS_TOKEN_INVENTORY_SCHEMA_VERSION,
    generatedBy: "src/css-contract.test.ts",
    bundle: INVENTORY_BUNDLE,
    declared: declaredTokens(bundle),
    referenced: referencedTokens(bundle),
  };
}

/** The exact bytes of the checked-in artifact: two-space indent and a trailing
 *  newline, which is what `prettier --check` requires of JSON here. Comparing
 *  rendered TEXT rather than parsed objects is what lets the drift guard fail on
 *  a hand edit that happens to parse the same. */
function renderCssTokenInventory(): string {
  return `${JSON.stringify(buildCssTokenInventory(), null, 2)}\n`;
}

const inventoryPath = path.join(packageDir, CSS_TOKEN_INVENTORY_PATH);

function readInventory(): CssTokenInventory {
  return JSON.parse(readFileSync(inventoryPath, "utf8")) as CssTokenInventory;
}

describe("generated CSS token inventory", () => {
  it("matches the checked-in artifact byte for byte", () => {
    // A generated-and-committed file with no guard goes stale the first time
    // someone edits a stylesheet, which is exactly the second-source-of-truth
    // failure it exists to remove. Regenerating through the SAME code path that
    // compares is what keeps the two from ever disagreeing.
    const rendered = renderCssTokenInventory();
    if (process.env["UPDATE_GOLDEN"]) {
      writeFileSync(inventoryPath, rendered, { encoding: "utf8", mode: 0o600 });
    }
    expect(
      readFileSync(inventoryPath, "utf8"),
      `${CSS_TOKEN_INVENTORY_PATH} drifted from css/. Regenerate with: ` +
        "UPDATE_GOLDEN=1 npx vitest --run src/css-contract.test.ts",
    ).toBe(rendered);
  });

  it("pins the schema revision, so a shape change is a deliberate edit", () => {
    expect(CSS_TOKEN_INVENTORY_SCHEMA_VERSION).toBe(1);
    const inventory = readInventory();
    expect(inventory.schemaVersion).toBe(CSS_TOKEN_INVENTORY_SCHEMA_VERSION);
    expect(inventory.bundle).toBe(INVENTORY_BUNDLE);
    expect(Object.keys(inventory)).toEqual([
      "schemaVersion",
      "generatedBy",
      "bundle",
      "declared",
      "referenced",
    ]);
  });

  it("covers the whole manifest bundle, so it cannot pass by covering nothing", () => {
    // The failure mode of a scrape is not a wrong answer, it is an EMPTY one.
    // Every assertion below is satisfied trivially by an inventory extracted
    // from zero files, so the extent of the read is pinned here.
    const members = bundleMembers(readFileSync(path.join(cssDir, "MANIFEST"), "utf8"));
    expect(members.length).toBeGreaterThanOrEqual(12);
    expect(members).toContain("page.css");
    expect(members).toContain("00-tokens.css");
    for (const member of members) {
      expect(readFileSync(path.join(cssDir, member), "utf8").length, member).toBeGreaterThan(0);
    }
    const inventory = readInventory();
    expect(inventory.declared.length).toBeGreaterThanOrEqual(PUBLIC_THEME_TOKENS.length);
    expect(inventory.referenced.length).toBeGreaterThanOrEqual(PUBLIC_THEME_TOKENS.length);
  });

  it("extracts declarations and references without believing comments", () => {
    // The extractors are the whole basis of the assertions below, so they are
    // pinned against a fixture rather than trusted. Each case is a way the
    // regex could quietly over- or under-count.
    const fixture = [
      "/* prose: --ghost-declared: red; and var(--ghost-referenced) */",
      ":root {",
      "  --first: 1px;",
      "  --second: var(--first); --third: 2px;",
      "  color: var( --spaced );",
      "  border: color-mix(in oklch, var(--mixed-a), var(--mixed-b) 25%);",
      "  outline: var(--fallback-outer, var(--fallback-inner));",
      "}",
    ].join("\n");
    const stripped = fixture.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declaredTokens(stripped)).toEqual(["--first", "--second", "--third"]);
    expect(referencedTokens(stripped)).toEqual([
      "--fallback-inner",
      "--fallback-outer",
      "--first",
      "--mixed-a",
      "--mixed-b",
      "--spaced",
    ]);
    // The comment carried both a declaration and a reference, and neither
    // survives stripping — a token kept alive only by its own documentation
    // must not satisfy the contract it is documenting.
    expect(declaredTokens(stripped)).not.toContain("--ghost-declared");
    expect(referencedTokens(stripped)).not.toContain("--ghost-referenced");
  });
});

describe("public theme-token contract", () => {
  it("declares AND reads every token the theme option promises", () => {
    // The assertion that makes the generated inventory worth generating. Both
    // halves fail, for different reasons:
    //   - not declared: the documented API is a lie, and a consumer's override
    //     lands on a property no default exists for.
    //   - declared but never read: the library ACCEPTS the override and it
    //     changes nothing. A token that looks supported and is dead.
    const { declared, referenced } = readInventory();
    for (const token of PUBLIC_THEME_TOKENS) {
      expect(declared, `${token} is a public theme token that css/ never declares`).toContain(
        token,
      );
      expect(
        referenced,
        `${token} is declared but no rule reads it — the override would be a silent no-op`,
      ).toContain(token);
    }
  });

  it("lists each public token once, and none of the internal ones", () => {
    // A duplicate would weaken the loop above into a repeated check of one
    // token; `--dot-color` is the internal indirection the --status-* family is
    // funnelled through, and publishing it would promise a name that exists to
    // be refactored.
    expect([...new Set(PUBLIC_THEME_TOKENS)]).toHaveLength(PUBLIC_THEME_TOKENS.length);
    for (const token of PUBLIC_THEME_TOKENS) {
      expect(token, `${token} must be a custom-property name`).toMatch(/^--[\w-]+$/);
    }
    expect([...PUBLIC_THEME_TOKENS]).not.toContain("--dot-color");
  });

  it("styles the loading-overlay classes a consumer's markup opts in by", () => {
    // These names live in a static HTML file no compiler reads, so a rename
    // here leaves the FIRST screen of every load unstyled with every other test
    // in this package still green.
    const bundle = readBundle();
    for (const className of Object.values(LOADING_OVERLAY_CLASSES)) {
      expect(
        new RegExp(`(^|[\\s,])\\.${className}(?![\\w-])[^{}]*\\{`, "m").test(bundle),
        `.${className} is not styled by any rule in the bundle`,
      ).toBe(true);
    }
  });
});

// The tabs feature listens for the `animationend` of the ONE keyframe name that
// belongs to the switch it started, so it holds a copy of three names that live in
// CSS. A rename on either side is SILENT: the listener stops matching, the class
// comes off on the 360ms fallback instead of the animation's own end, and every
// behavioural test still passes because those tests dispatch the JS constant. This
// is the only place the two languages are compared.
describe("switch-animation name contract (tabs feature vs 40-animations.css)", () => {
  it.each(Object.entries(SWITCH_ANIMATIONS))(
    "declares %s's animation as %s, and defines those keyframes",
    (cls, keyframe) => {
      // The rule the feature's class is expected to activate. Matched loosely on
      // purpose: the selector may gain or lose scoping wrappers, but it must target
      // this class and it must carry an `animation` shorthand.
      // Anchor on the class as a whole name and take the LAST matching rule, since a
      // later rule of equal specificity is the one that wins the cascade and so the
      // one whose animation actually plays.
      const all = [
        ...animations.matchAll(new RegExp(`\\.${cls}(?![\\w-])[^{]*\\{([^}]*)\\}`, "g")),
      ];
      const rule = all.length > 0 ? all[all.length - 1] : null;
      expect(rule, `a rule for .${cls} exists in 40-animations.css`).not.toBeNull();
      const body = rule?.[1] ?? "";
      const decl = /animation:\s*([\w-]+)/.exec(body);
      expect(decl, `.${cls}'s rule declares an animation shorthand`).not.toBeNull();
      expect(decl?.[1], `.${cls} plays the keyframes the feature listens for`).toBe(keyframe);
      // `\b` is NOT a sufficient boundary for a hyphenated identifier: it matches at
      // the hyphen, so `@keyframes wt-switch-in-reduced` satisfies a `wt-switch-in\b`
      // test and the assertion passes on a rename it exists to catch. Proven by
      // executing exactly that rename. Require a non-name character instead.
      expect(
        new RegExp(`@keyframes\\s+${keyframe}(?![\\w-])`).test(animations),
        `@keyframes ${keyframe} is defined, under exactly that name`,
      ).toBe(true);
    },
  );

  it("gives every switch class its OWN keyframes, so one animationend cannot answer for another", () => {
    // The listener's whole discrimination is the name, so two classes sharing one
    // name would make a completed switch able to end the next one.
    const names = Object.values(SWITCH_ANIMATIONS);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the switcher's aggregate cue dot survives every cue-worthy status", () => {
  // The switch button's dot reuses .wt-status-dot for colour and shape, and one
  // of its four cue statuses — `failed` — is ALSO one of 30-tabs.css's three
  // animated progress states. That rule set is specificity (0,2,0) and sets
  // `position: relative`, which beats the dot's own (0,1,0) `position: absolute`
  // badge placement (`:where()` contributes nothing), and it attaches a glow and
  // a travelling-wave pseudo-element. Inherited, `failed` would drop the dot out
  // of the button's corner into its normal flow AND pin a perpetual animation to
  // it for a state that persists until the program's next status change.
  //
  // happy-dom applies no CSS, so the behavioural test in features/tabs cannot see
  // any of that: it asserts data-status and a tooltip, and passes either way. This
  // is the grep-level guard instead, and it is derived from CueStatus rather than a
  // literal list so a fifth cue status cannot be added without answering it.

  /** The animated per-tab states, read out of 30-tabs.css itself rather than
   *  restated, so this cannot drift from the rule it is guarding against. */
  function animatedStates(): Set<string> {
    // A line scan rather than one regex: the rule's selectors are one per line and
    // its brace sits on the last of them, which a single pattern reads badly.
    const lines = tabs.split("\n");
    // Selected by BODY, not by being the first status rule in the file: several
    // status rules open the same way (idle, done, crashed) and only one introduces
    // the `position: relative` the switcher dot needs overridden.
    const opener = lines.findIndex((line, i) => {
      if (!line.includes(".wt-status-dot[data-status=") || !line.trimEnd().endsWith("{")) {
        return false;
      }
      const end = lines.indexOf("}", i);
      const body = lines.slice(i + 1, end === -1 ? i + 12 : end);
      return body.some((l) => l.includes("position: relative"));
    });
    expect(opener, "the animated-state disc rule still exists in 30-tabs.css").toBeGreaterThan(-1);
    // Walk back over the comma-continued selector lines to collect the whole set.
    const found = new Set<string>();
    for (let i = opener; i >= 0; i--) {
      const line = lines[i]!;
      const match = /data-status="([a-z]+)"/.exec(line);
      if (!match) {
        break;
      }
      found.add(match[1]!);
      if (i < opener && !line.trimEnd().endsWith(",")) {
        break;
      }
    }
    return found;
  }

  it("neutralises every cue status that is also an animated per-tab state", () => {
    const animated = animatedStates();
    // Guard the guard: an empty set would make the loop below vacuous.
    expect(animated.size).toBeGreaterThanOrEqual(3);

    const overlap = CUE_SEVERITY.filter((status) => animated.has(status));
    // `failed` is the overlap today. If this is ever empty the override is dead
    // code and should be deleted rather than left to rot.
    expect(overlap.length).toBeGreaterThan(0);

    for (const status of overlap) {
      const selector = `\\.wt-switcher-switch-dot\\[data-status="${status}"\\]`;
      const disc = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(switcher);
      expect(disc, `31-switcher.css overrides the ${status} dot`).not.toBeNull();
      // The badge placement the animated rule would otherwise steal.
      expect(disc![1], `${status}: keeps its badge placement`).toContain("position: absolute");
      expect(disc![1], `${status}: no disc animation`).toContain("animation: none");
      // Both pseudo-element layers must be removed, or the wave still paints.
      for (const pseudo of ["before", "after"]) {
        const rule = new RegExp(`${selector}::${pseudo}[^{]*\\{([^}]*)\\}`).exec(switcher);
        expect(rule, `31-switcher.css removes the ${status} ::${pseudo} layer`).not.toBeNull();
        expect(rule![1], `${status} ::${pseudo}`).toContain("content: none");
      }
    }
  });
});
