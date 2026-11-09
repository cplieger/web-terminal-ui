// The banner's state colours as the browser computes them with the shipped
// stylesheet loaded, since the feature's own tests build no stylesheet.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { connectionBanner } from "./connection-banner.js";
import type { ConnState, TerminalContext } from "../kernel/types.js";
import { shippedBundle } from "../test-helpers/stylesheet.js";

let styles: HTMLStyleElement;
const roots: HTMLElement[] = [];

beforeAll(() => {
  styles = document.createElement("style");
  styles.textContent = shippedBundle("MANIFEST");
  document.head.appendChild(styles);
});
afterAll(() => {
  styles.remove();
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    root.remove();
  }
});

/** A banner in a `.wt-root` carrying `theme` as inline custom properties, the
 *  way createTerminal applies its `theme` option, shown in `state`. */
function bannerIn(state: ConnState, theme: Record<string, string> = {}): HTMLElement {
  const root = document.createElement("div");
  root.className = "wt-root";
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(key, value);
  }
  document.body.appendChild(root);
  roots.push(root);
  let handler: ((s: ConnState) => void) | undefined;
  const ctx = {
    region: () => root,
    shell: { root },
    announce: () => undefined,
    on: (_e: string, fn: (s: ConnState) => void) => {
      handler = fn;
      return () => undefined;
    },
  } as unknown as TerminalContext;
  connectionBanner().setup(ctx);
  handler?.(state);
  const banner = root.querySelector<HTMLElement>(".wt-conn-banner");
  if (!banner) {
    throw new Error("the banner was not created");
  }
  return banner;
}

describe("connection banner theme tokens", () => {
  it("keeps the dark defaults: #f55 offline and #fa5 restarted", () => {
    expect(getComputedStyle(bannerIn("offline")).color).toBe("rgb(255, 85, 85)");
    expect(getComputedStyle(bannerIn("restarted")).color).toBe("rgb(255, 170, 85)");
  });

  it("paints the offline text from --banner-offline", () => {
    const banner = bannerIn("offline", { "--banner-offline": "rgb(1, 2, 3)" });
    expect(getComputedStyle(banner).color).toBe("rgb(1, 2, 3)");
  });

  it("paints the restarted text from --banner-restarted", () => {
    const banner = bannerIn("restarted", { "--banner-restarted": "rgb(4, 5, 6)" });
    expect(getComputedStyle(banner).color).toBe("rgb(4, 5, 6)");
  });

  it("leaves the other states on --text", () => {
    const theme = {
      "--text": "rgb(7, 8, 9)",
      "--banner-offline": "rgb(1, 2, 3)",
      "--banner-restarted": "rgb(4, 5, 6)",
    };
    expect(getComputedStyle(bannerIn("reconnecting", theme)).color).toBe("rgb(7, 8, 9)");
  });
});
