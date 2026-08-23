// The names that cross this package's boundary as STRINGS, published as data.
//
// Two surfaces of this library are addressed by name rather than by type, so no
// compiler on either side of the boundary checks them:
//
//   - `theme` is `Readonly<Record<string, string>>`. The kernel copies every key
//     onto the terminal root verbatim, so a consumer that names a token this
//     library renamed or retired gets a live declaration nothing reads: no
//     error, no warning, just the library's own defaults where the consumer's
//     brand was meant to be.
//   - The loading overlay is the CONSUMER's element (it must paint before this
//     module loads), styled by `css/page.css` purely because the markup opts in
//     by class. Those classes are usually hardcoded in a static HTML file no
//     compiler reads at all.
//
// Both were previously prose — a doc comment on the option, a sentence in the
// README — which a consumer could only agree with by remembering. Published as
// data they can be ASSERTED against instead: web-terminal-kiro's app.test.ts
// checks its theme keys and its overlay markup against these exports the same
// way it already checks its bootstrap watchdog's wording against
// STARTUP_FAILURE_COPY. Same reason, same shape: this file imports nothing and
// touches no DOM, so a test or a Node build script can read it without loading
// the kernel.
//
// These lists are HAND-WRITTEN on purpose. They are the public contract — a
// decision about what this library promises to support — not a fact derived
// from the stylesheets. What IS derived from the stylesheets is the
// verification that the promise holds: `src/css-contract.node.test.ts` generates the
// declared/referenced token inventory from the CSS itself and fails if any
// token named here is not both DECLARED and READ by a rule. A token that is
// declared but never read is the silent-no-op case above, reached from the
// library's side instead of the consumer's, and no hand-maintained list can
// catch it.

/** CSS custom properties a consumer may set through `CreateTerminalOptions.theme`.
 *
 *  Every entry is guaranteed to be both declared and read by the shipped
 *  stylesheets (see the inventory test), so setting any of them changes what the
 *  terminal renders. Anything NOT listed here is unsupported: it may be an
 *  internal token that is renamed without a release note, or it may not exist.
 *
 *  Two families, and one rule about the second:
 *
 *  - `--accent` and the `--tab-*` family recolor the chrome. `--accent` is the
 *    widest lever — the "+" glyphs, and the active-tab border via a `color-mix`
 *    derivation — so a single override themes several surfaces.
 *  - The `--status-*` family is the activity-dot palette. The three ANIMATED
 *    states (`working` / `warning` / `failed`) differ from one another only in
 *    HUE, so replacements must keep their LIGHTNESS spread: equal-lightness
 *    substitutes collapse into one indistinguishable state in greyscale and
 *    under deuteranopia. `crashed` deliberately has no token of its own — it
 *    reuses `--status-failed`, solid and static, separating from `failed` by
 *    motion rather than color.
 *
 *  Values are arbitrary CSS, including `var()` references. A value that reaches
 *  through `var()` to an INTERNAL token couples the consumer to a name this
 *  list does not cover — assert on those separately if you write one. */
export const PUBLIC_THEME_TOKENS = [
  "--accent",
  "--tab-bg",
  "--tab-hover-bg",
  "--tab-active-bg",
  "--tab-active-fg",
  "--tab-active-border",
  "--status-working",
  "--status-done",
  "--status-input",
  "--status-warning",
  "--status-failed",
] as const;

/** A CSS custom property `CreateTerminalOptions.theme` supports.
 *
 *  `theme` itself stays an open `Record<string, string>` — narrowing it would
 *  break every consumer that builds its theme object dynamically — so this type
 *  is offered for a consumer that wants its OWN theme constant typed closed,
 *  which is where the mistake is actually made. */
export type PublicThemeToken = (typeof PUBLIC_THEME_TOKENS)[number];

/** The class names `css/page.css` styles the pre-JS loading overlay by.
 *
 *  Selected by CLASS, never by the consumer's element id: the same
 *  no-element-id-contract rule the kernel follows, and an unnamespaced name
 *  would collide in a host document. Markup contract: one element carrying
 *  `overlay` plus `role="status"`, with one `bar` child. Recolor it by setting
 *  the `--wt-loading-*` custom properties on that element — it is the
 *  consumer's element, so no JS option is involved.
 *
 *  The kernel writes its progressive startup status line into a region it
 *  CREATES inside the overlay (`kernel/loading-status.ts`), so those class
 *  names are the kernel's own and are not part of the markup a consumer
 *  writes. */
export const LOADING_OVERLAY_CLASSES = {
  overlay: "wt-loading",
  bar: "wt-loading-bar",
} as const;
