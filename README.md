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

One `mount(root)` call builds the entire terminal UI inside a single container
element you provide and owns everything above the raw terminal:

- a **display-only** terminal output (native text selection survives redraws)
- a hidden `<textarea>` that owns the keyboard, the local typing buffer, and IME
- a **mobile key toolbar** (Tab / Esc / arrows / Enter / sticky-Ctrl) and a
  scroll-to-bottom control
- a **viewport-clamped context menu** (Copy / Select All / Paste)
- **predictive local echo** so the cursor moves on keypress even on a slow link
- **IME / composition** handling (CJK, dictation, autocorrect)
- **viewport + keyboard-inset** handling for the iOS soft keyboard, rotation,
  and font-load reflows
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
container element for the terminal, then call `mount(root)` from your entry
module:

```html
<div id="terminal"></div>
<div id="loading">Loading…</div>
<script type="importmap">
  {
    "imports": {
      "@cplieger/web-terminal-engine": "/vendor/cplieger-web-terminal-engine/index.js",
      "@cplieger/web-terminal-ui": "/vendor/cplieger-web-terminal-ui/index.js"
    }
  }
</script>
<script type="module">
  import { mount } from "@cplieger/web-terminal-ui";
  mount(document.getElementById("terminal"), {
    loading: document.getElementById("loading"),
  });
  // or, for a server that exposes the WebSocket elsewhere / a custom font:
  // mount(root, { wsPath: "/api/shell/ws", fontReady: '14px "MyMono"' });
</script>
```

`mount(root, opts?)` builds the entire terminal subtree (the display output,
the hidden keyboard textarea, the mobile key toolbar, the status banner, and
the context menu) inside `root` itself — there is no element-id contract for
the host page to reproduce. Call it exactly once; the module state is
single-instance per page. `scaffold/index.html` is a complete reference page to
copy and adapt.

### Options

| Option      | Default                    | Purpose                                                                                                                                                            |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wsPath`    | `"/ws"`                    | WebSocket endpoint path the engine connects to.                                                                                                                    |
| `fontReady` | `'14px "MonaspiceNe NFM"'` | CSS font shorthand awaited before the first resize, so the server is sized against the real web font's cell metrics rather than a fallback.                        |
| `loading`   | _(none)_                   | A pre-JS loading overlay element (kept in your served HTML so it paints before this module loads); mount fades it out and removes it once the first frame renders. |

`mount()` returns a small handle: `{ focus() }` re-focuses the terminal input
(and opens the soft keyboard on touch).

## What ships

| Path                     | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `src/*.ts`               | The UI modules (`mount`, IME, predictive echo, viewport, status).     |
| `css/*.css` + `MANIFEST` | The default theme + layout; concatenate in MANIFEST order.            |
| `scaffold/index.html`    | A reference HTML page: `<head>` + one empty root element + importmap. |

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

## License

GPL-3.0-or-later. See `LICENSE`.
