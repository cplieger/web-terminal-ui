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
 *  which now differ only in presumed activity reporting (presumeReports).
 *
 *  Titles are no longer a preset concern. The ENGINE resolves a session's name —
 *  its pinned name, an input-derived name when the host asked for one
 *  (terminal.WithInputTitle), the program's OSC window title, or its own
 *  foreground-process/cwd inference — and both presets render what it reports. A
 *  browser that re-derived any of that could only disagree with the server and
 *  with every other client attached to the same session. */
/** Options shared by the two tabbed presets, passed through to the tabs feature.
 *  A preset that takes arguments is called as `features: () =>
 *  presetTabbed({...})`, which keeps the call inside createTerminal's failure
 *  boundary (see CreateTerminalOptions.features). */
export interface TabbedPresetOptions {
  /** Swap the page's icon links to a status variant while a background session
   *  wants the user. Off by default, and enabling it is a promise that the
   *  variant assets are served — see TabsOptions.attentionIcons for the naming
   *  contract and .kiro/scripts/gen-attention-icons.py, which writes them. */
  attentionIcons?: boolean;
}

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

/** Tabbed UI: the touch features, tabs, the mobile keyboard bar, the activity
 *  monitor, and animations. Each tab's title follows the process OSC 0/2 window
 *  title when the program sets one, else the last submitted line; each tab's
 *  activity dot stays hidden until its session reports activity via OSC 9;4
 *  progress (kiro-cli, Claude Code, …), so a plain bash/sh keeps clean,
 *  label-only tabs. */
export function presetTabbed(opts: TabbedPresetOptions = {}): TerminalFeature<unknown>[] {
  return buildTabbed(false, opts);
}
