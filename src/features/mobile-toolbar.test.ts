// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { TerminalContext, FeatureInstance } from "../kernel/types.js";
import type { mobileToolbar as MobileToolbarFn, MobileToolbarApi } from "./mobile-toolbar.js";

let armed = false;
const isCtrlArmed = vi.fn(() => armed);
const applyStickyCtrl = vi.fn((t: string) => t);
const setCtrlArmed = vi.fn((v: boolean) => {
  armed = v;
});
const dispose = vi.fn();
let onCtrlChange: ((a: boolean) => void) | undefined;
const bindMobileToolbar = vi.fn((o: { onCtrlChange: (a: boolean) => void }) => {
  onCtrlChange = o.onCtrlChange;
  return { isCtrlArmed, applyStickyCtrl, setCtrlArmed, dispose };
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return { ...actual, toolbar: { ...actual.toolbar, bindMobileToolbar } };
});

function fakeCtx(): {
  ctx: TerminalContext;
  slot: HTMLElement;
  transform: (b: Uint8Array) => Uint8Array;
  offTransform: ReturnType<typeof vi.fn>;
} {
  const slot = document.createElement("div");
  let transformFn: ((b: Uint8Array) => Uint8Array) | undefined;
  const offTransform = vi.fn();
  const ctx = {
    region: () => slot,
    send: vi.fn(),
    registerInputTransform: (fn: (b: Uint8Array) => Uint8Array) => {
      transformFn = fn;
      return offTransform;
    },
  } as unknown as TerminalContext;
  return { ctx, slot, transform: (b) => transformFn?.(b) ?? b, offTransform };
}

let mobileToolbar: typeof MobileToolbarFn;

beforeEach(async () => {
  armed = false;
  isCtrlArmed.mockClear();
  applyStickyCtrl.mockClear();
  applyStickyCtrl.mockImplementation((t: string) => t);
  setCtrlArmed.mockClear();
  dispose.mockClear();
  bindMobileToolbar.mockClear();
  onCtrlChange = undefined;
  vi.resetModules();
  ({ mobileToolbar } = await import("./mobile-toolbar.js"));
});

describe("mobileToolbar: sticky-Ctrl outbound transform", () => {
  it("passes bytes through unchanged when Ctrl is not armed", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    armed = false;
    const input = new Uint8Array([0x61]);
    expect(f.transform(input)).toBe(input);
    expect(applyStickyCtrl).not.toHaveBeenCalled();
  });

  it("rewrites a typed char to its Ctrl byte when armed and the mapping changes it", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    armed = true;
    applyStickyCtrl.mockImplementation(() => "\u0003"); // Ctrl+C
    const out = f.transform(new Uint8Array([0x63])); // 'c'
    expect(Array.from(out)).toEqual([0x03]);
  });

  it("returns the original bytes (no re-encode) when the mapping is a no-op", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    armed = true;
    applyStickyCtrl.mockImplementation((t: string) => t);
    const input = new Uint8Array([0x63]);
    expect(f.transform(input)).toBe(input);
  });
});

describe("mobileToolbar: API + lifecycle", () => {
  it("toggle() flips the key grid open/closed and isOpen() reflects it", async () => {
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    const api = inst.api as MobileToolbarApi;
    expect(api.isOpen()).toBe(false);
    api.toggle();
    expect(api.isOpen()).toBe(true);
    api.toggle();
    expect(api.isOpen()).toBe(false);
  });

  it("onCtrlArmedChange subscribers receive the engine's arm/disarm fan-out", async () => {
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    const api = inst.api as MobileToolbarApi;
    const seen: boolean[] = [];
    const off = api.onCtrlArmedChange((a) => seen.push(a));
    onCtrlChange?.(true);
    onCtrlChange?.(false);
    off();
    onCtrlChange?.(true);
    expect(seen).toEqual([true, false]);
  });

  it("onDetach disarms a latched sticky-Ctrl so it cannot fire against the next session", async () => {
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    armed = true;
    inst.onDetach?.();
    expect(setCtrlArmed).toHaveBeenCalledWith(false);
  });

  it("onDetach does nothing when Ctrl is not armed", async () => {
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    armed = false;
    inst.onDetach?.();
    expect(setCtrlArmed).not.toHaveBeenCalled();
  });

  it("externalToggle adds the wt-toolbar-external class", async () => {
    const f = fakeCtx();
    await mobileToolbar({ externalToggle: true }).setup(f.ctx);
    expect(f.slot.querySelector(".wt-toolbar-external")).not.toBeNull();
  });

  it("teardown disposes the engine binding, drops the transform, and removes the toolbar", async () => {
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    expect(f.slot.querySelector(".key-toolbar")).not.toBeNull();
    inst.teardown();
    expect(f.offTransform).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.slot.querySelector(".key-toolbar")).toBeNull();
  });
});
