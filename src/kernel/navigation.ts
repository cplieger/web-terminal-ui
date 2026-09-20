// The library's one page-navigation call, in its own module because a test
// cannot substitute `window.location.reload`: `reload` is an own sealed property
// of the location instance, `Location.prototype` has no `reload`, and `window`
// and `globalThis.location` are non-configurable, so the real call would
// navigate the test runner's own frame. A caller's import of this module is the
// live binding a test can replace; keeping the call here also means exactly one
// place in the library navigates.

/** Reload the page `win` shows, the terminal's own document. The only navigation
 *  this library performs. */
export function reloadPage(win: Window): void {
  win.location.reload();
}
