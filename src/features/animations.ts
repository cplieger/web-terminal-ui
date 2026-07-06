// animations feature: opt-in motion for the chrome surfaces (design sections
// 13, 22.4). Without it the chrome surfaces are instant (no transitions); with
// it, and when the user has not asked for reduced motion, it enables the shared
// animation vocabulary by marking the terminal root, which the feature
// stylesheets key their transitions off. A few pieces of motion animate
// unconditionally regardless of this feature (terminal-core cursor/SGR blink and
// the mobile key toolbar open/close in 02-app.css, plus the working-status-dot
// pulse in 05-tabs.css, its WCAG non-hue cue), though prefers-reduced-motion
// still defeats all of it. It tracks prefers-reduced-motion live so toggling the
// OS setting takes effect.

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
