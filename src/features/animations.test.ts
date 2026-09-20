import { describe, it, expect, vi } from "vitest";
import { animations } from "./animations.js";
import type { TerminalContext, FeatureInstance } from "../kernel/types.js";

interface FakeMq {
  matches: boolean;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

function stubMatchMedia(reduce: boolean): {
  mq: FakeMq;
  fire: () => void;
  listenerCount: () => number;
} {
  const listeners = new Set<() => void>();
  const mq: FakeMq = {
    matches: reduce,
    addEventListener: (_t, cb) => {
      listeners.add(cb);
    },
    removeEventListener: (_t, cb) => {
      listeners.delete(cb);
    },
  };
  vi.stubGlobal("matchMedia", () => mq);
  return {
    mq,
    fire: () => {
      for (const cb of listeners) {
        cb();
      }
    },
    listenerCount: () => listeners.size,
  };
}

/** A shell context with the two members the feature reads: the shell root the
 *  class lands on, and `defer`, where the media-query listener's release goes for
 *  the terminal to run after teardown. */
function fakeCtx(): { ctx: TerminalContext; root: HTMLElement; drainDeferred: () => void } {
  const root = document.createElement("div");
  const deferred: (() => void)[] = [];
  const ctx = {
    shell: { root },
    defer: (release: () => void) => {
      deferred.push(release);
    },
  } as unknown as TerminalContext;
  return {
    ctx,
    root,
    drainDeferred: () => {
      while (deferred.length > 0) {
        deferred.pop()?.();
      }
    },
  };
}

describe("animations feature", () => {
  it("adds wt-animate to the shell root when reduced motion is NOT requested", () => {
    stubMatchMedia(false);
    const { ctx, root } = fakeCtx();
    animations().setup(ctx);
    expect(root.classList.contains("wt-animate")).toBe(true);
  });

  it("does NOT add wt-animate when the user requests reduced motion", () => {
    stubMatchMedia(true);
    const { ctx, root } = fakeCtx();
    animations().setup(ctx);
    expect(root.classList.contains("wt-animate")).toBe(false);
  });

  it("re-applies live when the OS reduced-motion setting toggles on", () => {
    const mm = stubMatchMedia(false);
    const { ctx, root } = fakeCtx();
    animations().setup(ctx);
    expect(root.classList.contains("wt-animate")).toBe(true);
    mm.mq.matches = true;
    mm.fire();
    expect(root.classList.contains("wt-animate")).toBe(false);
  });

  it("teardown removes the class, and the deferred release drops the media-query listener", () => {
    const mm = stubMatchMedia(false);
    const { ctx, root, drainDeferred } = fakeCtx();
    const inst = animations().setup(ctx) as FeatureInstance;
    inst.teardown();
    expect(root.classList.contains("wt-animate")).toBe(false);
    expect(mm.listenerCount()).toBe(1);
    drainDeferred();
    expect(mm.listenerCount()).toBe(0);
  });

  it("asks the shell root's own window about reduced motion, not the importing one", () => {
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
      const innerListeners = new Set<() => void>();
      const innerMq: FakeMq = {
        matches: true,
        addEventListener: (_t, cb) => {
          innerListeners.add(cb);
        },
        removeEventListener: (_t, cb) => {
          innerListeners.delete(cb);
        },
      };
      win.matchMedia = () => innerMq as unknown as MediaQueryList;
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      const ctx = { shell: { root }, defer: () => undefined } as unknown as TerminalContext;

      animations().setup(ctx);

      expect(root.classList.contains("wt-animate")).toBe(false);
      expect(innerListeners.size).toBe(1);
    } finally {
      frame.remove();
    }
  });
});
