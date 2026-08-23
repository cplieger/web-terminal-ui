// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRegions } from "./regions.js";
import type { RegionName } from "./types.js";

function slotOrder(root: HTMLElement, region: string): (string | undefined)[] {
  const container = root.querySelector(`[data-region="${region}"]`);
  return Array.from(container?.children ?? []).map((c) => (c as HTMLElement).dataset["slot"]);
}

describe("regions: skeleton", () => {
  it("builds one container per region in declared DOM order", () => {
    const root = document.createElement("div");
    createRegions(root);
    expect(Array.from(root.children).map((c) => (c as HTMLElement).dataset["region"])).toEqual([
      "top-bar",
      "banner",
      "bottom-inset-end",
      "bottom-switcher",
      "overlay",
      "sheet",
    ]);
  });

  it("returns the same slot element for a repeated (region, slot) request", () => {
    const root = document.createElement("div");
    const regions = createRegions(root);
    const first = regions.region("banner", "status");
    const second = regions.region("banner", "status");
    expect(second).toBe(first);
    expect(slotOrder(root, "banner")).toEqual(["status"]);
  });

  it("destroy removes every region container from the root", () => {
    const root = document.createElement("div");
    const regions = createRegions(root);
    regions.region("banner", "status");
    expect(root.children.length).toBe(6);
    regions.destroy();
    expect(root.children.length).toBe(0);
  });
});

describe("regions: slot ordering (DOM order == reading order, WCAG 2.4.3)", () => {
  it("inserts declared slots in their SLOT_ORDER position regardless of request order", () => {
    const root = document.createElement("div");
    const regions = createRegions(root);
    // "bottom-inset-end" declares ["keys", "scroll"]; request "scroll" first.
    regions.region("bottom-inset-end", "scroll");
    regions.region("bottom-inset-end", "keys");
    expect(slotOrder(root, "bottom-inset-end")).toEqual(["keys", "scroll"]);
  });

  it("ranks an unlisted slot after every declared slot", () => {
    const root = document.createElement("div");
    const regions = createRegions(root);
    // "overlay" declares only ["menu"]; an unlisted slot requested first must
    // still sort after the declared "menu" (the 1000+ base offset).
    regions.region("overlay", "custom");
    regions.region("overlay", "menu");
    expect(slotOrder(root, "overlay")).toEqual(["menu", "custom"]);
  });

  it("keeps two unlisted slots in stable first-request order, not alphabetical", () => {
    const root = document.createElement("div");
    const regions = createRegions(root);
    regions.region("overlay", "z-first");
    regions.region("overlay", "a-second");
    expect(slotOrder(root, "overlay")).toEqual(["z-first", "a-second"]);
  });
});

describe("regions: the declared slot order is the table's, not the request order's", () => {
  // SLOT_ORDER is built when the module is evaluated, so the statically imported
  // module above has already committed to it before any test runs. Re-importing
  // per test is what puts the TABLE itself under test rather than only the
  // ranking code that reads it.
  let freshRegions: typeof createRegions;

  beforeEach(async () => {
    vi.resetModules();
    ({ createRegions: freshRegions } = await import("./regions.js"));
  });

  it.each([
    ["top-bar", "tabs"],
    ["banner", "status"],
    ["bottom-switcher", "switcher"],
    ["overlay", "menu"],
    ["sheet", "overview"],
  ])("sorts %s's declared slot (%s) ahead of an undeclared one requested first", (region, slot) => {
    // Each region declares the slot its own feature contributes into. A region
    // whose declaration went missing would place that feature by arrival order
    // instead, which is the one thing this module exists to prevent: DOM order
    // is reading order and focus order (WCAG 2.4.3), so it cannot depend on
    // which feature happened to set up first.
    const root = document.createElement("div");
    const regions = freshRegions(root);

    regions.region(region as RegionName, "unlisted");
    regions.region(region as RegionName, slot);

    expect(slotOrder(root, region)).toEqual([slot, "unlisted"]);
  });

  it("sorts bottom-inset-end's two declared slots into keys-then-scroll", () => {
    // The one region with two declared slots, and the only place their relative
    // order is written down: the key toolbar sits above the scroll-to-bottom
    // button, whichever feature asks first.
    const root = document.createElement("div");
    const regions = freshRegions(root);

    regions.region("bottom-inset-end", "scroll");
    regions.region("bottom-inset-end", "keys");

    expect(slotOrder(root, "bottom-inset-end")).toEqual(["keys", "scroll"]);
  });
});

describe("regions: a destroyed accessor holds nothing", () => {
  it("refuses a region request after destroy instead of building into a detached container", () => {
    // A feature that asks for chrome after the terminal was destroyed has a bug;
    // handing it a slot inside a container that is no longer in the document
    // hides that bug and silently drops whatever it appends.
    const root = document.createElement("div");
    const regions = createRegions(root);

    regions.destroy();

    expect(() => regions.region("banner", "status")).toThrow(/unknown region/);
  });

  it("refuses a slot it had already handed out, rather than returning the detached one", () => {
    // The other half: the slot cache must go too, or the accessor keeps answering
    // for regions it has removed — and keeps the removed DOM alive to do it.
    const root = document.createElement("div");
    const regions = createRegions(root);
    const slot = regions.region("banner", "status");

    regions.destroy();

    expect(slot.isConnected).toBe(false);
    expect(() => regions.region("banner", "status")).toThrow(/unknown region/);
  });
});
