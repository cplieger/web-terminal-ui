import { describe, it, expect, afterEach, vi } from "vitest";
import { clipboard } from "./clipboard.js";
import type { ClipboardApi } from "./clipboard.js";
import type { TerminalContext, FeatureInstance, Unsubscribe } from "../kernel/types.js";

/** Everything the fakes below mounted into the document, removed after each case
 *  so a later case cannot find an earlier one's surface or selection. */
const mounted: HTMLElement[] = [];
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const el of mounted.splice(0)) {
    el.remove();
  }
});

/** A connected element, so a real selection can be placed inside or outside it. */
function connected(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

/** Select `text` as the whole content of `el`, the way a drag across it would. */
function selectInside(el: HTMLElement, text: string): void {
  el.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function fakeCtx(): {
  ctx: TerminalContext;
  surface: HTMLElement;
  keydown: (ev: KeyboardEvent) => boolean;
  emit: (topic: string, payload: unknown) => void;
  drainScope: () => void;
  toast: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
} {
  let keydownFn: ((ev: KeyboardEvent) => boolean) | undefined;
  const toast = vi.fn();
  const paste = vi.fn();
  const surfaceEl = connected();
  // The feature's cleanup scope, as the terminal keeps it: every release taken
  // through ctx lands here beside what the feature hands to ctx.defer, and the
  // terminal drains it after the instance's teardown.
  const scope: Unsubscribe[] = [];
  // The kernel bus, captured: the feature's only inbound-OSC-52 seam is the
  // handler it hands ctx.on, so a test that never delivers on that topic cannot
  // see the mirror path at all.
  const handlers = new Map<string, (payload: never) => void>();
  const ctx = {
    registerKeydown: (fn: (ev: KeyboardEvent) => boolean): Unsubscribe => {
      keydownFn = fn;
      const off = (): void => {
        keydownFn = undefined;
      };
      scope.push(off);
      return off;
    },
    on: (topic: string, fn: (payload: never) => void): Unsubscribe => {
      handlers.set(topic, fn);
      const off = (): void => {
        handlers.delete(topic);
      };
      scope.push(off);
      return off;
    },
    defer: (release: () => void) => {
      scope.push(release);
    },
    surface: () => surfaceEl,
    toast,
    paste,
  } as unknown as TerminalContext;
  return {
    ctx,
    surface: surfaceEl,
    keydown: (ev) => keydownFn?.(ev) ?? false,
    emit: (topic, payload) => {
      handlers.get(topic)?.(payload as never);
    },
    drainScope: () => {
      while (scope.length > 0) {
        scope.pop()?.();
      }
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

function setup(): ReturnType<typeof fakeCtx> & {
  api: ClipboardApi;
  inst: FeatureInstance<ClipboardApi>;
} {
  const f = fakeCtx();
  const inst = clipboard().setup(f.ctx) as FeatureInstance<ClipboardApi>;
  return { ...f, api: inst.api as ClipboardApi, inst };
}

describe("clipboard: desktop keyboard shortcuts", () => {
  it("plain Ctrl+V is consumed WITHOUT preventDefault, so the browser's native paste still fires", () => {
    const { keydown } = setup();
    const ev = keyEvent({ code: "KeyV", ctrl: true });
    expect(keydown(ev)).toBe(true);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+C copies the current selection and preventDefaults", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { keydown, surface } = setup();
    selectInside(surface, "hello");
    const ev = keyEvent({ code: "KeyC", ctrl: true, shift: true });
    expect(keydown(ev)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("Ctrl+Shift+C with an empty selection preventDefaults but writes nothing", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { keydown } = setup();
    window.getSelection()?.removeAllRanges();
    const ev = keyEvent({ code: "KeyC", ctrl: true, shift: true });
    expect(keydown(ev)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+C with a selection in the host page, outside this pane, copies nothing", () => {
    // Two panes share one document selection: a copy chord in pane A must not
    // lift the text selected in pane B, or in the host page around them.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { keydown } = setup();
    selectInside(connected(), "elsewhere");
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
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { keydown, surface } = setup();
    selectInside(surface, "hello");
    return { keydown, writeText };
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
  it("toasts 'Copied' when the copied selection lies inside the terminal surface", () => {
    const { surface, toast } = setup();
    selectInside(surface, "hello");
    document.dispatchEvent(new Event("copy"));
    expect(toast).toHaveBeenCalledWith("Copied");
  });

  it("does NOT toast when the copied selection lies outside the terminal surface", () => {
    const { toast } = setup();
    selectInside(connected(), "elsewhere");
    document.dispatchEvent(new Event("copy"));
    expect(toast).not.toHaveBeenCalled();
  });

  it("does NOT toast when a range starts in the surface and ends in the host page", () => {
    // A drag that leaves the terminal takes host content with it; the toast
    // answers for the terminal's text only.
    const { surface, toast } = setup();
    surface.textContent = "inside";
    const outside = connected();
    outside.textContent = "outside";
    const range = document.createRange();
    range.setStart(surface.firstChild ?? surface, 0);
    range.setEnd(outside.firstChild ?? outside, 3);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("copy"));
    expect(toast).not.toHaveBeenCalled();
  });

  it("does NOT toast on a copy event with no selection", () => {
    const { toast } = setup();
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("copy"));
    expect(toast).not.toHaveBeenCalled();
  });

  it("stops toasting once the scope has drained: the document listener is released", () => {
    // The listener is handed to ctx.defer at the acquisition, so a setup that
    // throws after it releases it too; the terminal drains the scope after
    // teardown, which is what this drains by hand.
    const { surface, toast, inst, drainScope } = setup();
    selectInside(surface, "hello");
    inst.teardown();
    drainScope();
    document.dispatchEvent(new Event("copy"));
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("clipboard: the terminal releases both kernel seams after teardown", () => {
  // Both registrations are taken through ctx, so the feature retains neither
  // release: the terminal drains its scope after teardown, and a feature that
  // released them itself would release them twice.
  it("keeps the keydown registration through teardown and loses it at the drain, so Ctrl+Shift+V then reads nothing", () => {
    const readText = vi.fn().mockResolvedValue("x");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { keydown, inst, drainScope } = setup();
    expect(keydown(keyEvent({ code: "KeyV", ctrl: true, shift: true }))).toBe(true);

    inst.teardown();
    expect(keydown(keyEvent({ code: "KeyV", ctrl: true, shift: true }))).toBe(true);
    drainScope();

    expect(keydown(keyEvent({ code: "KeyV", ctrl: true, shift: true }))).toBe(false);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("keeps the wire:clipboard subscription through teardown and loses it at the drain, so a late OSC 52 mirrors nothing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { emit, toast, inst, drainScope } = setup();
    emit("wire:clipboard", "from the app");
    expect(writeText).toHaveBeenCalledWith("from the app");

    inst.teardown();
    emit("wire:clipboard", "still subscribed");
    expect(writeText).toHaveBeenCalledTimes(2);
    drainScope();
    emit("wire:clipboard", "after the drain");
    await new Promise((r) => setTimeout(r, 0));

    expect(writeText).toHaveBeenCalledTimes(2);
    // Two "Copied" toasts for the two mirrors and none for the third: a mirror
    // after the drain would surface one over a terminal the host has taken down.
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith("Copied");
  });
});
