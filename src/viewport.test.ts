// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as ViewportModule from "./viewport.js";

const { isUserScrolledUp, scrollToBottom } = vi.hoisted(() => ({
  isUserScrolledUp: vi.fn<() => boolean>(() => false),
  scrollToBottom: vi.fn(),
}));

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    scroll: {
      isUserScrolledUp,
      scrollToBottom,
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
});
afterEach(() => {
  vi.useRealTimers();
});

describe("viewport: settle lifecycle", () => {
  it("fires onSettled once SETTLE_MS after the last viewport event and snaps to bottom", () => {
    isUserScrolledUp.mockReturnValue(false);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(true);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
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

  it("does not snap to bottom when the user was scrolled up at the start of the burst", () => {
    isUserScrolledUp.mockReturnValue(true);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(false);
    expect(scrollToBottom).not.toHaveBeenCalled();
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
