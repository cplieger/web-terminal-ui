/**
 * connectionBanner feature: renders the kernel's connection state as a visible
 * banner. The state machine, the loading
 * lifecycle, and the give-up hook are kernel-owned; this feature is a pure
 * renderer subscribing to connection:state. It uses the kernel's single
 * announcer (ctx.announce) rather than spawning its own aria-live region.
 *
 * @module
 */

import type { ConnState, TerminalFeature } from "../kernel/types.js";

const TEXT: Partial<Record<ConnState, string>> = {
  connecting: "Reconnecting\u2026",
  reconnecting: "Reconnecting\u2026",
  offline: "Offline",
  restarted: "Server restarted; recent input may be lost",
  // The session's process exited (definitive; nothing is retrying). The final
  // screen stays rendered behind the banner; open a new tab to keep working.
  ended: "Session ended",
  incompatible: "Terminal protocol mismatch; update the server or reload this page",
};

/** Build the connectionBanner feature. Exposes no API — it owns one element in
 *  the kernel's "banner" region and nothing else reads from it.
 *
 *  Only the states with copy above are shown; `connected` and any other state
 *  hides the banner, so it is a transient surface rather than a permanent status
 *  line. `restarted`, `ended` and `incompatible` are the terminal ones a user
 *  cannot wait out. Each change is announced once through `ctx.announce`, so a
 *  flaky link re-entering the same state does not repeat itself to a screen
 *  reader. Teardown unsubscribes and removes the element. */
export function connectionBanner(): TerminalFeature {
  return {
    name: "connectionBanner",
    setup(ctx) {
      const slot = ctx.region("banner", "status");
      const banner = document.createElement("div");
      banner.className = "wt-conn-banner";
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
