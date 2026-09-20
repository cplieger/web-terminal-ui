// The page's attention surfaces: the document-title count prefix, the installed
// app's icon badge and the tab icon. A feature reports STATE, never events, so
// rendering is a pure function of the last report that is safe to run on every
// status sweep, and each sink no-ops when nothing changed.

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

/** Render reports onto `sinks`, change-gated on the last rendered value: the
 *  title doubles as the browser-tab label and the bookmark name, and
 *  re-assigning an icon href makes some browsers re-fetch it. `pagehide` restores
 *  the surfaces (a browser remembers ONE icon per URL for the bookmark and the
 *  history row, so a tab closed on a lit cue would leave a status variant standing
 *  in for the app), `pageshow` repaints the last report for a page that came back
 *  from the back-forward cache, and `freeze` changes nothing because a frozen tab
 *  is still in the strip rendering its icon. */
export function createAttention(sinks: AttentionSinks, win: Window): AttentionSurface {
  let reported: AttentionState = NO_ATTENTION;
  let rendered: AttentionState | null = null;

  function render(next: AttentionState): void {
    const countChanged = next.count !== rendered?.count;
    const iconChanged = next.icon !== rendered?.icon;
    rendered = next;
    if (countChanged) {
      sinks.setTitleMark(titleMarkFor(next.count));
      sinks.setBadge?.(next.count);
    }
    if (iconChanged) {
      sinks.setIcon?.(next.icon);
    }
  }

  function onPageGone(): void {
    render(NO_ATTENTION);
  }
  function onPageBack(): void {
    render(reported);
  }
  const listeners = new AbortController();
  const { signal } = listeners;
  try {
    win.addEventListener("pagehide", onPageGone, { signal });
    win.addEventListener("pageshow", onPageBack, { signal });
  } catch (err) {
    listeners.abort();
    throw err;
  }

  return {
    report(state) {
      reported = state;
      render(state);
    },
    dispose() {
      listeners.abort();
      render(NO_ATTENTION);
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
