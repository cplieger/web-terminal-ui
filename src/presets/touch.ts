// presetTouch: the touch-first composition (single + the on-screen key
// toolbar). Its own entry module so a touch consumer's delivered import graph
// excludes the tabs/activity/animations modules entirely (vibekit's embedded
// panel imports exactly this).

import type { TerminalFeature } from "../kernel/types.js";
import { mobileToolbar } from "../features/mobile-toolbar.js";
import { presetSingle } from "./single.js";

/** Touch-first UI: presetSingle plus the on-screen key toolbar. */
export function presetTouch(): TerminalFeature<unknown>[] {
  return [...presetSingle(), mobileToolbar()];
}
