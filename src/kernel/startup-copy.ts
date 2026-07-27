// The copy of the "terminal did not start" recovery surface, as DATA.
//
// Why this is a module of its own rather than string literals inside the
// renderer: a full-page consumer needs the same words in a place no module can
// reach. Its HTML carries an inline bootstrap watchdog whose entire job is to
// report "the JS bundle never ran" -- a rung below `import`, by definition, or
// it could not detect its own failure case. That watchdog cannot import these
// strings at runtime, so a consumer's BUILD substitutes them into its HTML
// instead, and the words survive as one declaration rather than three
// hand-agreed copies (the pattern this replaced had web-terminal-kiro's app
// code, its inline watchdog, and this library all restating them, kept in step
// by comments asking the next reader to remember).
//
// This file therefore imports nothing and touches no DOM, so a Node build script
// can read it without loading the kernel. It is exported at the package root and
// at the "./startup-copy" subpath for exactly that use.

/** The words the recovery surface shows, whichever startup rung failed.
 *
 *  A user cannot tell these failures apart and does not need to: the bundle not
 *  loading, the mount target not existing, and a feature constructor throwing
 *  all look like "I opened this and there is no terminal", and reloading is what
 *  they will try. So the title and the action label are deliberately identical
 *  across every rung; only the diagnostic detail differs, and that belongs in a
 *  log or a consumer-supplied message, not in the headline.
 *
 *  `message` is the generic body the library uses when it has nothing more
 *  specific. A consumer with a precise cause (its own bootstrap watchdog knows a
 *  stylesheet failed) should say so instead -- it is strictly more useful than
 *  this text -- while still taking `title` and `reloadLabel` from here. */
export const STARTUP_FAILURE_COPY = {
  title: "Terminal failed to start",
  message: "A required interface could not be loaded. Reload the page to try again.",
  reloadLabel: "Reload page",
} as const;
