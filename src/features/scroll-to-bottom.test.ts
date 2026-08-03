// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { scrollToBottom } from "./scroll-to-bottom.js";
import type { TerminalContext, FeatureInstance } from "../kernel/types.js";

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal("matchMedia", () => ({ matches: reduce }));
}

function fakeCtx(): {
  ctx: TerminalContext;
  slot: HTMLElement;
  surface: HTMLElement;
  scrollToBottomSpy: ReturnType<typeof vi.fn>;
  offSpy: ReturnType<typeof vi.fn>;
  emitScroll: (scrolledUp: boolean) => void;
} {
  const slot = document.createElement("div");
  const surface = document.createElement("div");
  surface.scrollTo = vi.fn();
  const scrollToBottomSpy = vi.fn();
  const offSpy = vi.fn();
  let scrollHandler: ((p: { scrolledUp: boolean }) => void) | undefined;
  const ctx = {
    region: () => slot,
    surface: () => surface,
    scroll: {
      scrollToBottom: scrollToBottomSpy,
      isUserScrolledUp: () => false,
      currentScrollTop: () => 0,
      restoreScrollTop: () => undefined,
    },
    on: (_e: string, fn: (p: { scrolledUp: boolean }) => void) => {
      scrollHandler = fn;
      return offSpy;
    },
  } as unknown as TerminalContext;
  return {
    ctx,
    slot,
    surface,
    scrollToBottomSpy,
    offSpy,
    emitScroll: (s) => scrollHandler?.({ scrolledUp: s }),
  };
}

const button = (slot: HTMLElement): HTMLButtonElement | null =>
  slot.querySelector<HTMLButtonElement>("button");

describe("scrollToBottom feature", () => {
  it("under reduced motion, activating the control uses the engine's instant scrollToBottom", () => {
    stubMatchMedia(true);
    const { ctx, slot, surface, scrollToBottomSpy } = fakeCtx();
    scrollToBottom().setup(ctx);
    button(slot)?.click();
    expect(scrollToBottomSpy).toHaveBeenCalledTimes(1);
    expect(surface.scrollTo).not.toHaveBeenCalled();
  });

  it("with motion allowed, activating the control smooth-scrolls the surface instead", () => {
    stubMatchMedia(false);
    const { ctx, slot, surface, scrollToBottomSpy } = fakeCtx();
    scrollToBottom().setup(ctx);
    button(slot)?.click();
    expect(surface.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    expect(scrollToBottomSpy).not.toHaveBeenCalled();
  });

  it("toggles the scrolled-up class on the region from the scroll:state event", () => {
    stubMatchMedia(false);
    const { ctx, slot, emitScroll } = fakeCtx();
    scrollToBottom().setup(ctx);
    emitScroll(true);
    expect(slot.classList.contains("scrolled-up")).toBe(true);
    emitScroll(false);
    expect(slot.classList.contains("scrolled-up")).toBe(false);
  });

  it("jumps on the press and paints the press class while held", () => {
    // pointerdown, not click: the jump lands on the press. The class is what
    // gives the button a press state at all in Firefox, where cancelling the
    // pointerdown default (to keep the keyboard on the terminal) also suppresses
    // the browser's own :active.
    stubMatchMedia(true);
    const { ctx, slot, scrollToBottomSpy } = fakeCtx();
    scrollToBottom().setup(ctx);
    const btn = button(slot);
    btn?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(scrollToBottomSpy).toHaveBeenCalledTimes(1);
    expect(btn?.classList.contains("wt-pressed")).toBe(true);
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(btn?.classList.contains("wt-pressed")).toBe(false);
  });

  it("teardown removes the button and unsubscribes from scroll:state", () => {
    stubMatchMedia(false);
    const { ctx, slot, offSpy } = fakeCtx();
    const inst = scrollToBottom().setup(ctx) as FeatureInstance;
    expect(button(slot)).not.toBeNull();
    inst.teardown();
    expect(button(slot)).toBeNull();
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});
