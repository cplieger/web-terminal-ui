/**
 * Feature presets: the barrel. Presets are plain feature-array factories, so
 * they are spreadable and editable: a consumer can drop or add a feature with a
 * filter/spread. This barrel statically imports EVERY preset (and therefore
 * every feature); a consumer that wants the minimal delivered import graph for
 * its composition imports the per-preset entry module instead —
 * "@cplieger/web-terminal-ui/presets/single" | "/presets/touch" |
 * "/presets/tabbed" | "/presets/agent-tabbed" — or hand-picks individual
 * features from "@cplieger/web-terminal-ui/features/<name>".
 *
 * The tabbed presets (presetTabbed / presetAgentTabbed) share the same feature
 * set (both include the activity monitor, which drives the per-tab activity
 * dot). They differ in one flag, `presumeReports`: presetAgentTabbed presumes
 * every session's program is an agent that WILL report activity (OSC 7501
 * status, OSC 9;4 progress or a classified OSC 9 notification), so the idle dot
 * shows from tab creation instead of appearing seconds later on the first
 * report, while presetTabbed keeps the evidence-driven reveal so a plain shell
 * never grows a meaningless dot.
 * Session NAMES are not a preset concern: the engine resolves them, including a
 * title its host pushes. Which status a session holds is the server's: the UI
 * renders the status it is sent.
 *
 * @module
 */

export { presetSingle } from "./presets/single.js";
export { presetTouch } from "./presets/touch.js";
export { presetTabbed } from "./presets/tabbed.js";
export type { TabbedPresetOptions } from "./presets/tabbed.js";
export { presetAgentTabbed } from "./presets/agent-tabbed.js";
