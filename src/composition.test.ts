// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as composition from "./composition.js";
import { keyboard } from "@cplieger/web-terminal-engine";

const { bracketTextForPaste, prepareTextForTerminal } = keyboard;

let textarea: HTMLTextAreaElement;
let view: HTMLElement;
let send: Mock<(bytes: string) => void>;
let paste: Mock<(text: string) => void>;

beforeEach(() => {
  vi.useFakeTimers();
  textarea = document.createElement("textarea");
  view = document.createElement("div");
  document.body.replaceChildren(textarea, view);
  send = vi.fn<(bytes: string) => void>();
  // Mirror the kernel's single paste funnel: composition delegates to paste(),
  // so the funnel (bracket + newline-normalize) is applied here and forwarded to
  // send, keeping the paste-jacking assertions on `send` meaningful.
  paste = vi.fn<(text: string) => void>((text) => {
    send(bracketTextForPaste(prepareTextForTerminal(text)));
  });
  composition.init({
    textarea,
    compositionView: view,
    getCursorPx: () => ({ left: 0, top: 0, cellH: 16 }),
    send,
    paste,
  });
});
afterEach(() => {
  // The module keeps composing/sendingComposition at module scope, so a case
  // that leaves a composition open would hand it to the next one.
  composition.cancelComposition();
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

// happy-dom's CompositionEvent constructor drops the `data` init member, so the
// in-progress text has to be planted on the event the same way clipboardData is.
function compositionUpdate(data: string): CompositionEvent {
  const ev = new CompositionEvent("compositionupdate");
  Object.defineProperty(ev, "data", { configurable: true, value: data });
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

  it("prevents the browser's own insertion of the pasted text", () => {
    // Without preventDefault the browser also drops the text into the hidden
    // textarea, which the next input event would then send a second time.
    const ev = pasteEvent("ls");
    textarea.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("keeps the paste from reaching a document-level handler", () => {
    const documentPaste = vi.fn();
    document.addEventListener("paste", documentPaste);
    textarea.dispatchEvent(pasteEvent("ls"));
    document.removeEventListener("paste", documentPaste);
    expect(documentPaste).not.toHaveBeenCalled();
  });

  it("restores the placeholder so held-Backspace keeps repeating after a paste", () => {
    textarea.dispatchEvent(pasteEvent("ls"));
    expect(textarea.value).toBe("\u00A0"); // INPUT_PLACEHOLDER
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

describe("composition: cancelComposition (tab-switch detach, design 5.1)", () => {
  it("aborts an in-flight composition without sending and clears the view", () => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "\u4F60\u597D";
    view.textContent = "\u4F60\u597D";
    view.classList.add("active");
    expect(composition.isComposing()).toBe(true);

    composition.cancelComposition();

    expect(composition.isComposing()).toBe(false);
    expect(view.classList.contains("active")).toBe(false);
    expect(view.textContent).toBe("");
    vi.advanceTimersByTime(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("neutralizes a just-ended composition whose deferred send is still pending", () => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "\u4F60\u597D";
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    // The deferred send is queued but has not run yet; a switch lands here.
    composition.cancelComposition();
    vi.advanceTimersByTime(0);
    // The composed text must not be delivered to whoever is active after the switch.
    expect(send).not.toHaveBeenCalled();
  });

  it("restores the placeholder so held-Backspace still repeats on the new session", () => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "\u4F60\u597D";

    composition.cancelComposition();

    expect(textarea.value).toBe("\u00A0"); // INPUT_PLACEHOLDER
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

describe("composition: positionCompositionView anchors the textarea at the content cursor", () => {
  it("places the textarea and composition view at the same cursor coordinates", () => {
    // The textarea is position:absolute in the terminal's content space (like
    // the composition view), so both take the cursor's content coordinates
    // directly; .term being pinned to the visual viewport (viewport.ts) is what
    // keeps that on-screen above the keyboard.
    composition.init({
      textarea,
      compositionView: view,
      getCursorPx: () => ({ left: 40, top: 5000, cellH: 16 }),
      send,
      paste,
    });

    composition.positionCompositionView();

    expect(view.style.top).toBe("5000px");
    expect(textarea.style.top).toBe("5000px");
    expect(textarea.style.left).toBe("40px");
  });
});

describe("composition: compositionstart opens the view at the cursor", () => {
  it("marks the view active so the in-progress phrase is visible", () => {
    expect(view.classList.contains("active")).toBe(false);
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(view.classList.contains("active")).toBe(true);
  });

  it("anchors the view on the cursor row", () => {
    // The harness's getCursorPx reports a 16px cell; the view takes that height
    // only if compositionstart positions it.
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(view.style.height).toBe("16px");
  });
});

describe("composition: compositionupdate mirrors the in-progress phrase", () => {
  it("wraps the in-progress text in LTR marks so a long composition shows its tail", () => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.dispatchEvent(compositionUpdate("\u3042\u3044"));
    expect(view.textContent).toBe("\u200E\u3042\u3044\u200E");
  });

  it("re-anchors the view as the cursor advances mid-composition", () => {
    const cursor = { left: 12, top: 34, cellH: 16 };
    composition.init({
      textarea,
      compositionView: view,
      getCursorPx: () => cursor,
      send,
      paste,
    });
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    cursor.left = 96;

    textarea.dispatchEvent(compositionUpdate("\u3042"));

    expect(view.style.left).toBe("96px");
  });
});

describe("composition: compositionend hides the view", () => {
  it("drops the active class as soon as the composition ends", () => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(view.classList.contains("active")).toBe(true);

    textarea.dispatchEvent(new CompositionEvent("compositionend"));

    expect(view.classList.contains("active")).toBe(false);
  });
});

describe("composition: composing over a selected range", () => {
  it("sends the replaced segment without the text that trails the selection", () => {
    textarea.value = "abXYZ";
    textarea.setSelectionRange(2, 4); // "XY" is selected; "Z" trails the composition
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "ab\u65B0Z"; // the IME replaced the selected range
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledWith("\u65B0");
  });
});

describe("composition: the IME rewrote the tail", () => {
  it("sends everything after the composition point when the captured suffix is gone", () => {
    // Chromium's Korean/Chinese IMEs rewrite characters around the caret on
    // commit, so the value at the deferred read need not still end with the
    // suffix captured at compositionstart. When it does not, the whole tail is
    // the composition — chopping a suffix length off it would drop real input.
    textarea.value = "abXY";
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "ab\u65B0"; // the commit swallowed the trailing "XY"
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledWith("\u65B0");
  });
});

describe("composition: a composition that produced nothing", () => {
  it("sends nothing when the IME was dismissed without composing text", () => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    vi.advanceTimersByTime(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("restores the placeholder after the composed text is sent", () => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.value = "\u4F60";
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    vi.advanceTimersByTime(0);
    expect(textarea.value).toBe("\u00A0"); // INPUT_PLACEHOLDER
  });
});

describe("composition: teardown releases the kernel it was initialised with", () => {
  it("cancels an in-flight composition so a remount does not inherit it", () => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(composition.isComposing()).toBe(true);

    composition.teardown();

    expect(composition.isComposing()).toBe(false);
  });

  it("stops listening for compositionstart", () => {
    composition.teardown();
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(composition.isComposing()).toBe(false);
  });

  it("stops listening for compositionupdate", () => {
    composition.teardown();
    textarea.dispatchEvent(compositionUpdate("\u3042"));
    expect(view.textContent).toBe("");
  });

  it("stops listening for compositionend", () => {
    composition.teardown();
    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    // compositionend would arm the deferred send, which isComposing() reports.
    expect(composition.isComposing()).toBe(false);
  });

  it("stops listening for the native paste", () => {
    composition.teardown();
    const ev = pasteEvent("ls");
    textarea.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
