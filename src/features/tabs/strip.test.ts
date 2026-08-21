// @vitest-environment happy-dom
//
// The strip's markup factories. index.test.ts drives the built chrome; these pin
// the two things a caller of chipContent can only get from the string itself,
// because the desktop chip is assembled at module scope and never re-rendered.
import { describe, it, expect } from "vitest";

import { chipContent } from "./strip.js";

function parse(html: string): HTMLElement | null {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector("button");
}

describe("chipContent: the close button", () => {
  it("carries the caller's extra attributes verbatim", () => {
    // The whole chip is the switch target and the close is nested inside it, so
    // tabindex="-1" is what keeps Tab from stopping on the close button. It is the
    // caller's to pass, which means the markup has to emit it untouched.
    const { close } = chipContent({
      dot: "wt-tab-dot",
      label: "wt-tab-label",
      close: "wt-tab-close",
      closeAttr: ' tabindex="-1"',
    });

    const button = parse(close);

    expect(button?.getAttribute("tabindex")).toBe("-1");
    expect(button?.getAttribute("aria-label")).toBe("Close terminal");
  });

  it("emits no stray attribute when the caller passes none", () => {
    // The absent case must interpolate to nothing at all. Anything else lands
    // inside the open tag, where a browser parses it as an attribute name.
    const { close } = chipContent({ dot: "d", label: "l", close: "c" });

    const button = parse(close);

    expect(button?.getAttributeNames().sort()).toEqual(["aria-label", "class", "type"]);
  });
});
