# Setting up the host page

This page covers what your page serves and how it calls `createTerminal`, for a developer wiring web-terminal-ui into a full page or into an existing application layout.

## How the terminal is built

`createTerminal(target, { features })` builds the whole terminal UI inside one container element you provide. A small core is always present and owns the terminal itself. Feature modules you pick add everything around it, such as tabs, the key bar and the context menu.

The core shows terminal output in a display-only element, so native text selection survives redraws. A hidden `<textarea>` owns the keyboard and the IME. [Keyboard, mouse and touch input](input.md) explains what that split means for a host page.

## The engine version

`@cplieger/web-terminal-engine` is a peer dependency, so your page pins the engine version itself. The supported range is 6.x. Whether an engine and this UI can talk is decided by the engine's [wire contract](https://github.com/cplieger/web-terminal-engine#wire-protocol), not by matching package versions. When the two cannot talk, the connection banner stays up and asks the user to update the server or reload the page.

## Choose the CSS bundle

The CSS ships as separate files plus manifests that list them. Concatenate the files a manifest names, in the order it names them, because that order is the cascade.

### A full-page terminal

When the terminal is the whole page, as in web-terminal-server and web-terminal-kiro, concatenate `css/MANIFEST` into the `style.css` your page links. It holds `css/page.css` and the complete component set.

`css/page.css` is the page kit. It resets `html` and `body`, styles the loading overlay and declares the `@font-face` rules for two font families, expecting the font files at `/vendor/fonts/`:

- The four `MonaspaceNeonNF-*.woff2` faces back both the terminal display and the chrome text. A full-page host must serve them.
- `WebTerminalGlyphs.woff2` is a tiling overlay that draws the box-drawing, block, braille and powerline cells. Serve it with that font's `LICENSE` and `NOTICE` beside it.

A host that does not serve the overlay file still works. That face fails to load, and the terminal draws those cells from Monaspace and the system font instead.

### A terminal inside your own layout

When the terminal is a panel or a pane in your application, concatenate the manifest that matches your preset: `css/MANIFEST.single`, `css/MANIFEST.touch` or `css/MANIFEST.tabbed`. These hold only component styles scoped to the terminal root. They carry no page reset, no fonts and no document-level rules.

Chrome text then falls back to your platform's monospace font. Declare the `@font-face` rules yourself if you want the panel to match the full-page look. Pass `layout: "container"` so the terminal fills your container element and positions its chrome against it instead of the viewport.

## Load the modules

The package ships TypeScript source. Your build compiles it with the rest of your TypeScript, and an import map resolves the bare specifiers to the JavaScript your build emits:

```html
<div id="terminal"></div>
<div
  id="loading"
  class="wt-loading"
  role="status"
  aria-label="Loading"
>
  <div
    class="wt-loading-bar"
    aria-hidden="true"
  ></div>
</div>
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
  createTerminal("#terminal", {
    features: presetTabbed,
    loading: document.getElementById("loading"),
  });
  // For a server that exposes the WebSocket elsewhere, or a custom font:
  // createTerminal("#terminal", { features: presetTabbed, wsPath: "/api/shell/ws", fontReady: '14px "MyMono"' });
</script>
```

`scaffold/index.html` is a complete reference page to copy and adapt.

## Call createTerminal

`target` is a CSS selector or an element. From a page, pass a selector such as `"#terminal"`. Pass an element only when you created it yourself. `features` is a function, such as `presetTabbed` or `() => presetTabbed({ attentionIcons: true })`, never the result of calling one. Both are resolved inside the library's startup-failure handling, so a missing element or a preset that throws reaches that handling instead of leaving your page on a spinner. [Startup failures and ended sessions](failure-handling.md) describes that panel.

The library builds the terminal's own elements and finds them by class, so your page reproduces no element ids. Every style and CSS custom property is scoped to the `wt-root` class it adds to your element, and `destroy()` removes that class again.

Call `createTerminal` at most once per document while the previous terminal is alive. The document title, the loading overlay, the status stream and the notification permission belong to the document, so one terminal owns them. A second call reports a `kernel-init` failure and throws without touching the page. Call `destroy()` on the first terminal before you build another, or use the `split` option for a second pane.

## Pick a preset or features

Four presets are provided. Each is a plain function that returns an array of features, so you can spread it and edit the result.

- `presetSingle()` is the single-pane desktop UI, with the context menu, clipboard, scroll-to-bottom, predictive echo and the connection banner.
- `presetTouch()` is `presetSingle()` plus the on-screen key bar.
- `presetTabbed()` is `presetTouch()` plus tabs, the activity monitor and animations. It needs a server that serves the engine's session API: `/api/sessions`, `/ws?session=` and the status stream `/api/sessions/events`. web-terminal-server serves it.
- `presetAgentTabbed()` has the same features as `presetTabbed()`, tuned for an agent shell such as web-terminal-kiro. Each tab's activity dot shows from the moment the tab opens instead of waiting for the program's first progress report.

[Tabs, activity dots and notifications](tabs.md) describes what the two tabbed presets show.

Import the barrel `@cplieger/web-terminal-ui/presets` for convenience, or one preset's own module for the smallest import graph: `…/presets/single`, `…/presets/touch`, `…/presets/tabbed` or `…/presets/agent-tabbed`. The barrel imports every feature. The touch module, for example, never imports the tabs module.

For a composition of your own, import single features from `…/features/<name>`. The names are `clipboard`, `context-menu`, `scroll-to-bottom`, `predictive-echo`, `connection-banner`, `mobile-toolbar`, `tabs`, `activity-monitor` and `animations`.

## The loading overlay

Keep the loading overlay in your served HTML so it paints before the module loads. Give it the `wt-loading` class, a `wt-loading-bar` child and `role="status"`. `LOADING_OVERLAY_CLASSES` publishes those class names, because the markup usually lives in a static HTML file no compiler reads. Recolor the overlay by setting the `--wt-loading-*` custom properties on your own element.

Pass the element as the `loading` option. The terminal fades it out and removes it once the first frame renders. On a slow start it writes a status line into the overlay after 5 seconds, then rotates four messages every 20 seconds from the 60-second mark. The `loadingMessages` option rewords those messages. A screen reader hears only the changes that mean something, not every rotation.

## What ships

| Path | Purpose |
| --- | --- |
| `src/**/*.ts` | The UI modules: the core (`kernel/`), the features (`features/`), the per-preset entries (`presets/`), IME, predictive echo and viewport handling |
| `css/*.css` and manifests | Component styles scoped to the terminal root. `MANIFEST` is the full-page bundle, and `MANIFEST.single`, `MANIFEST.touch` and `MANIFEST.tabbed` are the embedder bundles |
| `css/page.css` | The page kit for full-page hosts only: the `html` and `body` reset, the loading overlay and the `@font-face` rules for `Monaspace Neon NF` and `Web Terminal Glyphs` |
| `scaffold/index.html` | A reference full-page host: the `<head>`, one empty root element and the import map |
