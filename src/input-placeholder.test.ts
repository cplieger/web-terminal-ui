import { describe, it, expect } from "vitest";
import { INPUT_PLACEHOLDER, resetToPlaceholder } from "./input-placeholder.js";

describe("input-placeholder: INPUT_PLACEHOLDER is a single NBSP", () => {
  it("is exactly U+00A0 (the iOS held-Backspace primer, not a normal space)", () => {
    expect(INPUT_PLACEHOLDER).toBe("\u00A0");
    expect(INPUT_PLACEHOLDER.length).toBe(1);
    expect(INPUT_PLACEHOLDER).not.toBe(" ");
  });
});

describe("input-placeholder: resetToPlaceholder", () => {
  it("replaces any prior textarea content with the placeholder", () => {
    const ta = document.createElement("textarea");
    ta.value = "leftover typed text";
    resetToPlaceholder(ta);
    expect(ta.value).toBe(INPUT_PLACEHOLDER);
  });

  it("places the caret at the end so the next char appends after the placeholder", () => {
    const ta = document.createElement("textarea");
    resetToPlaceholder(ta);
    expect(ta.selectionStart).toBe(INPUT_PLACEHOLDER.length);
    expect(ta.selectionEnd).toBe(INPUT_PLACEHOLDER.length);
  });

  it("moves the caret back to the end when re-padding a textarea that already holds it", () => {
    // This is the production path, and the one the explicit range exists for:
    // the kernel re-pads after every send, so the value being assigned is the
    // one already there. A DOM moves the caret to the end only when the value
    // CHANGES, so on a re-pad the caret stays wherever the last input left it —
    // and a caret before the placeholder means the next typed character lands in
    // front of it, which is what stops iOS repeating deleteContentBackward.
    const ta = document.createElement("textarea");
    resetToPlaceholder(ta);
    ta.setSelectionRange(0, 0);

    resetToPlaceholder(ta);

    expect(ta.selectionStart).toBe(INPUT_PLACEHOLDER.length);
    expect(ta.selectionEnd).toBe(INPUT_PLACEHOLDER.length);
  });

  it("re-seeds an already-empty textarea (idempotent priming)", () => {
    const ta = document.createElement("textarea");
    ta.value = "";
    resetToPlaceholder(ta);
    expect(ta.value).toBe(INPUT_PLACEHOLDER);
  });

  it("still sets the value when setSelectionRange throws (older WebKit)", () => {
    const ta = document.createElement("textarea");
    ta.setSelectionRange = () => {
      throw new Error("InvalidStateError");
    };
    expect(() => {
      resetToPlaceholder(ta);
    }).not.toThrow();
    expect(ta.value).toBe(INPUT_PLACEHOLDER);
  });
});
