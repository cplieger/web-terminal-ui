import type { AttentionOptions, AttentionReporter, AttentionState } from "./types.js";

const NO_ATTENTION: AttentionState = { count: 0, icon: null };

/** The sinks a render writes, every one injected. An absent optional sink is a
 *  silent no-op: an unsupported surface is a normal state of the world. Two can
 *  also fail INVISIBLY (`setBadge` resolves on a desktop that paints no badge,
 *  `setIcon` assigns an href Safari ignores), which is why the title is gated on
 *  no capability and is the floor: never arrange these as a fallback ladder. */
export interface AttentionSinks {
  /** Set the mark the document title starts with, or clear it with "". */
  setTitleMark: (text: string) => void;
  setBadge?: ((count: number) => void) | undefined;
  setIcon?: ((variant: string | null) => void) | undefined;
}

/** The reporter plus its release. */
export interface AttentionSurface extends AttentionReporter {
  /** Restore every surface and stop following the page lifecycle. */
  dispose(): void;
}

/** The count goes FIRST because a browser tab strip truncates a title to its
 *  first few characters; parenthesised digits are the convention every mail and
 *  chat client uses, so it needs no legend. */
export function titleMarkFor(count: number): string {
  return count > 0 ? `(${String(count)}) ` : "";
}

/** iconVariantHref rewrites an icon URL to its variant: the `favicon` token of
 *  the filename gains `-<variant>`, keeping the extension so each link keeps its
 *  own format. Null for a filename that does not start with `favicon`, which
 *  leaves that link alone rather than pointing it at a 404. */
export function iconVariantHref(href: string, variant: string): string | null {
  const match = /(^|\/)favicon(?=[-.])/.exec(href);
  if (!match) {
    return null;
  }
  const at = match.index + match[0].length;
  return `${href.slice(0, at)}-${variant}${href.slice(at)}`;
}

/** Render reports onto `sinks`. The title and icon are change-gated: the title is
 *  also the tab label and bookmark name, and re-assigning an icon href makes some
 *  browsers re-fetch it. The badge is OS state a platform may drop a write to
 *  without rejecting, so it is also re-asserted on `resync`, a return to visible,
 *  window focus and `pageshow`. `pagehide` restores the title and icon (a browser
 *  remembers ONE icon per URL) but leaves the badge, which means "unread" for the
 *  whole app rather than for this page. */
export function createAttention(sinks: AttentionSinks, win: Window): AttentionSurface {
  let reported: AttentionState | null = null;
  let rendered: AttentionState | null = null;
  let badged: number | null = null;
  let pendingResync: number | null = null;

  function render(next: AttentionState): void {
    const countChanged = next.count !== rendered?.count;
    const iconChanged = next.icon !== rendered?.icon;
    rendered = next;
    if (countChanged) {
      sinks.setTitleMark(titleMarkFor(next.count));
    }
    if (iconChanged) {
      sinks.setIcon?.(next.icon);
    }
  }
  function cancelResync(): void {
    if (pendingResync !== null) {
      win.clearTimeout(pendingResync);
      pendingResync = null;
    }
  }
  function writeBadge(count: number): void {
    cancelResync();
    badged = count;
    sinks.setBadge?.(count);
  }
  const listeners = new AbortController();
  const { signal } = listeners;
  // Deferred a task so this surface's listener and the caller's report on one
  // event write once. Before the first report, a write would wipe the badge
  // another page or a previous run set; after dispose, it would raise a cleared one.
  function resync(): void {
    if (reported === null || signal.aborted || pendingResync !== null) {
      return;
    }
    pendingResync = win.setTimeout(() => {
      pendingResync = null;
      if (reported !== null && !signal.aborted) {
        writeBadge(reported.count);
      }
    }, 0);
  }

  function onPageGone(): void {
    render(NO_ATTENTION);
  }
  function onPageBack(): void {
    if (reported !== null) {
      render(reported);
    }
    resync();
  }
  function onVisibility(): void {
    if (win.document.visibilityState !== "hidden") {
      resync();
    }
  }
  try {
    win.addEventListener("pagehide", onPageGone, { signal });
    win.addEventListener("pageshow", onPageBack, { signal });
    win.addEventListener("focus", resync, { signal });
    win.document.addEventListener("visibilitychange", onVisibility, { signal });
  } catch (err) {
    listeners.abort();
    throw err;
  }

  return {
    report(state) {
      reported = state;
      render(state);
      if (state.count !== badged) {
        writeBadge(state.count);
      }
    },
    resync,
    dispose() {
      listeners.abort();
      render(NO_ATTENTION);
      writeBadge(0);
    },
  };
}

/** Bind the sinks to `doc`'s browser realm. Every capability decision is made
 *  HERE, once, so the render never probes. */
export function browserAttentionSinks(
  setTitleMark: (text: string) => void,
  opts: AttentionOptions,
  doc: Document,
): AttentionSinks {
  const sinks: AttentionSinks = { setTitleMark };

  // Read through `unknown` because the Badging API is absent on most browsers
  // and exists only on an installed app's icon.
  const nav: unknown = doc.defaultView?.navigator;
  const setAppBadge = (nav as { setAppBadge?: unknown } | undefined)?.setAppBadge;
  const clearAppBadge = (nav as { clearAppBadge?: unknown } | undefined)?.clearAppBadge;
  if (typeof setAppBadge === "function") {
    sinks.setBadge = (count: number): void => {
      // Always a NUMBER, never the spec's bare flag form: iOS renders nothing for
      // `setAppBadge()` with no argument. Zero clears through clearAppBadge where
      // it exists and setAppBadge(0) otherwise (Chrome shipped the former later).
      try {
        const call =
          count > 0
            ? (setAppBadge as (n: number) => unknown).call(nav, count)
            : typeof clearAppBadge === "function"
              ? (clearAppBadge as () => unknown).call(nav)
              : (setAppBadge as (n: number) => unknown).call(nav, 0);
        // A rejection is an OS that will not paint a badge, not a page fault.
        void Promise.resolve(call).catch(() => undefined);
      } catch {
        /* a synchronous throw is the same non-event */
      }
    };
  }

  if (opts.icons) {
    // Every icon link, because which one a browser picks differs (Chrome prefers
    // the SVG). `rel~="icon"` deliberately skips apple-touch-icon: the OS caches
    // it at install time, so a swap cannot reach it.
    const links = [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    const originals = new Map<HTMLLinkElement, string>();
    for (const link of links) {
      originals.set(link, link.getAttribute("href") ?? "");
    }
    if (links.length > 0) {
      sinks.setIcon = (variant): void => {
        for (const link of links) {
          const original = originals.get(link) ?? "";
          if (variant === null) {
            link.setAttribute("href", original);
            continue;
          }
          const next = iconVariantHref(original, variant);
          if (next !== null) {
            link.setAttribute("href", next);
          }
        }
      };
    }
  }

  return sinks;
}
