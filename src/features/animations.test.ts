// @vitest-environment happy-dom
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

function fakeCtx(): { ctx: TerminalContext; root: HTMLElement } {
  const root = document.createElement("div");
  const surface = document.createElement("div");
  root.appendChild(surface);
  const ctx = { surface: () => surface } as unknown as TerminalContext;
  return { ctx, root };
}

describe("animations feature", () => {
  it("adds wt-animate to the root when reduced motion is NOT requested", () => {
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

  it("teardown removes the class and unsubscribes the media-query listener", () => {
    const mm = stubMatchMedia(false);
    const { ctx, root } = fakeCtx();
    const inst = animations().setup(ctx) as FeatureInstance;
    inst.teardown();
    expect(root.classList.contains("wt-animate")).toBe(false);
    expect(mm.listenerCount()).toBe(0);
  });
});
