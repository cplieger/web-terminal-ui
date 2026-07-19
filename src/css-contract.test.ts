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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cssDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "css");
const tokens = readFileSync(path.join(cssDir, "00-tokens.css"), "utf8");
const terminal = readFileSync(path.join(cssDir, "02-terminal.css"), "utf8");

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
});
