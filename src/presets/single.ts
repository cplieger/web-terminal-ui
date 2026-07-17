// presetSingle: the single-pane desktop composition. Its own entry module so a
// consumer importing "@cplieger/web-terminal-ui/presets/single" pulls in ONLY
// this feature graph — none of the toolbar/tabs modules (the ./presets barrel
// statically reaches everything; these per-preset entries are the
// graph-minimal imports).

import type { TerminalFeature } from "../kernel/types.js";
import { clipboard } from "../features/clipboard.js";
import { contextMenu } from "../features/context-menu.js";
import { scrollToBottom } from "../features/scroll-to-bottom.js";
import { predictiveEcho } from "../features/predictive-echo.js";
import { connectionBanner } from "../features/connection-banner.js";

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
