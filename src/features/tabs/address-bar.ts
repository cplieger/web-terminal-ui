/** How a fragment reached the page. A deep link (a fresh load, a typed fragment)
 *  earns a notice when it names a tab that is gone; history and restore, which
 *  replay entries the page itself wrote, are corrected silently. */
export type RouteOrigin = "deeplink" | "history" | "restore";

export interface AddressBarOptions {
  /** The fragment for what the page shows now (`#...`, or `""` for none), or null
   *  while there is nothing to name, which leaves the address bar alone. */
  readonly read: () => string | null;
  /** Show what `fragment` names. Writes the page schedules from inside are
   *  dropped; the address bar canonicalises once it returns. */
  readonly apply: (fragment: string, origin: RouteOrigin) => void;
}

export interface AddressBar {
  /** Write the current fragment after this task: a push adds a history entry, a
   *  replace rewrites the current one, and a push wins when both are asked for.
   *  Nothing is written before `start` or while applying, and a fragment already
   *  the address bar's adds no entry (an unmarked one is only re-marked). */
  schedule(mode: "push" | "replace"): void;
  /** Where this page load came from, for the boot's notice decision. */
  bootOrigin(): RouteOrigin;
  /** Start answering navigation: replace the current entry with what is shown
   *  (when `canonicalize`), then follow every fragment change. */
  start(canonicalize: boolean): void;
  dispose(): void;
}

// Marks a history entry this page wrote, so a back or forward onto it is told
// from a fragment someone typed (whose entry carries no state).
const ENTRY_MARK = "wtTabs";

function isMarked(state: unknown): boolean {
  return typeof state === "object" && state !== null && Object.hasOwn(state, ENTRY_MARK);
}

/** The page address as the tabs feature's: it writes the fragment, never the
 *  path or the query, and it reacts to the fragment changing under it. */
export function createAddressBar(win: Window, opts: AddressBarOptions): AddressBar {
  let started = false;
  let disposed = false;
  let applying = 0;
  let pending: "push" | "replace" | null = null;
  let timer: number | null = null;
  // The fragment last applied or written. popstate and hashchange both fire for
  // one fragment navigation, and the second must not apply it again.
  let known = win.location.hash;

  function cancel(): void {
    if (timer !== null) {
      win.clearTimeout(timer);
      timer = null;
    }
    pending = null;
  }

  function write(mode: "push" | "replace"): void {
    const target = opts.read();
    if (target === null) {
      return;
    }
    const current = win.location.hash;
    if (target === current && isMarked(win.history.state)) {
      known = current;
      return;
    }
    const url = new URL(win.location.href);
    url.hash = target;
    // An entry for a page with no addressable tab is not one worth going back to.
    if (mode === "push" && target !== current && target !== "") {
      win.history.pushState({ [ENTRY_MARK]: 1 }, "", url);
    } else {
      const prior: unknown = win.history.state;
      const state = typeof prior === "object" && prior !== null ? { ...prior } : {};
      win.history.replaceState({ ...state, [ENTRY_MARK]: 1 }, "", url);
    }
    known = win.location.hash;
  }

  function onNavigate(): void {
    const fragment = win.location.hash;
    if (fragment === known) {
      return;
    }
    known = fragment;
    const origin: RouteOrigin = isMarked(win.history.state) ? "history" : "deeplink";
    cancel();
    applying++;
    try {
      opts.apply(fragment, origin);
    } finally {
      applying--;
    }
    write("replace");
  }

  return {
    schedule(mode) {
      if (!started || disposed || applying > 0) {
        return;
      }
      if (pending !== "push") {
        pending = mode;
      }
      timer ??= win.setTimeout(() => {
        timer = null;
        const m = pending;
        pending = null;
        if (m !== null && !disposed) {
          write(m);
        }
      }, 0);
    },
    bootOrigin() {
      const entry: unknown = win.performance.getEntriesByType("navigation")[0];
      const type =
        typeof entry === "object" && entry !== null && "type" in entry ? entry.type : null;
      return type === "reload" || type === "back_forward" ? "restore" : "deeplink";
    },
    start(canonicalize) {
      if (started || disposed) {
        return;
      }
      started = true;
      if (canonicalize) {
        write("replace");
      }
      win.addEventListener("popstate", onNavigate);
      win.addEventListener("hashchange", onNavigate);
    },
    dispose() {
      disposed = true;
      cancel();
      win.removeEventListener("popstate", onNavigate);
      win.removeEventListener("hashchange", onNavigate);
    },
  };
}
