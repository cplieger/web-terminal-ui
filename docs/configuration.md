# Options and the terminal handle

This page lists every `createTerminal` option, the handle it returns and the theme tokens, for a developer tuning the terminal beyond the preset defaults.

## Every option

| Option              | Default                      | Purpose                                                                                                                                               |
| ------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features`          | _(none, the bare terminal)_  | A function returning the feature list. Pass a preset by name or a factory of your own. Omitted builds only the terminal, with no chrome               |
| `layout`            | `"viewport"`                 | `"viewport"` makes the root a fixed full-viewport box. `"container"` fills your container element, which becomes the styling and positioning boundary |
| `wsPath`            | `"/ws"`                      | The WebSocket endpoint path the engine connects to                                                                                                    |
| `fontReady`         | `'14px "Monaspace Neon NF"'` | The CSS font shorthand awaited, for at most 3 seconds, before the first resize. See [Waiting for the font](#waiting-for-the-font)                     |
| `scrollbackLines`   | _(engine default)_           | Retained scrollback lines per terminal and per tab. See [Scrollback size](#scrollback-size)                                                           |
| `persistScrollback` | _(off)_                      | Storage you supply to keep each session's scrollback across a page reload. See [Keeping scrollback across a reload](scrollback-persistence.md)        |
| `loading`           | _(none)_                     | The pre-JS loading overlay element, faded out and removed once the first frame renders                                                                |
| `loadingMessages`   | _(library wording)_          | Rewords the overlay's slow-start status lines. Anything omitted keeps the default                                                                     |
| `onFatalError`      | _(built-in Reload panel)_    | Called with a `TerminalStartupFailure` after a fatal startup failure. See [Startup failures](failure-handling.md#startup-failures)                    |
| `onSessionEnded`    | _(none)_                     | Called when the active session's process has ended and nothing is retrying. See [When a session ends](failure-handling.md#when-a-session-ends)        |
| `theme`             | _(none)_                     | CSS custom properties set on the terminal root. See [Themes](#themes)                                                                                 |
| `split`             | `false`                      | Two panes side by side, opened from the tab chrome. Needs the tabs feature. See [Split view](split-view.md)                                           |

`features` is a function rather than an array so that a preset which throws does so inside the library's startup-failure handling. A preset that takes arguments is written `features: () => presetTabbed({ attentionIcons: true })`.

## The terminal handle

`createTerminal()` returns a handle with these methods:

- `focus()` focuses the terminal input, which opens the soft keyboard on a touchscreen.
- `send(bytes)` sends bytes to the active session through the same input path as typing. Use it for a "type this command" button.
- `reset()` drops the local scrollback and screen. It types nothing, so send a redraw key such as Ctrl+L yourself if you want a fresh prompt.
- `reattach()` connects again to whatever the server serves now, for a session that has ended. See [When a session ends](failure-handling.md#when-a-session-ends).
- `destroy()` tears every feature down and releases the terminal.

With `split: true` the handle also carries `split`, the controller described in [Split view](split-view.md). In a split, `focus()`, `send()`, `reset()` and `reattach()` act on the selected pane.

## Waiting for the font

The terminal waits for the `fontReady` font before its first resize. The server is then sized against the web font's real cell metrics rather than a fallback. Name only the family that carries those metrics. The Web Terminal Glyphs overlay copies Monaspace's metrics and has no letter for the width probe to measure. Naming it too would let WebKit finish the wait on the overlay alone while Monaspace is still loading. WebKit is Safari and every iOS browser.

The wait ends after 3 seconds whatever the fonts do, which is the `font-display: block` period the bundled faces declare. A stalled request leaves the terminal sized on fallback metrics rather than never sized at all. A font that lands later costs one corrective resize.

## Scrollback size

`scrollbackLines` bounds the scrollback each terminal keeps, and each tab under the tabs feature. It is the page's largest memory setting. It bounds the styled text each session keeps and the DOM rows the renderer keeps, one row element per retained line. Safari on iOS reclaims a page under memory pressure, so a host there can pass a smaller value and accept a shorter scrollback.

The budget never evicts the visible screen. A value at or below the terminal height keeps the full screen with no scrollback. Choose a value a few times the tallest expected terminal. Near or below that height, the batched eviction falls back to one line at a time. Non-integer and non-positive values are ignored.

Left unset, the engine decides. It keeps 5000 lines against a server that cannot serve history back. Once a server declares demand-paged scrollback, it keeps a 1500-line tail plus a cache filled on demand. Leave it unset if you can. The depth then lives on the server, and the phone holds a working set. An explicit value opts out of that switch and holds in both cases.

## Themes

`theme` sets CSS custom properties on the terminal root, so you can recolor the UI without shipping CSS. The library ships neutral defaults. The supported keys are:

- `--accent`
- `--tab-bg`, `--tab-hover-bg`, `--tab-active-bg`, `--tab-active-fg` and `--tab-active-border`
- the activity-dot palette `--status-working`, `--status-done`, `--status-input`, `--status-warning` and `--status-failed`

If you recolor `--status-working`, `--status-warning` and `--status-failed`, keep their lightness apart. The three differ only in hue, so replacements of equal lightness look the same in greyscale and to a reader with deuteranopia.

### Checking your theme keys

`theme` accepts any key and sets it on the root as written. A key the library renamed or retired is therefore a live declaration that nothing reads. You get no error, only the library's defaults where your colors should be. The supported keys are published as data, so your own test can check them:

```ts
import { PUBLIC_THEME_TOKENS } from "@cplieger/web-terminal-ui/style-contract";
// or from the package root. The subpath imports nothing and touches no DOM,
// so a Node script can read it too.

for (const key of Object.keys(MY_THEME)) {
  expect(PUBLIC_THEME_TOKENS).toContain(key); // your test, our list
}
```

This package's tests guarantee that a shipped rule both declares and reads every token on that list, so setting it changes what renders. That second half is the one you cannot check from outside. A key not on the list is internal and may be renamed without a release note.
