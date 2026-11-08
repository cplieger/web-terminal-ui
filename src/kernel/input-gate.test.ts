// Input before the modes are known: after a switch the mode state holds
// power-on values until the server's modes frame, and across a reconnect the
// previous socket's, and input encoded under them can reach a program as bytes
// it never asked for (an unbracketed multi-line paste runs each line). The pane
// hands every input to the engine connection at once, which encodes it when the
// frame lands; the fake models that queue.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import type { SessionRef, TerminalContext, TerminalFeature } from "./types.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const { sendBinary } = fake.connection;
const enc = new TextEncoder();
const sentText = (): string => fake.sentInput().join("");

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
});

interface Mounted {
  readonly ctx: TerminalContext;
  readonly textarea: HTMLTextAreaElement;
  show(id: string): void;
}

/** A managed terminal whose owner shows sessions on demand, with the fake
 *  holding the modes until a test announces them. */
async function mountHeld(): Promise<Mounted> {
  fake.holdModes();
  let captured: TerminalContext | undefined;
  const owner: TerminalFeature = {
    name: "session-owner",
    sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
    setup(c) {
      captured = c;
      return { teardown: () => undefined };
    },
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  await mountTerminal(root, { features: () => [owner] });
  const ctx = captured;
  const textarea = root.querySelector<HTMLTextAreaElement>(".term-input");
  if (ctx === undefined || textarea === null) {
    throw new Error("the terminal did not mount its owner and input");
  }
  return {
    ctx,
    textarea,
    show(id) {
      const session: SessionRef = { id };
      ctx.notifySwitch(session);
    },
  };
}

function type(textarea: HTMLTextAreaElement, data: string): void {
  textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data }));
}

function pasteInto(textarea: HTMLTextAreaElement, data: string): void {
  textarea.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data }));
}

function arrowUp(textarea: HTMLTextAreaElement): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", cancelable: true });
  textarea.dispatchEvent(ev);
  return ev;
}

describe("input typed before the shown session's modes are known", () => {
  it("holds a paste and brackets it by the modes frame's value", async () => {
    const m = await mountHeld();
    m.show("s1");
    pasteInto(m.textarea, "echo a\necho b");
    expect(sentText()).toBe("");

    fake.announceModes({ bracketedPaste: true });
    expect(sentText()).toBe("\x1b[200~echo a\recho b\x1b[201~");
  });

  it("sends a held paste bare when the program has bracketed paste off", async () => {
    const m = await mountHeld();
    m.show("s1");
    pasteInto(m.textarea, "ls");
    fake.announceModes({ bracketedPaste: false });
    expect(sentText()).toBe("ls");
  });

  it("claims a key at once and encodes it under the announced modes", async () => {
    const m = await mountHeld();
    m.show("s1");
    const ev = arrowUp(m.textarea);
    expect(ev.defaultPrevented).toBe(true);
    expect(sentText()).toBe("");

    fake.announceModes({ applicationCursor: true });
    expect(sentText()).toBe("\x1bOA");
  });

  it("delivers held input in the order it was typed", async () => {
    const m = await mountHeld();
    m.show("s1");
    type(m.textarea, "a");
    arrowUp(m.textarea);
    m.ctx.send(enc.encode("c"));
    type(m.textarea, "d");

    fake.announceModes({ applicationCursor: true });
    expect(sentText()).toBe("a\x1bOAcd");
  });

  it("encodes a feature's key under the modes it is sent with", async () => {
    const m = await mountHeld();
    m.show("s1");
    m.ctx.send((modes) => enc.encode(modes.isApplicationCursor() ? "known" : "power-on"));
    expect(sentText()).toBe("");

    fake.announceModes({ applicationCursor: true });
    expect(sentText()).toBe("known");
  });

  it("sends input at once while the modes are known", async () => {
    const m = await mountHeld();
    m.show("s1");
    fake.announceModes();
    type(m.textarea, "x");
    expect(sentText()).toBe("x");
  });

  it("queues input for the session shown when it was typed, never for the next", async () => {
    const m = await mountHeld();
    m.show("s1");
    type(m.textarea, "for s1");
    m.show("s2");
    fake.announceModes();
    expect(sentText()).toBe("");

    type(m.textarea, "y");
    expect(sentText()).toBe("y");
    m.show("s3");
    type(m.textarea, "z");
    expect(sentText()).toBe("y");
  });
});

describe("input typed while the link is down", () => {
  async function mountReconnecting(): Promise<Mounted> {
    const m = await mountHeld();
    m.show("s1");
    fake.announceModes();
    fake.connection.reconnectNow();
    return m;
  }

  it("goes to the engine at once, so a server restart drops it with the rest", async () => {
    const m = await mountReconnecting();
    type(m.textarea, "make deploy");
    m.textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", cancelable: true }),
    );
    expect(sendBinary).toHaveBeenCalledTimes(2);

    fake.restartServer();
    fake.announceModes();

    expect(sentText()).toBe("");
  });

  it("hands a paste to the engine as a paste of its size, for the pending toast", async () => {
    const m = await mountReconnecting();
    pasteInto(m.textarea, "x".repeat(3000));

    expect(sendBinary.mock.calls.at(-1)?.[0]).toMatchObject({ paste: true, size: 3000 });
  });
});

describe("a numpad key pressed before the modes are known", () => {
  function numpad5(textarea: HTMLTextAreaElement): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { key: "5", code: "Numpad5", cancelable: true });
    textarea.dispatchEvent(ev);
    return ev;
  }

  // xterm ctlseqs, "PC-Style Function Keys": under DECKPAM keypad 5 sends SS3 u.
  it("follows an application keypad the modes announce", async () => {
    const m = await mountHeld();
    m.show("s1");
    const ev = numpad5(m.textarea);
    expect(ev.defaultPrevented).toBe(true);

    fake.announceModes({ applicationKeypad: true });
    expect(sentText()).toBe("\x1bOu");
  });

  it("types its digit when the modes announce the keypad off, after a stale DECKPAM", async () => {
    const m = await mountHeld();
    m.show("s1");
    fake.announceModes({ applicationKeypad: true });
    fake.connection.reconnectNow();
    const ev = numpad5(m.textarea);
    expect(ev.defaultPrevented).toBe(true);

    fake.announceModes({ applicationKeypad: false });
    expect(sentText()).toBe("5");
  });
});

// A keydown's default is decided before the modes are known and cannot be given
// back, so a key the modes may leave unsent is never taken from the browser.
describe("a chord or a page key pressed before the modes are known", () => {
  function press(textarea: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { cancelable: true, ...init });
    textarea.dispatchEvent(ev);
    return ev;
  }
  const ctrl1 = { key: "1", code: "Digit1", ctrlKey: true };
  const ctrlEqual = { key: "=", code: "Equal", ctrlKey: true };
  // With NumLock on, Shift+keypad 9 reaches the page as PageUp from the keypad.
  const shiftNumpad9 = { key: "PageUp", code: "Numpad9", shiftKey: true };

  it("leaves Ctrl+1 to the browser, and sends nothing when the modes are legacy", async () => {
    const m = await mountHeld();
    m.show("s1");
    const ev = press(m.textarea, ctrl1);
    expect(ev.defaultPrevented).toBe(false);

    fake.announceModes();
    expect(sentText()).toBe("");
  });

  // Kitty disambiguate is flag 1 (kitty keyboard protocol, "Progressive enhancement").
  it("leaves Ctrl+= to the browser across a reconnect from a kitty program", async () => {
    const m = await mountHeld();
    m.show("s1");
    fake.announceModes({ keyboardFlags: 1 });
    fake.connection.reconnectNow();
    const ev = press(m.textarea, ctrlEqual);
    expect(ev.defaultPrevented).toBe(false);

    fake.announceModes();
    expect(sentText()).toBe("");
  });

  it("scrolls on Shift+keypad 9 when the modes announce the keypad off, after a stale DECKPAM", async () => {
    const m = await mountHeld();
    m.show("s1");
    fake.announceModes({ applicationKeypad: true });
    fake.connection.reconnectNow();
    const ev = press(m.textarea, shiftNumpad9);
    expect(ev.defaultPrevented).toBe(true);
    expect(fake.scroll.scrollByPage).not.toHaveBeenCalled();

    fake.announceModes({ applicationKeypad: false });
    expect(fake.scroll.scrollByPage.mock.calls).toEqual([[-1]]);
    expect(fake.scroll.scrollToBottom).not.toHaveBeenCalled();
    expect(sentText()).toBe("");
  });

  // xterm ctlseqs, "PC-Style Function Keys": under DECKPAM keypad 9 sends SS3 y.
  it("sends Shift+keypad 9 as the keypad key when the modes announce DECKPAM", async () => {
    const m = await mountHeld();
    m.show("s1");
    const ev = press(m.textarea, shiftNumpad9);
    expect(ev.defaultPrevented).toBe(true);
    expect(fake.scroll.scrollToBottom).not.toHaveBeenCalled();

    fake.announceModes({ applicationKeypad: true });
    expect(sentText()).toBe("\x1bOy");
    expect(fake.scroll.scrollByPage).not.toHaveBeenCalled();
    expect(fake.scroll.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("ends at the bottom when a letter is typed after a held Shift+keypad 9", async () => {
    const m = await mountHeld();
    m.show("s1");
    fake.announceModes({ applicationKeypad: true });
    fake.connection.reconnectNow();
    press(m.textarea, shiftNumpad9);
    type(m.textarea, "a");
    expect(fake.scroll.scrollToBottom).not.toHaveBeenCalled();

    fake.announceModes({ applicationKeypad: false });
    expect(sentText()).toBe("a");
    expect(fake.scroll.scrollByPage.mock.calls).toEqual([[-1]]);
    const lastPage = fake.scroll.scrollByPage.mock.invocationCallOrder.at(-1) ?? 0;
    const lastBottom = fake.scroll.scrollToBottom.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastBottom).toBeGreaterThan(lastPage);
  });

  it("snaps to the bottom when held input is encoded, not when it is typed", async () => {
    const m = await mountHeld();
    m.show("s1");
    type(m.textarea, "a");
    expect(fake.scroll.scrollToBottom).not.toHaveBeenCalled();

    fake.announceModes();
    expect(fake.scroll.scrollToBottom).toHaveBeenCalledTimes(1);
  });
});
