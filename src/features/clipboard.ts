/**
 * clipboard feature: copy/paste helpers, the desktop Ctrl+Shift+C/V shortcuts,
 * and OSC 52 mirroring. Exposes a typed API so contextMenu
 * can offer Copy/Paste through it (ctx.use). With this feature absent, inbound
 * OSC 52 has no subscriber and is intentionally a no-op.
 *
 * @module
 */

import type { TerminalFeature } from "../kernel/types.js";

/** The value a peer feature reads through `ctx.use(clipboard())` — contextMenu's
 *  Copy and Paste items are this API behind a button.
 *
 *  Both members are fire-and-forget: the underlying Clipboard API calls are async
 *  and their outcome is reported to the user as a toast rather than returned, so a
 *  caller cannot await or branch on success. Both require a secure context
 *  (`navigator.clipboard` is absent on a plain-HTTP non-loopback host, a supported
 *  web-terminal-server deployment), where they toast "Clipboard unavailable" and
 *  do nothing. */
export interface ClipboardApi {
  /** Write text to the system clipboard (surfaces a toast on success/failure). */
  copy(text: string): void;
  /** Read the system clipboard and paste it through the sanitizing funnel. */
  paste(): void;
}

/** Build the clipboard feature.
 *
 *  It claims three things for the lifetime of the terminal: a kernel keydown
 *  intercept (Ctrl+Shift+C copies the browser selection, Ctrl+Shift+V pastes, and
 *  a plain Ctrl+V is consumed WITHOUT preventDefault so the browser's own paste
 *  event reaches the hidden textarea instead of being mapped to `\x16`), the
 *  `wire:clipboard` event that mirrors an application's OSC 52 copy to the system
 *  clipboard, and a document `copy` listener that toasts "Copied" for a selection
 *  inside the terminal surface only. Teardown releases all three. */
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

      // Native copy (e.g. Cmd/Ctrl+C on a selection) feedback toast, scoped to a
      // selection inside the terminal surface so an embedding host's copies of
      // its own (non-terminal) content do not raise a spurious "Copied".
      const surface = ctx.surface();
      const onCopy = (): void => {
        const node = window.getSelection()?.anchorNode ?? null;
        if (node && surface.contains(node)) {
          ctx.toast("Copied");
        }
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
