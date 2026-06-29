// @cplieger/web-terminal-ui — the reference touch-first browser UI built on
// the @cplieger/web-terminal engine. The public surface is a single mount()
// call against the shipped scaffold (scaffold/index.html) + CSS (css/).
//
// Consumers who want a different UI should depend on @cplieger/web-terminal
// directly and wire the engine's render/scroll/connection/keyboard modules
// to their own DOM.

export { mount } from "./mount.js";
export type { MountOptions, TerminalUI } from "./mount.js";
