# @cplieger/web-terminal-ui

[![npm](https://img.shields.io/npm/v/@cplieger/web-terminal-ui)](https://www.npmjs.com/package/@cplieger/web-terminal-ui)
[![JSR](https://jsr.io/badges/@cplieger/web-terminal-ui)](https://jsr.io/@cplieger/web-terminal-ui)
[![Test coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/web-terminal-ui/badges/coverage.json)](https://github.com/cplieger/web-terminal-ui/actions/workflows/coverage.yml)
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
- a connection-status banner and a copy toast

It is published as TypeScript source (no build step) to npm and JSR, alongside
the CSS bundle and a reference HTML page. Consumers who want a different UI should
depend on the engine directly and skip this package.

## Install

```sh
npm install @cplieger/web-terminal-ui @cplieger/web-terminal-engine
```

`@cplieger/web-terminal-engine` is a peer dependency — the UI is built on the engine,
and both halves of the wire protocol must stay in lockstep, so the consumer
pins the engine version explicitly.

## Usage

Serve the bundled CSS (`css/` concatenated per `css/MANIFEST` into the
`style.css` your page links) plus a minimal HTML page that has one empty
container element for the terminal, then call `createTerminal(root, { features })`
from your entry module. Feature bundles (presets) live at the `./presets`
sub-path:

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
contract for the host page to reproduce. Call it exactly once; the engine's
render/connection/scroll modules are single-instance per page (tabs multiplex
sessions over the one kernel). `scaffold/index.html` is a complete reference page
to copy and adapt.

Four presets are provided (import from `@cplieger/web-terminal-ui/presets`); each
is a plain feature-array factory, so you can spread and edit it, or hand-pick
individual features instead:

- `presetSingle()` — single-pane desktop UI (context menu, clipboard,
  scroll-to-bottom, predictive echo, connection banner).
- `presetTouch()` — `presetSingle()` plus the mobile key toolbar.
- `presetTabbed()` — the generic tabbed UI: `presetTouch()` plus tabs and
  animations. Tabs are label-only (no activity dots); each tab's title follows
  the process window title (OSC 0/2) when the program sets one and keeps it
  updated, otherwise the last command submitted. Requires a server that speaks
  the session API (`/api/sessions` and `/ws?session=`), such as
  `web-terminal-server`.
- `presetAgentTabbed()` — `presetTabbed()` plus the activity monitor, so each
  tab carries a live status dot (idle / working / done / needs-input) from the
  server's status SSE. Same title behavior as `presetTabbed`. For an agent shell
  such as `vibecli`.

### Options

| Option      | Default                    | Purpose                                                                                                                                                               |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features`  | _(none — bare kernel)_     | The feature list. Omitted or empty builds only the terminal (no chrome). Use a preset from `./presets` or a hand-picked array.                                        |
| `wsPath`    | `"/ws"`                    | WebSocket endpoint path the engine connects to.                                                                                                                       |
| `fontReady` | `'14px "MonaspiceNe NFM"'` | CSS font shorthand awaited before the first resize, so the server is sized against the real web font's cell metrics rather than a fallback.                           |
| `loading`   | _(none)_                   | A pre-JS loading overlay element (kept in your served HTML so it paints before this module loads); it is faded out and removed once the first frame renders.          |
| `theme`     | _(none)_                   | Theme overrides (CSS custom properties on the terminal root): `--accent`, `--tab-hover-bg`, `--tab-active-bg`, `--tab-active-fg`. The library ships neutral defaults. |

`createTerminal()` returns a handle: `focus()` re-focuses the terminal input
(and opens the soft keyboard on touch), and `destroy()` tears every feature down
and releases the kernel.

## What ships

| Path                     | Purpose                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `src/**/*.ts`            | The UI modules: the kernel (`kernel/`), opt-in features (`features/`), presets, IME, predictive echo, viewport. |
| `css/*.css` + `MANIFEST` | The default theme + layout; concatenate in MANIFEST order.                                                      |
| `scaffold/index.html`    | A reference HTML page: `<head>` + one empty root element + importmap.                                           |

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
- [`vibecli`](https://github.com/cplieger/vibecli)

## Disclaimer

This project is built with care and follows security best practices, but it is intended for personal / self-hosted use. No guarantees of fitness for production environments. Use at your own risk.

This project was built with AI-assisted tooling using [Claude Opus](https://www.anthropic.com/claude) and [Kiro](https://kiro.dev). The human maintainer defines architecture, supervises implementation, and makes all final decisions.

## License

GPL-3.0-or-later. See `LICENSE`.
