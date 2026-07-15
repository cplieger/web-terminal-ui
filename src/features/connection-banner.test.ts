// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { connectionBanner } from "./connection-banner.js";
import type { ConnState, TerminalContext, FeatureInstance } from "../kernel/types.js";

function fakeCtx(): {
  ctx: TerminalContext;
  emit: (s: ConnState) => void;
  announce: ReturnType<typeof vi.fn>;
  slot: HTMLElement;
} {
  const slot = document.createElement("div");
  const announce = vi.fn();
  let handler: ((s: ConnState) => void) | undefined;
  const ctx = {
    region: () => slot,
    announce,
    on: (_e: string, fn: (s: ConnState) => void) => {
      handler = fn;
      return () => undefined;
    },
  } as unknown as TerminalContext;
  return {
    ctx,
    emit: (s) => handler?.(s),
    announce,
    slot,
  };
}

const banner = (slot: HTMLElement): HTMLElement | null =>
  slot.querySelector<HTMLElement>(".wt-conn-banner");

describe("connectionBanner feature", () => {
  it("shows the mapped text, data-state, and visible class for a known state", () => {
    const { ctx, emit, slot } = fakeCtx();
    connectionBanner().setup(ctx);
    emit("offline");
    const b = banner(slot);
    expect(b?.textContent).toBe("Offline");
    expect(b?.dataset["state"]).toBe("offline");
    expect(b?.classList.contains("visible")).toBe(true);
  });

  it("renders 'Session ended' for the ended state (process exit is not 'Reconnecting…')", () => {
    const { ctx, emit, slot } = fakeCtx();
    connectionBanner().setup(ctx);
    emit("ended");
    const b = banner(slot);
    expect(b?.textContent).toBe("Session ended");
    expect(b?.dataset["state"]).toBe("ended");
    expect(b?.classList.contains("visible")).toBe(true);
  });

  it("hides the banner and clears its text for a state with no mapped message", () => {
    const { ctx, emit, slot } = fakeCtx();
    connectionBanner().setup(ctx);
    emit("reconnecting");
    expect(banner(slot)?.classList.contains("visible")).toBe(true);
    emit("open");
    const b = banner(slot);
    expect(b?.classList.contains("visible")).toBe(false);
    expect(b?.textContent).toBe("");
  });

  it("announces once per real state change, not on a repeat of the same state", () => {
    const { ctx, emit, announce } = fakeCtx();
    connectionBanner().setup(ctx);
    emit("reconnecting");
    emit("reconnecting");
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Reconnecting\u2026");
    emit("offline");
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("teardown removes the banner from its slot", () => {
    const { ctx, slot } = fakeCtx();
    const inst = connectionBanner().setup(ctx) as FeatureInstance;
    expect(banner(slot)).not.toBeNull();
    inst.teardown();
    expect(banner(slot)).toBeNull();
  });
});
