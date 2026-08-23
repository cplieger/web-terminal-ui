import { describe, it, expect, vi } from "vitest";
import { fromHTML, holdFocusOnPress, PRESSED_CLASS } from "./dom.js";

// The pointer events are spelled as MouseEvent (the pattern the other feature
// tests use). Only `button` and cancellability matter to the handler, and both
// interfaces carry them.
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

// The release listeners are the one part of holdFocusOnPress with no visible
// effect of its own: `end` only calls `release?.()`, so a listener left behind
// after a press is INDISTINGUISHABLE from a fresh one by dispatching events —
// it does the same nothing. What it is not is free: it is a window listener per
// press that keeps the button alive for the life of the page, which is why the
// module binds every one of them to the press's own AbortController. These tests
// assert that registration, because it is the only observable the contract has.
describe("holdFocusOnPress — a press owns its release listeners", () => {
  const button = (): HTMLElement => fromHTML(`<button type="button" class="wt-btn"></button>`);

  const pointer = (type: string, init: MouseEventInit = {}): MouseEvent =>
    new MouseEvent(type, { bubbles: true, cancelable: true, ...init });

  interface Registration {
    readonly target: "window" | "button";
    readonly type: string;
    readonly options: AddEventListenerOptions | undefined;
  }

  /** Records the release-listener registrations holdFocusOnPress makes, in order.
   *  The spies call through, so the real wiring still happens; the pointerdown
   *  registration that arms the press is not a release listener and is filtered
   *  out. */
  function watchRegistrations(btn: HTMLElement): () => Registration[] {
    const onWindow = vi.spyOn(window, "addEventListener");
    const onButton = vi.spyOn(btn, "addEventListener");
    const collect = (target: "window" | "button", spy: typeof onWindow): Registration[] =>
      spy.mock.calls
        .filter(([type]) => type !== "pointerdown")
        .map(([type, , options]) => ({
          target,
          type: String(type),
          options: (typeof options === "object" ? options : undefined) ?? undefined,
        }));
    return () => [...collect("window", onWindow), ...collect("button", onButton)];
  }

  it("registers every release listener against one abort signal for the press", () => {
    const btn = button();
    const registrations = watchRegistrations(btn);
    holdFocusOnPress(btn);
    btn.dispatchEvent(pointer("pointerdown"));

    const regs = registrations();
    expect(regs.map((r) => `${r.target}:${r.type}`)).toEqual([
      "window:pointerup",
      "window:pointercancel",
      "button:pointerleave",
    ]);
    // One controller for the whole press: a release cannot drop two of the three
    // and leave the last one bound to a button that has already come back up.
    const signals = regs.map((r) => r.options?.signal);
    expect(signals.every((s) => s !== undefined)).toBe(true);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("aborts that signal on the release, so the listeners are gone and not merely inert", () => {
    const btn = button();
    const registrations = watchRegistrations(btn);
    holdFocusOnPress(btn);
    btn.dispatchEvent(pointer("pointerdown"));
    const signal = registrations()[0]?.options?.signal;

    window.dispatchEvent(pointer("pointerup"));

    expect(btn.classList.contains(PRESSED_CLASS)).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it.each(["pointercancel", "pointerleave"])(
    "aborts that signal when the press ends on %s too",
    (type) => {
      const btn = button();
      const registrations = watchRegistrations(btn);
      holdFocusOnPress(btn);
      btn.dispatchEvent(pointer("pointerdown"));
      const signal = registrations()[0]?.options?.signal;

      if (type === "pointerleave") {
        btn.dispatchEvent(pointer(type));
      } else {
        window.dispatchEvent(pointer(type));
      }

      expect(signal?.aborted).toBe(true);
    },
  );

  it("ignores a second pointerdown while the press is live instead of starting a second press", () => {
    // A second finger, or a synthetic pointerdown from an embedding host. Without
    // the guard the second press installs its own controller and orphans the
    // first one's listeners: the release aborts only the newest, so the page
    // accumulates window listeners for as long as the user keeps pressing.
    const btn = button();
    const registrations = watchRegistrations(btn);
    holdFocusOnPress(btn);
    btn.dispatchEvent(pointer("pointerdown"));
    btn.dispatchEvent(pointer("pointerdown"));

    const regs = registrations();
    expect(regs).toHaveLength(3);

    window.dispatchEvent(pointer("pointerup"));
    expect(regs.every((r) => r.options?.signal?.aborted === true)).toBe(true);
  });
});
