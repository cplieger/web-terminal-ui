// clipboard feature: copy/paste helpers, the desktop Ctrl+Shift+C/V shortcuts,
// and OSC 52 mirroring (design section 22.4). Exposes a typed API so contextMenu
// can offer Copy/Paste through it (ctx.use). With this feature absent, inbound
// OSC 52 has no subscriber and is intentionally a no-op.

import type { TerminalFeature } from "../kernel/types.js";

export interface ClipboardApi {
  /** Write text to the system clipboard (surfaces a toast on success/failure). */
  copy(text: string): void;
  /** Read the system clipboard and paste it through the sanitizing funnel. */
  paste(): void;
}

export function clipboard(): TerminalFeature<ClipboardApi> {
  return {
    name: "clipboard",
    setup(ctx) {
      function copy(text: string): void {
        // navigator.clipboard is undefined outside a secure context (plain-HTTP
        // non-loopback host, a supported web-terminal-server deployment), where a
        // property access on it throws synchronously. Feature-detect first.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- undefined outside secure contexts
        if (!navigator.clipboard) {
          ctx.toast("Clipboard unavailable");
          return;
        }
        navigator.clipboard
          .writeText(text)
          .then(() => {
            ctx.toast("Copied");
          })
          .catch(() => {
            ctx.toast("Copy failed");
          });
      }

      function paste(): void {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- undefined outside secure contexts
        if (!navigator.clipboard) {
          ctx.toast("Clipboard unavailable");
          return;
        }
        navigator.clipboard
          .readText()
          .then((text) => {
            ctx.paste(text);
          })
          .catch(() => {
            ctx.toast("Paste blocked");
          });
      }

      // Desktop clipboard shortcuts, handled before the kernel's key mapping so
      // they take the browser selection/clipboard rather than server-bound bytes.
      const offKey = ctx.registerKeydown((ev) => {
        // Plain Ctrl+V: let the browser's NATIVE paste event flow into the
        // hidden textarea (the kernel's insertFromPaste path sends it through the
        // sanitizing funnel). Consuming the key WITHOUT preventDefault stops the
        // kernel mapping Ctrl+V to \x16 while leaving the native paste intact — so
        // no navigator.clipboard.readText(), hence no Firefox clipboard-read
        // popup. (Cmd+V on macOS already pastes natively and never reached the
        // \x16 mapping.)
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === "KeyV") {
          return true; // do NOT preventDefault — the browser pastes natively
        }
        if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
          if (ev.code === "KeyC") {
            const sel = window.getSelection()?.toString();
            if (sel) {
              copy(sel);
            }
            ev.preventDefault();
            return true;
          }
          if (ev.code === "KeyV") {
            paste();
            ev.preventDefault();
            return true;
          }
        }
        return false;
      });

      // Inbound OSC 52: an app copied; mirror it to the system clipboard. This
      // is an async push (not a user gesture), so some browsers reject it and
      // copy() surfaces "Copy failed".
      const offClip = ctx.on("wire:clipboard", (text) => {
        copy(text);
      });

      // Native copy (e.g. Cmd/Ctrl+C on a selection) feedback toast.
      const onCopy = (): void => {
        ctx.toast("Copied");
      };
      document.addEventListener("copy", onCopy);

      return {
        api: { copy, paste },
        teardown() {
          offKey();
          offClip();
          document.removeEventListener("copy", onCopy);
        },
      };
    },
  };
}
