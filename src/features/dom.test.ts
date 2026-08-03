// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { fromHTML, holdFocusOnPress, PRESSED_CLASS } from "./dom.js";

// happy-dom ships no PointerEvent, so the pointer events are spelled as
// MouseEvent (the pattern the other feature tests use). Only `button` and
// cancellability matter to the handler.
const pointer = (type: string, init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, ...init });

const press = (el: HTMLElement, init: MouseEventInit = {}): MouseEvent => {
  const e = pointer("pointerdown", init);
  el.dispatchEvent(e);
  return e;
};

describe("holdFocusOnPress", () => {
  const button = (): HTMLElement => fromHTML(`<button type="button" class="wt-btn"></button>`);

  it("cancels the pointerdown default so the press cannot take focus off the terminal", () => {
    const btn = button();
    holdFocusOnPress(btn);
    expect(press(btn).defaultPrevented).toBe(true);
  });

  it("paints the press class while held, because a cancelled default suppresses :active in Firefox", () => {
    const btn = button();
    holdFocusOnPress(btn);
    press(btn);
    expect(btn.classList.contains(PRESSED_CLASS)).toBe(true);
  });

  it.each(["pointerup", "pointercancel"])("drops the press class on a window %s", (type) => {
    const btn = button();
    holdFocusOnPress(btn);
    press(btn);
    window.dispatchEvent(pointer(type));
    expect(btn.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("drops the press class when the pointer leaves while held", () => {
    const btn = button();
    holdFocusOnPress(btn);
    press(btn);
    btn.dispatchEvent(pointer("pointerleave"));
    expect(btn.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("drops the press class even when the button hid itself on the press", () => {
    // .wt-scroll-bottom acts on pointerdown and then hides (its slot loses
    // .scrolled-up), so the release never reaches the button. Bound to the
    // button, the class would survive and the control would come back lit.
    const btn = button();
    holdFocusOnPress(btn);
    press(btn);
    btn.style.display = "none";
    window.dispatchEvent(pointer("pointerup"));
    expect(btn.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("re-arms for the next press", () => {
    const btn = button();
    holdFocusOnPress(btn);
    press(btn);
    window.dispatchEvent(pointer("pointerup"));
    press(btn);
    expect(btn.classList.contains(PRESSED_CLASS)).toBe(true);
  });

  it("paints nothing for a non-primary button, matching what :active does", () => {
    const btn = button();
    holdFocusOnPress(btn);
    // Still cancelled (the focus half is unconditional), but not painted.
    expect(press(btn, { button: 2 }).defaultPrevented).toBe(true);
    expect(btn.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("leaves no window listeners behind once the press ends", () => {
    // The release listeners exist only for the life of a press (AbortController),
    // so a torn-down feature's button is not kept alive by a stray window handler.
    const btn = button();
    holdFocusOnPress(btn);
    press(btn);
    window.dispatchEvent(pointer("pointerup"));
    // A stray window pointerup must not be able to touch the button any more:
    // re-add the class by hand and confirm nothing clears it.
    btn.classList.add(PRESSED_CLASS);
    window.dispatchEvent(pointer("pointerup"));
    expect(btn.classList.contains(PRESSED_CLASS)).toBe(true);
  });
});
