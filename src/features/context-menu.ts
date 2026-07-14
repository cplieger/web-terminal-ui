// contextMenu feature: the right-click / long-press menu (Copy, Select All,
// Paste) rendered into the overlay region (design section 22.4). Copy/Paste are
// offered only when the clipboard feature is present (ctx.use), routing Paste
// through the kernel's sanitizing funnel. Escape-to-close goes through the
// kernel keydown intercept; outside-click is a document gesture.
//
// TOUCH MODEL (best-practice, cross-platform iOS + Android):
// The terminal output is the browser's native text-selection surface, so a
// touch long-press ON TEXT is left to the platform: it selects a word and shows
// the OS copy callout. We do NOT stack a custom menu on that (it fought native
// selection and, since the long-press is immediately followed by a touchend,
// closed the instant the finger lifted). The custom menu opens on touch ONLY
// when the long-press selected nothing (empty space) — its job there is Paste,
// which the native callout cannot offer because our keyboard target is a 1x1,
// pointer-events:none textarea (no editable surface under the finger for the OS
// paste item). Paste reads the clipboard via the Clipboard API (secure context
// required, so serve over HTTPS for touch paste). Desktop is the ordinary
// right-click menu (Copy / Select All / Paste).
//
// Deciding "did the long-press select text?" is the crux — a naive
// getSelection() read at a fixed delay races the native selection and caused the
// reported flakiness (sometimes native, sometimes custom, sometimes both). So we
// TRACK whether a selection is made during THIS press via a selectionchange
// listener armed only while a touch is down (the moment one appears we cancel
// the pending menu and, if it already opened, close it), AND we gate the menu on
// PRESS POSITION: a long-press that landed on a glyph run belongs to the
// platform's word-select even when no selection has registered yet (iOS 26's
// native selection can land well past our 550ms timer, so timing alone misfires
// over text). The platforms deliver the long-press differently: iPhone fires NO
// contextmenu (a hold timer detects it); iPadOS DOES fire contextmenu mid-press
// and WebKit treats preventDefault on it as "cancel every remaining default of
// this gesture" — including a not-yet-registered selection — so on Apple touch
// devices the contextmenu handler never preventDefaults (that asymmetry is what
// once made iPad unable to select at all while iPhone worked); Android also
// fires contextmenu, and there we DO preventDefault when showing our own menu so
// Android's native menu doesn't also appear (the "both menus" case). All paths
// share the same selection + position gates, so the outcome is consistent.

import type { TerminalFeature } from "../kernel/types.js";
import type { ClipboardApi } from "./clipboard.js";

// Slightly longer than the browser's ~500ms native long-press so a native word
// selection (which we defer to) has registered — and fired selectionchange —
// before this fires.
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const EDGE_MARGIN = 8;
// When the menu can't fit below the anchor (a long-press near the bottom edge or
// above the keyboard), it opens above the point. This gap lifts it clear of the
// fingertip so the touch does not cover the menu items.
const MENU_GAP = 16;
// After a touch long-press opens the menu, swallow the trailing click/tap that
// the same gesture emits on finger-release for this window, so the menu does not
// immediately dismiss itself (the classic contextmenu-then-touchend race).
const SWALLOW_MS = 350;

export interface ContextMenuOptions {
  /** The clipboard feature value, so the menu can offer Copy/Paste through its
   *  API (ctx.use). Omitted: the menu shows only Select All. */
  clipboard?: TerminalFeature<ClipboardApi>;
}

/** iPhone/iPad/iPod, including iPadOS Safari's default "desktop mode" (which
 *  reports platform MacIntel but with a touch screen). On these, a long-press on
 *  text fires `contextmenu` slightly BEFORE the native word-selection registers,
 *  so hasNativeSelection() is still false at that instant and the Android
 *  empty-space branch would wrongly open our menu and preventDefault the native
 *  selection. Deferring on any Apple touch device lets iOS/iPadOS run its own
 *  text selection + drag handles (bug: an iPad long-press opened the custom menu
 *  instead of native selection, leaving Select All the only way to select). */
function isAppleTouchDevice(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/iP(hone|ad|od)/.test(ua) || /iP(hone|ad|od)/.test(platform)) {
    return true;
  }
  // iPadOS 13+ Safari defaults to desktop mode: platform "MacIntel" but a touch
  // screen (maxTouchPoints > 1). A real trackpad Mac reports maxTouchPoints 0.
  return platform === "MacIntel" && navigator.maxTouchPoints > 1;
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
      // The device that started the current interaction: contextmenu fires on
      // desktop right-click AND on Android long-press, so its handler branches
      // on this to tell them apart.
      let lastPointerType = "mouse";
      // Computed once: on an Apple touch device, defer a touch contextmenu to
      // native text selection (see isAppleTouchDevice).
      const appleTouch = isAppleTouchDevice();
      // Timestamp until which a document click is swallowed (see SWALLOW_MS).
      let swallowUntil = 0;
      // A native selection was made during the current touch press (tracked via
      // selectionchange). Gates the touch menu: a selected long-press belongs to
      // the native callout, an empty one to us (Paste).
      let pressSelectedText = false;
      // A touch press is in progress, so selectionchange is relevant (armed).
      let touchActive = false;

      const clip = (): ClipboardApi | undefined =>
        opts.clipboard ? ctx.use(opts.clipboard) : undefined;

      function focusInput(): void {
        surface.querySelector<HTMLElement>(".term-input")?.focus({ preventScroll: true });
      }

      const clearLongPress = (): void => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      };

      // True when the press landed on rendered text (a glyph run inside the
      // output). The empty-space menu must not open there: a long-press on text
      // belongs to the platform's word-selection, and opening ours first races
      // it (on iOS 26 the native selection can register well after 550ms, so
      // the old no-selection-yet check misfired over text). Hitting the row or
      // container (the blank area beside/below content) still counts as empty
      // space so Paste stays reachable.
      const pressOverText = (x: number, y: number): boolean => {
        const el = document.elementFromPoint(x, y);
        if (!(el instanceof HTMLElement) || !el.closest(".term-output")) {
          return false;
        }
        const run = el.closest("span, a");
        return run !== null && run.textContent.trim().length > 0;
      };

      // True when text is (or just got) selected, so the OS callout owns Copy and
      // our menu stays out of the way. pressSelectedText catches a native
      // selection the instant it happens (selectionchange), avoiding a race with
      // a fixed-delay read; the live check is the fallback for when selectionchange
      // did not arm (a desktop right-click on an existing selection).
      const hasNativeSelection = (): boolean => {
        if (pressSelectedText) {
          return true;
        }
        const s = window.getSelection();
        return s !== null && !s.isCollapsed && s.toString().length > 0;
      };

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

      function show(x: number, y: number, touch: boolean): void {
        hide();
        const clipboard = clip();
        // On touch we only reach here over empty space (no selection), so Copy
        // has nothing to act on; the native callout owns Copy over selected
        // text. On desktop, offer Copy when there is a selection.
        if (!touch) {
          const sel = window.getSelection()?.toString();
          if (sel) {
            addButton("Copy", () => {
              clipboard?.copy(sel);
            });
          }
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
        if (menu.childElementCount === 0) {
          return; // nothing to offer
        }
        // Make visible (so it has measurable size), then place it within the
        // VISIBLE viewport. position:fixed => x/y are viewport coordinates; the
        // visual viewport (when present) is the area above the on-screen
        // keyboard, so clamping to it keeps the menu off the keyboard too.
        menu.classList.add("visible");
        const vv = window.visualViewport;
        const viewLeft = vv ? vv.offsetLeft : 0;
        const viewTop = vv ? vv.offsetTop : 0;
        const viewWidth = vv ? vv.width : window.innerWidth;
        const viewHeight = vv ? vv.height : window.innerHeight;
        const menuW = menu.offsetWidth;
        const menuH = menu.offsetHeight;
        const left = Math.max(
          viewLeft + EDGE_MARGIN,
          Math.min(x, viewLeft + viewWidth - menuW - EDGE_MARGIN),
        );
        // Open just below the point; but if that would overflow the visible
        // bottom (a long-press near the bottom edge, where the user naturally
        // taps), flip above the finger so the menu is neither clipped off-screen
        // nor hidden under the fingertip.
        let top = y;
        if (y + menuH + EDGE_MARGIN > viewTop + viewHeight) {
          top = y - menuH - MENU_GAP;
        }
        top = Math.max(
          viewTop + EDGE_MARGIN,
          Math.min(top, viewTop + viewHeight - menuH - EDGE_MARGIN),
        );
        menu.style.left = `${String(left)}px`;
        menu.style.top = `${String(top)}px`;
        // A touch long-press is immediately followed by a synthetic click on
        // release; swallow it so the menu stays open (see SWALLOW_MS).
        if (touch) {
          swallowUntil = performance.now() + SWALLOW_MS;
        }
      }

      const onPointerDown = (e: PointerEvent): void => {
        lastPointerType = e.pointerType;
      };
      surface.addEventListener("pointerdown", onPointerDown, { passive: true });

      // contextmenu fires on desktop right-click AND on Android long-press (iOS
      // fires none). Desktop: always our menu. Touch (Android): our menu only
      // when nothing is selected — and preventDefault so Android's native menu
      // does not ALSO appear (the "both menus" bug); with a selection, defer to
      // the native selection toolbar (don't preventDefault).
      const onContextMenu = (e: MouseEvent): void => {
        if (lastPointerType !== "touch") {
          e.preventDefault();
          show(e.clientX, e.clientY, false);
          return;
        }
        if (appleTouch) {
          // NEVER preventDefault a touch contextmenu on iOS/iPadOS: WebKit then
          // cancels every remaining default action of the gesture, including a
          // native word-selection that registers AFTER this event (iPadOS fires
          // contextmenu mid-long-press; on iOS 26 the selection can land well
          // after it). iPhone fires no contextmenu at all, so suppressing here
          // is exactly what made iPad behave differently from iPhone. If our
          // empty-space menu opened first (the hold timer beat a slow native
          // selection), stand down so the platform's selection wins.
          if (menu.classList.contains("visible") && !hasNativeSelection()) {
            hide(false);
          }
          return;
        }
        if (menu.classList.contains("visible")) {
          e.preventDefault(); // the hold timer already opened it; just suppress native
          return;
        }
        if (hasNativeSelection()) {
          return; // native selection toolbar owns Copy over text
        }
        if (pressOverText(e.clientX, e.clientY)) {
          return; // a long-press on text belongs to the platform's word-select
        }
        e.preventDefault();
        clearLongPress();
        show(e.clientX, e.clientY, true);
      };
      surface.addEventListener("contextmenu", onContextMenu);

      // Track a native selection made during the current touch press, so the
      // long-press decision never races a fixed-delay read. Armed only while a
      // touch is down (touchActive) so unrelated selection changes (Select All,
      // typing) don't trip it.
      const onSelectionChange = (): void => {
        if (!touchActive) {
          return;
        }
        const s = window.getSelection();
        if (s && !s.isCollapsed && s.toString().length > 0) {
          pressSelectedText = true;
          clearLongPress(); // native selection is happening; don't open our menu
          if (menu.classList.contains("visible")) {
            hide(false); // a native selection appeared after we opened; native wins
          }
        }
      };
      document.addEventListener("selectionchange", onSelectionChange);

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
        // Swallow the release click of the long-press that just opened the menu.
        if (performance.now() < swallowUntil) {
          return;
        }
        hide();
      };
      document.addEventListener("click", onDocClick);
      // A right-click outside the terminal surface (a tab, its menu, elsewhere,
      // or a native browser menu) dismisses this menu. A right-click on the
      // surface is handled by onContextMenu (which reopens it) and fires first.
      const onDocContextMenu = (e: MouseEvent): void => {
        if (!surface.contains(e.target as Node)) {
          hide();
        }
      };
      document.addEventListener("contextmenu", onDocContextMenu);

      // Touch long-press — the iOS path (iOS fires no contextmenu). Open the menu
      // only when nothing got natively selected during the hold; if a word/line
      // was selected, the OS callout owns it and we stay out.
      const onTouchStart = (e: TouchEvent): void => {
        if (e.touches.length !== 1) {
          clearLongPress();
          return;
        }
        const t = e.touches[0];
        if (!t) {
          return;
        }
        touchActive = true;
        pressSelectedText = false;
        longPressOrigin = { x: t.clientX, y: t.clientY };
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0;
          if (!hasNativeSelection() && !pressOverText(longPressOrigin.x, longPressOrigin.y)) {
            show(longPressOrigin.x, longPressOrigin.y, true);
          }
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
      const onTouchEnd = (): void => {
        clearLongPress();
        touchActive = false;
      };
      surface.addEventListener("touchstart", onTouchStart, { passive: true });
      surface.addEventListener("touchmove", onTouchMove, { passive: true });
      surface.addEventListener("touchend", onTouchEnd, { passive: true });
      surface.addEventListener("touchcancel", onTouchEnd, { passive: true });

      return {
        teardown() {
          clearLongPress();
          offKey();
          surface.removeEventListener("pointerdown", onPointerDown);
          surface.removeEventListener("contextmenu", onContextMenu);
          document.removeEventListener("selectionchange", onSelectionChange);
          document.removeEventListener("click", onDocClick);
          document.removeEventListener("contextmenu", onDocContextMenu);
          surface.removeEventListener("touchstart", onTouchStart);
          surface.removeEventListener("touchmove", onTouchMove);
          surface.removeEventListener("touchend", onTouchEnd);
          surface.removeEventListener("touchcancel", onTouchEnd);
          menu.remove();
        },
      };
    },
  };
}
