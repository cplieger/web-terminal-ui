// scrollToBottom feature: a scroll-to-bottom control in the thumb-zone region,
// shown only while the user has scrolled up (design section 22.4). The
// scroll-state signal comes from the kernel's scroll:state event (the kernel
// owns scroll.init); this feature just renders the affordance and drives
// scroll.scrollToBottom.

import type { TerminalFeature } from "../kernel/types.js";
import { fromHTML } from "./dom.js";

const BUTTON_HTML = `
<button type="button" class="wt-btn wt-scroll-bottom" aria-label="Scroll to bottom">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" d="M7 13l5 5 5-5M7 6l5 5 5-5"/></svg>
</button>`;

export function scrollToBottom(): TerminalFeature {
  return {
    name: "scrollToBottom",
    setup(ctx) {
      const slot = ctx.region("bottom-inset-end", "scroll");
      const btn = fromHTML(BUTTON_HTML);
      slot.appendChild(btn);

      // Jump to the bottom. With motion allowed, smooth-scroll the surface so
      // the jump is animated rather than an instant teleport; the engine's
      // scroll controller re-derives its follow state from the scroll position
      // (its listener sees the animation land at the bottom), so following
      // re-engages with no programmatic flag, consistent with the engine's
      // position-only model. Under prefers-reduced-motion, fall back to the
      // engine's instant scrollToBottom (which re-engages following synchronously).
      const jump = (): void => {
        const reduce =
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduce) {
          ctx.scroll.scrollToBottom();
          return;
        }
        const surface = ctx.surface();
        surface.scrollTo({ top: surface.scrollHeight, behavior: "smooth" });
      };

      // pointerdown (like the toolbar keys) so touch devices show press
      // feedback; preventDefault keeps focus on the terminal. click is kept for
      // keyboard activation. jump is idempotent, so the pair is safe.
      const onDown = (e: PointerEvent): void => {
        e.preventDefault();
        jump();
      };
      btn.addEventListener("pointerdown", onDown);
      btn.addEventListener("click", jump);

      // Visible only while scrolled up; the region reflects it via a class.
      const off = ctx.on("scroll:state", ({ scrolledUp }) => {
        slot.classList.toggle("scrolled-up", scrolledUp);
      });

      return {
        teardown() {
          off();
          btn.remove();
        },
      };
    },
  };
}
