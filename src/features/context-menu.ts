// contextMenu feature: the Copy / Select All / Paste menu for the terminal
// surface (design section 22.4), rendered into the overlay region. Copy and Paste
// need the clipboard feature (ctx.use), and Paste routes through the kernel's
// sanitizing funnel. Escape-to-close goes through the kernel keydown intercept;
// outside-click is a document gesture.
//
// WHY THIS MENU EXISTS
// The terminal output is real DOM text, so the browser already does the hard
// part: drag-select with a mouse, long-press word-select plus the OS copy callout
// on touch. What no platform can offer is PASTE — the keyboard target is a 1x1
// pointer-events:none textarea, so there is no editable surface under the pointer
// for a native paste item to attach to. This menu is the paste path. It carries
// Copy and Select All because a menu appearing where the platform's would have
// appeared should not be missing them.
//
// THE MODEL: one owner per gesture, and nothing decided mid-gesture.
//
//   Mouse / pen — `contextmenu` is an already-classified request for a menu:
//   preventDefault and open at the pointer. No timers, no heuristics, no
//   platform branches.
//
//   Touch — the platform owns the press while the finger is down. We run no hold
//   timer against it, open nothing before it finishes, and never cancel its
//   gesture on WebKit. We classify ONCE, on `touchend`, when every fact is
//   settled: a single-finger, stationary press held past the tap ceiling
//   (kernel/gesture.ts, shared with the kernel's tap-to-focus so the two cannot
//   both claim one press) that selected nothing and did not start on a link is a
//   press the platform declined — so it is ours, and it is the paste path. A
//   press that produced a selection belongs to the OS callout; a press on a link
//   belongs to the platform's link preview; a shorter press is the kernel's tap.
//
// WHY AT RELEASE RATHER THAN DURING THE HOLD
// Opening from a ~550ms hold timer put this feature in a race it cannot win: the
// timer has to beat the platform's own long-press threshold and then GUESS
// whether a selection is still coming (iOS 26 registers a word selection well
// after 550ms). Four mechanisms existed only to referee that guess — a hit test
// for glyphs under the finger, a selectionchange watch to retract a menu that
// opened too early, a device sniff, and per-platform contextmenu branching,
// because WebKit reads preventDefault on a touch contextmenu as "cancel every
// remaining default of this gesture", the not-yet-registered selection included.
// Deciding at release deletes all four: the outcome is observed, not predicted.
//
// It also fixes the symptom that prompted the rewrite. A touch long-press emits a
// trailing click on release, and the swallow window that covers that click was
// armed when the menu OPENED — ~550ms into the press, expiring 350ms later — so
// holding a beat longer meant the release click landed as an outside click and
// dismissed the menu the instant the finger lifted. Opened BY the release, the
// window can only ever start at the release edge.

import type { TerminalFeature } from "../kernel/types.js";
import { TAP_MAX_MS, TAP_MOVEMENT_PX, isLinkTarget } from "../kernel/gesture.js";
import type { ClipboardApi } from "./clipboard.js";
import { createClickSwallow, placeMenuAt } from "./menu-position.js";

// Viewport clamping, the flip-above-the-fingertip gap, and the trailing-click
// swallow all live in the shared point-anchored menu module (menu-position.ts),
// shared with the tab menu.

export interface ContextMenuOptions {
  /** The clipboard feature value, so the menu can offer Copy/Paste through its
   *  API (ctx.use). Omitted: the menu shows only Select All. */
  clipboard?: TerminalFeature<ClipboardApi>;
}

/** iPhone/iPad/iPod, including iPadOS Safari's default "desktop mode" (platform
 *  MacIntel with a touch screen).
 *
 *  This decides exactly one thing: whether a touch `contextmenu` may be
 *  cancelled. WebKit reads preventDefault there as "cancel every remaining
 *  default action of this gesture", which takes the platform's own
 *  not-yet-registered word selection with it — that asymmetry is what once left
 *  an iPad unable to select text at all while an iPhone (which fires no
 *  contextmenu) could. Everywhere else, cancelling is how we stop the platform's
 *  menu appearing alongside ours. It no longer decides whether or when our menu
 *  opens, so a wrong answer here costs at most a duplicated menu on an unusual
 *  device, never a broken selection and never a lost paste. */
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

/** The current selection as text ("" when nothing is selected). A collapsed
 *  selection stringifies to "", so this is the whole test. */
function selectionText(): string {
  return window.getSelection()?.toString() ?? "";
}

/** True when an event target sits inside a hyperlink. A long-press on a link
 *  raises the platform's own link preview/menu without ever making a selection,
 *  so the selection test alone would not keep us out of its way. */
const onLink = isLinkTarget;

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
        const sel = selectionText();
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
        if (!appleTouch && !onLink(e.target) && selectionText() === "") {
          e.preventDefault();
        }
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
      // A right-click outside the terminal surface (a tab, its menu, elsewhere,
      // or a native browser menu) dismisses this menu. A right-click on the
      // surface is handled by onContextMenu (which reopens it) and fires first.
      const onDocContextMenu = (e: MouseEvent): void => {
        if (!surface.contains(e.target as Node)) {
          hide();
        }
      };
      document.addEventListener("contextmenu", onDocContextMenu);

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
        pressSelection = selectionText();
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
        const sel = selectionText();
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

      return {
        teardown() {
          offKey();
          surface.removeEventListener("pointerdown", onPointerDown);
          surface.removeEventListener("contextmenu", onContextMenu);
          document.removeEventListener("click", onDocClick);
          document.removeEventListener("contextmenu", onDocContextMenu);
          surface.removeEventListener("touchstart", onTouchStart);
          surface.removeEventListener("touchmove", onTouchMove);
          surface.removeEventListener("touchend", onTouchEnd);
          surface.removeEventListener("touchcancel", onTouchCancel);
          menu.remove();
        },
      };
    },
  };
}
