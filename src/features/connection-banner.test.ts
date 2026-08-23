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

  it("renders an actionable persistent message for wire incompatibility", () => {
    const { ctx, emit, slot } = fakeCtx();
    connectionBanner().setup(ctx);
    emit("incompatible");
    const b = banner(slot);
    expect(b?.textContent).toBe(
      "Terminal protocol mismatch; update the server or reload this page",
    );
    expect(b?.dataset["state"]).toBe("incompatible");
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

// TEXT, the state -> message map, is a module-scope constant: it is built once
// when the module loads, so the assertions above run against a map that was
// already in place before the first test started and cannot tell a populated map
// from an empty one being consulted. Loading the module INSIDE the test is what
// puts the map's construction under the test's own observation.
describe("connectionBanner: the state -> message map is built at load", () => {
  async function loadFresh(): Promise<typeof connectionBanner> {
    vi.resetModules();
    const mod = await import("./connection-banner.js");
    return mod.connectionBanner;
  }

  it.each<[ConnState, string]>([
    ["connecting", "Reconnecting\u2026"],
    ["reconnecting", "Reconnecting\u2026"],
    ["offline", "Offline"],
    ["restarted", "Server restarted; recent input may be lost"],
    ["ended", "Session ended"],
    ["incompatible", "Terminal protocol mismatch; update the server or reload this page"],
  ])("a freshly loaded module renders %s as its own message", async (state, text) => {
    const fresh = await loadFresh();
    const { ctx, emit, slot, announce } = fakeCtx();
    fresh().setup(ctx);
    emit(state);
    const b = banner(slot);
    expect(b?.textContent).toBe(text);
    expect(b?.classList.contains("visible")).toBe(true);
    expect(announce).toHaveBeenCalledWith(text);
  });

  it("a freshly loaded module still hides the banner for 'open', which carries no message", async () => {
    const fresh = await loadFresh();
    const { ctx, emit, slot, announce } = fakeCtx();
    fresh().setup(ctx);
    emit("open");
    expect(banner(slot)?.classList.contains("visible")).toBe(false);
    expect(announce).not.toHaveBeenCalled();
  });
});

// The feature is a pure subscriber, so its teardown has exactly one job besides
// removing the element: give the subscription back. fakeCtx above returns a
// no-op unsubscribe, which cannot show that; this one models the kernel bus,
// whose returned function really does remove the handler.
describe("connectionBanner: teardown gives the subscription back", () => {
  function releasableCtx(): {
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
        return () => {
          handler = undefined;
        };
      },
    } as unknown as TerminalContext;
    return { ctx, emit: (s) => handler?.(s), announce, slot };
  }

  it("a connection state arriving after teardown announces nothing and paints nothing", () => {
    // The state machine outlives the feature (the kernel owns it), so a
    // reconnect during teardown is a real ordering. A retained subscription
    // would announce into the screen reader for a terminal that is gone, and
    // write text onto a detached banner.
    const { ctx, emit, announce, slot } = releasableCtx();
    const inst = connectionBanner().setup(ctx) as FeatureInstance;
    const b = banner(slot);
    if (!b) {
      throw new Error("the banner was not created");
    }
    inst.teardown();

    emit("offline");

    expect(announce).not.toHaveBeenCalled();
    expect(b.textContent).toBe("");
    expect(b.classList.contains("visible")).toBe(false);
  });
});
