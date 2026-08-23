// navigation.ts — the library's one page-navigation call, behind its own module.
//
// `window.location.reload` cannot be substituted in a real browser: `reload` is
// an own, sealed property of the location instance (`configurable: false`,
// `writable: false`), `Location.prototype` carries no `reload` to spy on, and
// `window`, `globalThis.window` and `globalThis.location` are all
// non-configurable. So a test cannot redefine it, assign over it, or stub the
// global, and letting the real call run navigates the test runner's own frame
// and takes the whole run down with it.
//
// A separate module is the seam that works: a caller's import is a live binding
// the test framework can replace, which an intra-module call is not. Keeping the
// call here also means there is exactly one place in the library that navigates,
// so the next one has to be added deliberately.

/** Reload the current page. The only navigation this library performs. */
export function reloadPage(): void {
  window.location.reload();
}
