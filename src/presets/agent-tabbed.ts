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
 *    activity (OSC 7501 status, OSC 9;4 progress or a classified OSC 9
 *    notification), so the idle activity dot
 *    shows from tab creation instead of popping in when the agent first
 *    reports; the server's sticky reportsActivity flag then merely confirms.
 *    (presetTabbed keeps the evidence-driven reveal: a plain shell never grows
 *    a meaningless dot.) */
export function presetAgentTabbed(opts: TabbedPresetOptions = {}): TerminalFeature<unknown>[] {
  return buildTabbed(true, opts);
}
