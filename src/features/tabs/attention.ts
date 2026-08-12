// tabs/attention.ts — the unseen-cue set, rendered onto the surfaces that exist
// OUTSIDE this page's chrome: the browser tab title, the installed app's icon
// badge, and the tab icon.
//
// Why these are needed at all: a tab holding a latched status paints a dot on its
// chip, and that dot is not reliably on screen. The desktop strip scrolls
// horizontally once it is full, a narrow coarse-pointer device hides the strip
// entirely (only the active row plus the switcher's aggregate dot remain), and a
// hidden page shows no chrome at all. notify.ts already covers the last case with
// a browser Notification, but that API is absent on iOS Safari outside an
// installed web app, which is exactly where this UI spends its time.
//
// STATE, not events. A notification fires once per occurrence and is deduped on a
// sequence number; everything here is a pure render of what is currently true, so
// it is safe to recompute on every status sweep and each sink no-ops when nothing
// changed. That split is why this module and notify.ts stay separate.
//
// The set is CueStatus and nothing else, so these surfaces cannot disagree with
// the switcher's aggregate dot about what wants the user; the fold and the raise
// share isUnseenCue (model.ts).
//
// DOM-free and global-free by construction, like notify.ts: every capability
// arrives through AttentionEnv, so the decisions are unit-testable with no
// document, no navigator and no icon assets, and browserAttentionEnv() below is
// the one place that touches globals.

import { type CueStatus, cueIconName, isUnseenCue, worseCue } from "./model.js";

/** What the fold reads per tab. A structural type, so the caller passes its own
 *  tab objects without this module knowing what else they carry. */
export interface CueCandidate {
  readonly id: string;
  readonly status: string;
}

/** The whole attention state, and the only thing the sinks are allowed to see. */
export interface Attention {
  /** How many sessions hold an unacknowledged cue. */
  readonly count: number;
  /** The most severe of them, or "" when there is none. */
  readonly worst: CueStatus | "";
}

export const NO_ATTENTION: Attention = { count: 0, worst: "" };

/** summarize folds the tab list and this viewer's acknowledgements into the one
 *  value every surface renders.
 *
 *  A COUNT for the title and the badge, a single WORST for the icon. That split
 *  is deliberate: a count is set-valued, so it needs no rule for choosing among
 *  sessions, and severity is a total order, so the icon's choice is not arbitrary
 *  either. Neither surface can name a session, which is the standing constraint
 *  on anything written to a page-wide surface here (see the decision against
 *  per-session progress in the document title, index.ts). */
export function summarize(
  tabs: readonly CueCandidate[],
  seen: ReadonlyMap<string, CueStatus>,
): Attention {
  let count = 0;
  let worst: CueStatus | "" = "";
  for (const tab of tabs) {
    if (!isUnseenCue(tab.status, tab.id, seen)) {
      continue;
    }
    count += 1;
    worst = worseCue(worst, tab.status);
  }
  return { count, worst };
}

/** The capabilities the sinks need, all injected, all optional except the title.
 *
 *  An absent capability is an absent sink and therefore a silent no-op, the same
 *  contract notify.ts uses for a missing Notification constructor: an unsupported
 *  surface is a normal state of the world, not an error to report.
 *
 *  Two of these can also fail INVISIBLY, and that is accepted rather than
 *  handled. `setBadge` resolves on Linux where the desktop paints no badge at
 *  all, and `setIcon` assigns an href that Safari ignores because it caches the
 *  first icon it fetched. Neither is detectable, and neither costs anything when
 *  it fails, because the title is not gated on any capability and so is the
 *  floor: every platform that renders a title at all gets the count. Do not
 *  arrange these into a fallback ladder where the title only appears if the
 *  others are missing — on those two platforms the detection would report
 *  success and the user would be left with nothing. */
export interface AttentionEnv {
  /** Set (or clear, with "") the document-title prefix. The kernel's composing
   *  writer, so this cannot be erased by a program's OSC 0/2 window title. */
  titlePrefix: (text: string) => void;
  /** Set the installed app's icon badge to a count, or clear it at zero. */
  setBadge?: ((count: number) => void) | undefined;
  /** Point the page's icon links at a variant, or restore them with null. */
  setIcon?: ((variant: "input" | "done" | "alert" | null) => void) | undefined;
}

export interface AttentionSurfaces {
  /** Render an attention state. Idempotent: a value equal to the last one
   *  applied touches nothing. */
  apply(next: Attention): void;
}

/** titlePrefixFor is the title text for a count, and the format is load-bearing
 *  enough to name: the count goes FIRST, because a browser tab strip truncates a
 *  title to its first few characters and a suffix would be the part that is cut.
 *  Parenthesised digits are also the convention every mail and chat client uses,
 *  so it needs no legend. */
export function titlePrefixFor(count: number): string {
  return count > 0 ? `(${String(count)}) ` : "";
}

export function createAttention(env: AttentionEnv): AttentionSurfaces {
  // Last applied, so each sink is called only on a real change. This matters
  // beyond cost: the document title doubles as the browser-tab label and the
  // bookmark name, and re-assigning an icon href makes some browsers re-fetch it.
  let applied: Attention = NO_ATTENTION;
  let first = true;

  return {
    apply(next: Attention): void {
      const countChanged = first || next.count !== applied.count;
      const worstChanged = first || next.worst !== applied.worst;
      first = false;
      applied = next;

      if (countChanged) {
        env.titlePrefix(titlePrefixFor(next.count));
        // The badge takes the SAME number as the title, which is the whole
        // reason both read one fold: two surfaces disagreeing about how many
        // things want you is worse than either being absent.
        env.setBadge?.(next.count);
      }
      if (worstChanged) {
        env.setIcon?.(next.worst === "" ? null : cueIconName(next.worst));
      }
    },
  };
}

/** iconVariantHref rewrites an icon URL to its variant, by the convention the
 *  asset generator writes (scripts/gen-attention-icons.py): the `favicon` token
 *  of the filename gains `-<variant>`, so `/favicon.svg` becomes
 *  `/favicon-input.svg` and `/favicon-32x32.png` becomes
 *  `/favicon-input-32x32.png`. The extension is preserved, so each link keeps
 *  pointing at its own format and no `type` attribute has to change.
 *
 *  A URL whose filename does not start with `favicon` is returned unchanged,
 *  which leaves that link alone rather than pointing it at a 404. Exported for
 *  the test that pins this against the generator's own naming. */
export function iconVariantHref(href: string, variant: string): string | null {
  const match = /(^|\/)favicon(?=[-.])/.exec(href);
  if (!match) {
    return null;
  }
  const at = match.index + match[0].length;
  return `${href.slice(0, at)}-${variant}${href.slice(at)}`;
}

/** browserAttentionEnv binds the sinks to the real browser, given the kernel's
 *  title setter. Everything optional is decided HERE, once, so the core never
 *  probes for a capability.
 *
 *  `icons` opts the icon sink in. It is off unless the consumer asks for it,
 *  because it needs asset files the library cannot ship: the dot's colour comes
 *  from the app's own `--status-*` theme, so the variants are per-app artifacts.
 */
export function browserAttentionEnv(
  titlePrefix: (text: string) => void,
  icons: boolean,
): AttentionEnv {
  const env: AttentionEnv = { titlePrefix };

  // The Badging API, read through `unknown` for the same reason notify.ts reads
  // Notification that way: it is absent on most browsers and must degrade rather
  // than be asserted. Installed apps only — a badge lives on an app icon, which
  // exists only after the app is installed.
  const nav: unknown = globalThis.navigator;
  const setAppBadge = (nav as { setAppBadge?: unknown } | undefined)?.setAppBadge;
  const clearAppBadge = (nav as { clearAppBadge?: unknown } | undefined)?.clearAppBadge;
  if (typeof setAppBadge === "function") {
    env.setBadge = (count: number): void => {
      // Always a NUMBER, never the spec's bare flag form: iOS renders nothing at
      // all for `setAppBadge()` with no argument. Zero clears, via clearAppBadge
      // where it exists (the documented way) and setAppBadge(0) otherwise.
      //
      // Both return promises that reject on an unsupported platform, so the
      // rejection is swallowed: a badge the OS declines to paint is not an error
      // this page can do anything about, and an unhandled rejection in a status
      // sweep would be reported as a page fault.
      try {
        const call =
          count > 0
            ? (setAppBadge as (n: number) => unknown).call(nav, count)
            : typeof clearAppBadge === "function"
              ? (clearAppBadge as () => unknown).call(nav)
              : (setAppBadge as (n: number) => unknown).call(nav, 0);
        void Promise.resolve(call).catch(() => {
          /* an OS that will not paint a badge is a title-only OS */
        });
      } catch {
        /* a synchronous throw is the same non-event */
      }
    };
  }

  if (icons) {
    // Every icon link, not one of them: which link a browser picks differs
    // between browsers (Chrome prefers the SVG), so mutating a single element is
    // unreliable. apple-touch-icon is deliberately NOT matched — `rel~="icon"`
    // does not select it — because that icon and the manifest's are cached by the
    // OS when the app is installed and a swap cannot reach them.
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    const originals = new Map<HTMLLinkElement, string>();
    for (const link of links) {
      originals.set(link, link.getAttribute("href") ?? "");
    }
    if (links.length > 0) {
      env.setIcon = (variant): void => {
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

  return env;
}
