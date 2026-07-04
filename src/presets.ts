// Feature presets (design section 22.6). Presets are plain feature-array
// factories, so they are spreadable and editable: a consumer can drop or add a
// feature with a filter/spread. Importing a preset pulls in every feature it
// lists (convenient, full UI); a consumer wanting a minimal footprint imports
// individual features instead.
//
// The tabbed presets (presetTabbed / presetAgentTabbed) are now identical: both
// include the activity monitor, because the per-tab activity dot reveals itself
// only when a session reports activity (OSC 9;4 progress), so a plain shell
// simply never shows one. The generic-vs-agent distinction is now purely
// server-side — an agent server sets a status classifier that maps OSC 9
// notifications to done/needs-input. presetAgentTabbed is kept as an alias for
// its consumers (vibecli).

import type { TerminalFeature } from "./kernel/types.js";
import { clipboard } from "./features/clipboard.js";
import { contextMenu } from "./features/context-menu.js";
import { scrollToBottom } from "./features/scroll-to-bottom.js";
import { predictiveEcho } from "./features/predictive-echo.js";
import { connectionBanner } from "./features/connection-banner.js";
import { mobileToolbar } from "./features/mobile-toolbar.js";
import { tabs } from "./features/tabs.js";
import { activityMonitor } from "./features/activity-monitor.js";
import { animations } from "./features/animations.js";

/** Single-pane desktop UI: context menu, clipboard, scroll-to-bottom, predictive
 *  echo, and the connection banner. No mobile toolbar, no tabs. */
export function presetSingle(): TerminalFeature<unknown>[] {
  // contextMenu offers Copy/Paste through the clipboard feature (ctx.use), so it
  // holds the same clipboard value the array includes.
  const clip = clipboard();
  return [
    contextMenu({ clipboard: clip }),
    clip,
    scrollToBottom(),
    predictiveEcho(),
    connectionBanner(),
  ];
}

/** Touch-first UI: presetSingle plus the on-screen key toolbar. */
export function presetTouch(): TerminalFeature<unknown>[] {
  return [...presetSingle(), mobileToolbar()];
}

// buildTabbed composes the tabbed UI: the single-pane touch features, an
// externally-driven mobile toolbar (its grid is opened from a keyboard button in
// the tab bar, not its own toggle), the activity monitor (the status-SSE data
// source), tabs wired to both, and animations. The activity dot reveals itself
// per tab only when a session reports activity (OSC 9;4), so the monitor is
// always included — a plain shell just never reveals a dot. The toolbar and
// monitor are ordered before tabs because tabs reads their APIs via ctx.use.
function buildTabbed(): TerminalFeature<unknown>[] {
  const kb = mobileToolbar({ externalToggle: true });
  const monitor = activityMonitor();
  return [
    ...presetSingle(),
    kb,
    monitor,
    tabs({ keyboardToggle: kb, activityMonitor: monitor }),
    animations(),
  ];
}

/** Tabbed UI: the touch features, tabs, the mobile keyboard bar, the activity
 *  monitor, and animations. Requires a server that speaks the session API
 *  (`/api/sessions`, `/ws?session=`, and the status SSE `/api/sessions/events`),
 *  such as `web-terminal-server` or `vibecli`. Each tab's title follows the
 *  process OSC 0/2 window title when the program sets one, else the last
 *  submitted line; each tab's activity dot stays hidden until its session
 *  reports activity via OSC 9;4 progress (kiro-cli, Claude Code, …), so a plain
 *  bash/sh keeps clean, label-only tabs. */
export function presetTabbed(): TerminalFeature<unknown>[] {
  return buildTabbed();
}

/** Alias of presetTabbed, kept for the agent-shell consumer (vibecli). The UI is
 *  identical — the generic-vs-agent distinction is now purely server-side: an
 *  agent server sets a status classifier (mapping OSC 9 notifications to
 *  done/needs-input), and each tab's dot reveals itself from OSC 9;4 either way. */
export function presetAgentTabbed(): TerminalFeature<unknown>[] {
  return buildTabbed();
}
