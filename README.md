# @cplieger/web-terminal-ui

[![npm](https://img.shields.io/npm/v/@cplieger/web-terminal-ui)](https://www.npmjs.com/package/@cplieger/web-terminal-ui)
[![JSR](https://jsr.io/badges/@cplieger/web-terminal-ui)](https://jsr.io/@cplieger/web-terminal-ui)
[![Test coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/web-terminal-ui/badges/coverage.json)](https://github.com/cplieger/web-terminal-ui/actions/workflows/coverage.yml)
[![Mutation (TS)](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/cplieger/web-terminal-ui/badges/mutation-ts.json)](https://github.com/cplieger/web-terminal-ui/issues?q=label%3Astryker-tracker)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13431/badge)](https://www.bestpractices.dev/projects/13431)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/cplieger/web-terminal-ui/badge)](https://scorecard.dev/viewer/?uri=github.com/cplieger/web-terminal-ui)

The reference touch-first browser UI for
[`@cplieger/web-terminal-engine`](https://github.com/cplieger/web-terminal-engine).
It turns the engine's render/scroll/connection/keyboard modules into a usable
terminal on a phone as well as a desktop.

One `createTerminal(target, { features })` call builds the entire terminal UI
inside a single container element you provide. A small always-present kernel
composes with opt-in feature modules that own everything above the raw
terminal:

- a **display-only** terminal output (native text selection survives redraws)
  and a hidden `<textarea>` that owns the keyboard and IME (the kernel)
- **tabs**: multiple independent terminals with a desktop strip, a mobile
  bottom switcher, and a modal overview sheet
- an **activity monitor** that drives per-tab status dots (working / idle /
  needs-input / exited) from the server's status stream
- a **mobile key toolbar** (Tab / Esc / arrows / Enter / sticky-Ctrl) and a
  scroll-to-bottom control
- a **context menu** (Copy / Select All / Paste), on a right-click and on a
  touch long-press. Paste is the reason it exists: the keyboard target is a
  hidden `<textarea>`, so no platform can offer a native paste over the output.
  On touch the platform keeps its long-press — word selection and the OS copy
  callout run untouched, and the menu appears on release only when the press
  selected nothing
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

`@cplieger/web-terminal-engine` is a peer dependency: the UI is built on the
engine, so the consumer pins the engine version explicitly. Pairing compatibility
is governed by the engine's
[directional wire contract](https://github.com/cplieger/web-terminal-engine#wire-protocol),
not strict package-version equality; the UI surfaces a terminal incompatibility
through its connection banner.

## Usage

Serve a CSS bundle matching how you embed the terminal, plus a minimal HTML
page that has one empty container element, then call
`createTerminal(target, { features })` from your entry module.

**Full-page host** (the terminal IS the page, as in `web-terminal-server` and
`web-terminal-kiro`): concatenate `css/MANIFEST` into the `style.css` your page
links. That reference bundle is `css/page.css` (the page kit: `html/body`
reset + the bundled web font's `@font-face`, expecting the font files at
`/vendor/fonts/`) plus the complete component set. The bundled font backs both
the terminal display and the chrome text, so serving those files is not
optional for a full-page host.

**Embedder** (the terminal lives inside your app's layout, as a panel or pane):
concatenate the per-preset manifest matching your composition instead:
`css/MANIFEST.single`, `css/MANIFEST.touch`, or `css/MANIFEST.tabbed`. These
contain ONLY root-scoped component styles: no page reset, no fonts, no
document-level rules, nothing to quarantine. Chrome text then falls back to your
platform's monospace unless you declare the `@font-face` yourself; ship it if you
want the terminal panel to match the full-page product. Pass `layout: "container"`
so the terminal fills (and positions its chrome against) your container element
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
  createTerminal("#terminal", {
    features: presetTabbed,
    loading: document.getElementById("loading"),
  });
  // or, for a server that exposes the WebSocket elsewhere / a custom font:
  // createTerminal("#terminal", { features: presetTabbed, wsPath: "/api/shell/ws", fontReady: '14px "MyMono"' });
</script>
```

`createTerminal(target, opts?)` builds the entire terminal subtree (the kernel
plus every feature's chrome) inside the target element itself. `target` is a CSS
selector or an element: pass a **selector** from a page (`"#terminal"`) and pass
an **element** only when you already hold one you created yourself. The
difference matters — see "Startup failures" below. There is no element-id
contract for the host page to reproduce, and every style and CSS custom
property is scoped to the `wt-root` class it stamps on your element (removed
again by `destroy()`). Call it exactly once; the engine's
render/connection/scroll modules are single-instance per page (tabs multiplex
sessions over the one kernel). `scaffold/index.html` is a complete reference page
to copy and adapt.

Four presets are provided; each is a plain feature-array factory, so you can
spread and edit it. Import the barrel (`@cplieger/web-terminal-ui/presets`) for
convenience, or a per-preset entry module (`…/presets/single`, `…/presets/touch`,
`…/presets/tabbed`, `…/presets/agent-tabbed`) for the minimal delivered import
graph; the barrel statically reaches every feature, while the touch entry, for
example, never imports the tabs module. Individual features
are importable from `…/features/<name>` (`clipboard`, `context-menu`,
`scroll-to-bottom`, `predictive-echo`, `connection-banner`, `mobile-toolbar`,
`tabs`, `activity-monitor`, `animations`) for hand-picked compositions:

- `presetSingle()`: single-pane desktop UI (context menu, clipboard,
  scroll-to-bottom, predictive echo, connection banner).
- `presetTouch()`: `presetSingle()` plus the mobile key toolbar.
- `presetTabbed()`: the generic tabbed UI, `presetTouch()` plus tabs, the
  activity monitor, and animations. Each tab's title is OSC-first: it follows
  the process window title (OSC 0/2) when the program sets one and keeps it
  updated, otherwise the last command submitted. The per-tab activity dot
  reveals itself only when a session reports OSC 9;4 progress, so a plain shell
  keeps clean, label-only tabs. Requires a server that speaks the session API
  (`/api/sessions` and `/ws?session=`), such as `web-terminal-server`.
- `presetAgentTabbed()`: the same feature set as `presetTabbed()`, tuned for an
  agent shell such as `web-terminal-kiro`. With `preferInputTitle`, each tab's
  label follows the latest submitted line (persisted server-side and recovered
  on reload) and the program's OSC 0/2 title is ignored. With `presumeReports`,
  the idle activity dot shows from tab creation instead of waiting for the
  session's first OSC 9;4 signal. Its status dots come from the same activity
  monitor and cover eight states: the three animated OSC 9;4 progress states
  (working, warning, error), the frozen ringed needs-input dot, two static discs
  (a green finished turn, a red crashed process), and two hollow ones (idle and a
  dim ended session). A
  reported percentage additionally renders a 2px determinate bar on the chip,
  shown only while one of those three progress states is the session's current
  status. The number itself is announced in the tab's accessible name and drawn
  nowhere: no terminal emulator puts a percentage next to a tab label, and a chip
  that shrinks toward a 100px floor has no width to spare. It is likewise never
  written to the browser document title, since one page title cannot represent
  several sessions. An OSC 9 notification is posted as a browser
  notification when the user is not already looking at that terminal (permission
  is requested on a user gesture; a denial degrades silently to the tab dots).
  Clicking one switches to the session that raised it: the Notifications API's
  own click default already focuses the page, and the handler supplies the
  in-page half. These are non-persistent notifications, so per the API the
  constructor throws on most mobile browsers, where the notification degrades to
  the tab dots.

### Options

| Option              | Default                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features`          | _(none; bare kernel)_        | A FUNCTION returning the feature list. Omitted builds only the terminal (no chrome). Pass a preset by name (`features: presetTabbed`) or a factory of your own; it is called inside the startup-failure boundary, so a preset that throws is handled rather than escaping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `layout`            | `"viewport"`                 | How the terminal claims space. `"viewport"`: the root becomes a fixed full-viewport box (the full-page product). `"container"`: the root fills your container element, which becomes the styling and positioning boundary (the embedded case).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `wsPath`            | `"/ws"`                      | WebSocket endpoint path the engine connects to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fontReady`         | `'14px "Monaspace Neon NF"'` | CSS font shorthand awaited before the first resize, so the server is sized against the real web font's cell metrics rather than a fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scrollbackLines`   | _(engine default)_           | Retained scrollback lines per terminal — and per tab under the tabs feature (every per-tab cache is built through the same budget). This is the page's dominant memory dial: it bounds the styled-run arrays each session retains AND the DOM rows the renderer keeps (one row element per retained line), so a memory-constrained host (iOS Safari, where the content process is reclaimed under system pressure) passes a smaller budget at the price of a shorter scroll-back. A history budget floored at the live screen: the engine never evicts the current window, so a value at or below the terminal height keeps the full screen with no scrollback — but choose a value comfortably above the largest expected terminal height (a few multiples), since near or below it the batched eviction degrades to per-line churn. Non-integer or non-positive values are ignored. Left unset, the engine decides, and it decides twice: 5000 against a server that cannot serve history back, dropping to a 1500-line resident tail plus an on-demand cache once a server declares demand-paged scrollback. Prefer leaving it unset — the depth then lives on the server and the phone holds a working set. An explicit value opts OUT of that flip: it is an explicit memory decision and holds in both states. |
| `persistScrollback` | _(off)_                      | Persist each session's scrollback across a page discard, through storage YOU supply. A page that is discarded and reloaded otherwise resumes holding nothing, so it asks the server for everything and refills its whole buffer over the wire — the normal case on iOS, where Safari evicts backgrounded tabs under memory pressure and returning to one re-runs the page. With a snapshot restored, the resume asks only for what was printed while the tab was gone. It helps the FRESH-LOAD case only: a warm reconnect and an in-page tab switch already replay nothing. Off by default because `localStorage` is a shared, origin-wide, quota-limited resource and this library is embedded in applications that keep their own state there — an application decides durability for its own users, a library does not decide it for an embedder. Applies to a single terminal and to every tab alike. See below.                                                                                                                                                                                                                                                                                                                                                                                                |
| `loading`           | _(none)_                     | A pre-JS loading overlay element (kept in your served HTML so it paints before this module loads); it is faded out and removed once the first frame renders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `onFatalError`      | _(built-in recovery)_        | Called with a `TerminalStartupFailure` after a fatal startup failure, in either phase (`feature-setup` or `kernel-init`); behavior below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `theme`             | _(none)_                     | Theme overrides (CSS custom properties on the terminal root): `--accent`, `--tab-bg`, `--tab-hover-bg`, `--tab-active-bg`, `--tab-active-fg`, `--tab-active-border`, plus the activity-dot palette `--status-working`, `--status-done`, `--status-input`, `--status-warning`, `--status-failed`. The library ships neutral defaults. If you retheme the animated trio (`--status-working` / `--status-warning` / `--status-failed`), keep their LIGHTNESS spread: they differ only in hue, so equal-lightness replacements collapse into one another in greyscale and under deuteranopia.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`createTerminal()` returns a handle: `focus()` re-focuses the terminal input
(and opens the soft keyboard on touch); `send(bytes)` sends bytes to the active
session through the kernel's sanitizing input funnel (the supported host path
for a "type this command" affordance); `reset()` drops the local scrollback and
screen without injecting keystrokes (send a redraw keystroke yourself if you
want one, for example Ctrl+L); and `destroy()` tears every feature down and
releases the kernel.

### Persisting scrollback across a discard

`persistScrollback` takes the storage, not a switch, because storage is a
decision this library should not make for you. Chrome's page-lifecycle guidance
is to close IndexedDB connections on freeze, since a held connection costs
bfcache eligibility — and this kernel depends on bfcache, so it must not own a
database. `localStorage` is also a shared, origin-wide, ~5 MB resource, and this
package is embedded in applications that keep their own state there: consuming it
uninvited would risk the host's writes failing, and how that degrades is theirs to
design. Ours degrades gracefully — nothing restored, terminal unaffected.

So the option is off until you pass storage, and `localScrollbackStorage()` is the
ready-made answer for consumers who want the ordinary one — one import, and it
handles the quota sweep, the age bound and the `localStorage`-unavailable case:

```ts
import { createTerminal, localScrollbackStorage, presetTabbed } from "@cplieger/web-terminal-ui";

createTerminal("#terminal", {
  features: presetTabbed,
  persistScrollback: localScrollbackStorage(),
});
```

All three reference apps (web-terminal-kiro, web-terminal-server, vibekit's shell
panel) enable it that way; web-terminal-server additionally exposes an operator
opt-out, because it runs a command its operator chooses.

Supply your own storage instead when the snapshots belong somewhere else — a shared
IndexedDB, a server round-trip, an in-memory cache for a test. The rest of this
section is that case:

```ts
import { createTerminal } from "@cplieger/web-terminal-ui";
import type { PersistedScrollback } from "@cplieger/web-terminal-ui";

// Read your snapshots into memory BEFORE mounting; see the note below.
const cache = new Map<string, PersistedScrollback>(await loadAllFromIndexedDB());

createTerminal("#terminal", {
  features: presetTabbed,
  persistScrollback: {
    load: (sessionId) => cache.get(sessionId) ?? null,
    save: (sessionId, entry) => {
      cache.set(sessionId, entry);
      void writeToIndexedDB(sessionId, entry); // fire and forget
    },
    drop: (sessionId) => {
      cache.delete(sessionId);
      void deleteFromIndexedDB(sessionId);
    },
  },
});
```

`load` is synchronous, which is the one constraint worth understanding rather
than working around: a restore has to be in place before the resume announces
what the client already holds, and a resume cannot be taken back. A store
hydrated after that has already lost the argument. So an asynchronous store is
read into memory first — which is also the shape that holds no database
connection open.

`sessionId` is a real session id, never a key of your invention: the id the tabs
feature uses, or — for a single terminal — the engine's own per-tab id. That is
load-bearing rather than tidy, because the same id is what the persisted server
boot epoch is checked against. Prefix it however you like inside your storage.

Knobs, all optional. On the option itself: `lines` (default 200) bounds how much of
each session's tail is written, `maxAgeMs` (default 7 days) bounds how long an entry
may be used, and `saveIntervalMs` (default 10s) sets the background save cadence.
`localScrollbackStorage` adds `prefix` and `maxBytes` (default 512 KiB of
characters, roughly 1 MiB of quota since `localStorage` is accounted in UTF-16 —
about a fifth of the ~5 MiB floor, leaving the rest to the host application).

The 200-line default is a measurement rather than a guess: VS Code's own
`terminal.integrated.persistentSessionScrollback` restores 100 lines by default, and
at 200 a coloured session serialises to ~60 K characters in under a millisecond,
against ~300 K and ~4 ms at 1000. A write happens on every backgrounding and on a
timer while output advances, so that cost is paid repeatedly on the device this
exists for.

The library writes on `visibilitychange` to hidden, on `pagehide`, on `destroy()`,
and on that timer — in every case only for a session whose content has advanced
since its last recorded save. That predicate is not an optimisation: two pages of
the same app hold the same session ids, and an unconditional write let a background
page roll a foreground page's newer entry back. `pagehide` is documented as not
guaranteed, which is why the timer exists.

Every callback may throw or return nonsense without consequence — a failure
degrades to "nothing was restored", exactly as if the option were absent. An
entry is also discarded, and dropped, when it is too old, unreadable, or from a
different server process: absolute line indices only mean anything within one
server boot, so an entry that cannot be checked against the live server is
thrown away rather than shown. A slow restore is a much better failure than a
terminal that is confidently wrong.

No permission prompt is involved: `localStorage` is not in the Permissions API, so
there is nothing for a user to grant or refuse. (`navigator.storage.persist()` is
the call that can prompt, and this library never makes it — these snapshots are
disposable by design, so asking a user to exempt them from eviction would be asking
for the wrong thing.) Storage can still be _unavailable_ with no prompt either way,
and the failures differ: a browser set to block site data makes
`window.localStorage` **throw on access** (Chrome, Firefox), while Safari
historically allowed access in private browsing and threw on the **write**; Firefox
can clear it on close; Safari's ITP evicts script-writable storage after seven days
without interaction; and a cross-origin iframe embed gets **partitioned, ephemeral**
storage rather than the top-level origin's (all three engines partition; Safari has
the strictest lifetime). `localScrollbackStorage` guards access as well as writes, so
the read side always degrades to "nothing restored" and the terminal is unaffected; a
refused write is reported instead, so the library never records a save that did not
happen.

Cleanup, since a store that only ever writes fills up. Four mechanisms, and the
first is the one that matters day to day: the kernel calls `drop` when a session
closes, so a tab the user closes — or one the server reaps while the page is open —
takes its entry with it. On top of that, an entry past `maxAgeMs` is deleted when it
is next read; `localScrollbackStorage` sweeps both at construction and after every
write (expired entries first, then the oldest until the byte budget fits); and a
rejected entry is always dropped rather than left to be re-read. What no mechanism
can catch promptly is a session that disappeared while the page was CLOSED — nothing
runs then, and there is no reliable "this tab is closing for good" event to hook — so
that case is the sweep's, which is why a budget exists rather than the age bound
alone.

The budget is bytes rather than an entry count deliberately, because a count bounds
the wrong thing. Measured on the real stored value at the 200-line default, a plain
80-column session is ~24 K characters and a wide coloured one ~112 K, so a 20-entry
allowance would have permitted over 4 MiB of a ~5 MiB quota — the cap would have
guaranteed the refusal it was meant to prevent. A single snapshot larger than the
whole budget is refused outright rather than evicting everything for something that
still would not fit.

### Themes that provably apply

`theme` is an open `Record<string, string>` — the kernel sets every key on the
terminal root verbatim — so a key this library renamed or retired becomes a live
declaration nothing reads: no error, just the library's neutral defaults where
your brand should be. The supported keys are therefore published as data:

```ts
import { PUBLIC_THEME_TOKENS } from "@cplieger/web-terminal-ui/style-contract";
// or from the package root; the subpath imports nothing and touches no DOM,
// so a Node script can read it too.

for (const key of Object.keys(MY_THEME)) {
  expect(PUBLIC_THEME_TOKENS).toContain(key); // your test, our list
}
```

Every token on that list is guaranteed by this package's own suite to be both
declared AND read by a shipped rule, so setting it changes what renders. The
second half is the one you cannot check from outside: a token that is declared
but that no rule reads accepts your override and applies it to nothing. Anything
NOT on the list is internal and may be renamed without a release note.

`LOADING_OVERLAY_CLASSES` is published from the same module for the same reason:
your pre-JS overlay markup opts into `css/page.css`'s styling by class name, and
that markup usually lives in a static HTML file no compiler reads.

### Startup failures

You do not need your own startup-failure UI. Every way starting up can fail ends
at one recovery surface this package owns — a "Terminal failed to start" panel
with a Reload button — and your loading overlay is lowered so that panel is
visible.

Two phases can fail. If a feature's setup throws or rejects
(`phase: "feature-setup"`), the kernel stops the connection, tears down every
completed feature and core listener, clears the broken subtree, and shows the
panel. If `createTerminal` itself throws (`phase: "kernel-init"` — an
unresolvable mount selector, a preset that throws, an invalid feature list, a DOM
invariant), it shows the same panel and then rethrows, so a caller with its own
error handling still sees the error. Either way the panel is modal when the
terminal owns the viewport and non-modal when it fills an embedded container.

**This is why `target` takes a selector and `features` takes a function.** Both
are resolved INSIDE that boundary. Written the other way round —
`createTerminal(document.getElementById("terminal"), { features: presetTabbed() })`
— the lookup and the preset call both happen at your call site, before
`createTerminal` is entered, so a missing element or a throwing preset escapes
the library entirely and leaves the page spinning under your overlay with nothing
but a console error. Those were the two failures every consumer used to
hand-build its own dialog for.

One case has no panel by design: an embedded terminal (`layout: "container"`)
whose mount target does not exist. It is one panel inside a host application that
is otherwise working, so claiming the viewport to report its own failure would
break a healthy page. The failure is still delivered to `onFatalError` and still
rethrown, with `surface: undefined` to say there is nowhere to render.

`onFatalError` receives the failure after cleanup. Discriminate on `phase`:
`feature-setup` names the offending `feature`, `kernel-init` does not, because
feature composition never began. `surface` names the element the built-in panel
would fill, and is the element to render into if you claim it. Return `true` only
when you have rendered replacement recovery UI there.

If your page also carries an inline bootstrap watchdog — a script that reports
"the JS bundle never loaded at all", a rung below `import` — it cannot import
anything by definition. Take its wording from `STARTUP_FAILURE_COPY` (exported at
the package root and at `@cplieger/web-terminal-ui/startup-copy`, which imports
nothing and touches no DOM so a build script can read it) and substitute the
strings into your HTML at build time, rather than restating them by hand.

## What ships

| Path                    | Purpose                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/**/*.ts`           | The UI modules: the kernel (`kernel/`), opt-in features (`features/`), per-preset entries (`presets/`), IME, predictive echo, viewport.                                                                                   |
| `css/*.css` + manifests | Root-scoped component styles. `MANIFEST` = the reference full-page bundle (`page.css` + the tabbed set); `MANIFEST.single/touch/tabbed` = component-only per-preset bundles for embedders. Concatenate in manifest order. |
| `css/page.css`          | The page kit (full-page hosts only): `html/body` reset + the terminal web font's `@font-face`.                                                                                                                            |
| `scaffold/index.html`   | A reference full-page HTML host: `<head>` + one empty root element + importmap.                                                                                                                                           |

## Related projects

The web-terminal family:

- [`web-terminal-engine`](https://github.com/cplieger/web-terminal-engine): the
  Go session engine + TypeScript browser renderer this UI is built on (peer
  dependency).
- [`web-terminal-server`](https://github.com/cplieger/web-terminal-server): a
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
