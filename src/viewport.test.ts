// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as ViewportModule from "./viewport.js";

const { isUserScrolledUp, scrollToBottom, stickToBottom } = vi.hoisted(() => ({
  isUserScrolledUp: vi.fn<() => boolean>(() => false),
  scrollToBottom: vi.fn(),
  stickToBottom: vi.fn(),
}));

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    scroll: {
      isUserScrolledUp,
      scrollToBottom,
      stickToBottom,
      init: vi.fn(),
      suppressScroll: vi.fn(),
      isInUserScroll: vi.fn(() => false),
    },
  };
});

const SETTLE_MS = 350;
let viewport: typeof ViewportModule;
let termWrap: HTMLElement;
let onSettled: Mock<(wasAtBottom: boolean) => void>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  isUserScrolledUp.mockReturnValue(false);
  viewport = await import("./viewport.js");
  termWrap = document.createElement("div");
  document.body.replaceChildren(termWrap);
  onSettled = vi.fn<(wasAtBottom: boolean) => void>();
  viewport.init({ termWrap, onSettled });
  // Flush any transition started by the init-time visualViewport onChange.
  vi.advanceTimersByTime(SETTLE_MS + 50);
  onSettled.mockClear();
  scrollToBottom.mockClear();
  stickToBottom.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("viewport: settle lifecycle", () => {
  it("fires onSettled once SETTLE_MS after the last viewport event and pins to the bottom", () => {
    isUserScrolledUp.mockReturnValue(false);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(true);
    // Pins, never forces: stickToBottom respects the follow state, whereas
    // scrollToBottom would OVERRIDE it, which is not this handler's decision.
    expect(stickToBottom).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("coalesces a burst of events into a single settle (debounce)", () => {
    isUserScrolledUp.mockReturnValue(false);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    // 400ms elapsed but only 200ms since the last event: not settled yet.
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("does not pin when the user is scrolled up at settle time", () => {
    isUserScrolledUp.mockReturnValue(true);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(false);
    expect(stickToBottom).not.toHaveBeenCalled();
  });

  it("does not drag down a user who scrolled up DURING the burst", () => {
    // The regression this settle-time read exists to prevent. Every viewport
    // event re-arms the timer without re-reading, and on iOS a wake or keyboard
    // slide emits a stream of them, so a latch captured when the burst STARTED
    // stayed true across the user scrolling up and then snapped them to the
    // bottom. Reading at settle is the whole fix.
    isUserScrolledUp.mockReturnValue(false); // at the bottom when the burst starts
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("resize")); // the burst continues (iOS)
    isUserScrolledUp.mockReturnValue(true); // ... and the user scrolls up to read
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(false);
    expect(stickToBottom).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("reports a transition in flight so a caller can withhold a provisional measurement", () => {
    expect(viewport.isInTransition()).toBe(false);
    window.dispatchEvent(new Event("resize"));
    expect(viewport.isInTransition()).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(viewport.isInTransition()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(viewport.isInTransition()).toBe(false);
  });
});

describe("viewport: visualViewport keyboard inset", () => {
  afterEach(() => {
    viewport.teardown();
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("pins the term wrap to the visual viewport and publishes --kb-inset/--vv-top", () => {
    const vv = {
      height: window.innerHeight - 200,
      offsetTop: 30,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    const tw = document.createElement("div");
    const root = document.createElement("div");
    root.appendChild(tw);
    document.body.replaceChildren(root);
    viewport.init({ termWrap: tw, root, onSettled: vi.fn() });
    // .term is pinned to the visual viewport: top = offsetTop (30); the bottom
    // inset is the gap from the layout bottom to the keyboard top
    // (innerHeight - offsetTop - vv.height = innerHeight - 30 - (innerHeight - 200) = 170).
    expect(tw.style.top).toBe("30px");
    expect(tw.style.bottom).toBe("170px");
    expect(root.style.getPropertyValue("--kb-inset")).toBe("170px");
    expect(root.style.getPropertyValue("--vv-top")).toBe("30px");
  });

  it("clears the top/bottom insets and zeroes --kb-inset when the keyboard closes", () => {
    const vv = {
      height: window.innerHeight,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    const tw = document.createElement("div");
    const root = document.createElement("div");
    root.appendChild(tw);
    document.body.replaceChildren(root);
    viewport.init({ termWrap: tw, root, onSettled: vi.fn() });
    expect(tw.style.top).toBe("");
    expect(tw.style.bottom).toBe("");
    expect(root.style.getPropertyValue("--kb-inset")).toBe("0px");
  });

  it("ignores keyboard geometry when suppressKeyboardInset is set (hardware keyboard)", () => {
    // A hardware-keyboard device (fine pointer) never opens the soft keyboard, so
    // a visualViewport height shrink is not a keyboard to accommodate. iPadOS has
    // been seen to report a phantom keyboard-sized shrink with no keyboard shown,
    // which otherwise pinned a bottom inset and left the lower half of the screen
    // black (the recurring "moved up ~50%" bug). The terminal must stay
    // full-height: no top/bottom inset, --kb-inset/--vv-top zeroed.
    const vv = {
      height: window.innerHeight - 300, // a phantom "keyboard" shrink
      offsetTop: 40,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    const tw = document.createElement("div");
    const root = document.createElement("div");
    root.appendChild(tw);
    document.body.replaceChildren(root);
    viewport.init({ termWrap: tw, root, onSettled: vi.fn(), suppressKeyboardInset: () => true });
    expect(tw.style.top).toBe("");
    expect(tw.style.bottom).toBe("");
    expect(root.style.getPropertyValue("--kb-inset")).toBe("0px");
    expect(root.style.getPropertyValue("--vv-top")).toBe("0px");
  });
});

describe("viewport: reserved bottom chrome (--wt-reserve-bottom)", () => {
  const realInnerHeight = window.innerHeight;
  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  });
  afterEach(() => {
    viewport.teardown();
    Reflect.deleteProperty(window, "visualViewport");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: realInnerHeight });
  });

  it("folds a --wt-reserve-bottom value into the term-wrap bottom offset with the keyboard closed", () => {
    const vv = {
      height: 900,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    const tw = document.createElement("div");
    tw.style.setProperty("--wt-reserve-bottom", "48px");
    const root = document.createElement("div");
    root.appendChild(tw);
    document.body.replaceChildren(root);
    viewport.init({ termWrap: tw, root, onSettled: vi.fn() });
    // Keyboard closed (vv.height == innerHeight, offsetTop 0) so bottomInset is 0;
    // the 48px reserve (< innerHeight/3 == 300) is the whole bottom offset.
    expect(tw.style.bottom).toBe("48px");
  });

  it("caps a runaway reserve at a third of the viewport height (bad-measurement guard)", () => {
    const vv = {
      height: 900,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    // A reserve near/over the screen height (e.g. the switcher bar measured while a
    // phantom keyboard inset had lifted it) must be clamped so it never strands the
    // lower screen black. round(innerHeight / 3) == round(900 / 3) == 300.
    const tw = document.createElement("div");
    tw.style.setProperty("--wt-reserve-bottom", "100000px");
    const root = document.createElement("div");
    root.appendChild(tw);
    document.body.replaceChildren(root);
    viewport.init({ termWrap: tw, root, onSettled: vi.fn() });
    expect(tw.style.bottom).toBe("300px");
  });
});

// A visualViewport stand-in whose listeners actually fire. Every other suite
// here stubs addEventListener with a vi.fn, so the geometry is only ever
// computed by the one direct onChange() call init makes — nothing proved the
// listener WIRING reacts to a keyboard opening after init, or that teardown
// releases it.
function liveVisualViewport(
  height: number,
  offsetTop: number,
): {
  height: number;
  offsetTop: number;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  fire: (type: string) => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height,
    offsetTop,
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) {
        fn();
      }
    },
  };
}

describe("viewport: the visual-viewport wiring reacts after init", () => {
  let vv: ReturnType<typeof liveVisualViewport>;
  let root: HTMLElement;

  beforeEach(() => {
    viewport.teardown(); // drop the beforeEach init's window listeners first
    vv = liveVisualViewport(window.innerHeight, 0);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    root = document.createElement("div");
    const tw = document.createElement("div");
    root.appendChild(tw);
    document.body.replaceChildren(root);
    viewport.init({ termWrap: tw, root, onSettled });
  });

  afterEach(() => {
    viewport.teardown();
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("republishes the keyboard inset when the keyboard opens after init", () => {
    vv.height = window.innerHeight - 300;
    vv.fire("resize");
    expect(root.style.getPropertyValue("--kb-inset")).toBe("300px");
  });

  it("republishes the offset when the visual viewport scrolls", () => {
    vv.offsetTop = 40;
    vv.fire("scroll");
    expect(root.style.getPropertyValue("--vv-top")).toBe("40px");
  });

  it("treats a visual-viewport change as a transition in flight", () => {
    vv.height = window.innerHeight - 100;
    vv.fire("resize");
    expect(viewport.isInTransition()).toBe(true);
  });

  it("self-heals a stuck inset when the window regains focus", () => {
    vv.height = window.innerHeight - 120;
    window.dispatchEvent(new Event("focus"));
    expect(root.style.getPropertyValue("--kb-inset")).toBe("120px");
  });

  it("self-heals a stuck inset when the page is restored from the bfcache", () => {
    vv.height = window.innerHeight - 140;
    window.dispatchEvent(new Event("pageshow"));
    expect(root.style.getPropertyValue("--kb-inset")).toBe("140px");
  });
});

describe("viewport: teardown releases every listener it attached", () => {
  let vv: ReturnType<typeof liveVisualViewport>;
  let root: HTMLElement;

  beforeEach(() => {
    viewport.teardown();
    vv = liveVisualViewport(window.innerHeight - 200, 0);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    root = document.createElement("div");
    const tw = document.createElement("div");
    root.appendChild(tw);
    document.body.replaceChildren(root);
    viewport.init({ termWrap: tw, root, onSettled });
    expect(root.style.getPropertyValue("--kb-inset")).toBe("200px");
    viewport.teardown();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("clears the geometry vars it published, so a destroy without a remount leaves no inset", () => {
    expect(root.style.getPropertyValue("--kb-inset")).toBe("");
    expect(root.style.getPropertyValue("--vv-top")).toBe("");
  });

  it("stops answering visual-viewport resizes", () => {
    vv.height = window.innerHeight - 500;
    vv.fire("resize");
    expect(root.style.getPropertyValue("--kb-inset")).toBe("");
  });

  it("stops answering visual-viewport scrolls", () => {
    vv.offsetTop = 90;
    vv.fire("scroll");
    expect(root.style.getPropertyValue("--vv-top")).toBe("");
  });

  it("stops answering window focus", () => {
    window.dispatchEvent(new Event("focus"));
    expect(root.style.getPropertyValue("--kb-inset")).toBe("");
  });

  it("stops answering a bfcache restore", () => {
    window.dispatchEvent(new Event("pageshow"));
    expect(root.style.getPropertyValue("--kb-inset")).toBe("");
  });

  it("stops answering window resize, so no transition starts after destroy", () => {
    window.dispatchEvent(new Event("resize"));
    expect(viewport.isInTransition()).toBe(false);
  });
});

describe("viewport: rotation is a re-measure signal on both Safari generations", () => {
  afterEach(() => {
    viewport.teardown();
    Reflect.deleteProperty(screen, "orientation");
  });

  it("re-measures on screen.orientation change where the modern API exists", () => {
    viewport.teardown();
    const orientation = liveVisualViewport(0, 0); // reused as a bare event target
    Object.defineProperty(screen, "orientation", { configurable: true, value: orientation });
    viewport.init({ termWrap, onSettled });
    expect(viewport.isInTransition()).toBe(false);
    orientation.fire("change");
    expect(viewport.isInTransition()).toBe(true);
  });

  it("does not listen for the deprecated window event on a browser that lacks it", () => {
    // happy-dom exposes neither screen.orientation nor onorientationchange, which
    // is the older-Safari-absent case: nothing must be bound to the window event.
    viewport.teardown();
    viewport.init({ termWrap, onSettled });
    window.dispatchEvent(new Event("orientationchange"));
    expect(viewport.isInTransition()).toBe(false);
  });

  it("releases the screen.orientation listener on teardown", () => {
    // screen.orientation is a global the terminal does not own: a listener left on
    // it survives destroy() and keeps calling into a torn-down module, and a
    // remount then re-measures twice per rotation.
    viewport.teardown();
    const orientation = liveVisualViewport(0, 0); // reused as a bare event target
    Object.defineProperty(screen, "orientation", { configurable: true, value: orientation });
    viewport.init({ termWrap, onSettled });

    viewport.teardown();
    orientation.fire("change");

    expect(viewport.isInTransition()).toBe(false);
  });
});

// A ResizeObserver whose callback a test can actually fire. happy-dom's own is a
// documented no-op that does not even keep the callback, so nothing here reaches
// the term-wrap observation init makes — the signal that catches a font load, a
// devtools dock, and an embedder resizing its panel, none of which raise a window
// resize event. `disconnect()` is modelled faithfully because teardown's release
// of the observer is half of what is under test.
interface FakeObserver {
  callback: ResizeObserverCallback;
  targets: Element[];
}
let observers: FakeObserver[] = [];

function stubResizeObserver(): void {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      private readonly record: FakeObserver;
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.targets.push(target);
      }
      unobserve(target: Element): void {
        this.record.targets = this.record.targets.filter((t) => t !== target);
      }
      disconnect(): void {
        this.record.targets.length = 0;
      }
    },
  );
}

/** Fire every observer watching `target`, and report how many there were, so a
 *  test can tell "the callback did nothing" from "nothing was ever observing". */
function fireResize(target: Element): number {
  const watching = observers.filter((o) => o.targets.includes(target));
  for (const o of watching) {
    o.callback([], {} as ResizeObserver);
  }
  return watching.length;
}

describe("viewport: the term wrap's own size is a re-measure signal", () => {
  let tw: HTMLElement;

  beforeEach(() => {
    viewport.teardown(); // drop the outer init's window listeners first
    stubResizeObserver();
    tw = document.createElement("div");
    document.body.replaceChildren(tw);
    viewport.init({ termWrap: tw, onSettled });
    vi.advanceTimersByTime(SETTLE_MS + 50);
    onSettled.mockClear();
    stickToBottom.mockClear();
  });

  afterEach(() => {
    viewport.teardown();
    vi.unstubAllGlobals();
  });

  it("observes the term wrap, so a font load or a panel resize settles like any other change", () => {
    // A window resize is not the only way the terminal's box changes: a webfont
    // arriving, devtools docking, or an embedder resizing its own panel move it
    // with no window event at all.
    expect(viewport.isInTransition()).toBe(false);

    expect(fireResize(tw)).toBe(1);

    expect(viewport.isInTransition()).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("disconnects that observer on teardown, so a destroyed terminal stops re-measuring", () => {
    // The observer outliving destroy() is how a create->destroy->create remount
    // ends up with two of them driving one settle lifecycle.
    viewport.teardown();

    expect(fireResize(tw)).toBe(0);
    expect(viewport.isInTransition()).toBe(false);
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe("viewport: rotation on older Safari (the deprecated window event)", () => {
  // screen.orientation is the canonical rotation signal, and happy-dom exposes
  // neither it nor the legacy fallback — so the else arm below is reached by
  // giving the window the property older Safari has and nothing else does.
  beforeEach(() => {
    viewport.teardown();
    Object.defineProperty(window, "onorientationchange", { configurable: true, value: null });
    viewport.init({ termWrap, onSettled });
    vi.advanceTimersByTime(SETTLE_MS + 50);
    onSettled.mockClear();
  });

  afterEach(() => {
    viewport.teardown();
    Reflect.deleteProperty(window, "onorientationchange");
  });

  it("re-measures on window orientationchange where screen.orientation is absent", () => {
    // iOS Safari emits window.resize late or not at all on rotation, so without
    // this arm an older device rotates and never re-measures: the terminal keeps
    // the portrait geometry it had.
    expect(viewport.isInTransition()).toBe(false);

    window.dispatchEvent(new Event("orientationchange"));

    expect(viewport.isInTransition()).toBe(true);
  });

  it("releases that listener on teardown too", () => {
    viewport.teardown();

    window.dispatchEvent(new Event("orientationchange"));

    expect(viewport.isInTransition()).toBe(false);
  });
});

describe("viewport: teardown and a settle already in flight", () => {
  // Driven through the fake ResizeObserver rather than a window event: earlier
  // suites in this file deliberately leave their instances mounted, so a window
  // resize reaches all of them and the engine mock counts their settles too. An
  // observer fire reaches exactly this instance.
  let tw: HTMLElement;

  beforeEach(() => {
    viewport.teardown();
    stubResizeObserver();
    tw = document.createElement("div");
    document.body.replaceChildren(tw);
    viewport.init({ termWrap: tw, onSettled });
    vi.advanceTimersByTime(SETTLE_MS + 50);
    onSettled.mockClear();
    stickToBottom.mockClear();
    scrollToBottom.mockClear();
  });

  afterEach(() => {
    viewport.teardown();
    vi.unstubAllGlobals();
  });

  it("cancels the pending settle, so nothing reaches the scroll controller after destroy", () => {
    // destroy() during an iOS keyboard slide is ordinary (a tab close mid-slide),
    // and the settle callback drives the engine's scroll controller. Firing it
    // after teardown pins a terminal that no longer exists to the bottom.
    expect(fireResize(tw)).toBe(1);
    expect(viewport.isInTransition()).toBe(true);

    viewport.teardown();
    vi.advanceTimersByTime(SETTLE_MS + 50);

    expect(onSettled).not.toHaveBeenCalled();
    expect(stickToBottom).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("survives a teardown that runs before any init", async () => {
    // The kernel calls teardown from destroy(), and a consumer that destroys a
    // terminal whose init never ran (a failed bootstrap) must not get a crash out
    // of the cleanup path.
    vi.resetModules();
    const fresh = await import("./viewport.js");

    expect(() => {
      fresh.teardown();
    }).not.toThrow();
    expect(fresh.isInTransition()).toBe(false);
  });
});
