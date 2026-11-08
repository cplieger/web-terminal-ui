import { describe, it, expect, vi, afterEach } from "vitest";
import { createScrollController, type ScrollController } from "@cplieger/web-terminal-engine";
import { scrollToBottom } from "./scroll-to-bottom.js";
import type { TerminalContext, FeatureInstance, ScrollHandle } from "../kernel/types.js";

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal("matchMedia", () => ({ matches: reduce }));
}

function fakeCtx(scroll?: ScrollHandle): {
  ctx: TerminalContext;
  slot: HTMLElement;
  scrollToBottomSpy: ReturnType<typeof vi.fn>;
  offSpy: ReturnType<typeof vi.fn>;
  /** What the feature handed to `ctx.defer`, in order. */
  deferred: (() => void)[];
  emitScroll: (scrolledUp: boolean) => void;
} {
  const slot = document.createElement("div");
  const scrollToBottomSpy = vi.fn();
  const offSpy = vi.fn();
  const deferred: (() => void)[] = [];
  let scrollHandler: ((p: { scrolledUp: boolean }) => void) | undefined;
  const ctx = {
    region: () => slot,
    shell: { root: slot },
    defer: (release: () => void) => {
      deferred.push(release);
    },
    scroll: scroll ?? {
      scrollToBottom: scrollToBottomSpy,
      isUserScrolledUp: () => false,
      currentScrollTop: () => 0,
      restoreView: () => undefined,
    },
    on: (_e: string, fn: (p: { scrolledUp: boolean }) => void) => {
      scrollHandler = fn;
      return offSpy;
    },
  } as unknown as TerminalContext;
  return {
    ctx,
    slot,
    scrollToBottomSpy,
    offSpy,
    deferred,
    emitScroll: (s) => scrollHandler?.({ scrolledUp: s }),
  };
}

const button = (slot: HTMLElement): HTMLButtonElement | null =>
  slot.querySelector<HTMLButtonElement>("button");

describe("scrollToBottom feature", () => {
  it("under reduced motion, activating the control follows the output without animating", () => {
    stubMatchMedia(true);
    const { ctx, slot, scrollToBottomSpy } = fakeCtx();
    scrollToBottom().setup(ctx);
    button(slot)?.click();
    expect(scrollToBottomSpy.mock.calls).toEqual([[{ smooth: false }]]);
  });

  it("with motion allowed, activating the control asks the engine for an animated move", () => {
    stubMatchMedia(false);
    const { ctx, slot, scrollToBottomSpy } = fakeCtx();
    scrollToBottom().setup(ctx);
    button(slot)?.click();
    expect(scrollToBottomSpy.mock.calls).toEqual([[{ smooth: true }]]);
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

  it("hands the press wiring's release to the terminal, so a press held across teardown ends with it", () => {
    stubMatchMedia(false);
    const { ctx, slot, deferred } = fakeCtx();
    scrollToBottom().setup(ctx);
    const btn = button(slot);
    if (!btn) {
      throw new Error("no button");
    }
    document.body.appendChild(slot);
    btn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(btn.classList.contains("wt-pressed")).toBe(true);
    expect(deferred).toHaveLength(1);
    deferred[0]?.();
    expect(btn.classList.contains("wt-pressed")).toBe(false);
    slot.remove();
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
    const { ctx, slot, scrollToBottomSpy } = fakeCtx();
    scrollToBottom().setup(ctx);

    button(slot)?.click();

    expect(scrollToBottomSpy.mock.calls).toEqual([[{ smooth: true }]]);
  });
});

describe("scrollToBottom: in a second document", () => {
  it("reads reduced motion off the shell root's own window, not the importing one", () => {
    // A same-origin iframe is a second document with a window of its own; a
    // terminal mounted there follows that window's media query.
    stubMatchMedia(false);
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!doc || !win) {
      throw new Error("no frame document");
    }
    try {
      win.matchMedia = () => ({ matches: true }) as unknown as MediaQueryList;
      const { ctx, slot, scrollToBottomSpy } = fakeCtx();
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      (ctx as unknown as { shell: { root: HTMLElement } }).shell = { root };
      scrollToBottom().setup(ctx);

      button(slot)?.click();

      expect(scrollToBottomSpy.mock.calls).toEqual([[{ smooth: false }]]);
    } finally {
      frame.remove();
    }
  });
});

describe("scrollToBottom: with the engine's scroll controller", () => {
  let host: HTMLElement | undefined;
  let controller: ScrollController | undefined;
  afterEach(() => {
    controller?.dispose();
    host?.remove();
  });

  it("resumes following at the press when the move is animated", () => {
    stubMatchMedia(false);
    host = document.createElement("div");
    host.style.cssText = "height: 300px; overflow-y: auto";
    const content = document.createElement("div");
    content.style.height = "3000px";
    host.appendChild(content);
    document.body.appendChild(host);
    controller = createScrollController({ scrollEl: host });
    controller.scrollToBottom();
    controller.scrollByPage(-1);
    expect(controller.isUserScrolledUp()).toBe(true);
    const { ctx, slot } = fakeCtx(controller);
    scrollToBottom().setup(ctx);

    button(slot)?.click();

    expect(controller.isUserScrolledUp()).toBe(false);
  });
});
