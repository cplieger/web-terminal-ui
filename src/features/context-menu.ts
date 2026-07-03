// contextMenu feature: the right-click / long-press menu (Copy, Select All,
// Paste) rendered into the overlay region (design section 22.4). Copy/Paste are
// offered only when the clipboard feature is present (ctx.use), routing Paste
// through the kernel's sanitizing funnel. Escape-to-close goes through the
// kernel keydown intercept; outside-click and long-press are surface gestures.
//
// Touch long-press opens this menu on every touch platform, iOS included. The
// terminal's keyboard target is a 1x1, pointer-events:none textarea, so iOS's
// own long-press callout never lands on an editable field and no native "Paste"
// ever appears (the reason tap-and-hold-to-paste felt broken). This menu is
// therefore the paste path on touch; Paste reads the system clipboard via the
// Clipboard API, which needs a secure context, so serve vibecli over HTTPS for
// touch paste.

import type { TerminalFeature } from "../kernel/types.js";
import type { ClipboardApi } from "./clipboard.js";

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;
const EDGE_MARGIN = 8;

export interface ContextMenuOptions {
  /** The clipboard feature value, so the menu can offer Copy/Paste through its
   *  API (ctx.use). Omitted: the menu shows only Select All. */
  clipboard?: TerminalFeature<ClipboardApi>;
}

export function contextMenu(opts: ContextMenuOptions = {}): TerminalFeature {
  return {
    name: "contextMenu",
    setup(ctx) {
      const surface = ctx.surface();
      const menu = document.createElement("div");
      menu.className = "wt-ctx-menu";
      ctx.region("overlay", "menu").appendChild(menu);

      let longPressTimer = 0;
      let longPressOrigin = { x: 0, y: 0 };

      const clip = (): ClipboardApi | undefined =>
        opts.clipboard ? ctx.use(opts.clipboard) : undefined;

      function focusInput(): void {
        surface.querySelector<HTMLElement>(".term-input")?.focus({ preventScroll: true });
      }

      function hide(): void {
        const refocus = menu.contains(document.activeElement);
        menu.classList.remove("visible");
        menu.replaceChildren();
        if (refocus) {
          focusInput();
        }
      }

      function addButton(label: string, onClick: () => void): void {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => {
          onClick();
          hide();
        });
        menu.appendChild(b);
      }

      function show(x: number, y: number): void {
        hide();
        const clipboard = clip();
        const sel = window.getSelection()?.toString();
        if (sel) {
          addButton("Copy", () => {
            clipboard?.copy(sel);
          });
        }
        addButton("Select All", () => {
          const s = window.getSelection();
          const output = surface.querySelector(".term-output");
          if (s && output) {
            s.selectAllChildren(output);
          }
        });
        // Paste needs the clipboard feature. Offered on touch too (see the header
        // note): the hidden textarea means iOS's native paste callout never
        // appears, so this is the paste path there.
        if (clipboard) {
          addButton("Paste", () => {
            clipboard.paste();
          });
        }
        if (menu.childElementCount === 0) {
          return; // nothing to offer
        }
        // Make visible (so it has measurable size) then clamp inside the
        // viewport. position:fixed => x/y are viewport coordinates.
        menu.classList.add("visible");
        const left = Math.max(
          EDGE_MARGIN,
          Math.min(x, window.innerWidth - menu.offsetWidth - EDGE_MARGIN),
        );
        const top = Math.max(
          EDGE_MARGIN,
          Math.min(y, window.innerHeight - menu.offsetHeight - EDGE_MARGIN),
        );
        menu.style.left = `${String(left)}px`;
        menu.style.top = `${String(top)}px`;
      }

      const onContextMenu = (e: MouseEvent): void => {
        e.preventDefault();
        show(e.clientX, e.clientY);
      };
      surface.addEventListener("contextmenu", onContextMenu);

      // Escape closes the menu without also sending ESC to the PTY.
      const offKey = ctx.registerKeydown((ev) => {
        if (ev.key === "Escape" && menu.classList.contains("visible")) {
          ev.preventDefault();
          hide();
          return true;
        }
        return false;
      });

      const onDocClick = (): void => {
        hide();
      };
      document.addEventListener("click", onDocClick);

      // Long-press opens the menu on touch, all platforms (see the header note).
      const clearLongPress = (): void => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      };
      const onTouchStart = (e: TouchEvent): void => {
        if (e.touches.length !== 1) {
          clearLongPress();
          return;
        }
        const t = e.touches[0];
        if (!t) {
          return;
        }
        longPressOrigin = { x: t.clientX, y: t.clientY };
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0;
          show(longPressOrigin.x, longPressOrigin.y);
        }, LONG_PRESS_MS);
      };
      const onTouchMove = (e: TouchEvent): void => {
        if (!longPressTimer || e.touches.length !== 1) {
          return;
        }
        const t = e.touches[0];
        if (!t) {
          return;
        }
        const dx = t.clientX - longPressOrigin.x;
        const dy = t.clientY - longPressOrigin.y;
        if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) {
          clearLongPress();
        }
      };
      surface.addEventListener("touchstart", onTouchStart, { passive: true });
      surface.addEventListener("touchmove", onTouchMove, { passive: true });
      surface.addEventListener("touchend", clearLongPress, { passive: true });
      surface.addEventListener("touchcancel", clearLongPress, { passive: true });

      return {
        teardown() {
          clearLongPress();
          offKey();
          surface.removeEventListener("contextmenu", onContextMenu);
          document.removeEventListener("click", onDocClick);
          surface.removeEventListener("touchstart", onTouchStart);
          surface.removeEventListener("touchmove", onTouchMove);
          surface.removeEventListener("touchend", clearLongPress);
          surface.removeEventListener("touchcancel", clearLongPress);
          menu.remove();
        },
      };
    },
  };
}
