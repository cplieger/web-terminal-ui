// @vitest-environment happy-dom
//
// Kernel lifecycle rules that the contract suites next door state in passing but
// never pin: what a released runtime must STOP doing, what a teardown owes the
// primitives it built, and which startup steps are ordered against destroy().
//
// The kernel is the module every feature composes against, so these are the
// rules a feature is entitled to assume. Each `it` below names one and drives
// the real module to it; the engine is doubled exactly as the sibling suites
// double it, because the assertions are about the kernel's own wiring.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as KernelModule from "./kernel.js";
import { INPUT_PLACEHOLDER } from "../input-placeholder.js";
import type { SessionRef, TerminalContext, TerminalFeature, TerminalHandle } from "./types.js";

const hoisted = vi.hoisted(() => ({
  sendBinary: vi.fn<(buf: Uint8Array) => boolean>(() => true),
  connectionInit: vi.fn(),
  renderInit: vi.fn(),
  getCursorPx: vi.fn(() => ({ left: 0, top: 0, cellH: 16 })),
  connect: vi.fn(),
  setSession: vi.fn<(id: string) => void>(),
  disconnect: vi.fn(),
  reconnectNow: vi.fn(),
  resetScrollback: vi.fn(),
  resetScreen: vi.fn(),
  updateFontMetrics: vi.fn(),
  dropBrowseCache: vi.fn(),
  browseCacheSize: vi.fn<() => number>(() => 0),
  lastBrowseActivityMs: vi.fn<() => number>(() => 0),
  boundStore: vi.fn<() => Engine.LineStore | undefined>(() => undefined),
  currentSessionId: vi.fn<() => string>(() => "session-under-test"),
}));

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    render: {
      init: hoisted.renderInit,
      updateFontMetrics: hoisted.updateFontMetrics,
      setPredictedCursor: vi.fn(),
      computeSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getCursorPx: hoisted.getCursorPx,
      getHighestIndex: vi.fn(() => -1),
      pendingRowCount: vi.fn(() => 0),
      noteResumeBounds: vi.fn(),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      updateReverseVideo: vi.fn(),
      resetScrollback: hoisted.resetScrollback,
      resetScreen: hoisted.resetScreen,
      browseCacheSize: hoisted.browseCacheSize,
      lastBrowseActivityMs: hoisted.lastBrowseActivityMs,
      dropBrowseCache: hoisted.dropBrowseCache,
      maybeFetchHistory: vi.fn(),
      handleScrollPosition: vi.fn(),
      replayMaxForResume: vi.fn(() => 1500),
      handleHistoryReply: vi.fn(),
      applyResumeTransition: vi.fn(),
      noteSolicited: vi.fn(),
      clearSolicited: vi.fn(),
      bind: vi.fn(),
      boundStore: hoisted.boundStore,
    },
    scroll: {
      init: vi.fn(),
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      restoreScrollTop: vi.fn(),
      restoreView: vi.fn(),
      // The viewport settle re-pins the bottom through this, so a double without
      // it throws out of every geometry transition.
      stickToBottom: vi.fn(),
    },
    connection: {
      init: hoisted.connectionInit,
      connect: hoisted.connect,
      sendBinary: hoisted.sendBinary,
      sendResize: vi.fn(),
      reconnectNow: hoisted.reconnectNow,
      disconnect: hoisted.disconnect,
      setSession: hoisted.setSession,
      forgetSession: vi.fn(),
      currentSessionId: hoisted.currentSessionId,
    },
  };
});

const {
  sendBinary,
  connect,
  renderInit,
  getCursorPx,
  browseCacheSize,
  setSession,
  disconnect,
  resetScrollback,
  resetScreen,
  dropBrowseCache,
} = hoisted;

let createTerminal: (typeof KernelModule)["createTerminal"];
const dec = new TextDecoder();
const sentText = (): string => sendBinary.mock.calls.map((c) => dec.decode(c[0])).join("");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  for (const fn of Object.values(hoisted)) {
    fn.mockClear();
  }
  hoisted.sendBinary.mockReturnValue(true);
  hoisted.getCursorPx.mockReturnValue({ left: 0, top: 0, cellH: 16 });
  hoisted.browseCacheSize.mockReturnValue(0);
  hoisted.lastBrowseActivityMs.mockReturnValue(0);
  hoisted.boundStore.mockReturnValue(undefined);
  hoisted.currentSessionId.mockReturnValue("session-under-test");
  document.body.replaceChildren();
  ({ createTerminal } = await import("./kernel.js"));
});

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

const ta = (root: HTMLElement): HTMLTextAreaElement =>
  root.querySelector(".term-input") as HTMLTextAreaElement;
const term = (root: HTMLElement): HTMLElement => root.querySelector(".term") as HTMLElement;

/** A feature that hands its ctx back, so a test can drive the kernel from the
 *  inside the way a real feature does. */
function probeFeature(onCtx: (ctx: TerminalContext) => void): TerminalFeature<void> {
  return {
    name: "probe",
    setup(ctx) {
      onCtx(ctx);
      return { teardown: () => undefined };
    },
  };
}

/** Appends text to the output and selects part of it, both endpoints inside —
 *  the state the document-level type-to-focus listener arms on. */
function selectInOutput(root: HTMLElement): Selection {
  const output = root.querySelector(".term-output");
  if (!output) {
    throw new Error("no .term-output");
  }
  const text = document.createTextNode("line 1 the quick brown fox");
  output.appendChild(text);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 7);
  const sel = window.getSelection();
  if (!sel) {
    throw new Error("no selection");
  }
  sel.removeAllRanges();
  sel.addRange(range);
  expect(sel.isCollapsed).toBe(false);
  return sel;
}

function keyOnDocument(key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "getModifierState", { value: (): boolean => false });
  document.body.dispatchEvent(ev);
  return ev;
}

describe("a released runtime answers no event it registered for", () => {
  // Every listener below is registered with the kernel's AbortSignal, and that
  // signal is the ONLY thing that stops them: the elements survive destroy() in
  // whatever reference a handler, a feature or a test still holds, so a listener
  // the abort misses keeps serving a terminal that no longer exists.

  it("does not put a keystroke typed into the released textarea on the wire", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    const input = ta(root);
    handle.destroy();
    sendBinary.mockClear();

    input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "rm -rf /" }));

    expect(sentText()).toBe("");
  });

  it("does not encode a key pressed in the released textarea", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    const input = ta(root);
    handle.destroy();
    sendBinary.mockClear();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));

    expect(sentText()).toBe("");
  });

  it("does not repaint the focus class on the released surface", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    const input = ta(root);
    const wrap = term(root);
    handle.destroy();
    wrap.classList.remove("focus");

    input.dispatchEvent(new FocusEvent("focus"));
    expect(wrap.classList.contains("focus")).toBe(false);

    wrap.classList.add("focus");
    input.dispatchEvent(new FocusEvent("blur"));
    expect(wrap.classList.contains("focus")).toBe(true);
  });

  it("does not clear a selection on a tap into the released surface", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    const wrap = term(root);
    const sel = selectInOutput(root);
    handle.destroy();

    wrap.dispatchEvent(
      new PointerEvent("pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 }),
    );
    wrap.dispatchEvent(
      new PointerEvent("pointerup", { pointerType: "touch", clientX: 5, clientY: 5 }),
    );

    expect(sel.isCollapsed).toBe(false);
  });

  it("does not collapse a selection on a mouse press into the released surface", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    const wrap = term(root);
    const sel = selectInOutput(root);
    handle.destroy();

    wrap.dispatchEvent(new MouseEvent("mousedown", { button: 0, cancelable: true }));

    expect(sel.isCollapsed).toBe(false);
  });

  it("does not open a link clicked inside the released subtree", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    try {
      const root = rootIn();
      const handle = createTerminal(root, { features: () => [] });
      const wrap = term(root);
      const link = document.createElement("a");
      link.className = "term-link";
      link.href = "https://example.invalid/";
      wrap.appendChild(link);
      handle.destroy();

      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops no browse cache when the page is put away after destroy", () => {
    // pagehide is the bfcache entry point, and it fires on a page whose terminal
    // a host may have destroyed minutes earlier: the renderer it would reach is
    // no longer this kernel's business.
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    handle.destroy();
    dropBrowseCache.mockClear();

    window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }));

    expect(dropBrowseCache).not.toHaveBeenCalled();
  });

  it("takes no focus from the public handle after destroy", () => {
    // handle.focus() IS focusTerminal, and a host keeps the handle: focusing a
    // detached textarea would scroll a page that has moved on.
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    const input = ta(root);
    const focus = vi.spyOn(input, "focus");
    handle.destroy();

    handle.focus();

    expect(focus).not.toHaveBeenCalled();
  });
});

describe("the textarea's own focus and blur wiring", () => {
  it("paints the focus class while the textarea holds focus, and drops it on blur", () => {
    // The class is what every .term rule keys the focused treatment off; nothing
    // else in the library sets it.
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      const input = ta(root);
      const wrap = term(root);
      input.dispatchEvent(new FocusEvent("focus"));
      expect(wrap.classList.contains("focus")).toBe(true);

      input.dispatchEvent(new FocusEvent("blur"));
      expect(wrap.classList.contains("focus")).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it("restores the placeholder on blur, so the next backspace still has a target", () => {
    // A backspace is only observable as an input event when there is something
    // in the field to delete; leaving the field in whatever state the blur found
    // it silently loses the first one after a refocus.
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      const input = ta(root);
      input.value = "half-typed";

      input.dispatchEvent(new FocusEvent("blur"));

      expect(input.value).toBe(INPUT_PLACEHOLDER);
    } finally {
      handle.destroy();
    }
  });
});

describe("an open IME composition owns the keyboard", () => {
  // The composition module has its own clock, and both keyboard paths early-return
  // on it: the composed text is delivered once, by compositionend, and anything
  // sent from under a live composition is a duplicate the user never typed.

  it("sends nothing from an input event while a composition is running", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      const input = ta(root);
      input.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      sendBinary.mockClear();

      input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "n" }));

      expect(sentText()).toBe("");
    } finally {
      handle.destroy();
    }
  });

  it("sends nothing from a keydown while a composition is running", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      const input = ta(root);
      input.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      sendBinary.mockClear();

      // Enter is the key that commits a candidate: encoding it as a carriage
      // return would run the half-composed line as a command.
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));

      expect(sentText()).toBe("");
    } finally {
      handle.destroy();
    }
  });

  it("resets the composition singleton on destroy, so a later terminal is not stuck mid-IME", () => {
    // The module is a singleton shared by every mount, so a destroy in the middle
    // of a composition cycle would otherwise leave the next terminal's keyboard
    // permanently deferred to an IME that is no longer there.
    const first = rootIn();
    const firstHandle = createTerminal(first, { features: () => [] });
    ta(first).dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    firstHandle.destroy();

    const second = rootIn();
    const secondHandle = createTerminal(second, { features: () => [] });
    try {
      sendBinary.mockClear();
      ta(second).dispatchEvent(
        new InputEvent("input", { inputType: "insertText", data: "echo hi" }),
      );

      expect(sentText()).toBe("echo hi");
    } finally {
      secondHandle.destroy();
    }
  });
});

describe("the document-level type-to-focus listener", () => {
  it("serves no keystroke a feature teardown dispatches, because the runtime is gone", async () => {
    // The one window where this listener can fire on a dead terminal:
    // cleanupRuntime() tears features down BEFORE it aborts the signal that
    // removes the listener, and the feature keydown chain is still populated at
    // that moment.
    const root = rootIn();
    const claimed = vi.fn(() => false);
    const watcher: TerminalFeature<void> = {
      name: "watcher",
      setup(ctx) {
        ctx.registerKeydown(claimed);
        return { teardown: () => undefined };
      },
    };
    const noisy: TerminalFeature<void> = {
      name: "noisy",
      setup() {
        return {
          teardown: () => {
            keyOnDocument("x");
          },
        };
      },
    };
    const handle = createTerminal(root, { features: () => [watcher, noisy] });
    // Both features must be REGISTERED before destroy, or teardown never runs and
    // this passes without ever reaching the listener.
    await tick();
    ta(root).blur();
    selectInOutput(root);
    claimed.mockClear();

    handle.destroy();

    expect(claimed).not.toHaveBeenCalled();
    expect(sentText()).toBe("");
  });

  it("stops at the feature that claims the key, without taking the keyboard or the selection", () => {
    // A claimed key must leave the selection intact, which is the whole reason
    // the chain runs before this listener takes focus: clipboard's Ctrl+Shift+C
    // needs the selection it is about to copy.
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [probeKeydown()] });
    try {
      const input = ta(root);
      input.blur();
      const sel = selectInOutput(root);
      sendBinary.mockClear();

      keyOnDocument("x");

      expect(sentText()).toBe("");
      expect(sel.isCollapsed).toBe(false);
      expect(document.activeElement).not.toBe(input);
    } finally {
      handle.destroy();
    }
  });

  function probeKeydown(): TerminalFeature<void> {
    return {
      name: "claimer",
      setup(ctx) {
        ctx.registerKeydown(() => true);
        return { teardown: () => undefined };
      },
    };
  }
});

describe("where the keyboard lands", () => {
  it("focuses the hidden textarea on mount, so the first keystroke is not lost", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      expect(document.activeElement).toBe(ta(root));
    } finally {
      handle.destroy();
    }
  });

  it("hands the keyboard back when the page becomes visible again", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      ta(root).blur();
      expect(document.activeElement).not.toBe(ta(root));

      document.dispatchEvent(new Event("visibilitychange"));

      expect(document.activeElement).toBe(ta(root));
    } finally {
      handle.destroy();
    }
  });

  it("hands the keyboard back on pageshow, which is the bfcache restore", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      ta(root).blur();

      window.dispatchEvent(new Event("pageshow"));

      expect(document.activeElement).toBe(ta(root));
    } finally {
      handle.destroy();
    }
  });

  it("focuses without scrolling, so raising the soft keyboard cannot shift the page", () => {
    // preventScroll is not modelled by the test DOM, so this asserts the call
    // the kernel makes: an iOS focus that scrolls jumps the terminal out from
    // under the caret, and nothing else in the library would restore it.
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      const focus = vi.spyOn(ta(root), "focus");

      handle.focus();

      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      handle.destroy();
    }
  });

  it("registers the pointer listeners as passive, so a tap cannot block scrolling", () => {
    // Also not modelled by the test DOM: a non-passive touch listener on the
    // scroller costs a frame on every drag, which is the gesture this UI is for.
    //
    // Spied on HTMLElement.prototype, NOT on EventTarget.prototype: the global
    // `EventTarget` under this runner is Node's own built-in class, not the DOM
    // one the elements inherit from, so a spy there records nothing at all.
    const spy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    try {
      const root = rootIn();
      const handle = createTerminal(root, { features: () => [] });
      const optionsFor = (type: string): AddEventListenerOptions[] =>
        spy.mock.calls
          .filter((c) => c[0] === type)
          .map((c) => (c[2] ?? {}) as AddEventListenerOptions);

      for (const type of ["pointerdown", "pointerup"]) {
        const registrations = optionsFor(type);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.passive).toBe(true);
        expect(registrations[0]?.signal).toBeInstanceOf(AbortSignal);
      }
      handle.destroy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("what a teardown owes the primitives the kernel built", () => {
  it("tears features down in reverse order, and a throwing teardown strands nobody", async () => {
    // Reverse of registration, so a feature that decorated an earlier one's
    // chrome comes off first; and one broken teardown must not abandon the rest,
    // because the rest hold the timers and observers.
    const order: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const first: TerminalFeature<void> = {
        name: "first",
        setup() {
          return {
            teardown: () => {
              order.push("first");
            },
          };
        },
      };
      const second: TerminalFeature<void> = {
        name: "second",
        setup() {
          return {
            teardown: () => {
              order.push("second");
              throw new Error("teardown broke");
            },
          };
        },
      };
      const handle = createTerminal(rootIn(), { features: () => [first, second] });
      await tick();

      handle.destroy();

      expect(order).toEqual(["second", "first"]);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('feature "second" error'),
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("cancels a pending announcement, so a released live region is never written", async () => {
    // The announcer re-sets its region on a timer (screen readers ignore an
    // unchanged value), and that timer holds the detached element.
    let ctx: TerminalContext | undefined;
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [probeFeature((c) => (ctx = c))] });
    await tick();
    const polite = root.querySelector<HTMLElement>('[aria-live="polite"]');
    if (!ctx || !polite) {
      throw new Error("the probe feature never ran");
    }
    vi.useFakeTimers();
    try {
      ctx.announce("session ready");
      handle.destroy();

      vi.advanceTimersByTime(1000);

      expect(polite.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the toast timer, so nothing writes the toast after destroy", async () => {
    let ctx: TerminalContext | undefined;
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [probeFeature((c) => (ctx = c))] });
    await tick();
    const toast = root.querySelector<HTMLElement>(".wt-toast");
    if (!ctx || !toast) {
      throw new Error("the probe feature never ran");
    }
    vi.useFakeTimers();
    try {
      ctx.toast("Copied");
      expect(toast.classList.contains("visible")).toBe(true);
      handle.destroy();

      vi.advanceTimersByTime(10_000);

      // Untouched: the timer that would have hidden it was cancelled with the
      // runtime, rather than left to fire against a detached element.
      expect(toast.classList.contains("visible")).toBe(true);
      expect(toast.textContent).toBe("Copied");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands out no feature api once the runtime is released", async () => {
    // ctx outlives destroy in any closure a feature left behind, and a stale api
    // is a live handle onto a torn-down feature's state.
    const other: TerminalFeature<{ ping: () => string }> = {
      name: "other",
      setup() {
        return { api: { ping: () => "pong" }, teardown: () => undefined };
      },
    };
    let ctx: TerminalContext | undefined;
    const handle = createTerminal(rootIn(), {
      features: () => [other, probeFeature((c) => (ctx = c))],
    });
    await tick();
    if (!ctx) {
      throw new Error("the probe feature never ran");
    }
    expect(ctx.use(other)?.ping()).toBe("pong");

    handle.destroy();

    expect(ctx.use(other)).toBeUndefined();
  });

  it("runs the cleanup exactly once, so a destroy after a fatal does not repeat it", async () => {
    // Two paths reach cleanupRuntime: the fatal rollback and destroy(). Nothing
    // in it is safe to run twice — the second pass would close a socket the host
    // may have reopened, and re-flush a snapshot.
    const boom: TerminalFeature<void> = {
      name: "boom",
      setup() {
        throw new Error("import graph broken");
      },
    };
    const handle = createTerminal(rootIn(), { features: () => [boom] });
    await tick();
    expect(disconnect).toHaveBeenCalledTimes(1);

    handle.destroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("the fatal-startup rollback", () => {
  const boom: TerminalFeature<void> = {
    name: "boom",
    setup() {
      throw new Error("import graph broken");
    },
  };

  it("drops the narrow class, so the recovery surface is not laid out as a phone", async () => {
    // .wt-narrow is a live mirror of the root's size and the recovery surface has
    // its own layout; leaving it stamped hands the surface compact chrome rules
    // that no longer describe anything.
    const root = rootIn();
    createTerminal(root, { features: () => [boom] });
    await tick();

    expect(root.classList.contains("wt-narrow")).toBe(false);
    // The boundary classes stay: every .wt-fatal rule is scoped inside .wt-root.
    expect(root.classList.contains("wt-root")).toBe(true);
  });

  it("tears the terminal subtree down even when a handler takes over the surface", async () => {
    // The handler's own UI replaces the recovery panel, not the rollback: a live
    // terminal left underneath it would still hold the socket and the listeners.
    const root = rootIn();
    createTerminal(root, {
      features: () => [boom],
      onFatalError() {
        const own = document.createElement("p");
        own.className = "host-recovery";
        root.appendChild(own);
        return true;
      },
    });
    await tick();

    expect(root.querySelector(".host-recovery")).not.toBeNull();
    expect(root.querySelector(".term-output")).toBeNull();
    expect(root.querySelector(".term-input")).toBeNull();
  });

  it("leaves the handle inert, so a host that kept it cannot write to a dead socket", async () => {
    const handle = createTerminal(rootIn(), { features: () => [boom] });
    await tick();
    sendBinary.mockClear();

    handle.send(new TextEncoder().encode("ls\n"));

    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("reports a handler that throws, and still renders the built-in surface", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const root = rootIn();
      createTerminal(root, {
        features: () => [boom],
        onFatalError() {
          throw new Error("reporter broke too");
        },
      });
      await tick();

      expect(error).toHaveBeenCalledWith(
        "web-terminal-ui: onFatalError handler failed",
        expect.any(Error),
      );
      expect(root.querySelector(".wt-fatal")).not.toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it("reports a handler that throws in the synchronous phase too", () => {
    // The kernel-init phase: the multiple-owner guard throws before any DOM work,
    // so a silent reporting failure here leaves a consumer with no signal at all.
    const twoOwners = (): TerminalFeature<void>[] =>
      ["a", "b"].map((name) => ({
        name,
        sessionOwner: {
          resolveInitialSession: (): Promise<SessionRef | null> => Promise.resolve(null),
        },
        setup: () => ({ teardown: () => undefined }),
      }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const root = rootIn();
      expect(() =>
        createTerminal(root, {
          features: twoOwners,
          onFatalError() {
            throw new Error("reporter broke too");
          },
        }),
      ).toThrow(/multiple session-owning features/);

      expect(error).toHaveBeenCalledWith(
        "web-terminal-ui: onFatalError handler failed",
        expect.any(Error),
      );
      expect(root.querySelector(".wt-fatal")).not.toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it("does not resurrect the surface when the handler destroyed the terminal", async () => {
    // A handler is allowed to call destroy() while taking over; recreating the
    // default surface afterwards would put library UI back into a root the host
    // has explicitly released.
    const root = rootIn();
    const handle: TerminalHandle = createTerminal(root, {
      features: () => [boom],
      onFatalError() {
        // Initialized by the time this runs: the rollback is dispatched from a
        // .then, so createTerminal has already returned.
        handle.destroy();
        // Deliberately NOT claiming the surface: the rollback must respect the
        // released root even when the handler declines to take it over.
        return false;
      },
    });
    await tick();

    expect(root.querySelector(".wt-fatal")).toBeNull();
    expect(root.childElementCount).toBe(0);
  });

  it("offers a reload button that actually reloads the page", async () => {
    // The only action on the surface. Nothing else in the library can recover a
    // failed startup, so a button that does nothing is the whole surface failing.
    const reload = vi.fn();
    const root = rootIn();
    createTerminal(root, { features: () => [boom] });
    await tick();
    const button = root.querySelector<HTMLButtonElement>(".wt-fatal-reload");
    if (!button) {
      throw new Error("no reload button");
    }
    const original = window.location.reload;
    Object.defineProperty(window.location, "reload", { configurable: true, value: reload });
    try {
      button.click();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window.location, "reload", {
        configurable: true,
        value: original,
      });
    }
  });
});

describe("a startup cancelled under the kernel", () => {
  it("does not report a setup rejection that lost the race with destroy", async () => {
    // An intentional teardown is cancellation, not a failure: reporting it would
    // hand a host a startup error for a terminal it closed itself.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: string[] = [];
    try {
      let reject: ((err: Error) => void) | undefined;
      const slow: TerminalFeature<void> = {
        name: "slow",
        setup(ctx) {
          ctx.onError((feature) => {
            seen.push(feature);
          });
          return new Promise((_resolve, rej) => {
            reject = rej;
          });
        },
      };
      const handle = createTerminal(rootIn(), { features: () => [slow] });
      handle.destroy();
      reject?.(new Error("too late"));
      await tick();
      await tick();

      expect(seen).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("reports a teardown that throws while unwinding a post-destroy setup", async () => {
    // The instance resolved into a runtime that is already gone, so the kernel
    // tears it down instead of registering it — and that teardown is the last
    // code that will ever run for the feature, so its failure has to be visible.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const hostHandler = vi.fn();
      let release: (() => void) | undefined;
      const registrar: TerminalFeature<void> = {
        name: "registrar",
        setup(ctx) {
          ctx.onError(hostHandler);
          return { teardown: () => undefined };
        },
      };
      const slow: TerminalFeature<void> = {
        name: "slow",
        setup: () =>
          new Promise((resolve) => {
            release = () => {
              resolve({
                teardown: () => {
                  throw new Error("teardown broke");
                },
              });
            };
          }),
      };
      const handle = createTerminal(rootIn(), { features: () => [registrar, slow] });
      await tick();
      handle.destroy();
      release?.();
      await tick();
      await tick();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('feature "slow" error'),
        expect.any(Error),
      );
      // And NOT to the host handler: the runtime released the handler set with
      // everything else it owned, so this late failure goes to the console, which
      // is where a report with nobody left to receive it belongs.
      expect(hostHandler).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("ignores a session the owner resolved after destroy", async () => {
    // tabs' bootstrap is an un-cancelled fetch: it can land after a host closed
    // the panel, and switching then would reopen the socket it just closed.
    let resolve: ((s: SessionRef | null) => void) | undefined;
    const owner: TerminalFeature<void> = {
      name: "owner",
      sessionOwner: {
        resolveInitialSession: () =>
          new Promise<SessionRef | null>((r) => {
            resolve = r;
          }),
      },
      setup: () => ({ teardown: () => undefined }),
    };
    const handle = createTerminal(rootIn(), { features: () => [owner] });
    await tick();
    handle.destroy();
    setSession.mockClear();
    connect.mockClear();

    resolve?.({ id: "sess-late" });
    await tick();
    await tick();

    expect(setSession).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("leaves the overlay to the first frame when the owner already connected", async () => {
    // A null resolution means the bootstrap failed and the owner's retry chrome
    // needs to be visible. But a switch may already have happened (tabs adopts a
    // session during setup), and then the overlay belongs to the first frame:
    // lowering it here would show an empty terminal as a live one.
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const owner: TerminalFeature<void> = {
      name: "owner",
      sessionOwner: {
        resolveInitialSession: (): Promise<SessionRef | null> => Promise.resolve(null),
      },
      setup(ctx) {
        ctx.notifySwitch({ id: "sess-adopted" });
        return { teardown: () => undefined };
      },
    };
    const handle = createTerminal(rootIn(), { features: () => [owner], loading });
    try {
      await tick();
      await tick();

      expect(setSession).toHaveBeenCalledWith("sess-adopted");
      expect(loading.classList.contains("fade")).toBe(false);
    } finally {
      handle.destroy();
    }
  });
});

describe("the handle after destroy", () => {
  it("reset() touches neither the scrollback nor the screen", () => {
    const handle = createTerminal(rootIn(), { features: () => [] });
    handle.destroy();
    resetScrollback.mockClear();
    resetScreen.mockClear();

    handle.reset();

    expect(resetScrollback).not.toHaveBeenCalled();
    expect(resetScreen).not.toHaveBeenCalled();
  });
});

describe("the narrow-layout driver", () => {
  it("watches the root for size changes in both dimensions", () => {
    // .wt-narrow is what every compact CSS rule keys off, and the root's size
    // changes without a window resize (a keyboard slide, a host panel animating).
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    try {
      const root = rootIn();
      const handle = createTerminal(root, { features: () => [] });
      expect(observe).toHaveBeenCalledWith(root);
      handle.destroy();
    } finally {
      observe.mockRestore();
    }
  });

  it("requires ResizeObserver rather than pretending to degrade without it", () => {
    // kernel.ts used to guard this observer with `typeof ResizeObserver ===
    // "function"`, promising a browser without the constructor a terminal minus
    // the narrow-layout enhancement. It never delivered one: viewport.init()
    // (same buildTerminal, ~900 lines later) and the tabs strip both construct a
    // ResizeObserver with no guard, so the build threw either way — this test
    // failed with `TypeError: ResizeObserver is not a constructor` from
    // viewport.ts:182 while the guard was still in place. The requirement is real
    // and unguardable here; the assertion is that it is stated honestly.
    vi.stubGlobal("ResizeObserver", undefined);
    try {
      expect(() => createTerminal(rootIn(), { features: () => [] })).toThrow(
        /ResizeObserver is not a constructor/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the browse-cache sweep", () => {
  it("keeps no sweep running after destroy, with a cache the sweep would drop", () => {
    // The sweep callback has no destroy guard of its own: the interval cleared on
    // abort is the only thing that stops it, so a released terminal would keep
    // reaching into a renderer the host has moved on from, once a minute, for the
    // life of the page.
    vi.useFakeTimers();
    try {
      const handle = createTerminal(rootIn(), { features: () => [] });
      handle.destroy();
      // A cache the sweep WOULD act on: with an empty one the sweep short-circuits
      // and a surviving interval looks identical to a cancelled one.
      browseCacheSize.mockReturnValue(12);
      hoisted.lastBrowseActivityMs.mockReturnValue(0);
      dropBrowseCache.mockClear();

      vi.advanceTimersByTime(300_000);

      expect(dropBrowseCache).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the composition view follows the cursor", () => {
  // The hidden textarea rides with the composition view, and iOS puts the soft
  // keyboard against the FOCUSED INPUT's box: a textarea left at the origin makes
  // the platform scroll the page to reveal it, moving the terminal out from under
  // the caret. So both are placed at the cursor the renderer reports.

  it("places both at the cursor before the first frame", () => {
    getCursorPx.mockReturnValue({ left: 24, top: 96, cellH: 19 });
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      const view = root.querySelector<HTMLElement>(".composition-view");
      expect(view?.style.left).toBe("24px");
      expect(view?.style.top).toBe("96px");
      expect(ta(root).style.top).toBe("96px");
    } finally {
      handle.destroy();
    }
  });

  it("moves them when the renderer reports a cursor move", () => {
    const root = rootIn();
    const handle = createTerminal(root, { features: () => [] });
    try {
      const onCursorMove = (
        renderInit.mock.calls[0]?.[0] as { onCursorMove?: () => void } | undefined
      )?.onCursorMove;
      if (!onCursorMove) {
        throw new Error("the kernel gave the renderer no cursor-move hook");
      }
      getCursorPx.mockReturnValue({ left: 40, top: 160, cellH: 19 });

      onCursorMove();

      expect(root.querySelector<HTMLElement>(".composition-view")?.style.top).toBe("160px");
      expect(ta(root).style.top).toBe("160px");
    } finally {
      handle.destroy();
    }
  });

  it("moves them again once a viewport transition settles", async () => {
    // A keyboard slide or a rotation moves the cursor's box without a cursor
    // move: the settle is the authoritative geometry, so the placement has to be
    // redone there or the textarea is left at the pre-slide position and iOS
    // scrolls the page to reveal it.
    vi.useFakeTimers();
    try {
      const root = rootIn();
      const handle = createTerminal(root, { features: () => [] });
      await vi.advanceTimersByTimeAsync(0);
      getCursorPx.mockReturnValue({ left: 8, top: 240, cellH: 19 });

      window.dispatchEvent(new Event("resize"));
      await vi.advanceTimersByTimeAsync(500);

      expect(root.querySelector<HTMLElement>(".composition-view")?.style.top).toBe("240px");
      handle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the document title, which the kernel is the only writer of", () => {
  it("is not re-assigned when nothing about it changed", async () => {
    // It doubles as the browser-tab label and the bookmark name, and a feature
    // repaints the prefix on every status sweep: an unchanged assignment churns
    // both for nothing.
    document.title = "kiro-cli";
    let ctx: TerminalContext | undefined;
    const handle = createTerminal(rootIn(), { features: () => [probeFeature((c) => (ctx = c))] });
    await tick();
    if (!ctx) {
      throw new Error("the probe feature never ran");
    }
    // Counted at the setter, because that IS the assignment the guard exists to
    // suppress; the test DOM's own title element gives no other signal. The
    // accessor lives further up the prototype chain than `document`, so find it
    // rather than assuming which class owns it.
    let owner: object | null = Object.getPrototypeOf(document) as object | null;
    while (owner !== null && !Object.getOwnPropertyDescriptor(owner, "title")) {
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    const descriptor = owner === null ? undefined : Object.getOwnPropertyDescriptor(owner, "title");
    if (!descriptor?.get || !descriptor.set) {
      throw new Error("document.title is not an accessor in this DOM");
    }
    const { get, set } = descriptor;
    let writes = 0;
    Object.defineProperty(document, "title", {
      configurable: true,
      get: () => get.call(document) as string,
      set: (v: string) => {
        writes++;
        set.call(document, v);
      },
    });
    try {
      ctx.titlePrefix("(2) ");
      expect(writes).toBe(1);
      expect(document.title).toBe("(2) kiro-cli");

      ctx.titlePrefix("(2) ");

      expect(writes).toBe(1);
    } finally {
      delete (document as unknown as Record<string, unknown>)["title"];
      handle.destroy();
    }
  });
});

describe("a browser with no matchMedia at all", () => {
  // Both pointer questions the kernel asks are feature-detected, and the detect
  // has to hold: reading the answer from a missing function throws out of an event
  // handler, which loses the gesture entirely rather than degrading it.

  it("still preserves the keyboard on a touch press", () => {
    // The synthetic mousedown after a touch tap is cancelled to keep iOS's
    // keyboard up, and that decision reads the pointer question: a detect that
    // does not hold throws out of the handler and the cancellation is lost.
    vi.stubGlobal("matchMedia", undefined);
    try {
      const root = rootIn();
      const handle = createTerminal(root, { features: () => [] });
      const wrap = term(root);

      wrap.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 }),
      );
      const press = new MouseEvent("mousedown", { button: 0, cancelable: true });
      wrap.dispatchEvent(press);

      expect(press.defaultPrevented).toBe(true);
      handle.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still focuses the terminal on a clean touch tap", () => {
    vi.stubGlobal("matchMedia", undefined);
    try {
      const root = rootIn();
      const handle = createTerminal(root, { features: () => [] });
      const wrap = term(root);
      ta(root).blur();

      wrap.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 }),
      );
      wrap.dispatchEvent(
        new PointerEvent("pointerup", { pointerType: "touch", clientX: 5, clientY: 5 }),
      );

      expect(document.activeElement).toBe(ta(root));
      handle.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still answers ctx.layout(), reporting a pointer it cannot ask about as not coarse", async () => {
    vi.stubGlobal("matchMedia", undefined);
    try {
      let ctx: TerminalContext | undefined;
      const handle = createTerminal(rootIn(), { features: () => [probeFeature((c) => (ctx = c))] });
      await tick();
      if (!ctx) {
        throw new Error("the probe feature never ran");
      }

      expect(ctx.layout().coarse).toBe(false);
      handle.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a fontReady the document cannot resolve", () => {
  it("is reported by name and does not wedge startup", () => {
    // The font gate is one of the two things the loading overlay waits for, so a
    // fontReady this document cannot answer for — a browser with no Font Loading
    // API, or a descriptor it refuses — must fall through to the settled path with
    // a named warning rather than stalling the page silently. (The test DOM has no
    // `document.fonts` at all, which is the first of those two cases.)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const root = rootIn();
      const handle = createTerminal(root, {
        features: () => [],
        fontReady: "14px SomeMissingFace",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid fontReady 14px SomeMissingFace"),
        expect.anything(),
      );
      expect(root.querySelector(".term-output")).not.toBeNull();
      handle.destroy();
    } finally {
      warn.mockRestore();
    }
  });
});
