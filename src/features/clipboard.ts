import { windowOf } from "../kernel/realm.js";
import { selectionTextWithin } from "../kernel/selection.js";
import { isShortcutLetter } from "../kernel/shortcut-letter.js";
import type { TerminalFeature } from "../kernel/types.js";

// A program that retries a refused copy would otherwise re-toast and re-announce
// it on every attempt; each refusal from its session inside the window extends it.
const REFUSAL_QUIET_MS = 10_000;

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
 *  copy is mirrored to the system clipboard, one the server refused as too large
 *  toasts the server's reason, and a native copy of a selection inside the
 *  terminal toasts "Copied". Absent, inbound OSC 52 is a no-op. */
export function clipboard(): TerminalFeature<ClipboardApi> {
  return {
    name: "clipboard",
    setup(ctx) {
      const surface = ctx.surface();
      const doc = ctx.shell.root.ownerDocument;
      const win = windowOf(doc);
      /** Write `text`, toasting the outcome only while `current()` still holds. */
      function write(text: string, current: () => boolean): void {
        // A property access on navigator.clipboard throws outside a secure context.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- undefined outside secure contexts
        if (!win.navigator.clipboard) {
          ctx.toast("Clipboard unavailable");
          return;
        }
        win.navigator.clipboard
          .writeText(text)
          .then(() => {
            if (current()) {
              ctx.toast("Copied");
            }
          })
          .catch(() => {
            if (current()) {
              ctx.toast("Copy failed");
            }
          });
      }

      function copy(text: string): void {
        write(text, () => true);
      }

      function paste(): void {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- undefined outside secure contexts
        if (!win.navigator.clipboard) {
          ctx.toast("Clipboard unavailable");
          return;
        }
        win.navigator.clipboard
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
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && isShortcutLetter(ev, "v")) {
          return true;
        }
        if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
          if (isShortcutLetter(ev, "c")) {
            const sel = selectionTextWithin(surface);
            if (sel !== "") {
              copy(sel);
            }
            ev.preventDefault();
            return true;
          }
          if (isShortcutLetter(ev, "v")) {
            paste();
            ev.preventDefault();
            return true;
          }
        }
        return false;
      });

      // This pane has one toast, so a write that settles after a later OSC 52
      // event must not replace that event's toast (a refusal with "Copied").
      let wireGeneration = 0;
      const refusalQuietUntil = new Map<string, number>();

      // An OSC 52 copy is an async push, not a user gesture, so some browsers
      // reject it and write() toasts "Copy failed".
      ctx.on("wire:clipboard", (text) => {
        refusalQuietUntil.clear();
        const generation = ++wireGeneration;
        write(text, () => generation === wireGeneration);
      });
      ctx.on("wire:clipboardRefused", ({ session, message }) => {
        wireGeneration++;
        const now = Date.now();
        const quiet = now < (refusalQuietUntil.get(session) ?? 0);
        refusalQuietUntil.set(session, now + REFUSAL_QUIET_MS);
        if (!quiet) {
          ctx.toast(message);
        }
      });

      const onCopy = (): void => {
        if (selectionTextWithin(surface) !== "") {
          ctx.toast("Copied");
        }
      };
      doc.addEventListener("copy", onCopy);
      ctx.defer(() => {
        doc.removeEventListener("copy", onCopy);
      });

      return {
        api: { copy, paste },
        teardown: () => undefined,
      };
    },
  };
}
