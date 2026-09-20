import { selectionTextWithin } from "../kernel/selection.js";
import type { TerminalFeature } from "../kernel/types.js";

/** The value a peer reads through `ctx.use(clipboard())`. Both members are
 *  fire-and-forget: the outcome reaches the user as a toast, never the caller.
 *  Outside a secure context (`navigator.clipboard` absent) they toast
 *  "Clipboard unavailable" and do nothing. */
export interface ClipboardApi {
  /** Write text to the system clipboard. */
  copy(text: string): void;
  /** Read the system clipboard and paste it through the sanitizing funnel. */
  paste(): void;
}

/** Build the clipboard feature: Ctrl+Shift+C copies the browser selection,
 *  Ctrl+Shift+V pastes, a plain Ctrl+V is consumed WITHOUT preventDefault so the
 *  browser's own paste event reaches the hidden textarea, an application's OSC 52
 *  copy is mirrored to the system clipboard, and a native copy of a selection
 *  inside the terminal toasts "Copied". Absent, inbound OSC 52 is a no-op. */
export function clipboard(): TerminalFeature<ClipboardApi> {
  return {
    name: "clipboard",
    setup(ctx) {
      const surface = ctx.surface();
      function copy(text: string): void {
        // A property access on navigator.clipboard throws outside a secure context.
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

      ctx.registerKeydown((ev) => {
        // Consuming plain Ctrl+V without preventDefault stops the kernel mapping
        // it to \x16 while the native paste still flows into the textarea, so no
        // clipboard read and no Firefox clipboard-read popup.
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === "KeyV") {
          return true;
        }
        if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
          if (ev.code === "KeyC") {
            const sel = selectionTextWithin(surface);
            if (sel !== "") {
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

      // An OSC 52 copy is an async push, not a user gesture, so some browsers
      // reject it and copy() toasts "Copy failed".
      ctx.on("wire:clipboard", (text) => {
        copy(text);
      });

      const onCopy = (): void => {
        if (selectionTextWithin(surface) !== "") {
          ctx.toast("Copied");
        }
      };
      document.addEventListener("copy", onCopy);
      ctx.defer(() => {
        document.removeEventListener("copy", onCopy);
      });

      return {
        api: { copy, paste },
        teardown: () => undefined,
      };
    },
  };
}
