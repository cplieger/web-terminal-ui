// Feature presets: the barrel. Presets are plain feature-array factories, so
// they are spreadable and editable: a consumer can drop or add a feature with a
// filter/spread. This barrel statically imports EVERY preset (and therefore
// every feature); a consumer that wants the minimal delivered import graph for
// its composition imports the per-preset entry module instead —
// "@cplieger/web-terminal-ui/presets/single" | "/presets/touch" |
// "/presets/tabbed" | "/presets/agent-tabbed" — or hand-picks individual
// features from "@cplieger/web-terminal-ui/features/<name>".
//
// The tabbed presets (presetTabbed / presetAgentTabbed) share the same feature
// set (both include the activity monitor, whose per-tab dot reveals itself only
// on OSC 9;4 progress, so a plain shell never shows one). They differ in the
// title source: presetAgentTabbed sets preferInputTitle (the agent's program
// emits a useless OSC title, so the label follows the latest submitted line),
// while presetTabbed is OSC-first. The generic-vs-agent STATUS distinction stays
// server-side — an agent server sets a classifier mapping OSC 9 notifications to
// done/needs-input.

export { presetSingle } from "./presets/single.js";
export { presetTouch } from "./presets/touch.js";
export { presetTabbed } from "./presets/tabbed.js";
export { presetAgentTabbed } from "./presets/agent-tabbed.js";
