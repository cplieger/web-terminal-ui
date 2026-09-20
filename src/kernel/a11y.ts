// Kernel-owned accessibility primitives: one polite and one assertive live
// region so features never spawn competing aria-live regions, and one
// tablist/tabpanel controller wired on the kernel's output surface so `tabs`
// gets the ARIA seam without crossing into kernel-owned DOM.

import type { PaneSide, TablistController, TabHandle } from "./types.js";
import { windowOf } from "./realm.js";

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
  const doc = root.ownerDocument;
  const win = windowOf(doc);
  const polite = doc.createElement("div");
  polite.setAttribute("aria-live", "polite");
  polite.setAttribute("aria-atomic", "true");
  hideVisually(polite);
  const assertive = doc.createElement("div");
  assertive.setAttribute("aria-live", "assertive");
  assertive.setAttribute("aria-atomic", "true");
  hideVisually(assertive);
  root.append(polite, assertive);

  // Pending re-set timers, one per region, so a rapid follow-up announcement
  // replaces the pending one instead of interleaving with it.
  const timers = new Map<HTMLElement, number>();

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
      win.clearTimeout(pending);
    }
    timers.set(
      el,
      win.setTimeout(() => {
        timers.delete(el);
        el.textContent = message;
      }, REANNOUNCE_DELAY_MS),
    );
  }

  function destroy(): void {
    for (const t of timers.values()) {
      win.clearTimeout(t);
    }
    timers.clear();
    polite.remove();
    assertive.remove();
  }

  return { announce, destroy };
}

let panelSeq = 0;
let tabSeq = 0;

/** One pane's tabpanel: labelled by the tab it shows, described by the shell's
 *  selection text. */
export interface PaneTablist {
  panelId(): string;
  labelBy(tabId: string): void;
  /** Drop the label when `tabId` is the tab labelling the panel. */
  unlabel(tabId: string): void;
  /** The panel's `aria-describedby` text; empty removes it. */
  setDescription(text: string): void;
}

/** Wire the tabpanel half of the ARIA seam on a pane's output surface. */
export function createPaneTablist(panel: HTMLElement): PaneTablist {
  panelSeq += 1;
  const panelId = panel.id || `wt-panel-${String(panelSeq)}`;
  panel.id = panelId;
  panel.setAttribute("role", "tabpanel");
  let description: HTMLElement | null = null;

  return {
    panelId: () => panelId,
    labelBy(tabId) {
      panel.setAttribute("aria-labelledby", tabId);
    },
    unlabel(tabId) {
      if (panel.getAttribute("aria-labelledby") === tabId) {
        panel.removeAttribute("aria-labelledby");
      }
    },
    setDescription(text) {
      if (text === "") {
        description?.remove();
        description = null;
        panel.removeAttribute("aria-describedby");
        return;
      }
      if (description === null) {
        description = panel.ownerDocument.createElement("span");
        description.id = `${panelId}-description`;
        hideVisually(description);
        panel.parentElement?.appendChild(description);
        panel.setAttribute("aria-describedby", description.id);
      }
      description.textContent = text;
    },
  };
}

/** Wire the tab-row half of the ARIA seam. `panelFor(side)` answers the pane
 *  showing a tab, and `panelFor(null)` the pane a click on an unshown tab would
 *  fill; either may be null before that pane is built. */
export function createTablist(
  panelFor: (side: PaneSide | null) => PaneTablist | null,
): TablistController {
  function registerTab(tab: HTMLElement): TabHandle {
    tabSeq += 1;
    const tabId = tab.id || `wt-tab-${String(tabSeq)}`;
    tab.id = tabId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    // Roving tabindex (WAI-ARIA APG Tabs pattern): only the selected tab is in
    // the Tab sequence; the others are focusable programmatically (arrow keys).
    tab.tabIndex = -1;
    let side: PaneSide | null = null;
    let selected = false;
    let labelled: PaneTablist | null = null;
    function paintPanel(): void {
      const panel = panelFor(side);
      if (panel === null) {
        tab.removeAttribute("aria-controls");
      } else {
        tab.setAttribute("aria-controls", panel.panelId());
      }
      // A panel is labelled by the selected tab that controls it, and by nothing else.
      const labelling = selected ? panel : null;
      if (labelling !== labelled) {
        labelled?.unlabel(tabId);
        labelling?.labelBy(tabId);
        labelled = labelling;
      }
    }
    paintPanel();

    return {
      setSelected(on: boolean): void {
        selected = on;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        paintPanel();
      },
      setPanel(next: PaneSide | null): void {
        side = next;
        paintPanel();
      },
      setExpanded(state: boolean | null): void {
        if (state === null) {
          tab.removeAttribute("aria-expanded");
        } else {
          tab.setAttribute("aria-expanded", state ? "true" : "false");
        }
      },
      setLabel(text: string): void {
        tab.setAttribute("aria-label", text);
      },
      setEditing(editing: boolean, on: boolean): void {
        if (editing) {
          // Drop the tab semantics while a textbox lives inside the chip, and
          // take the chip out of the roving sequence so Tab moves past it to the
          // field rather than onto a role-less container. aria-controls and the
          // panel's aria-labelledby stay: the panel still describes this session,
          // and clearing them would flap the panel's accessible name mid-edit.
          tab.removeAttribute("role");
          tab.removeAttribute("aria-selected");
          tab.tabIndex = -1;
          return;
        }
        selected = on;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        paintPanel();
      },
      remove(): void {
        tab.removeAttribute("role");
        tab.removeAttribute("aria-controls");
        tab.removeAttribute("aria-selected");
        tab.removeAttribute("aria-expanded");
        tab.removeAttribute("tabindex");
        labelled?.unlabel(tabId);
        labelled = null;
      },
    };
  }

  return {
    panelId: () => panelFor(null)?.panelId() ?? "",
    registerTab,
  };
}
