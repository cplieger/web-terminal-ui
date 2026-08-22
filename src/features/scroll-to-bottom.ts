// scrollToBottom feature: a scroll-to-bottom control in the thumb-zone region,
// shown only while the user has scrolled up (design section 22.4). The
// scroll-state signal comes from the kernel's scroll:state event (the kernel
// owns scroll.init); this feature just renders the affordance and drives
// scroll.scrollToBottom.

import type { TerminalFeature } from "../kernel/types.js";
import { fromHTML, holdFocusOnPress } from "./dom.js";

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
      // scroll controller then re-engages follow when it sees the animation land
      // at the bottom (a downward move reaching the tail), so the animation needs
      // no programmatic flag and the render pin does not fight it mid-flight.
      // Under prefers-reduced-motion, fall back to the engine's instant
      // scrollToBottom (which re-engages following synchronously).
      const jump = (): void => {
        const reduce =
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduce) {
          ctx.scroll.scrollToBottom();
          return;
        }
        const surface = ctx.surface();
        // Already AT the bottom but possibly holding: a program erasing its
        // scrollback (ED3) clamps a scrolled-up reader to the bottom without
        // engaging follow, which is a durable state since the engine stopped
        // letting an upward clamp engage it. A smooth scroll with zero distance
        // to travel fires no scroll event, so nothing would re-derive the state
        // and this button — whose entire job is resuming follow — would be inert
        // until new output happened to arrive. State the intent directly instead.
        if (surface.scrollHeight - surface.clientHeight - surface.scrollTop <= 0) {
          ctx.scroll.scrollToBottom();
          return;
        }
        // Target the MAXIMUM offset, not scrollHeight. An over-scroll target is
        // one clientHeight past the end and needs the container to clamp it,
        // which is the assumption the engine's own bottom writes stopped making:
        // clamping an offset the content shrank out from under is an
        // implementation behaviour and WebKit does not do it. The line above
        // already computes the maximum, so this is the same arithmetic said once.
        surface.scrollTo({
          top: surface.scrollHeight - surface.clientHeight,
          behavior: "smooth",
        });
      };

      // pointerdown (like the toolbar keys) so touch devices get the jump on the
      // press rather than the release; click is kept for keyboard activation.
      // jump is idempotent, so the pair is safe. holdFocusOnPress keeps the
      // keyboard on the terminal across the press and paints the press class the
      // cancelled default costs this button.
      holdFocusOnPress(btn);
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
