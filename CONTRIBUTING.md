# Contributing to web-terminal-ui

The [shared rules](https://github.com/cplieger/.github/blob/main/CONTRIBUTING.md) for commits, releases, synced files and checks apply here.

## Rules

- `package.json` declares the `exports` map and the engine version range in `peerDependencies`, and `jsr.json` repeats both, the range in its `imports` map. Change them together, or npm and JSR publish packages that resolve differently.
- A new stylesheet goes in `css/MANIFEST` and in each per-preset manifest whose preset includes the feature it styles. A file no manifest lists ships in the package and reaches no host's stylesheet.
- To test without a browser capability such as `document.fonts`, shadow it with an own `undefined` property and restore the saved descriptor afterwards. A plain `delete` cannot remove a prototype property, so the test runs against the real API.

## Checks

When your change needs an engine change that is not published yet, run `npm run verify`. It runs the type checks and tests against the engine source in `../web-terminal-engine`, or in the engine checkout that `ENGINE_DIR` names.

CI installs the published engine from `package-lock.json`, so such a change fails there until that engine version is released and in the lock file.

Run `node scripts/verify-chip-geometry.mjs --font <path to MonaspaceNeonNF-Regular.woff2>` before you change chip-label geometry, the label font sizes, the chip's spacing or the font. CI does not run it, and the unit suite measures layout in Chromium at one viewport only.

The script drives WebKit, Blink and Gecko, so install them once with `npx playwright install webkit chromium firefox`. It finds `playwright-core` in the sibling engine checkout, or in this repository with `PLAYWRIGHT_DIR=node_modules`.

## Releases

When the wire protocol changes, the engine and this package release together.
