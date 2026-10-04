import { describe, it, expect, beforeEach, vi } from "vitest";
import { createKeyboardPresence, type KeyboardPresenceTracker } from "./keyboard-presence.js";

let softKeyboard = 0;
let presence: KeyboardPresenceTracker;
let field: HTMLTextAreaElement;

beforeEach(() => {
  softKeyboard = 0;
  presence = createKeyboardPresence({ win: window, softKeyboardHeight: () => softKeyboard });
  field = document.createElement("textarea");
  document.body.replaceChildren(field);
});

function keydown(
  target: EventTarget,
  init: KeyboardEventInit & { key: string },
  keyCode = 0,
): void {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  // KeyboardEventInit carries no keyCode; the soft-keyboard shapes need 229.
  Object.defineProperty(ev, "keyCode", { value: keyCode });
  target.addEventListener(
    "keydown",
    (e) => {
      presence.noteKeydown(e as KeyboardEvent);
    },
    { once: true },
  );
  target.dispatchEvent(ev);
}

function stubMedia(answers: Record<string, boolean>): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: answers[query] ?? false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe("keyboard presence: what a soft keyboard can send never latches", () => {
  it.each([
    ["Unidentified", 229],
    ["a", 0],
    ["a", 229],
    ["Backspace", 0],
    ["Enter", 0],
  ] as const)("%s (keyCode %d) from the focused input", (key, keyCode) => {
    softKeyboard = 300;
    keydown(field, { key }, keyCode);
    expect(presence.hardwareSeen()).toBe(false);
  });

  it.each([
    [{ key: "ArrowLeft" }, 0],
    [{ key: "Escape" }, 0],
    [{ key: "Tab" }, 120],
    [{ key: "c", ctrlKey: true }, 0],
  ])(
    "refuses an Android on-screen %o, which has no physical code, at a %dpx reading",
    (init, height) => {
      softKeyboard = height;
      keydown(field, { ...init, code: "" });
      expect(presence.hardwareSeen()).toBe(false);
    },
  );

  it("clears a latch at its first key, a letter included", () => {
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    keydown(field, { key: "a", code: "" });
    expect(presence.hardwareSeen()).toBe(false);
  });

  it.each([{ key: "Tab" }, { key: "Tab", shiftKey: true }])(
    "refuses an iPad on-screen %o typed into the input, which carries a real code, undocked at a 0px reading",
    (init) => {
      keydown(field, { ...init, code: "Tab" });
      expect(presence.hardwareSeen()).toBe(false);
    },
  );
});

describe("keyboard presence: a hardware-only key latches", () => {
  it.each(["ArrowLeft", "Escape", "PageUp", "F5", "F12"])(
    "%s in the input with no on-screen keyboard",
    (key) => {
      keydown(field, { key, code: key });
      expect(presence.hardwareSeen()).toBe(true);
    },
  );

  it("a modified key, whatever the key", () => {
    keydown(field, { key: "c", code: "KeyC", metaKey: true });
    expect(presence.hardwareSeen()).toBe(true);
  });

  it("a Tab on the body, where no on-screen keyboard can be typing", () => {
    keydown(document.body, { key: "Tab", code: "Tab" });
    expect(presence.hardwareSeen()).toBe(true);
  });

  it("a modified Tab typed into the input", () => {
    keydown(field, { key: "Tab", code: "Tab", ctrlKey: true });
    expect(presence.hardwareSeen()).toBe(true);
  });

  it("keeps the latch through a hardware IME's Process key, which has a physical code", () => {
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    keydown(field, { key: "Process", code: "KeyA" }, 229);
    expect(presence.hardwareSeen()).toBe(true);
  });
});

describe("keyboard presence: an iOS key, which always carries a code", () => {
  it("latches on an arrow under the iPad shortcut bar, which is far shorter than a keyboard", () => {
    softKeyboard = 60;
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(presence.hardwareSeen()).toBe(true);
  });

  it("refuses an arrow typed into the input over a docked on-screen keyboard", () => {
    softKeyboard = 300;
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(presence.hardwareSeen()).toBe(false);
  });

  it("latches on an arrow on the body, where no on-screen keyboard can be typing", () => {
    softKeyboard = 300;
    keydown(document.body, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(presence.hardwareSeen()).toBe(true);
  });

  it("keeps the latch through a letter", () => {
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    keydown(field, { key: "a", code: "KeyA" });
    expect(presence.hardwareSeen()).toBe(true);
  });

  it("clears it on an Unidentified key", () => {
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    keydown(field, { key: "Unidentified", code: "Unidentified" });
    expect(presence.hardwareSeen()).toBe(false);
  });
});

describe("keyboard presence: the latch clears for an on-screen keyboard", () => {
  it("when a docked keyboard shows with the input focused", () => {
    stubMedia({ "(pointer: coarse)": true });
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    presence.noteSoftKeyboard(300, true);
    expect(presence.hardwareSeen()).toBe(false);
  });

  it("not for a keyboard-sized reading with nothing editable focused", () => {
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    presence.noteSoftKeyboard(300, false);
    expect(presence.hardwareSeen()).toBe(true);
  });

  it("not for the shortcut bar, which is far shorter", () => {
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    presence.noteSoftKeyboard(60, true);
    expect(presence.hardwareSeen()).toBe(true);
  });

  it("not while a mouse or trackpad is attached, whose iPad reading can be a phantom", () => {
    stubMedia({ "(pointer: coarse)": true, "(any-hover: hover)": true });
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    presence.noteSoftKeyboard(300, true);
    expect(presence.hardwareSeen()).toBe(true);
  });
});

describe("keyboard presence: insetSuppressed()", () => {
  it("is false for a plain touch user", () => {
    stubMedia({ "(pointer: coarse)": true });
    expect(presence.insetSuppressed()).toBe(false);
  });

  it("is false for a Pencil, which never answers any-hover", () => {
    stubMedia({ "(pointer: coarse)": true, "(any-pointer: fine)": true });
    expect(presence.insetSuppressed()).toBe(false);
  });

  it("is true with a mouse or trackpad attached, before any key", () => {
    stubMedia({ "(pointer: coarse)": true, "(any-hover: hover)": true });
    expect(presence.insetSuppressed()).toBe(true);
  });

  it("follows the latch on a coarse primary pointer", () => {
    stubMedia({ "(pointer: coarse)": true });
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(presence.insetSuppressed()).toBe(true);
  });
});

describe("keyboard presence: likely()", () => {
  it("is the latch on a coarse primary pointer", () => {
    stubMedia({ "(pointer: coarse)": true });
    expect(presence.likely()).toBe(false);
    keydown(field, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(presence.likely()).toBe(true);
  });

  it("is true with a fine primary pointer and no key seen", () => {
    stubMedia({ "(pointer: fine)": true });
    expect(presence.likely()).toBe(true);
  });

  it("ignores a fine SECONDARY pointer, which a Pencil or a trackpad adds", () => {
    stubMedia({ "(any-pointer: fine)": true, "(pointer: coarse)": true });
    expect(presence.likely()).toBe(false);
  });
});
