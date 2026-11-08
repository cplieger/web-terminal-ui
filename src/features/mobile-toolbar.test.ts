import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { POWER_ON_MODES, createModeState } from "@cplieger/web-terminal-engine";
import type {
  AcceptedInput,
  FeatureInstance,
  KeyEncoder,
  KeyModes,
  ModeReaders,
  TerminalContext,
} from "../kernel/types.js";
import { mobileToolbar, type MobileToolbarApi } from "./mobile-toolbar.js";

// Hoisted because the mock factory below runs before this module's own
// statements, and the feature is imported as a value.
const { state, isCtrlArmed, applyStickyCtrl, setCtrlArmed, dispose, bindMobileToolbar } =
  vi.hoisted(() => {
    const state: {
      armed: boolean;
      onCtrlChange: ((a: boolean) => void) | undefined;
      sendFromToolbar: ((encode: (modes: KeyModes) => string) => void) | undefined;
    } = { armed: false, onCtrlChange: undefined, sendFromToolbar: undefined };
    const isCtrlArmed = vi.fn(() => state.armed);
    const applyStickyCtrl = vi.fn((_text: string): ((modes: KeyModes) => string) | null => null);
    const setCtrlArmed = vi.fn((v: boolean) => {
      state.armed = v;
    });
    const dispose = vi.fn();
    const bindMobileToolbar = vi.fn(
      (o: {
        onCtrlChange: (a: boolean) => void;
        send: (encode: (modes: KeyModes) => string) => void;
      }) => {
        state.onCtrlChange = o.onCtrlChange;
        state.sendFromToolbar = o.send;
        return { isCtrlArmed, applyStickyCtrl, setCtrlArmed, dispose };
      },
    );
    return { state, isCtrlArmed, applyStickyCtrl, setCtrlArmed, dispose, bindMobileToolbar };
  });

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return { ...actual, toolbar: { ...actual.toolbar, bindMobileToolbar } };
});

function fakeCtx(): {
  ctx: TerminalContext;
  slot: HTMLElement;
  modes: ModeReaders;
  transform: (input: AcceptedInput) => AcceptedInput | null;
  send: ReturnType<typeof vi.fn>;
  /** What the terminal does on destroy: the instance's `teardown()`, then every
   *  release the feature handed to `ctx.defer`, newest first. */
  destroy(inst: FeatureInstance<MobileToolbarApi>): void;
} {
  const slot = document.createElement("div");
  let transformFn: ((input: AcceptedInput) => AcceptedInput | null) | undefined;
  const send = vi.fn();
  const scope: (() => void)[] = [];
  const modes: ModeReaders = createModeState(POWER_ON_MODES);
  const ctx = {
    region: () => slot,
    shell: { root: slot },
    send,
    modes,
    registerInputTransform: (fn: (input: AcceptedInput) => AcceptedInput | null) => {
      transformFn = fn;
      return () => undefined;
    },
    defer: (release: () => void) => {
      scope.push(release);
    },
  } as unknown as TerminalContext;
  return {
    ctx,
    slot,
    modes,
    transform: (input) => (transformFn === undefined ? input : transformFn(input)),
    send,
    destroy(inst) {
      inst.teardown();
      while (scope.length > 0) {
        scope.pop()?.();
      }
    },
  };
}

beforeEach(() => {
  state.armed = false;
  isCtrlArmed.mockClear();
  applyStickyCtrl.mockClear();
  applyStickyCtrl.mockImplementation(() => null);
  setCtrlArmed.mockClear();
  dispose.mockClear();
  bindMobileToolbar.mockClear();
  state.onCtrlChange = undefined;
  state.sendFromToolbar = undefined;
});

const LEGACY: KeyModes = {
  isApplicationCursor: () => false,
  isApplicationKeypad: () => false,
  getKeyboardFlags: () => 0,
};
const KITTY: KeyModes = { ...LEGACY, getKeyboardFlags: () => 1 };

describe("mobileToolbar: the sticky-Ctrl input transform", () => {
  it("leaves input alone when Ctrl is not armed", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    const input: AcceptedInput = { kind: "text", text: "a" };
    expect(f.transform(input)).toBe(input);
    expect(applyStickyCtrl).not.toHaveBeenCalled();
  });

  it("turns a typed character into its Ctrl chord, encoded under the modes it is sent with", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    state.armed = true;
    applyStickyCtrl.mockImplementation(
      () => (modes) => (modes.getKeyboardFlags() === 0 ? "\x03" : "\x1b[99;5u"),
    );

    const out = f.transform({ kind: "text", text: "c" });

    expect(applyStickyCtrl).toHaveBeenCalledWith("c");
    const dec = new TextDecoder();
    const encode = out?.kind === "key" ? out.encode : null;
    expect(encode === null ? null : dec.decode(encode(LEGACY))).toBe("\x03");
    expect(encode === null ? null : dec.decode(encode(KITTY))).toBe("\x1b[99;5u");
  });

  it("leaves typed text alone when the chord does not apply", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    state.armed = true;
    const input: AcceptedInput = { kind: "text", text: "hello" };
    expect(f.transform(input)).toBe(input);
  });

  it("disarms on a paste or a key and leaves them alone", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    const inputs: AcceptedInput[] = [
      { kind: "paste", text: "ab" },
      { kind: "key", encode: () => new Uint8Array([0x0d]) },
    ];
    for (const input of inputs) {
      state.armed = true;
      expect(f.transform(input)).toBe(input);
      expect(state.armed).toBe(false);
    }
    expect(applyStickyCtrl).not.toHaveBeenCalled();
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
    state.onCtrlChange?.(true);
    state.onCtrlChange?.(false);
    off();
    state.onCtrlChange?.(true);
    expect(seen).toEqual([true, false]);
  });

  it("onDetach disarms a latched sticky-Ctrl so it cannot fire against the next session", async () => {
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    state.armed = true;
    inst.onDetach?.();
    expect(setCtrlArmed).toHaveBeenCalledWith(false);
  });

  it("onDetach does nothing when Ctrl is not armed", async () => {
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    state.armed = false;
    inst.onDetach?.();
    expect(setCtrlArmed).not.toHaveBeenCalled();
  });

  it("externalToggle adds the wt-toolbar-external class", async () => {
    const f = fakeCtx();
    await mobileToolbar({ externalToggle: true }).setup(f.ctx);
    expect(f.slot.querySelector(".wt-toolbar-external")).not.toBeNull();
  });

  it("keeps its own toggle when no peer drives it (presetTouch)", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    // Without the class the CSS keeps the top-right kb-toggle visible and the
    // grid anchored to the viewport rather than above a tab bar.
    expect(f.slot.querySelector(".wt-toolbar-external")).toBeNull();
    expect(f.slot.querySelector(".key-toolbar")).not.toBeNull();
  });

  it("routes a toolbar press through the kernel funnel, encoded under the modes it sends with", async () => {
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    let encoded = 0;
    state.sendFromToolbar?.((modes) => {
      encoded++;
      return modes.isApplicationCursor() ? "\x1bOA" : "\x1b[A";
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(encoded).toBe(0);
    const input = f.send.mock.calls[0]?.[0] as KeyEncoder;
    const dec = new TextDecoder();
    expect(dec.decode(input(LEGACY))).toBe("\x1b[A");
    expect(dec.decode(input({ ...LEGACY, isApplicationCursor: () => true }))).toBe("\x1bOA");
  });

  it("enables the slide transition only after two frames, so the first paint does not flash", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const f = fakeCtx();
    await mobileToolbar().setup(f.ctx);
    const bar = f.slot.querySelector(".key-toolbar");
    expect(bar?.classList.contains("no-transition")).toBe(true);
    frames.shift()?.(0);
    expect(bar?.classList.contains("no-transition")).toBe(true);
    frames.shift()?.(0);
    expect(bar?.classList.contains("no-transition")).toBe(false);
  });

  it("teardown removes the toolbar, and the engine binding is released by the cleanup scope", async () => {
    // The binding's release lives in the scope rather than in teardown() so a
    // setup that throws after taking it still gives it back.
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    expect(f.slot.querySelector(".key-toolbar")).not.toBeNull();
    inst.teardown();
    expect(f.slot.querySelector(".key-toolbar")).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
    f.destroy(inst);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending first frame when destroyed before it, so nothing runs against the removed toolbar", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(next, cb);
      return next++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    const bar = f.slot.querySelector(".key-toolbar");
    expect(frames.size).toBe(1);
    f.destroy(inst);
    expect(frames.size).toBe(0);
    expect(bar?.classList.contains("no-transition")).toBe(true);
  });

  it("cancels the pending second frame when destroyed between the two", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(next, cb);
      return next++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    const bar = f.slot.querySelector(".key-toolbar");
    const first = frames.get(1);
    frames.delete(1);
    first?.(0);
    expect(frames.size).toBe(1);
    f.destroy(inst);
    expect(frames.size).toBe(0);
    expect(bar?.classList.contains("no-transition")).toBe(true);
  });

  it("waits for the shell root's own window to paint, not the importing one", async () => {
    // A same-origin iframe is a second document with a window of its own; the two
    // settling frames come from the window whose paint they are waiting for. The
    // importing window's frames are stubbed to never run, so only the frame's own
    // can settle the toolbar.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc) {
      throw new Error("no frame document");
    }
    try {
      const f = fakeCtx();
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      (f.ctx as unknown as { shell: { root: HTMLElement } }).shell = { root };
      await mobileToolbar().setup(f.ctx);
      const bar = f.slot.querySelector(".key-toolbar");
      expect(bar?.classList.contains("no-transition")).toBe(true);

      await vi.waitFor(() => {
        expect(bar?.classList.contains("no-transition")).toBe(false);
      });
    } finally {
      frame.remove();
    }
  });
});

describe("mobileToolbar: teardown releases the arm/disarm subscribers", () => {
  it("a late arm from the engine reaches nobody once the toolbar is torn down", async () => {
    // The subscriber here is the tab bar's keyboard button, which mirrors a
    // pending Ctrl. It is the PEER's lifetime, not this feature's, so nothing
    // guarantees it unsubscribed first — and ctrl.dispose() is the engine's
    // binding, not a promise that no further arm/disarm arrives (the engine's
    // own listeners can outlive a dispose by one dispatch). So the set is
    // dropped, and a fan-out after teardown paints nothing on a chrome the
    // composition has already taken down.
    const f = fakeCtx();
    const inst = (await mobileToolbar().setup(f.ctx)) as FeatureInstance<MobileToolbarApi>;
    const api = inst.api as MobileToolbarApi;
    const seen: boolean[] = [];
    api.onCtrlArmedChange((a) => seen.push(a));
    state.onCtrlChange?.(true);
    expect(seen).toEqual([true]);

    inst.teardown();
    state.onCtrlChange?.(false);
    state.onCtrlChange?.(true);

    expect(seen).toEqual([true]);
  });
});
