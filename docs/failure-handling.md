# Startup failures and ended sessions

This page describes what the terminal shows when it cannot start and when a session's process ends, for a developer deciding whether to hook `onFatalError`, `onSessionEnded` or `reattach()`.

## Startup failures

You do not need to build a general startup-failure UI. When the library has a place to render, it shows one recovery panel titled "Terminal failed to start" with a **Reload** button. It also lowers your loading overlay so that the panel is visible. Two cases have no such place, described under [When no panel is drawn](#when-no-panel-is-drawn).

Two phases can fail:

- `phase: "feature-setup"`: a feature's setup threw or rejected. The terminal stops the connection, tears down every completed feature and core listener, clears the broken elements and shows the panel.
- `phase: "kernel-init"`: `createTerminal` itself threw. Causes include a mount selector that matches nothing, a preset that throws, an invalid feature list, a `split` option the features cannot support and a broken DOM invariant. It shows the same panel, then rethrows, so a caller with its own error handling still sees the error.

The panel is a native `<dialog>`. In `viewport` layout it opens with `showModal()`, so the rest of your document is inert while it is up. In `container` layout it opens without a modal, so the application around an embedded terminal keeps working and keeps its focusable elements. Escape does not dismiss it in either mode, because the terminal is already gone and there is nothing behind it. Reload is the recovery.

In `viewport` layout a modal dialog sits in the browser's top layer, above every `z-index` in the document. The panel therefore paints over your loading overlay at once, and the overlay finishes fading out behind it.

### Why target is a selector and features a function

Both are resolved inside that failure handling. Written the other way round, as `createTerminal(document.getElementById("terminal"), { features: presetTabbed() })`, the lookup and the preset call both run at your call site, before `createTerminal` is entered. A missing element or a throwing preset then escapes the library. The page is left spinning under your overlay with only a console error.

### When no panel is drawn

These two cases draw no panel, by design. Both are `kernel-init` failures with `surface: undefined`, which says there is nowhere to render.

- An embedded terminal, in `layout: "container"`, whose mount target does not exist. It is one panel inside a host application that otherwise works, so taking over the viewport to report its own failure would break a healthy page.
- A second `createTerminal` while the document already holds a live terminal, in either layout. The root it names may belong to the first terminal, so nothing is written to the page and no overlay is faded.

Both are still delivered to `onFatalError` and still rethrown.

### A failure in the second pane

Under `split: true`, a failure in the second pane at its first open is not the terminal's failure. That covers its core or one of its pane features. The first pane keeps running, and the panel renders into the failed pane's own root, without a modal, with its one Reload button. `onFatalError` receives the failure with that pane root as `surface`. The split button in the tab row closes the split and discards the failed pane, and the next open builds a fresh one.

A pane feature that rejects only after the split has closed finds no place for a panel. The healthy pane fills the view again and takes over the tab the failed pane was showing. The failed pane is discarded at once, `onFatalError` receives the failure with `surface: undefined`, and nothing is rendered.

### Handling it yourself

`onFatalError` receives the failure after cleanup. Check `phase` first. `feature-setup` names the offending `feature`, and `kernel-init` does not, because feature setup never began. `surface` is the element the built-in panel would fill, and the element to render into if you take over. It is `undefined` in the cases above where nothing is rendered, so check it. Return `true` only when you have rendered your own recovery UI there. A handler that throws is logged, and the built-in panel is shown.

### An inline bootstrap watchdog

Your page may also carry an inline script that reports that the JavaScript bundle never loaded at all. That script cannot import anything. Take its wording from `STARTUP_FAILURE_COPY` and substitute the strings into your HTML at build time, rather than restating them by hand. It is exported at the package root and at `@cplieger/web-terminal-ui/startup-copy`, which imports nothing and touches no DOM, so a build script can read it.

## When a session ends

A session whose process exits is over. The engine closes with its process-exited code, the connection banner reads "Session ended", and no reconnect is attempted. On a server that gives each session its own endpoint, reconnecting could only collect the same close again, an endless "Reconnecting…" over a screen that will never change.

Some hosts work differently. Your endpoint may hand out a new session on the next connect, such as one shared shell the server replaces once it ends, or an endpoint that starts a process on attach. Then the connection the engine declines to make is exactly what would produce a working terminal, and only you know that. So the library gives you the event and the method, and leaves the policy to you:

```ts
const term = createTerminal("#terminal", {
  features: presetTouch,
  wsPath: "/api/shell/ws",
  onSessionEnded: () => {
    // Your endpoint's own restart call goes here if it needs one, then:
    term.reattach();
  },
});
```

`onSessionEnded` is called when the active session's process has ended and nothing is retrying. It only observes. Everything the terminal does about the end happens first and regardless, and a handler that throws is logged and swallowed.

`reattach()` drops the local scrollback and screen, leaves the ended state and reconnects, in that order. The local buffer holds the dead session's content and a line position the replacement has never reached. A bare reconnect would resume from the wrong position, and a bare reset would leave "Session ended" over a screen it just cleared.

`reattach()` reconnects and nothing more. It starts no process and calls none of your APIs, so if your server must be told to make a new session, tell it first and reattach after. Do not call it on a live session. That costs a full replay and drops history the server may have evicted since.

Bound your own retries. A shell that dies as fast as it starts will end again the moment it is replaced, so a handler that reattaches every time is a tight loop. Count consecutive ends, back off and stop after a few. The "Session ended" banner is the honest outcome when a session cannot stay up. How many attempts are worth making is a fact about your server, so the library leaves it to you.
