// Feature presets (design section 22.6). Presets are plain feature-array
// factories, so they are spreadable and editable: a consumer can drop or add a
// feature with a filter/spread. Importing a preset pulls in every feature it
// lists (convenient, full UI); a consumer wanting a minimal footprint imports
// individual features instead.
//
// presetTabbed (tabs + activityMonitor) is added once those features land.

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
  return [contextMenu({ clipboard: clip }), clip, scrollToBottom(), predictiveEcho(), connectionBanner()];
}

/** Touch-first UI: presetSingle plus the on-screen key toolbar. */
export function presetTouch(): TerminalFeature<unknown>[] {
  return [...presetSingle(), mobileToolbar()];
}

/** Full reference UI: presetTouch plus tabs, the activity monitor, and
 *  animations. activityMonitor is ordered before tabs because tabs reads its
 *  API via ctx.use during setup (to wire status dots). */
export function presetTabbed(): TerminalFeature<unknown>[] {
  const monitor = activityMonitor();
  return [...presetTouch(), monitor, tabs({ activityMonitor: monitor }), animations()];
}
