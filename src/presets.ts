// Feature presets (design section 22.6). Presets are plain feature-array
// factories, so they are spreadable and editable: a consumer can drop or add a
// feature with a filter/spread. Importing a preset pulls in every feature it
// lists (convenient, full UI); a consumer wanting a minimal footprint imports
// individual features instead.
//
// The tabbed presets split by consumer: presetTabbed is the generic label-only
// tabbed UI (a plain bash/sh terminal, the first-class experience); the derived
// presetAgentTabbed layers the activity monitor on top, so an agent shell like
// vibecli gets per-tab status dots. The split keeps agent semantics out of the
// generic terminal (design "generic first, vibecli is a derivation").

import type { TerminalFeature } from "./kernel/types.js";
import { clipboard } from "./features/clipboard.js";
import { contextMenu } from "./features/context-menu.js";
import { scrollToBottom } from "./features/scroll-to-bottom.js";
import { predictiveEcho } from "./features/predictive-echo.js";
import { connectionBanner } from "./features/connection-banner.js";
import { mobileToolbar } from "./features/mobile-toolbar.js";
import { tabs } from "./features/tabs.js";
import { activityMonitor } from "./features/activity-monitor.js";
import type { ActivityMonitorApi } from "./features/activity-monitor.js";
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

// buildTabbed composes the tabbed UI shared by both tabbed presets: the
// single-pane touch features, an externally-driven mobile toolbar (its grid is
// opened from a keyboard button in the tab bar, not its own toggle), tabs wired
// to that toolbar, and animations. An optional activity monitor adds per-tab
// status dots (the agent variant). The toolbar and monitor are ordered before
// tabs because tabs reads their APIs via ctx.use.
function buildTabbed(monitor?: TerminalFeature<ActivityMonitorApi>): TerminalFeature<unknown>[] {
  const kb = mobileToolbar({ externalToggle: true });
  return [
    ...presetSingle(),
    kb,
    ...(monitor ? [monitor] : []),
    tabs({ keyboardToggle: kb, ...(monitor ? { activityMonitor: monitor } : {}) }),
    animations(),
  ];
}

/** Generic tabbed UI: touch features, label-only tabs, the mobile keyboard bar,
 *  and animations. No activity monitor, so tabs carry no status dots. This is
 *  the first-class experience for a plain terminal (bash/sh) where "agent
 *  activity" has no meaning. An agent shell wants presetAgentTabbed instead. */
export function presetTabbed(): TerminalFeature<unknown>[] {
  return buildTabbed();
}

/** Agent-shell tabbed UI: presetTabbed plus the activity monitor, so each tab
 *  shows a live status dot (idle / working / done / needs-input) from the
 *  server's status SSE. vibecli composes this; a generic terminal composes
 *  presetTabbed. */
export function presetAgentTabbed(): TerminalFeature<unknown>[] {
  return buildTabbed(activityMonitor());
}
