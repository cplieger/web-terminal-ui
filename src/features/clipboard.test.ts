// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { clipboard } from "./clipboard.js";
import type { ClipboardApi } from "./clipboard.js";
import type { TerminalContext, FeatureInstance, Unsubscribe } from "../kernel/types.js";

function fakeCtx(): {
  ctx: TerminalContext;
  keydown: (ev: KeyboardEvent) => boolean;
  emit: (topic: string, payload: unknown) => void;
  toast: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
} {
  let keydownFn: ((ev: KeyboardEvent) => boolean) | undefined;
  const toast = vi.fn();
  const paste = vi.fn();
  const surfaceEl = document.createElement("div");
  // The kernel bus, captured: the feature's only inbound-OSC-52 seam is the
  // handler it hands ctx.on, so a test that never delivers on that topic cannot
  // see the mirror path at all.
  const handlers = new Map<string, (payload: never) => void>();
  const ctx = {
    registerKeydown: (fn: (ev: KeyboardEvent) => boolean): Unsubscribe => {
      keydownFn = fn;
      return () => undefined;
    },
    on: (topic: string, fn: (payload: never) => void): Unsubscribe => {
      handlers.set(topic, fn);
      return () => handlers.delete(topic);
    },
    surface: () => surfaceEl,
    toast,
    paste,
  } as unknown as TerminalContext;
  return {
    ctx,
    keydown: (ev) => keydownFn?.(ev) ?? false,
    emit: (topic, payload) => {
      handlers.get(topic)?.(payload as never);
    },
    toast,
    paste,
  };
}

function keyEvent(o: {
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}): KeyboardEvent {
  return {
    code: o.code,
    ctrlKey: o.ctrl ?? false,
    shiftKey: o.shift ?? false,
    altKey: o.alt ?? false,
    metaKey: o.meta ?? false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

function setup(): {
  api: ClipboardApi;
  keydown: (ev: KeyboardEvent) => boolean;
  emit: (topic: string, payload: unknown) => void;
  toast: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
} {
  const f = fakeCtx();
  const inst = clipboard().setup(f.ctx) as FeatureInstance<ClipboardApi>;
  return {
    api: inst.api as ClipboardApi,
    keydown: f.keydown,
    emit: f.emit,
    toast: f.toast,
    paste: f.paste,
  };
}

describe("clipboard: desktop keyboard shortcuts", () => {
  it("plain Ctrl+V is consumed WITHOUT preventDefault, so the browser's native paste still fires", () => {
    const { keydown } = setup();
    const ev = keyEvent({ code: "KeyV", ctrl: true });
    expect(keydown(ev)).toBe(true);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+C copies the current selection and preventDefaults", () => {
    vi.stubGlobal("getSelection", () => ({ toString: () => "hello" }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { keydown } = setup();
    const ev = keyEvent({ code: "KeyC", ctrl: true, shift: true });
    expect(keydown(ev)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("Ctrl+Shift+C with an empty selection preventDefaults but writes nothing", () => {
    vi.stubGlobal("getSelection", () => ({ toString: () => "" }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { keydown } = setup();
    const ev = keyEvent({ code: "KeyC", ctrl: true, shift: true });
    expect(keydown(ev)).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+V reads the clipboard and pastes through the sanitizing funnel", async () => {
    const readText = vi.fn().mockResolvedValue("pasted-text");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { keydown, paste } = setup();
    const ev = keyEvent({ code: "KeyV", ctrl: true, shift: true });
    expect(keydown(ev)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(paste).toHaveBeenCalledWith("pasted-text");
    });
  });

  it("an unrelated keystroke is not consumed", () => {
    const { keydown } = setup();
    expect(keydown(keyEvent({ code: "KeyA" }))).toBe(false);
  });

  it("plain Ctrl+A is not consumed: the native-paste bail is for KeyV only", () => {
    const { keydown } = setup();
    const ev = keyEvent({ code: "KeyA", ctrl: true });
    expect(keydown(ev)).toBe(false);
  });
});

describe("clipboard: the copy shortcut requires exactly Ctrl+Shift", () => {
  function armed(): {
    keydown: (ev: KeyboardEvent) => boolean;
    writeText: ReturnType<typeof vi.fn>;
  } {
    vi.stubGlobal("getSelection", () => ({ toString: () => "hello" }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    return { keydown: setup().keydown, writeText };
  }

  it("Ctrl+C without Shift is left to the kernel's key mapping", () => {
    const { keydown, writeText } = armed();
    expect(keydown(keyEvent({ code: "KeyC", ctrl: true }))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Shift+C without Ctrl types a capital C and copies nothing", () => {
    const { keydown, writeText } = armed();
    expect(keydown(keyEvent({ code: "KeyC", shift: true }))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("an unmodified C copies nothing", () => {
    const { keydown, writeText } = armed();
    expect(keydown(keyEvent({ code: "KeyC" }))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+Alt+C is a different chord and copies nothing", () => {
    const { keydown, writeText } = armed();
    expect(keydown(keyEvent({ code: "KeyC", ctrl: true, shift: true, alt: true }))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+Cmd+C is a different chord and copies nothing", () => {
    const { keydown, writeText } = armed();
    expect(keydown(keyEvent({ code: "KeyC", ctrl: true, shift: true, meta: true }))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift with any other key falls through: no copy, no paste", () => {
    const readText = vi.fn().mockResolvedValue("x");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { keydown } = setup();
    expect(keydown(keyEvent({ code: "KeyX", ctrl: true, shift: true }))).toBe(false);
    expect(readText).not.toHaveBeenCalled();
  });
});

describe("clipboard: each clipboard outcome surfaces its own toast", () => {
  it("a successful copy toasts 'Copied'", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { api, toast } = setup();
    api.copy("text");
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledWith("Copied");
    });
  });

  it("a rejected write toasts 'Copy failed'", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { api, toast } = setup();
    api.copy("text");
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledWith("Copy failed");
    });
  });

  it("a rejected read toasts 'Paste blocked' and pastes nothing", async () => {
    const readText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { api, toast, paste } = setup();
    api.paste();
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledWith("Paste blocked");
    });
    expect(paste).not.toHaveBeenCalled();
  });
});

describe("clipboard: inbound OSC 52 mirrors to the system clipboard", () => {
  it("a wire:clipboard payload is written to the system clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { emit } = setup();
    emit("wire:clipboard", "from-the-app");
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("from-the-app");
    });
  });
});

describe("clipboard: feature-detection when navigator.clipboard is absent", () => {
  it("copy() toasts 'Clipboard unavailable' rather than throwing", () => {
    vi.stubGlobal("navigator", { clipboard: undefined });
    const { api, toast } = setup();
    api.copy("x");
    expect(toast).toHaveBeenCalledWith("Clipboard unavailable");
  });

  it("paste() toasts 'Clipboard unavailable' rather than throwing", () => {
    vi.stubGlobal("navigator", { clipboard: undefined });
    const { api, toast } = setup();
    api.paste();
    expect(toast).toHaveBeenCalledWith("Clipboard unavailable");
  });
});

describe("clipboard: native-copy feedback toast is scoped to the terminal surface", () => {
  function setupWithSurface(): {
    surface: HTMLElement;
    toast: ReturnType<typeof vi.fn>;
    inst: FeatureInstance<ClipboardApi>;
  } {
    const surface = document.createElement("div");
    document.body.appendChild(surface);
    const toast = vi.fn();
    const ctx = {
      registerKeydown: () => () => undefined,
      on: () => () => undefined,
      surface: () => surface,
      toast,
      paste: vi.fn(),
    } as unknown as TerminalContext;
    const inst = clipboard().setup(ctx) as FeatureInstance<ClipboardApi>;
    return { surface, toast, inst };
  }

  it("toasts 'Copied' when the copied selection's anchor is inside the terminal surface", () => {
    const { surface, toast, inst } = setupWithSurface();
    const inside = document.createElement("span");
    surface.appendChild(inside);
    vi.stubGlobal("getSelection", () => ({ anchorNode: inside }));
    document.dispatchEvent(new Event("copy"));
    expect(toast).toHaveBeenCalledWith("Copied");
    inst.teardown();
  });

  it("does NOT toast when the copied selection anchor is outside the terminal surface", () => {
    const { toast, inst } = setupWithSurface();
    const outside = document.createElement("span");
    document.body.appendChild(outside);
    vi.stubGlobal("getSelection", () => ({ anchorNode: outside }));
    document.dispatchEvent(new Event("copy"));
    expect(toast).not.toHaveBeenCalled();
    inst.teardown();
  });

  it("does NOT toast on a copy event with no selection anchor", () => {
    const { toast, inst } = setupWithSurface();
    vi.stubGlobal("getSelection", () => ({ anchorNode: null }));
    document.dispatchEvent(new Event("copy"));
    expect(toast).not.toHaveBeenCalled();
    inst.teardown();
  });

  it("stops toasting once torn down: the document listener is released", () => {
    const { surface, toast, inst } = setupWithSurface();
    const inside = document.createElement("span");
    surface.appendChild(inside);
    vi.stubGlobal("getSelection", () => ({ anchorNode: inside }));
    inst.teardown();
    document.dispatchEvent(new Event("copy"));
    expect(toast).not.toHaveBeenCalled();
  });
});
