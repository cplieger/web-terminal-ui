# Contributing to web-terminal-ui

`@cplieger/web-terminal-ui` is the reference touch-first browser UI built on the
[`@cplieger/web-terminal-engine`](https://github.com/cplieger/web-terminal-engine) engine,
published as TypeScript source to npm and JSR. This guide covers the
architecture, the local workflow, and the conventions a contributor needs;
org-wide defaults are inherited from
[cplieger/.github](https://github.com/cplieger/.github), and the shared CI/lint
configuration is synced from [cplieger/ci](https://github.com/cplieger/ci) (do
not hand-edit `.editorconfig`, `.prettierrc.json`, `.stylelintrc.json`,
`.htmlvalidate.json`, `eslint.config.base.mjs`, `cliff.toml`, the workflows, or
`LICENSE`; they arrive as `chore(sync)` PRs).

## Architecture

The package is a thin UI layer over the engine. The engine owns the VT screen
buffer, the wire protocol, rendering, scrolling, and the WebSocket/resume
lifecycle; this package owns the input model and chrome.

- `kernel/kernel.ts`: the entry (`createTerminal`). Builds the kernel subtree
  plus each listed feature's chrome inside the host root, initializes the engine
  layers (`render` / `scroll` / `connection`), and wires every listener: textarea
  input + keydown, tap-to-focus (pointerup-based to stay inside iOS's user-gesture
  window), and the visibility/pageshow/online reconnect hooks. `createTerminal(root, opts)`
  is the only public export; features live in `features/` and preset bundles in
  `presets.ts` plus the per-preset entries in `presets/`.
- `composition.ts`: IME / composition (`compositionstart/update/end` + native
  `paste`). Mirrors xterm.js's CompositionHelper; the deferred read at
  `compositionend` is the Chromium-correctness workaround.
- `predict.ts`: predictive local-echo mini-VT. Advances a predicted cursor
  optimistically and **bails (suspends) on any byte it cannot model**; wrong
  predictions are worse than missing ones. It carries unit and property-based
  tests (`predict.test.ts`, `predict.property.test.ts`); the other UI modules
  have unit tests too.
- `viewport.ts`: coalesces iOS keyboard transitions, resizes, font-load
  reflows, and `ResizeObserver` fires into one transition→settle lifecycle.
- `input-placeholder.ts`: the invisible NBSP placeholder constant
  (`INPUT_PLACEHOLDER`) and its `resetToPlaceholder()` helper, shared by
  the kernel and `composition.ts` so the iOS held-Backspace key-repeat
  workaround stays in lockstep across both.

The public API is whatever `src/index.ts` re-exports: `createTerminal` plus the
option, handle, feature, and context types around it (presets from `./presets`).
Keep the README's API section in sync.

### The input-model contract (protect this)

The terminal output element is **display-only** and is never focused or made
contenteditable; the hidden `<textarea>` is the single keyboard target. This
split is deliberate and load-bearing: it is what lets the first touch-drag
scroll instead of placing a caret, lets a tap on a sparse screen land on the
full-viewport scroll surface, and lets a text selection survive a redraw. Do
not move keyboard handling onto the output element.

## Local development

Requires Node and npm, plus a sibling checkout of the engine (local checks run
against your working-tree engine, not a published snapshot).

```sh
npm install                # devDeps; the engine peer is overlaid by verify.sh
npm run verify             # overlay local engine + tsc (src & tests) + vitest
```

`scripts/verify.sh` copies the local engine's `web/src` into
`node_modules/@cplieger/web-terminal-engine` (gitignored) so `tsc` and `vitest`
resolve the bare `@cplieger/web-terminal-engine` specifier against your local
engine checkout. Point it at a non-default location with `ENGINE_DIR=../web-terminal-engine
npm run verify`. The individual gates are also available:

```sh
npm run typecheck          # tsc -p tsconfig.json (source)
npm run typecheck:tests    # tsc -p tsconfig.test.json (includes *.test.ts)
npm test                   # vitest --run
npm run lint:eslint        # strict typed-linting (needs the synced base present)
npm run lint:prettier      # formatting (printWidth 100)
npm run lint:knip          # unused-export / dependency check
```

There is **no build step**: the package ships TypeScript source
(`exports` points at `./src/index.ts`), so `tsc` stands in for a compile. CI
runs the same battery centrally via cplieger/ci; the `web-lint` job also lints
`css/` (stylelint) and `scaffold/index.html` (html-validate).

### Verifying chip geometry

Run this before changing anything about chip-label geometry, the label font
sizes, the chip's spacing, or the bundled font:

```sh
node scripts/verify-chip-geometry.mjs --font /path/to/MonaspaceNeonNF-Regular.woff2
```

It renders the real CSS bundle and the real `src/features/tabs/ink-centre.ts` in
WebKit, Blink and Gecko, sweeps the label size across the ascent/descent
rounding boundaries, and asserts two invariants at both chip sites: each label's
visible ink centres on its chip within 0.05px, and the gap from the chip's inner
edge to the activity dot equals the gap from the dot to the label. Four earlier
fixes to the centring shipped a hardcoded correction constant and each was wrong
somewhere else, and the dot's gaps sat 8px against 6px for as long. Both classes
are invisible to the rest of the battery: sub-pixel or single-pixel, and only
visible at a size or in an engine the author did not happen to open. The unit
suite runs in a real headless Chromium and does measure real layout, but only in
Chromium and only at the one viewport the config pins.

This script is not wired into CI: it drives three engines (~300 MB of browsers)
and the `validate` gate is deliberately cheap. The unit suite's own Chromium
arrives with the `playwright` devDependency, so Blink is now available in CI if
this is ever wired up; WebKit and Gecko still are not. The script resolves
`playwright-core` from the sibling engine checkout, the same way `verify.sh`
reaches for the local engine; override with `PLAYWRIGHT_DIR`. Once
per machine: `npx playwright install webkit chromium firefox`. Without `--font`
it measures the platform monospace instead, which is a useful second case since
the correction must not depend on the font.

### Conventions and gotchas

- **Tests run in a real browser by default; `.node.test.ts` is the opt-out.**
  `vitest --run` has two projects: `browser`, a headless Chromium at a pinned
  1280x720 viewport, which takes every `src/**/*.test.ts`; and `node`, which takes
  only `src/**/*.node.test.ts`. Use the suffix ONLY for a test that needs a Node
  capability — a `node:fs` read, a golden written under `UPDATE_GOLDEN=1` — because
  that is the case which fails loudly when it is misplaced. A test whose subject is
  a browser capability being ABSENT (`document.fonts`, `screen.orientation`,
  `navigator.setAppBadge`) does NOT belong in the node project: Node has no
  `document` either, so it would pass for a third wrong reason. Keep it in the
  browser project and shadow the one capability at the site with an own
  `undefined`, restoring the captured descriptor afterwards. A plain `delete`
  cannot create absence for anything defined on a prototype — it drops your shadow
  and re-exposes the real API for whatever test runs next.
- **Never hardcode a font-metric constant.** Engines round a font's ascent and
  descent to whole CSS pixels before laying out a line box, so anything derived
  from them is a sawtooth in font size, not a ratio: the shift a 14px label needs
  is 1.29px in Blink and WebKit and 1.76px in Gecko, and the same font at 13px
  needs 1.55px in Blink. Measure it in the engine (`ink-centre.ts`) and treat any
  constant in the stylesheet as a pre-measurement default only.
- **ESM only.** Use `.js` extensions in relative imports (e.g.
  `from "./predict.js"`) even though the files are `.ts`; required for the
  TS-source publish to resolve.
- **Strict TypeScript + strict typed-linting.** `no-explicit-any` is an error,
  `eqeqeq` is enforced, types use inline `import type`. Test files get relaxed
  rules (see `eslint.config.mjs`, which imports the synced base and layers only
  the `*.mjs` delta; never copy the base inline).
- **`predict.ts` is the testable core.** When changing it, run the suite and add
  cases rather than weakening the bail rules.

## Publishing

Releases are automated. A push to `main` triggers the central release pipeline,
which computes the version from commit history with git-cliff and publishes the
TS source to npm and JSR. The engine and this package release in lockstep when
the wire protocol changes. The `version` field in `package.json` / `jsr.json`
is only a baseline; do not bump it by hand.

## Commits and PRs

Branch from `main`, keep changes focused with tests, and open a PR. Commit
messages follow [Conventional Commits](https://www.conventionalcommits.org/):
git-cliff parses them for the changelog and version bump, so write the subject
as the changelog line you want (`feat: add a paste size cap`,
`fix: clamp context menu above the keyboard inset`).

## Conduct & security

By participating you agree to the
[Code of Conduct](https://github.com/cplieger/.github/blob/main/CODE_OF_CONDUCT.md).
Report security issues through the
[security policy](https://github.com/cplieger/.github/blob/main/SECURITY.md),
never in a public issue.
