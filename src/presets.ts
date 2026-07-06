// Feature presets (design section 22.6). Presets are plain feature-array
// factories, so they are spreadable and editable: a consumer can drop or add a
// feature with a filter/spread. Importing a preset pulls in every feature it
// lists (convenient, full UI); a consumer wanting a minimal footprint imports
// individual features instead.
//
// The tabbed presets (presetTabbed / presetAgentTabbed) share the same feature
// set (both include the activity monitor, whose per-tab dot reveals itself only
// on OSC 9;4 progress, so a plain shell never shows one). They differ in the
// title source: presetAgentTabbed sets preferInputTitle (the agent's program
// emits a useless OSC title, so the label follows the latest submitted line),
// while presetTabbed is OSC-first. The generic-vs-agent STATUS distinction stays
// server-side — an agent server sets a classifier mapping OSC 9 notifications to
// done/needs-input.

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
function buildTabbed(preferInputTitle: boolean): TerminalFeature<unknown>[] {
  const kb = mobileToolbar({ externalToggle: true });
  const monitor = activityMonitor();
  return [
    ...presetSingle(),
    kb,
    monitor,
    tabs({ keyboardToggle: kb, activityMonitor: monitor, preferInputTitle }),
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
  return buildTabbed(false);
}

/** Tabbed UI for an agent shell (vibecli). Same features as presetTabbed, but
 *  with `preferInputTitle`: the agent's program (kiro-cli) emits a non-empty but
 *  useless OSC 0/2 title, so each tab's label follows the latest submitted line
 *  (persisted server-side and recovered on reload) and the OSC title is ignored.
 *  The agent-vs-generic status distinction remains server-side (a status
 *  classifier mapping OSC 9 notifications to done/needs-input). */
export function presetAgentTabbed(): TerminalFeature<unknown>[] {
  return buildTabbed(true);
}
