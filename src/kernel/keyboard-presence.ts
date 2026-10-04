// No web API reports a hardware keyboard, so the shell infers one from the keys
// it sees and keeps that inference in one place for every pane and feature.

import type { KeyboardPresence } from "./types.js";

/** An on-screen keyboard at least this tall is docked; the hardware-keyboard
 *  shortcut bar iPadOS shows is well under it. */
const SOFT_KEYBOARD_MIN_PX = 150;

/** Whether the PRIMARY pointer is fine. False on every iPad and iPhone whatever
 *  is attached, true on a desktop (`pointerCharacteristicsOfPrimaryPointingDevice`,
 *  https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/WebPage/ios/WebPageIOS.mm). */
export function primaryPointerFine(win: Window): boolean {
  return typeof win.matchMedia === "function" && win.matchMedia("(pointer: fine)").matches;
}

/** Whether a mouse or trackpad is attached; a Pencil never answers it, unlike
 *  `any-pointer: fine` (`hoverSupportedByAnyAvailablePointingDevice`, same file). */
function accessoryMouse(win: Window): boolean {
  return typeof win.matchMedia === "function" && win.matchMedia("(any-hover: hover)").matches;
}

export interface KeyboardPresenceTracker extends KeyboardPresence {
  /** Whether the visual-viewport keyboard inset is to be ignored. */
  insetSuppressed(): boolean;
  noteKeydown(ev: KeyboardEvent): void;
  noteSoftKeyboard(heightPx: number, editableFocused: boolean): void;
}

export interface KeyboardPresenceOptions {
  readonly win: Window & typeof globalThis;
  /** Never the suppressed inset: the suppression itself reads this tracker. */
  readonly softKeyboardHeight: () => number;
}

/** A key that is not text: a modifier chord, navigation, Escape, Tab or a
 *  function key. An on-screen keyboard can send some of these too (Android's
 *  `InputConnection.sendKeyEvent`, https://developer.android.com/reference/android/view/inputmethod/InputConnection#sendKeyEvent(android.view.KeyEvent)),
 *  which the empty `code`, the height gate and `isOnScreenTab` answer. */
function looksLikeHardwareKey(ev: KeyboardEvent): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) {
    return true;
  }
  switch (ev.key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
    case "Escape":
    case "Tab":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
      return true;
    default:
      return /^F\d{1,2}$/.test(ev.key);
  }
}

/** An unmodified Tab: the one hardware-only key on the iPad's full on-screen
 *  keyboard, which reports no inset while undocked or split (`_keyboardChangedWithInfo:`,
 *  https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/ios/WKWebViewIOS.mm).
 *  Its code cannot tell: WebKit derives a soft key's code from its character
 *  (`initWithKeyEventType:`, https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/WebEvent.mm). */
function isOnScreenTab(ev: KeyboardEvent): boolean {
  return ev.key === "Tab" && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
}

export function createKeyboardPresence(opts: KeyboardPresenceOptions): KeyboardPresenceTracker {
  const { win } = opts;
  let seen = false;
  const isEditable = (target: EventTarget | null): boolean =>
    target instanceof win.HTMLElement &&
    (target.isContentEditable ||
      target instanceof win.HTMLInputElement ||
      target instanceof win.HTMLTextAreaElement);
  return {
    hardwareSeen: () => seen,
    likely: () => seen || primaryPointerFine(win),
    // createKeyboardInsets owns the phantom iPad inset this defends against; it
    // comes with a Magic Keyboard, whose trackpad any-hover sees.
    insetSuppressed: () => seen || primaryPointerFine(win) || accessoryMouse(win),
    noteKeydown(ev) {
      // An on-screen key has no physical key, so Chromium Android leaves `code`
      // empty (it fills it from the scan code alone:
      // https://chromium.googlesource.com/chromium/src/+/main/components/input/web_input_event_builders_android.cc),
      // and any such key clears a latch. A keyboard app that stamps a real scan
      // code on its own arrow can latch until its next letter. WebKit never
      // reports an empty code (`codeForKeyEvent`,
      // https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/PlatformEventFactoryIOS.mm),
      // so on iOS "Unidentified", the height gate and the Tab rule below decide.
      if (ev.code === "" || ev.key === "Unidentified") {
        seen = false;
        return;
      }
      if (
        looksLikeHardwareKey(ev) &&
        (!isEditable(ev.target) ||
          (opts.softKeyboardHeight() < SOFT_KEYBOARD_MIN_PX && !isOnScreenTab(ev)))
      ) {
        seen = true;
      }
    },
    noteSoftKeyboard(heightPx, editableFocused) {
      // With a mouse or trackpad attached the reading may be that phantom.
      if (heightPx >= SOFT_KEYBOARD_MIN_PX && editableFocused && !accessoryMouse(win)) {
        seen = false;
      }
    },
  };
}
