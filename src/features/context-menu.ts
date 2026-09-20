// contextMenu: the Copy / Select All / Paste menu for the terminal surface. It
// exists for PASTE: the keyboard target is a 1x1 pointer-events:none textarea,
// so no platform can attach a native paste item under the pointer. A touch press
// is classified ONCE, at touchend, when every fact is settled: a stationary
// single-finger press past the tap ceiling that selected nothing and did not
// start on a link is a press the platform declined, so it is ours. Deciding at
// release is what lets the trailing-click swallow start at the release edge.

import { selectionTextWithin } from "../kernel/selection.js";
import type { TerminalFeature } from "../kernel/types.js";
import { TAP_MAX_MS, TAP_MOVEMENT_PX, isLinkTarget } from "../kernel/gesture.js";
import type { ClipboardApi } from "./clipboard.js";
import { createClickSwallow, placeMenuAt } from "./menu-position.js";

/** Options for the contextMenu feature. Pass the SAME clipboard feature value
 *  the composition includes, not a second `clipboard()` call: `ctx.use` resolves
 *  a value that is not in the feature list to nothing, and the menu silently
 *  loses Copy and Paste. */
export interface ContextMenuOptions {
  /** The clipboard feature value. Omitted: the menu shows only Select All. */
  clipboard?: TerminalFeature<ClipboardApi>;
}

/** Whether a touch `contextmenu` may be cancelled. WebKit reads preventDefault
 *  there as "cancel every remaining default of this gesture", the platform's
 *  not-yet-registered word selection included, which once left an iPad unable to
 *  select text; everywhere else cancelling keeps the platform's menu from
 *  appearing beside ours. */
function isAppleTouchDevice(): boolean {
  // Totality only: a runtime with no navigator binding would throw a
  // ReferenceError on the reads below. Node and workers both carry one.
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/iP(hone|ad|od)/.test(ua) || /iP(hone|ad|od)/.test(platform)) {
    return true;
  }
  // iPadOS Safari's desktop mode reports MacIntel with a touch screen; a
  // trackpad Mac reports maxTouchPoints 0.
  return platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

/** A long-press on a link raises the platform's own preview without ever making
 *  a selection, so the selection test alone would not keep us out of its way. */
const onLink = isLinkTarget;

/** Build the contextMenu feature. Exposes no API. Without the clipboard value of
 *  ContextMenuOptions it degrades to a Select All-only menu. Its items act on the
 *  browser selection inside the surface and on the kernel's paste funnel, so it
 *  holds no session state. */
export function contextMenu(opts: ContextMenuOptions = {}): TerminalFeature {
  return {
    name: "contextMenu",
    setup(ctx) {
      const surface = ctx.surface();
      const menu = document.createElement("div");
      menu.className = "wt-ctx-menu";
      ctx.region("overlay", "menu").appendChild(menu);

      // The device that started the current interaction: `contextmenu` fires on a
      // desktop right-click AND on an Android long-press, so its handler branches
      // on this to tell them apart.
      let lastPointerType = "mouse";
      // Computed once: may a touch contextmenu be cancelled (see isAppleTouchDevice).
      const appleTouch = isAppleTouchDevice();
      // Swallows the trailing click a touch long-press emits on release.
      const swallow = createClickSwallow();

      // The in-flight single-finger press, all of it read at `touchend`.
      // pressLive goes false the moment the gesture stops being a candidate (a
      // second finger, movement past the ceiling, a cancel), so touchend does not
      // have to re-derive any of it.
      let pressLive = false;
      let pressStart = 0;
      let pressX = 0;
      let pressY = 0;
      let pressOnLink = false;
      // The selection as it stood when the press began, so touchend can tell a
      // selection THIS press produced (the OS callout owns it) from one that was
      // already on screen (ours to offer Copy for).
      let pressSelection = "";

      const clip = (): ClipboardApi | undefined =>
        opts.clipboard ? ctx.use(opts.clipboard) : undefined;

      function focusInput(): void {
        surface.querySelector<HTMLElement>(".term-input")?.focus({ preventScroll: true });
      }

      function hide(refocus = true): void {
        const shouldRefocus = refocus && menu.contains(document.activeElement);
        menu.classList.remove("visible");
        menu.replaceChildren();
        if (shouldRefocus) {
          focusInput();
        }
      }

      // refocus=false suppresses the return-focus-to-input step: Select All must
      // NOT refocus the textarea, or Firefox collapses the just-made selection
      // when focus leaves the output.
      function addButton(label: string, onClick: () => void, refocus = true): void {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => {
          onClick();
          hide(refocus);
        });
        menu.appendChild(b);
      }

      /** Open the menu at viewport point (x, y). Same items for every modality:
       *  Copy when something is selected, then Select All, then Paste. */
      function show(x: number, y: number): void {
        hide();
        const clipboard = clip();
        const sel = selectionTextWithin(surface);
        if (clipboard && sel) {
          addButton("Copy", () => {
            clipboard.copy(sel);
          });
        }
        addButton(
          "Select All",
          () => {
            const s = window.getSelection();
            const output = surface.querySelector(".term-output");
            if (s && output) {
              s.selectAllChildren(output);
            }
          },
          false,
        );
        if (clipboard) {
          addButton("Paste", () => {
            clipboard.paste();
          });
        }
        // Make visible (so it has measurable size), then place it within the
        // visible viewport via the shared point-anchored positioner (clamp to the
        // visual viewport; flip above the finger near the bottom edge).
        menu.classList.add("visible");
        placeMenuAt(menu, x, y);
      }

      const onPointerDown = (e: PointerEvent): void => {
        lastPointerType = e.pointerType;
      };
      surface.addEventListener("pointerdown", onPointerDown, { passive: true });
      ctx.defer(() => {
        surface.removeEventListener("pointerdown", onPointerDown);
      });

      const onContextMenu = (e: MouseEvent): void => {
        if (lastPointerType !== "touch") {
          e.preventDefault();
          show(e.clientX, e.clientY);
          return;
        }
        // Touch: our menu never opens from here — the touchend classifier owns
        // that. The only question left is whether the PLATFORM's menu may
        // proceed. On WebKit it must (cancelling here cancels the whole gesture's
        // remaining defaults, the word selection included). Elsewhere (Android
        // fires contextmenu mid-press) cancel it when the press has nothing of
        // the platform's own to show, so its menu and ours cannot both appear.
        if (!appleTouch && !onLink(e.target) && selectionTextWithin(surface) === "") {
          e.preventDefault();
        }
      };
      surface.addEventListener("contextmenu", onContextMenu);
      ctx.defer(() => {
        surface.removeEventListener("contextmenu", onContextMenu);
      });

      // Escape closes the menu without also sending ESC to the PTY.
      ctx.registerKeydown((ev) => {
        if (ev.key === "Escape" && menu.classList.contains("visible")) {
          ev.preventDefault();
          hide();
          return true;
        }
        return false;
      });

      const onDocClick = (e: MouseEvent): void => {
        // A click on an item is that item's own business: its handler hides the
        // menu with the correct refocus behaviour (Select All must not refocus
        // the input, or Firefox collapses the selection it just made). Reaching
        // hide() from here as well would override that choice.
        if (e.target instanceof Node && menu.contains(e.target)) {
          return;
        }
        // The release click of the long-press that just opened the menu is that
        // gesture's own end, not a click-away.
        if (swallow.swallowing()) {
          return;
        }
        hide();
      };
      document.addEventListener("click", onDocClick);
      ctx.defer(() => {
        document.removeEventListener("click", onDocClick);
      });
      // A right-click outside the terminal surface (a tab, its menu, elsewhere,
      // or a native browser menu) dismisses this menu. A right-click on the
      // surface is handled by onContextMenu (which reopens it) and fires first.
      const onDocContextMenu = (e: MouseEvent): void => {
        if (!surface.contains(e.target as Node)) {
          hide();
        }
      };
      document.addEventListener("contextmenu", onDocContextMenu);
      ctx.defer(() => {
        document.removeEventListener("contextmenu", onDocContextMenu);
      });

      const onTouchStart = (e: TouchEvent): void => {
        const t = e.touches.length === 1 ? e.touches[0] : undefined;
        if (!t) {
          pressLive = false; // a second finger: pinch/zoom, not a long-press
          return;
        }
        pressLive = true;
        pressStart = e.timeStamp;
        pressX = t.clientX;
        pressY = t.clientY;
        pressOnLink = onLink(e.target);
        pressSelection = selectionTextWithin(surface);
      };
      const onTouchMove = (e: TouchEvent): void => {
        if (!pressLive) {
          return;
        }
        const t = e.touches.length === 1 ? e.touches[0] : undefined;
        if (!t) {
          pressLive = false;
          return;
        }
        // A drag is a scroll or a selection-extend, both the browser's.
        if (
          Math.abs(t.clientX - pressX) > TAP_MOVEMENT_PX ||
          Math.abs(t.clientY - pressY) > TAP_MOVEMENT_PX
        ) {
          pressLive = false;
        }
      };
      // The whole touch decision, made with the gesture complete: every input is
      // a settled fact, so there is nothing here to race and nothing to retract.
      const onTouchEnd = (e: TouchEvent): void => {
        const live = pressLive;
        pressLive = false;
        if (!live || pressOnLink) {
          return;
        }
        if (e.timeStamp - pressStart <= TAP_MAX_MS) {
          return; // a tap: the kernel focuses the input / clears the selection
        }
        const sel = selectionTextWithin(surface);
        if (sel !== "" && sel !== pressSelection) {
          return; // this press selected text; the OS callout owns it
        }
        show(pressX, pressY);
        if (menu.classList.contains("visible")) {
          // Armed at the release edge, so the trailing click this same gesture
          // emits is always inside the window.
          swallow.arm();
        }
      };
      const onTouchCancel = (): void => {
        pressLive = false;
      };
      surface.addEventListener("touchstart", onTouchStart, { passive: true });
      surface.addEventListener("touchmove", onTouchMove, { passive: true });
      surface.addEventListener("touchend", onTouchEnd, { passive: true });
      surface.addEventListener("touchcancel", onTouchCancel, { passive: true });
      ctx.defer(() => {
        surface.removeEventListener("touchstart", onTouchStart);
        surface.removeEventListener("touchmove", onTouchMove);
        surface.removeEventListener("touchend", onTouchEnd);
        surface.removeEventListener("touchcancel", onTouchCancel);
      });

      return {
        teardown() {
          menu.remove();
        },
      };
    },
  };
}
