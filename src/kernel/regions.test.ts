// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createRegions } from "./regions.js";

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
