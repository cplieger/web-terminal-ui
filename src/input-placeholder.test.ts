// @vitest-environment happy-dom
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
