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
`LICENSE` — they arrive as `chore(sync)` PRs).

## Architecture

The package is a thin UI layer over the engine. The engine owns the VT screen
buffer, the wire protocol, rendering, scrolling, and the WebSocket/resume
lifecycle; this package owns the input model and chrome.

- `kernel/kernel.ts` — the entry (`createTerminal`). Builds the kernel subtree
  plus each listed feature's chrome inside the host root, initializes the engine
  layers (`render` / `scroll` / `connection`), and wires every listener: textarea
  input + keydown, tap-to-focus (pointerup-based to stay inside iOS's user-gesture
  window), and the visibility/pageshow/online reconnect hooks. `createTerminal(root, opts)`
  is the only public export; features live in `features/` and bundles in
  `presets.ts`.
- `composition.ts` — IME / composition (`compositionstart/update/end` + native
  `paste`). Mirrors xterm.js's CompositionHelper; the deferred read at
  `compositionend` is the Chromium-correctness workaround.
- `predict.ts` — predictive local-echo mini-VT. Advances a predicted cursor
  optimistically and **bails (suspends) on any byte it cannot model** — wrong
  predictions are worse than missing ones. It carries unit and property-based
  tests (`predict.test.ts`, `predict.property.test.ts`); the other UI modules
  now have unit tests too.
- `viewport.ts` — coalesces iOS keyboard transitions, resizes, font-load
  reflows, and `ResizeObserver` fires into one transition→settle lifecycle.
- `input-placeholder.ts` — the invisible NBSP placeholder constant
  (`INPUT_PLACEHOLDER`) and its `resetToPlaceholder()` helper, shared by
  the kernel and `composition.ts` so the iOS held-Backspace key-repeat
  workaround stays in lockstep across both.

The public API is whatever `src/index.ts` re-exports, currently `createTerminal`
plus its `CreateTerminalOptions` / `TerminalHandle` / `TerminalFeature` /
`TerminalContext` types (presets from `./presets`). Keep the README's API section in sync.

### The input-model contract (protect this)

The terminal output element is **display-only** and is never focused or made
contenteditable; the hidden `<textarea>` is the single keyboard target. This
split is deliberate and load-bearing: it is what lets the first touch-drag
scroll instead of placing a caret, lets a tap on a sparse screen land on the
full-viewport scroll surface, and lets a text selection survive a redraw. Do
not move keyboard handling onto the output element.

## Local development

Requires Node and npm, plus a sibling checkout of the engine (the UI is built
on the unpublished `@cplieger/web-terminal-engine`).

```sh
npm install                # devDeps; the engine peer is overlaid by verify.sh
npm run verify             # overlay local engine + tsgo (src & tests) + vitest
```

`scripts/verify.sh` copies the local engine's `web/src` into
`node_modules/@cplieger/web-terminal-engine` (gitignored) so `tsgo` and `vitest` can
resolve the bare `@cplieger/web-terminal-engine` specifier before the engine is
published. Point it at a non-default location with `ENGINE_DIR=../web-terminal-engine
npm run verify`. The individual gates are also available:

```sh
npm run typecheck          # tsgo -p tsconfig.json (source)
npm run typecheck:tests    # tsgo -p tsconfig.test.json (includes *.test.ts)
npm test                   # vitest --run
npm run lint:eslint        # strict typed-linting (needs the synced base present)
npm run lint:prettier      # formatting (printWidth 100)
npm run lint:knip          # unused-export / dependency check
```

There is **no build step** — the package ships TypeScript source
(`exports` points at `./src/index.ts`), so `tsgo` stands in for a compile. CI
runs the same battery centrally via cplieger/ci; the `web-lint` job also lints
`css/` (stylelint) and `scaffold/index.html` (html-validate).

### Conventions and gotchas

- **ESM only.** Use `.js` extensions in relative imports (e.g.
  `from "./predict.js"`) even though the files are `.ts` — required for the
  TS-source publish to resolve.
- **Strict TypeScript + strict typed-linting.** `no-explicit-any` is an error,
  `eqeqeq` is enforced, types use inline `import type`. Test files get relaxed
  rules (see `eslint.config.mjs`, which imports the synced base and layers only
  the `*.mjs` delta — never copy the base inline).
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
messages follow [Conventional Commits](https://www.conventionalcommits.org/) —
git-cliff parses them for the changelog and version bump, so write the subject
as the changelog line you want (`feat: add a paste size cap`,
`fix: clamp context menu above the keyboard inset`).

## Conduct & security

By participating you agree to the
[Code of Conduct](https://github.com/cplieger/.github/blob/main/CODE_OF_CONDUCT.md).
Report security issues through the
[security policy](https://github.com/cplieger/.github/blob/main/SECURITY.md) —
never in a public issue.
