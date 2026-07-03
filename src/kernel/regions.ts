// Layout regions (design section 22.13).
//
// The kernel owns a small layout skeleton: named regions with fixed geometry,
// stacking, and keyboard-inset behavior. Features contribute chrome into a
// region via ctx.region(name, slot); the region owns position, spacing, stack
// direction, z-order, and the keyboard lift, so features cannot invent their own
// placement or collide. DOM order within a region always equals visual order, so
// focus order never diverges from reading order (WCAG 2.4.3): each slot is a
// wrapper inserted in a declared order, and a feature appends into its slot.

import type { RegionName, RegionSlot } from "./types.js";

/** The regions the kernel builds, in DOM order. */
const REGION_NAMES: readonly RegionName[] = [
  "top-bar",
  "banner",
  "bottom-inset-end",
  "bottom-switcher",
  "overlay",
  "sheet",
];

/** Declared slot order per region. A slot not listed here sorts after the known
 *  ones, in first-request order, so an unanticipated slot still composes
 *  predictably rather than throwing. */
const SLOT_ORDER: Record<RegionName, readonly RegionSlot[]> = {
  "top-bar": ["tabs"],
  banner: ["status"],
  "bottom-inset-end": ["keys", "scroll"],
  "bottom-switcher": ["switcher"],
  overlay: ["menu"],
  sheet: ["overview"],
};

const DEFAULT_SLOT = "default";

export interface Regions {
  /** Return the live slot element within a region for a feature to append into.
   *  Created once per (region, slot) and inserted in the region's declared slot
   *  order. */
  region(name: RegionName, slot?: RegionSlot): HTMLElement;
  /** Remove all region containers from the root. */
  destroy(): void;
}

/** slotRank returns a sort key for a slot within a region: its index in the
 *  declared order, or a large base offset plus a per-region monotonic counter
 *  for unlisted slots (stable first-request order). */
function slotRank(name: RegionName, slot: RegionSlot, seen: Map<string, number>): number {
  const order = SLOT_ORDER[name];
  const idx = order.indexOf(slot);
  if (idx >= 0) {
    return idx;
  }
  const key = `${name}:${slot}`;
  let rank = seen.get(key);
  if (rank === undefined) {
    rank = 1000 + seen.size;
    seen.set(key, rank);
  }
  return rank;
}

/** Build the region skeleton inside root and return a Regions accessor. */
export function createRegions(root: HTMLElement): Regions {
  const containers = new Map<RegionName, HTMLElement>();
  const slots = new Map<string, HTMLElement>(); // "region:slot" -> slot element
  const unlistedSeen = new Map<string, number>();

  for (const name of REGION_NAMES) {
    const el = document.createElement("div");
    el.className = `wt-region wt-region-${name}`;
    el.dataset["region"] = name;
    root.appendChild(el);
    containers.set(name, el);
  }

  function region(name: RegionName, slot: RegionSlot = DEFAULT_SLOT): HTMLElement {
    const key = `${name}:${slot}`;
    const existing = slots.get(key);
    if (existing) {
      return existing;
    }
    const container = containers.get(name);
    if (!container) {
      throw new Error(`web-terminal-ui: unknown region ${name}`);
    }
    const el = document.createElement("div");
    el.className = `wt-slot wt-slot-${slot}`;
    el.dataset["slot"] = slot;
    // Insert in declared slot order: before the first existing child whose rank
    // is greater than ours.
    const myRank = slotRank(name, slot, unlistedSeen);
    let inserted = false;
    for (const child of Array.from(container.children)) {
      const childSlot = (child as HTMLElement).dataset["slot"] ?? DEFAULT_SLOT;
      if (slotRank(name, childSlot, unlistedSeen) > myRank) {
        container.insertBefore(el, child);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      container.appendChild(el);
    }
    slots.set(key, el);
    return el;
  }

  function destroy(): void {
    for (const el of containers.values()) {
      el.remove();
    }
    containers.clear();
    slots.clear();
  }

  return { region, destroy };
}
