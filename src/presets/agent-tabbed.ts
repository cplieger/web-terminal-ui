/**
 * presetAgentTabbed: the tabbed composition tuned for an agent shell.
 *
 * @module
 */

import type { TerminalFeature } from "../kernel/types.js";
import { type TabbedPresetOptions, buildTabbed } from "./tabbed.js";

/** Tabbed UI for an agent shell. Same features as presetTabbed, tuned for
 *  sessions that ARE agents:
 *  - `presumeReports`: every session's program is an agent that WILL report
 *    OSC 9;4 progress, so the idle activity dot shows from tab creation
 *    instead of popping in seconds later when the agent has booted far enough
 *    to first report; the server's sticky reportsActivity flag then merely
 *    confirms. (presetTabbed keeps the evidence-driven reveal instead: a
 *    plain shell never grows a meaningless dot.)
 *  One agent-vs-generic distinction lives SERVER-side rather than here: the
 *  status classifier that maps OSC 9 notifications to done/needs-input. Tab
 *  names are server-side too but are not agent-specific — see buildTabbed. */
export function presetAgentTabbed(opts: TabbedPresetOptions = {}): TerminalFeature<unknown>[] {
  return buildTabbed(true, opts);
}
