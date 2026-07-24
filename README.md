# @cplieger/web-terminal-ui

[![npm](https://img.shields.io/npm/v/@cplieger/web-terminal-ui)](https://www.npmjs.com/package/@cplieger/web-terminal-ui)
[![JSR](https://jsr.io/badges/@cplieger/web-terminal-ui)](https://jsr.io/@cplieger/web-terminal-ui)
[![Test coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/web-terminal-ui/badges/coverage.json)](https://github.com/cplieger/web-terminal-ui/actions/workflows/coverage.yml)
[![Mutation (TS)](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/web-terminal-ui/badges/mutation-ts.json)](https://github.com/cplieger/web-terminal-ui/issues?q=label%3Astryker-tracker)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13431/badge)](https://www.bestpractices.dev/projects/13431)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/cplieger/web-terminal-ui/badge)](https://scorecard.dev/viewer/?uri=github.com/cplieger/web-terminal-ui)

The reference touch-first browser UI for
[`@cplieger/web-terminal-engine`](https://github.com/cplieger/web-terminal-engine) — the part
that turns the engine's render/scroll/connection/keyboard modules into a
usable terminal on a phone as well as a desktop.

One `createTerminal(root, { features })` call builds the entire terminal UI
inside a single container element you provide. A small always-present kernel
(the display output, the hidden keyboard textarea, IME, engine wiring, the
sanitizing input funnel, connection-state, and named layout regions) composes
with opt-in feature modules that own everything above the raw terminal:

- a **display-only** terminal output (native text selection survives redraws)
  and a hidden `<textarea>` that owns the keyboard and IME (the kernel)
- **tabs**: multiple independent terminals with a desktop strip, a mobile
  bottom switcher, and a modal overview sheet
- an **activity monitor** that drives per-tab status dots (working / idle /
  needs-input / exited) from the server's status stream
- a **mobile key toolbar** (Tab / Esc / arrows / Enter / sticky-Ctrl) and a
  scroll-to-bottom control
- a **context menu** (Copy / Select All / Paste), reachable by right-click and
  by long-press on touch
- **predictive local echo**, **IME / composition** (CJK, dictation,
  autocorrect), and **viewport + keyboard-inset** handling for the iOS soft
  keyboard, rotation, and font-load reflows
- a connection-status banner, including a persistent protocol-incompatibility
  state, and a copy toast

It is published as TypeScript source (no build step) to npm and JSR, alongside
the CSS bundle and a reference HTML page. Consumers who want a different UI should
depend on the engine directly and skip this package.

## Install

```sh
npm install @cplieger/web-terminal-ui @cplieger/web-terminal-engine
```

`@cplieger/web-terminal-engine` is a peer dependency — the UI is built on the
engine, so the consumer pins the engine version explicitly. Pairing compatibility
is governed by the engine's
[directional wire contract](https://github.com/cplieger/web-terminal-engine#wire-protocol),
not strict package-version equality; the UI surfaces a terminal incompatibility
through its connection banner.

## Usage

Serve a CSS bundle matching how you embed the terminal, plus a minimal HTML
page that has one empty container element, then call
`createTerminal(root, { features })` from your entry module.

**Full-page host** (the terminal IS the page — `web-terminal-server`,
`web-terminal-kiro`): concatenate `css/MANIFEST` into the `style.css` your page
links. That reference bundle is `css/page.css` (the page kit: `html/body`
reset + the terminal web font's `@font-face`, expecting the font files at
`/vendor/fonts/`) plus the complete component set.

**Embedder** (the terminal lives inside your app's layout — a panel, a pane):
concatenate the per-preset manifest matching your composition instead —
`css/MANIFEST.single`, `css/MANIFEST.touch`, or `css/MANIFEST.tabbed`. These
contain ONLY root-scoped component styles: no page reset, no fonts, no
document-level rules, nothing to quarantine. Pass `layout: "container"` so the
terminal fills (and positions its chrome against) your container element
instead of the viewport.

Feature bundles (presets) live at the `./presets` sub-path, with per-preset
entry modules beside it:

```html
<div id="terminal"></div>
<div id="loading">Loading…</div>
<script type="importmap">
  {
    "imports": {
      "@cplieger/web-terminal-engine": "/vendor/cplieger-web-terminal-engine/index.js",
      "@cplieger/web-terminal-ui": "/vendor/cplieger-web-terminal-ui/index.js",
      "@cplieger/web-terminal-ui/presets": "/vendor/cplieger-web-terminal-ui/presets.js"
    }
  }
</script>
<script type="module">
  import { createTerminal } from "@cplieger/web-terminal-ui";
  import { presetTabbed } from "@cplieger/web-terminal-ui/presets";
  createTerminal(document.getElementById("terminal"), {
    features: presetTabbed(),
    loading: document.getElementById("loading"),
  });
  // or, for a server that exposes the WebSocket elsewhere / a custom font:
  // createTerminal(root, { features: presetTabbed(), wsPath: "/api/shell/ws", fontReady: '14px "MyMono"' });
</script>
```

`createTerminal(root, opts?)` builds the entire terminal subtree (the kernel
plus every feature's chrome) inside `root` itself — there is no element-id
contract for the host page to reproduce, and every style and CSS custom
property is scoped to the `wt-root` class it stamps on your element (removed
again by `destroy()`). Call it exactly once; the engine's
render/connection/scroll modules are single-instance per page (tabs multiplex
sessions over the one kernel). `scaffold/index.html` is a complete reference page
to copy and adapt.

Four presets are provided; each is a plain feature-array factory, so you can
spread and edit it. Import the barrel (`@cplieger/web-terminal-ui/presets`) for
convenience, or a per-preset entry module for the minimal delivered import
graph — `…/presets/single`, `…/presets/touch`, `…/presets/tabbed`,
`…/presets/agent-tabbed` (the barrel statically reaches every feature; the
touch entry, for example, never imports the tabs module). Individual features
are importable from `…/features/<name>` (`clipboard`, `context-menu`,
`scroll-to-bottom`, `predictive-echo`, `connection-banner`, `mobile-toolbar`,
`tabs`, `activity-monitor`, `animations`) for hand-picked compositions:

- `presetSingle()` — single-pane desktop UI (context menu, clipboard,
  scroll-to-bottom, predictive echo, connection banner).
- `presetTouch()` — `presetSingle()` plus the mobile key toolbar.
- `presetTabbed()` — the generic tabbed UI: `presetTouch()` plus tabs, the
  activity monitor, and animations. Each tab's title is OSC-first — it follows
  the process window title (OSC 0/2) when the program sets one and keeps it
  updated, otherwise the last command submitted. The per-tab activity dot
  reveals itself only when a session reports OSC 9;4 progress, so a plain shell
  keeps clean, label-only tabs. Requires a server that speaks the session API
  (`/api/sessions` and `/ws?session=`), such as `web-terminal-server`.
- `presetAgentTabbed()` — the same feature set as `presetTabbed()` (activity
  monitor included), tuned for an agent shell such as `web-terminal-kiro`: with
  `preferInputTitle`, each tab's label follows the latest submitted line
  (persisted server-side and recovered on reload) and the program's non-empty
  but useless OSC 0/2 title is ignored; and with `presumeReports`, the idle
  activity dot shows from tab creation instead of waiting for the session's
  first OSC 9;4 signal — every session is an agent, so there is nothing to
  prove. Its status dots (idle / working / done / needs-input) come from the
  same activity monitor, driven by the server's status SSE and its OSC-9
  classifier.

### Options

| Option         | Default                    | Purpose                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `features`     | _(none — bare kernel)_     | The feature list. Omitted or empty builds only the terminal (no chrome). Use a preset from `./presets` or a hand-picked array.                                                                                                                                                                                                                                     |
| `layout`       | `"viewport"`               | How the terminal claims space. `"viewport"`: the root becomes a fixed full-viewport box (the full-page product). `"container"`: the root fills your container element, which becomes the styling and positioning boundary (the embedded case).                                                                                                                     |
| `wsPath`       | `"/ws"`                    | WebSocket endpoint path the engine connects to.                                                                                                                                                                                                                                                                                                                    |
| `fontReady`    | `'14px "MonaspiceNe NFM"'` | CSS font shorthand awaited before the first resize, so the server is sized against the real web font's cell metrics rather than a fallback.                                                                                                                                                                                                                        |
| `loading`      | _(none)_                   | A pre-JS loading overlay element (kept in your served HTML so it paints before this module loads); it is faded out and removed once the first frame renders.                                                                                                                                                                                                       |
| `onFatalError` | _(built-in recovery)_      | Called after a fatal feature setup failure has stopped the connection, released the terminal runtime, and cleared the root. It receives `{ phase, feature, cause }`. Return `true` only after rendering replacement recovery UI into the root; otherwise the kernel shows its Reload page surface.                                                                 |
| `theme`        | _(none)_                   | Theme overrides (CSS custom properties on the terminal root): `--accent`, `--tab-bg`, `--tab-hover-bg`, `--tab-active-bg`, `--tab-active-fg`, `--tab-active-border`, plus the activity-dot palette `--status-working`, `--status-done`, `--status-input` (the working ripple and the input ring derive from their own tokens). The library ships neutral defaults. |

`createTerminal()` returns a handle: `focus()` re-focuses the terminal input
(and opens the soft keyboard on touch); `send(bytes)` sends bytes to the active
session through the kernel's sanitizing input funnel (the supported host path
for a "type this command" affordance); `reset()` drops the local scrollback and
screen without injecting keystrokes (send a redraw keystroke yourself if you
want one, for example Ctrl+L); and `destroy()` tears every feature down and
releases the kernel.

If a feature's setup throws or rejects, the kernel stops the connection, tears
down every completed feature and core listener, clears the broken subtree, and
shows a reload surface. The surface is modal when the terminal owns the
viewport and non-modal when it fills an embedded container. `onFatalError`
receives the failure after cleanup; return `true` only when the host has rendered
replacement recovery UI into the terminal root.

## What ships

| Path                    | Purpose                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/**/*.ts`           | The UI modules: the kernel (`kernel/`), opt-in features (`features/`), per-preset entries (`presets/`), IME, predictive echo, viewport.                                                                                   |
| `css/*.css` + manifests | Root-scoped component styles. `MANIFEST` = the reference full-page bundle (`page.css` + the tabbed set); `MANIFEST.single/touch/tabbed` = component-only per-preset bundles for embedders. Concatenate in manifest order. |
| `css/page.css`          | The page kit (full-page hosts only): `html/body` reset + the terminal web font's `@font-face`.                                                                                                                            |
| `scaffold/index.html`   | A reference full-page HTML host: `<head>` + one empty root element + importmap.                                                                                                                                           |

## Related projects

The web-terminal family:

- [`web-terminal-engine`](https://github.com/cplieger/web-terminal-engine) — the
  Go session engine + TypeScript browser renderer this UI is built on (peer
  dependency).
- [`web-terminal-server`](https://github.com/cplieger/web-terminal-server) — a
  ready-to-run container that serves this UI over HTTP + WebSocket for any
  command.

Consumers that ship this UI:

- [`vibekit`](https://github.com/cplieger/vibekit)
- [`web-terminal-kiro`](https://github.com/cplieger/web-terminal-kiro)

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
conventions and how to run the checks locally.

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude](https://claude.com), [GPT](https://openai.com), and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
