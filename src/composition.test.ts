// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as composition from "./composition.js";

let textarea: HTMLTextAreaElement;
let view: HTMLElement;
let scrollEl: HTMLElement;
let send: Mock<(bytes: string) => void>;

beforeEach(() => {
  vi.useFakeTimers();
  textarea = document.createElement("textarea");
  view = document.createElement("div");
  scrollEl = document.createElement("div");
  document.body.replaceChildren(textarea, view, scrollEl);
  send = vi.fn<(bytes: string) => void>();
  composition.init({
    textarea,
    compositionView: view,
    scrollEl,
    getCursorPx: () => ({ left: 0, top: 0, cellH: 16 }),
    send,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

function pasteEvent(text: string): ClipboardEvent {
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(ev, "clipboardData", {
    configurable: true,
    value: { getData: (t: string) => (t === "text/plain" ? text : "") },
  });
  return ev;
}

describe("composition: native paste is bracketed and sanitized (paste-jacking defense)", () => {
  it("wraps pasted text in DEC 2004 sentinels and neutralizes an embedded closing marker", () => {
    textarea.dispatchEvent(pasteEvent("ls\n\x1b[201~rm"));
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0] ?? "";
    expect(sent.startsWith("\x1b[200~")).toBe(true);
    expect(sent.endsWith("\x1b[201~")).toBe(true);
    // the injected closing sentinel's ESC is neutralized to U+241B, never sent verbatim
    expect(sent).toContain("\u241B[201~rm");
    expect(sent).not.toContain("\x1b[201~rm");
    // CR/LF normalized to a single CR before bracketing
    expect(sent).toContain("ls\r");
  });

  it("ignores a paste with empty clipboard text", () => {
    textarea.dispatchEvent(pasteEvent(""));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("composition: composition lifecycle", () => {
  it("tracks isComposing across start/end and sends the composed value on the deferred read", () => {
    expect(composition.isComposing()).toBe(false);
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(composition.isComposing()).toBe(true);
    textarea.value = "\u4F60\u597D"; // the IME-composed phrase
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    // compositionend defers the textarea read one tick; still "composing" until it runs
    expect(composition.isComposing()).toBe(true);
    vi.advanceTimersByTime(0);
    expect(composition.isComposing()).toBe(false);
    expect(send).toHaveBeenCalledWith("\u4F60\u597D");
  });
});

describe("composition: mid-line composition strips the trailing suffix", () => {
  it("sends only the composed segment when text follows the composition point", () => {
    textarea.value = "abXY";
    textarea.setSelectionRange(2, 2); // caret between "ab" and the "XY" suffix
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "ab\u65B0XY"; // IME inserted the composed char at the caret
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledWith("\u65B0");
  });
});

describe("composition: positionCompositionView anchors the fixed textarea in viewport space", () => {
  it("subtracts the scroll offset for the textarea but leaves the composition view in content space", () => {
    // Cursor deep in the scrollback (content-space top 5000) with the container
    // scrolled near the bottom. happy-dom does no layout, so pin scrollTop/Left.
    Object.defineProperty(scrollEl, "scrollTop", { value: 4800, configurable: true });
    Object.defineProperty(scrollEl, "scrollLeft", { value: 0, configurable: true });
    composition.init({
      textarea,
      compositionView: view,
      scrollEl,
      getCursorPx: () => ({ left: 40, top: 5000, cellH: 16 }),
      send,
    });

    composition.positionCompositionView();

    // The composition view is position:absolute inside the scroll container, so
    // it scrolls with the content: content-space coords place it at the cursor.
    expect(view.style.top).toBe("5000px");
    // The textarea is position:fixed, so its content-space offset is converted
    // to viewport space (5000 - 4800 = 200). Pre-fix it was left at 5000px,
    // far below the viewport, which made iOS scroll the page up on focus.
    expect(textarea.style.top).toBe("200px");
    expect(textarea.style.left).toBe("40px");
  });
});
