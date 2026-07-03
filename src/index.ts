// @cplieger/web-terminal-ui — the reference touch-first browser UI built on the
// @cplieger/web-terminal-engine engine.
//
// v3 entry: createTerminal(root, { features }) builds a small kernel (display
// output, hidden textarea, IME, engine wiring, input funnel, connection-state,
// layout regions) plus opt-in feature modules. Feature bundles live at
// "@cplieger/web-terminal-ui/presets" (presetSingle / presetTouch /
// presetTabbed); a consumer that hand-picks features imports them individually.
//
// A consumer who wants a different UI depends on @cplieger/web-terminal-engine
// directly and wires the engine's render/scroll/connection/keyboard modules to
// their own DOM.

export { createTerminal } from "./kernel/kernel.js";
export type {
  CreateTerminalOptions,
  TerminalHandle,
  TerminalFeature,
  FeatureInstance,
  TerminalContext,
  TerminalEvents,
  RegionName,
  RegionSlot,
  RenderHandle,
  ScrollHandle,
  SessionRef,
  SessionView,
  ConnState,
  TablistController,
  TabHandle,
  Unsubscribe,
} from "./kernel/types.js";

// The legacy single-instance entry. Retained for consumers still on mount(root)
// until they migrate to createTerminal; removed in the final v3 cutover.
export { mount } from "./mount.js";
export type { MountOptions, TerminalUI } from "./mount.js";
