// animations feature: opt-in motion (design sections 13, 22.4). Without it the
// UI is instant (no transitions); with it, and when the user has not asked for
// reduced motion, it enables the shared animation vocabulary by marking the
// terminal root, which the feature stylesheets key their transitions off. It
// tracks prefers-reduced-motion live so toggling the OS setting takes effect.

import type { TerminalFeature } from "../kernel/types.js";

export function animations(): TerminalFeature {
  return {
    name: "animations",
    setup(ctx) {
      // The root is the surface's parent (regions + surface are its children).
      const root = ctx.surface().parentElement;
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const apply = (): void => {
        root?.classList.toggle("wt-animate", !mq.matches);
      };
      apply();
      mq.addEventListener("change", apply);
      return {
        teardown() {
          mq.removeEventListener("change", apply);
          root?.classList.remove("wt-animate");
        },
      };
    },
  };
}
