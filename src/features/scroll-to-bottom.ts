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

      // pointerdown (like the toolbar keys) so touch devices show press
      // feedback; preventDefault keeps focus on the terminal. click is kept for
      // keyboard activation. scrollToBottom is idempotent, so the pair is safe.
      const onDown = (e: PointerEvent): void => {
        e.preventDefault();
        ctx.scroll.scrollToBottom();
      };
      const onClick = (): void => {
        ctx.scroll.scrollToBottom();
      };
      btn.addEventListener("pointerdown", onDown);
      btn.addEventListener("click", onClick);

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
