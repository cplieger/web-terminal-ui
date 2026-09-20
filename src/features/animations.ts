import type { TerminalFeature } from "../kernel/types.js";

/** Build the animations feature. Exposes no API; its whole effect is the
 *  `wt-animate` class on the shell root, which the shipped stylesheets gate their
 *  transitions on, tracking prefers-reduced-motion live. */
export function animations(): TerminalFeature {
  return {
    name: "animations",
    scope: "shell",
    setup(ctx) {
      const root = ctx.shell.root;
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const apply = (): void => {
        root.classList.toggle("wt-animate", !mq.matches);
      };
      apply();
      mq.addEventListener("change", apply);
      ctx.defer(() => {
        mq.removeEventListener("change", apply);
      });
      return {
        teardown() {
          root.classList.remove("wt-animate");
        },
      };
    },
  };
}
