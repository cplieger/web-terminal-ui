/**
 * presetTabbed (and the shared tabbed composition builder): the full
 * multi-session UI. Requires a server that speaks the session API
 * (`/api/sessions`, `/ws?session=`, and the status SSE `/api/sessions/events`).
 *
 * @module
 */

import type { TerminalFeature } from "../kernel/types.js";
import { mobileToolbar } from "../features/mobile-toolbar.js";
import { tabs } from "../features/tabs/index.js";
import { activityMonitor } from "../features/activity-monitor.js";
import { animations } from "../features/animations.js";
import { presetSingle } from "./single.js";

/** Options shared by the two tabbed presets, passed through to the tabs feature.
 *  A preset that takes arguments is called as `features: () =>
 *  presetTabbed({...})`, which keeps the call inside createTerminal's failure
 *  boundary (see CreateTerminalOptions.features). */
export interface TabbedPresetOptions {
  /** Swap the page's icon links to a status variant while a background session
   *  wants the user. Off by default, and enabling it is a promise that the
   *  variant assets are served — see TabsOptions.attentionIcons for the naming
   *  contract those files must satisfy. */
  attentionIcons?: boolean;
}

/** buildTabbed composes the tabbed UI: the single-pane touch features, a mobile
 *  toolbar opened from the tab bar's keyboard button, the activity monitor (the
 *  status SSE), tabs wired to both, and animations. The monitor is always
 *  included: a tab's dot shows only once its session reports activity (OSC
 *  9;4), or from creation under presumeReports. The toolbar and monitor precede
 *  tabs, which reads their APIs via ctx.use. Titles are the engine's: a browser
 *  that re-derived one would disagree with the server and every other client.
 *  Shared by presetTabbed and presetAgentTabbed (agent-tabbed.ts). */
export function buildTabbed(
  agentShell: boolean,
  opts: TabbedPresetOptions = {},
): TerminalFeature<unknown>[] {
  const kb = mobileToolbar({ externalToggle: true });
  const monitor = activityMonitor();
  return [
    ...presetSingle(),
    kb,
    monitor,
    tabs({
      keyboardToggle: kb,
      activityMonitor: monitor,
      presumeReports: agentShell,
      attentionIcons: opts.attentionIcons === true,
    }),
    animations(),
  ];
}

/** Tabbed UI: buildTabbed with agent activity presumed off (see buildTabbed for
 *  title and activity-dot sourcing). */
export function presetTabbed(opts: TabbedPresetOptions = {}): TerminalFeature<unknown>[] {
  return buildTabbed(false, opts);
}
