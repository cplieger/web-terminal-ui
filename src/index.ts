// @cplieger/web-terminal-ui — the reference touch-first browser UI built on
// the @cplieger/web-terminal-engine engine. The public surface is a single
// mount(root) call that builds the whole terminal subtree inside a
// host-provided element; scaffold/index.html + css/ are a reference page to copy.
//
// Consumers who want a different UI should depend on @cplieger/web-terminal-engine
// directly and wire the engine's render/scroll/connection/keyboard modules
// to their own DOM.

export { mount } from "./mount.js";
export type { MountOptions, TerminalUI } from "./mount.js";
