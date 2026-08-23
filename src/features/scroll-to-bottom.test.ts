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
  // happy-dom has no layout, so the scroll geometry is declared. The default is
  // "there is somewhere to scroll to" (700px of range, parked at the top), which
  // is the state the button exists for; the zero-distance case gets its own test
  // because the feature branches on it.
  let scrollTopValue = 0;
  Object.defineProperty(surface, "scrollHeight", { get: () => 1000, configurable: true });
  Object.defineProperty(surface, "clientHeight", { get: () => 300, configurable: true });
  Object.defineProperty(surface, "scrollTop", {
    get: () => scrollTopValue,
    set: (v: number) => {
      scrollTopValue = v;
    },
    configurable: true,
  });
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
    // The target is the MAXIMUM offset (1000 - 300), not scrollHeight. An
    // over-scroll target is one clientHeight past the end and needs the container
    // to clamp it, which is the assumption the engine's bottom writes dropped:
    // WebKit does not keep an offset inside the range for free.
    expect(surface.scrollTo).toHaveBeenCalledWith({ top: 700, behavior: "smooth" });
    expect(scrollToBottomSpy).not.toHaveBeenCalled();
  });

  it("re-engages follow directly when there is no distance to animate", () => {
    // The state that makes this necessary: a program erasing its scrollback
    // clamps a scrolled-up reader to the bottom WITHOUT engaging follow, and the
    // engine now keeps them there (an upward clamp may not engage follow). A
    // smooth scroll with zero distance fires no scroll event, so nothing would
    // re-derive the state and this button — whose whole job is resuming follow —
    // would be inert until output happened to arrive.
    stubMatchMedia(false);
    const { ctx, slot, surface, scrollToBottomSpy } = fakeCtx();
    surface.scrollTop = 700; // already at the bottom of the 1000/300 geometry
    scrollToBottom().setup(ctx);
    button(slot)?.click();
    expect(scrollToBottomSpy).toHaveBeenCalledTimes(1);
    expect(surface.scrollTo).not.toHaveBeenCalled();
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

describe("scrollToBottom: an engine with no matchMedia at all", () => {
  it("still smooth-scrolls, rather than failing on the media query", () => {
    // window.matchMedia is feature-detected because the reduced-motion answer is
    // an optimisation, not a requirement: an engine (or an embedding webview)
    // without the media-query API must still get a working button. Calling it
    // unguarded throws inside the click handler, which loses the scroll AND
    // whatever the handler would have done next.
    vi.stubGlobal("matchMedia", undefined);
    const { ctx, slot, surface, scrollToBottomSpy } = fakeCtx();
    scrollToBottom().setup(ctx);

    button(slot)?.click();

    expect(surface.scrollTo).toHaveBeenCalledWith({ top: 700, behavior: "smooth" });
    expect(scrollToBottomSpy).not.toHaveBeenCalled();
  });
});
