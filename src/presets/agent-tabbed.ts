// presetAgentTabbed: the tabbed composition tuned for an agent shell.

import type { TerminalFeature } from "../kernel/types.js";
import { buildTabbed } from "./tabbed.js";

/** Tabbed UI for an agent shell (web-terminal-kiro). Same features as
 *  presetTabbed, tuned for sessions that ARE agents:
 *  - `preferInputTitle`: the agent's program (kiro-cli) emits a non-empty but
 *    useless OSC 0/2 title, so each tab's label follows the latest submitted
 *    line (persisted server-side and recovered on reload) and the OSC title
 *    is ignored.
 *  - `presumeReports`: every session's program is an agent that WILL report
 *    OSC 9;4 progress, so the idle activity dot shows from tab creation
 *    instead of popping in seconds later when the agent has booted far enough
 *    to first report; the server's sticky reportsActivity flag then merely
 *    confirms. (presetTabbed keeps the evidence-driven reveal instead: a
 *    plain shell never grows a meaningless dot.)
 *  The agent-vs-generic status distinction remains server-side (a status
 *  classifier mapping OSC 9 notifications to done/needs-input). */
export function presetAgentTabbed(): TerminalFeature<unknown>[] {
  return buildTabbed(true);
}
