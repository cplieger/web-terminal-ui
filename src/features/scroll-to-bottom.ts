import { windowOf } from "../kernel/realm.js";
import type { TerminalFeature } from "../kernel/types.js";
import { fromHTML, holdFocusOnPress } from "./dom.js";

const BUTTON_HTML = `
<button type="button" class="wt-btn wt-scroll-bottom" aria-label="Scroll to bottom">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" d="M7 13l5 5 5-5M7 6l5 5 5-5"/></svg>
</button>`;

/** Build the scrollToBottom feature. Exposes no API: the button is the whole
 *  surface, and a peer that wants the effect calls `ctx.scroll.scrollToBottom`.
 *  The press resumes following, animated unless the reader prefers reduced
 *  motion. Teardown unsubscribes and removes it. */
export function scrollToBottom(): TerminalFeature {
  return {
    name: "scrollToBottom",
    setup(ctx) {
      const win = windowOf(ctx.shell.root.ownerDocument);
      const slot = ctx.region("bottom-inset-end", "scroll");
      const btn = fromHTML(ctx.shell.root.ownerDocument, BUTTON_HTML);
      slot.appendChild(btn);

      // The engine's scroll controller owns the offset and the follow state,
      // including output that arrives during the animation.
      const jump = (): void => {
        const reduce =
          typeof win.matchMedia === "function" &&
          win.matchMedia("(prefers-reduced-motion: reduce)").matches;
        ctx.scroll.scrollToBottom({ smooth: !reduce });
      };

      // pointerdown (like the toolbar keys) so touch devices get the jump on the
      // press rather than the release; click is kept for keyboard activation.
      // jump is idempotent, so the pair is safe. holdFocusOnPress keeps the
      // keyboard on the terminal across the press and paints the press class the
      // cancelled default costs this button.
      ctx.defer(holdFocusOnPress(btn));
      btn.addEventListener("pointerdown", jump);
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
