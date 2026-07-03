// connectionBanner feature: renders the kernel's connection state as a visible
// banner (design sections 22.3, 22.4). The state machine, the loading
// lifecycle, and the give-up hook are kernel-owned; this feature is a pure
// renderer subscribing to connection:state. It uses the kernel's single
// announcer (ctx.announce) rather than spawning its own aria-live region.

import type { ConnState, TerminalFeature } from "../kernel/types.js";

const TEXT: Partial<Record<ConnState, string>> = {
  connecting: "Reconnecting\u2026",
  reconnecting: "Reconnecting\u2026",
  offline: "Offline",
  restarted: "Server restarted \u2014 recent input may have been lost",
};

export function connectionBanner(): TerminalFeature {
  return {
    name: "connectionBanner",
    setup(ctx) {
      const slot = ctx.region("banner", "status");
      const banner = document.createElement("div");
      banner.className = "wt-conn-banner";
      banner.setAttribute("role", "status");
      slot.appendChild(banner);

      let last: ConnState | null = null;
      const off = ctx.on("connection:state", (s) => {
        const text = TEXT[s];
        if (text !== undefined) {
          banner.textContent = text;
          banner.dataset["state"] = s;
          banner.classList.add("visible");
          // Announce only on a real change, so a flaky link does not spam the
          // screen reader with repeated "Reconnecting" for the same state.
          if (s !== last) {
            ctx.announce(text);
          }
        } else {
          banner.classList.remove("visible");
          banner.textContent = "";
        }
        last = s;
      });

      return {
        teardown() {
          off();
          banner.remove();
        },
      };
    },
  };
}
