// Kernel-owned accessibility primitives (design sections 12, 22.4): one polite
// and one assertive live region so features never spawn competing aria-live
// regions, and one tablist/tabpanel controller wired on the kernel's output
// surface so `tabs` gets the ARIA seam without crossing into kernel-owned DOM.

import type { TablistController, TabHandle } from "./types.js";

/** Visually-hidden style applied inline so it holds without external CSS
 *  (tests run without the stylesheet). Standard sr-only clip technique. */
function hideVisually(el: HTMLElement): void {
  const s = el.style;
  s.position = "absolute";
  s.width = "1px";
  s.height = "1px";
  s.margin = "-1px";
  s.padding = "0";
  s.overflow = "hidden";
  s.clipPath = "inset(50%)";
  s.whiteSpace = "nowrap";
  s.border = "0";
}

export interface Announcer {
  announce(message: string, politeness?: "polite" | "assertive"): void;
  destroy(): void;
}

/** Delay before a cleared live region is re-set with the new message (ms).
 *  Long enough for assistive tech to register the clear and the set as two
 *  distinct mutations (a sub-frame gap is not). */
const REANNOUNCE_DELAY_MS = 100;

/** Build the single pair of live regions inside root. */
export function createAnnouncer(root: HTMLElement): Announcer {
  const polite = document.createElement("div");
  polite.setAttribute("aria-live", "polite");
  polite.setAttribute("aria-atomic", "true");
  hideVisually(polite);
  const assertive = document.createElement("div");
  assertive.setAttribute("aria-live", "assertive");
  assertive.setAttribute("aria-atomic", "true");
  hideVisually(assertive);
  root.append(polite, assertive);

  // Pending re-set timers, one per region, so a rapid follow-up announcement
  // replaces the pending one instead of interleaving with it.
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  function announce(message: string, politeness: "polite" | "assertive" = "polite"): void {
    const el = politeness === "assertive" ? assertive : polite;
    // Clear then re-set after a short (~100ms) TIMER so a repeat of the same
    // message is re-announced: screen readers ignore an unchanged live-region
    // value, and a sub-frame gap (the previous requestAnimationFrame
    // approach, ~16ms) is too fast for some assistive tech to register two
    // distinct mutations — the same rationale ui-primitives' announce()
    // documents for its shared region.
    el.textContent = "";
    const pending = timers.get(el);
    if (pending !== undefined) {
      clearTimeout(pending);
    }
    timers.set(
      el,
      setTimeout(() => {
        timers.delete(el);
        el.textContent = message;
      }, REANNOUNCE_DELAY_MS),
    );
  }

  function destroy(): void {
    for (const t of timers.values()) {
      clearTimeout(t);
    }
    timers.clear();
    polite.remove();
    assertive.remove();
  }

  return { announce, destroy };
}

let panelSeq = 0;
let tabSeq = 0;

/** Wire the ARIA tablist/tabpanel seam on the kernel's output surface. */
export function createTablist(panel: HTMLElement): TablistController {
  panelSeq += 1;
  const panelId = panel.id || `wt-panel-${String(panelSeq)}`;
  panel.id = panelId;
  panel.setAttribute("role", "tabpanel");

  function registerTab(tab: HTMLElement): TabHandle {
    tabSeq += 1;
    const tabId = tab.id || `wt-tab-${String(tabSeq)}`;
    tab.id = tabId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId);
    tab.setAttribute("aria-selected", "false");
    // Roving tabindex (WAI-ARIA APG Tabs pattern): only the selected tab is in
    // the Tab sequence; the others are focusable programmatically (arrow keys).
    tab.tabIndex = -1;

    return {
      setSelected(selected: boolean): void {
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected ? 0 : -1;
        if (selected) {
          // The panel is labelled by whichever tab is currently selected.
          panel.setAttribute("aria-labelledby", tabId);
        }
      },
      setLabel(text: string): void {
        tab.setAttribute("aria-label", text);
      },
      remove(): void {
        tab.removeAttribute("role");
        tab.removeAttribute("aria-controls");
        tab.removeAttribute("aria-selected");
        tab.removeAttribute("tabindex");
        if (panel.getAttribute("aria-labelledby") === tabId) {
          panel.removeAttribute("aria-labelledby");
        }
      },
    };
  }

  return {
    panelId: () => panelId,
    registerTab,
  };
}
