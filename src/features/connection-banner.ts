// The state machine, the loading lifecycle and the give-up hook are the kernel's;
// this feature only renders connection:state, and announces through the kernel's
// one announcer rather than an aria-live region of its own.

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

/** Build the connectionBanner feature. Exposes no API: it owns one element in
 *  the "banner" region. Only the states with copy above are shown, so it is a
 *  transient surface, not a status line; `restarted`, `ended` and
 *  `incompatible` are the terminal ones a user cannot wait out. Each change is
 *  announced once, so a flaky link re-entering a state does not repeat itself
 *  to a screen reader. Teardown unsubscribes and removes the element. */
export function connectionBanner(): TerminalFeature {
  return {
    name: "connectionBanner",
    setup(ctx) {
      const slot = ctx.region("banner", "status");
      const banner = ctx.shell.root.ownerDocument.createElement("div");
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
