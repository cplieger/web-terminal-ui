// The tap/long-press boundary's shared inputs. The thresholds were shared from
// the start; the link predicate was not, and the two copies had already diverged
// — the kernel matched only `.term-link` while the context menu matched
// `a[href], .term-link`, so an ordinary anchor in the output was a link to one
// half of the boundary and not the other. The menu then stood down for the
// platform's link preview while tap-to-focus claimed the same press.

import { describe, it, expect } from "vitest";
import { TAP_MAX_MS, TAP_MOVEMENT_PX, isLinkTarget } from "./gesture.js";

describe("gesture boundary", () => {
  it("keeps the two ceilings positive and finite, since both halves divide on them", () => {
    expect(Number.isInteger(TAP_MOVEMENT_PX)).toBe(true);
    expect(TAP_MOVEMENT_PX).toBeGreaterThan(0);
    expect(Number.isInteger(TAP_MAX_MS)).toBe(true);
    expect(TAP_MAX_MS).toBeGreaterThan(0);
  });

  it("treats BOTH an engine-linkified span and a plain anchor as a link", () => {
    document.body.innerHTML = `
      <div id="out">
        <span class="term-link" id="linkified">https://example.test</span>
        <a href="https://example.test" id="anchor"><span id="inside">text</span></a>
        <span id="plain">not a link</span>
      </div>`;
    expect(isLinkTarget(document.getElementById("linkified"))).toBe(true);
    expect(isLinkTarget(document.getElementById("anchor"))).toBe(true);
    // A press lands on the deepest element, so the predicate must climb.
    expect(isLinkTarget(document.getElementById("inside"))).toBe(true);
    expect(isLinkTarget(document.getElementById("plain"))).toBe(false);
    expect(isLinkTarget(document.getElementById("out"))).toBe(false);
  });

  it("says no for a non-Element target rather than throwing", () => {
    // A pointer event's target can be a text node or null depending on the path.
    expect(isLinkTarget(null)).toBe(false);
    expect(isLinkTarget(document.createTextNode("x") as unknown as EventTarget)).toBe(false);
  });
});
