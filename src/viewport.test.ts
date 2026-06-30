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
    Reflect.deleteProperty(window, "visualViewport");
    document.documentElement.style.removeProperty("--kb-inset");
    document.documentElement.style.removeProperty("--vv-top");
  });

  it("lifts the term wrap and publishes --kb-inset/--vv-top when the keyboard shrinks the viewport", () => {
    const vv = {
      height: window.innerHeight - 200,
      offsetTop: 30,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    const tw = document.createElement("div");
    document.body.replaceChildren(tw);
    viewport.init({ termWrap: tw, onSettled: vi.fn() });
    expect(tw.style.bottom).toBe("200px");
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("200px");
    expect(document.documentElement.style.getPropertyValue("--vv-top")).toBe("30px");
  });

  it("clears the bottom inset and zeroes --kb-inset when the keyboard closes (inset === 0)", () => {
    const vv = {
      height: window.innerHeight,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    const tw = document.createElement("div");
    document.body.replaceChildren(tw);
    viewport.init({ termWrap: tw, onSettled: vi.fn() });
    expect(tw.style.bottom).toBe("");
    expect(document.documentElement.style.getPropertyValue("--kb-inset")).toBe("0px");
  });
});
