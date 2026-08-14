// Per-test cleanup of DOM state that outlives a test file.
//
// Loaded via vitest's `setupFiles` alongside fc-strict-setup, because
// `vitest.config.ts` deliberately sets `isolate: false`: test FILES share one
// happy-dom instance inside a worker thread, which is what makes the suite fast
// and also what lets one file's leftovers reach another's assertions.
//
// The document selection is the state that actually bites, for two compounding
// reasons. Several suites end with a live selection on purpose (the kernel's
// mouse-selection and type-to-focus suites assert that a gesture PRESERVED one,
// and contextMenu's dismissal suite clicks a real Select All). And happy-dom does
// not apply the selection fixup a real browser does, so a range whose nodes were
// removed by `document.body.replaceChildren()` keeps reporting its old text:
// measured rangeCount 1, isCollapsed false, and toString() unchanged after the
// nodes were detached.
//
// Left alone, that reached `context-menu.test.ts`'s "omits Copy with nothing
// selected" case, which found text to copy and failed. Order-dependently, so it
// passed every local run and every PR check, then failed once on main where the
// thread layout put the files in a different order. Clearing here rather than in
// each suite keeps the guarantee independent of which files a worker happens to
// pair up.
import { beforeEach } from "vitest";

beforeEach(() => {
  // Node-environment files (the default; DOM files opt in per file) have no
  // window, and nothing to clean.
  if (typeof window === "undefined") {
    return;
  }
  window.getSelection()?.removeAllRanges();
});
