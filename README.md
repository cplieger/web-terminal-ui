# @cplieger/web-terminal-ui

The reference touch-first browser UI for
[`@cplieger/web-terminal`](https://github.com/cplieger/web-terminal) — the part
that turns the engine's render/scroll/connection/keyboard modules into a
usable terminal on a phone as well as a desktop.

One `mount()` call wires the engine to a small HTML scaffold and owns
everything above the raw terminal:

- a **display-only** `#term-output` (native text selection survives redraws)
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
the CSS bundle and an HTML scaffold. Consumers who want a different UI should
depend on the engine directly and skip this package.

## Install

```sh
npm install @cplieger/web-terminal-ui @cplieger/web-terminal
```

`@cplieger/web-terminal` is a peer dependency — the UI is built on the engine,
and both halves of the wire protocol must stay in lockstep, so the consumer
pins the engine version explicitly.

## Usage

Serve the scaffold (`scaffold/index.html` — copy and adapt it) and the bundled
CSS (`css/` concatenated per `css/MANIFEST` into the `style.css` the scaffold
links), then call `mount()` from your entry module:

```ts
import { mount } from "@cplieger/web-terminal-ui";

mount();
// or, for a server that exposes the WebSocket elsewhere / a custom font:
mount({ wsPath: "/api/shell/ws", fontReady: '14px "MyMono"' });
```

`mount()` expects the scaffold's element ids to exist in the DOM (`term`,
`term-output`, `term-input`, `composition-view`, `pred-cursor`, `loading`,
`conn-banner`, `key-toolbar`, the `kb-*` buttons, `scroll-bottom`, `ctx-menu`)
and throws a clear error if a required one is missing. Call it exactly once —
the UI is single-instance per page.

### Options

| Option      | Default                    | Purpose                                                                                                                                     |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `wsPath`    | `"/ws"`                    | WebSocket endpoint path the engine connects to.                                                                                             |
| `fontReady` | `'14px "MonaspiceNe NFM"'` | CSS font shorthand awaited before the first resize, so the server is sized against the real web font's cell metrics rather than a fallback. |

`mount()` returns a small handle: `{ focus() }` re-focuses the terminal input
(and opens the soft keyboard on touch).

## What ships

| Path                     | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `src/*.ts`               | The UI modules (`mount`, IME, predictive echo, viewport, status). |
| `css/*.css` + `MANIFEST` | The default theme + layout; concatenate in MANIFEST order.        |
| `scaffold/index.html`    | A reference HTML scaffold with the required element ids.          |

## License

GPL-3.0-or-later. See `LICENSE`.
