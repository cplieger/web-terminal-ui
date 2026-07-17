// presetAgentTabbed: the tabbed composition tuned for an agent shell.

import type { TerminalFeature } from "../kernel/types.js";
import { buildTabbed } from "./tabbed.js";

/** Tabbed UI for an agent shell (web-terminal-kiro). Same features as
 *  presetTabbed, but with `preferInputTitle`: the agent's program (kiro-cli)
 *  emits a non-empty but useless OSC 0/2 title, so each tab's label follows the
 *  latest submitted line (persisted server-side and recovered on reload) and
 *  the OSC title is ignored. The agent-vs-generic status distinction remains
 *  server-side (a status classifier mapping OSC 9 notifications to
 *  done/needs-input). */
export function presetAgentTabbed(): TerminalFeature<unknown>[] {
  return buildTabbed(true);
}
