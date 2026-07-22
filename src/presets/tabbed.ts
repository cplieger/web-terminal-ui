// presetTabbed (and the shared tabbed composition builder): the full
// multi-session UI. Requires a server that speaks the session API
// (`/api/sessions`, `/ws?session=`, and the status SSE `/api/sessions/events`),
// such as `web-terminal-server` or `web-terminal-kiro`.

import type { TerminalFeature } from "../kernel/types.js";
import { mobileToolbar } from "../features/mobile-toolbar.js";
import { tabs } from "../features/tabs/index.js";
import { activityMonitor } from "../features/activity-monitor.js";
import { animations } from "../features/animations.js";
import { presetSingle } from "./single.js";

/** buildTabbed composes the tabbed UI: the single-pane touch features, an
 *  externally-driven mobile toolbar (its grid is opened from a keyboard button
 *  in the tab bar, not its own toggle), the activity monitor (the status-SSE
 *  data source), tabs wired to both, and animations. The activity dot reveals
 *  itself per tab only when a session reports activity (OSC 9;4) — or from tab
 *  creation when the agent composition presumes it — so the monitor is always
 *  included; a plain shell under presetTabbed just never shows a dot. The
 *  toolbar and monitor are ordered before tabs because tabs reads their APIs
 *  via ctx.use. Shared by presetTabbed and presetAgentTabbed (agent-tabbed.ts),
 *  which differ only in the agent-shell tuning: input-derived titles
 *  (preferInputTitle) + presumed activity reporting (presumeReports). */
export function buildTabbed(agentShell: boolean): TerminalFeature<unknown>[] {
  const kb = mobileToolbar({ externalToggle: true });
  const monitor = activityMonitor();
  return [
    ...presetSingle(),
    kb,
    monitor,
    tabs({
      keyboardToggle: kb,
      activityMonitor: monitor,
      preferInputTitle: agentShell,
      presumeReports: agentShell,
    }),
    animations(),
  ];
}

/** Tabbed UI: the touch features, tabs, the mobile keyboard bar, the activity
 *  monitor, and animations. Each tab's title follows the process OSC 0/2 window
 *  title when the program sets one, else the last submitted line; each tab's
 *  activity dot stays hidden until its session reports activity via OSC 9;4
 *  progress (kiro-cli, Claude Code, …), so a plain bash/sh keeps clean,
 *  label-only tabs. */
export function presetTabbed(): TerminalFeature<unknown>[] {
  return buildTabbed(false);
}
