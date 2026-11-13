// A paste streams whatever its size: the engine sends it a window at a time, and
// until its last byte is out an Escape or a Ctrl+C drops the unsent rest. The
// closing bracket always follows what was sent, so the program never stays in
// paste mode, and the interrupt reaches it after that bracket.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mobileToolbar } from "../features/mobile-toolbar.js";
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

const { sendBinary, cancelPendingInput } = fake.connection;
const dec = new TextDecoder();
const enc = new TextEncoder();
const MiB = 1024 * 1024;
const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
});

interface Mounted {
  readonly root: HTMLElement;
  readonly ctx: TerminalContext;
  readonly textarea: HTMLTextAreaElement;
  show(id: string): void;
  states: string[];
}

/** A managed terminal showing one session, with the modes held until a test
 *  announces them when `held`. */
async function mount(opts: { held?: boolean; toolbar?: boolean } = {}): Promise<Mounted> {
  if (opts.held === true) {
    fake.holdModes();
  }
  let captured: TerminalContext | undefined;
  const states: string[] = [];
  const owner: TerminalFeature = {
    name: "session-owner",
    sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
    setup(c) {
      captured = c;
      c.on("connection:state", (s) => {
        states.push(s);
      });
      return { teardown: () => undefined };
    },
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  await mountTerminal(root, {
    features: () => (opts.toolbar === true ? [mobileToolbar(), owner] : [owner]),
  });
  // A pane feature's setup can follow a shell feature's by a task.
  await new Promise((r) => setTimeout(r, 0));
  const ctx = captured;
  const textarea = root.querySelector<HTMLTextAreaElement>(".term-input");
  if (ctx === undefined || textarea === null) {
    throw new Error("the terminal did not mount its owner and input");
  }
  const m: Mounted = {
    root,
    ctx,
    textarea,
    show(id) {
      const session: SessionRef = { id };
      ctx.notifySwitch(session);
    },
    states,
  };
  m.show("s1");
  return m;
}

function pasteInto(textarea: HTMLTextAreaElement, data: string): void {
  textarea.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data }));
}

function press(textarea: HTMLTextAreaElement, init: KeyboardEventInit): void {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init }));
}
const escape = { key: "Escape", code: "Escape" };
const ctrlC = { key: "c", code: "KeyC", ctrlKey: true };

function toast(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>(".wt-toast");
  if (el === null) {
    throw new Error("no toast element");
  }
  return el;
}

/** The last input went out as `text`, and the engine was asked to cancel before it was queued. */
function cancelledBefore(text: string): boolean {
  const cancelAt = cancelPendingInput.mock.invocationCallOrder[0];
  const sendAt = sendBinary.mock.invocationCallOrder.at(-1);
  return (
    fake.sentInput().at(-1) === text &&
    cancelAt !== undefined &&
    sendAt !== undefined &&
    cancelAt < sendAt
  );
}

/** The input the pane queued at `call`, as the engine would encode it. */
function queued(call: number): { paste: boolean; size: number; body: string; tail: string } {
  const input = sendBinary.mock.calls[call]?.[0];
  if (input === undefined || input instanceof Uint8Array) {
    throw new Error(`call ${String(call)} queued no deferred input`);
  }
  const out = input.encode();
  return {
    paste: input.paste === true,
    size: input.size ?? 0,
    body: dec.decode(out?.body),
    tail: dec.decode(out?.tail),
  };
}

function button(root: HTMLElement, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`#${id}`);
  if (el === null) {
    throw new Error(`no #${id}`);
  }
  return el;
}
function tap(el: HTMLElement): void {
  el.dispatchEvent(new PointerEvent("pointerdown", { cancelable: true }));
}
function typeText(textarea: HTMLTextAreaElement, data: string): void {
  textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data }));
}

describe("a paste of any size", () => {
  it("goes to the engine whole, as one cancelable body with the closing bracket as its tail", async () => {
    const m = await mount();
    fake.announceModes({ bracketedPaste: true });
    const text = "x".repeat(2 * MiB);

    pasteInto(m.textarea, text);

    expect(sendBinary).toHaveBeenCalledTimes(1);
    expect(queued(0)).toEqual({ paste: true, size: 2 * MiB, body: OPEN + text, tail: CLOSE });
    expect(m.states).not.toContain("reconnecting");
  });

  it("is still cancelable with bracketed paste off, with nothing to close", async () => {
    const m = await mount();
    fake.announceModes({ bracketedPaste: false });

    pasteInto(m.textarea, "ls");

    expect(queued(0)).toEqual({ paste: true, size: 2, body: "ls", tail: "" });
  });
});

describe("an interrupt while a paste is being sent", () => {
  it("Escape cancels the rest of the paste before the Escape itself is sent", async () => {
    const m = await mount();
    fake.announceModes({ bracketedPaste: true });
    pasteInto(m.textarea, "x".repeat(2 * MiB));
    cancelPendingInput.mockReturnValueOnce(true);

    press(m.textarea, escape);

    expect(cancelledBefore("\x1b")).toBe(true);
    expect(toast(m.root).textContent).toBe("Paste cancelled");
  });

  it("Ctrl+C cancels the rest, and the interrupt follows", async () => {
    const m = await mount();
    fake.announceModes();
    pasteInto(m.textarea, "x".repeat(2 * MiB));

    press(m.textarea, ctrlC);

    expect(cancelledBefore("\x03")).toBe(true);
  });

  it("is read from the key, whatever keyboard protocol the program asked for", async () => {
    const m = await mount();
    fake.announceModes({ keyboardFlags: 1 });

    press(m.textarea, escape);
    press(m.textarea, ctrlC);

    expect(cancelPendingInput).toHaveBeenCalledTimes(2);
    expect(fake.sentInput()).toEqual(["\x1b[27u", "\x1b[99;5u"]);
  });

  it("the toolbar's Escape and a sticky Ctrl+C cancel too", async () => {
    const m = await mount({ toolbar: true });
    fake.announceModes();

    tap(button(m.root, "kb-esc"));
    expect(cancelPendingInput).toHaveBeenCalledTimes(1);
    tap(button(m.root, "kb-ctrl"));
    typeText(m.textarea, "c");

    expect(cancelPendingInput).toHaveBeenCalledTimes(2);
    expect(fake.sentInput()).toEqual(["\x1b", "\x03"]);
  });

  it("other keys and text cancel nothing", async () => {
    const m = await mount();
    fake.announceModes();

    press(m.textarea, { key: "Escape", code: "Escape", altKey: true });
    press(m.textarea, { key: "d", code: "KeyD", ctrlKey: true });
    m.ctx.send(enc.encode("c"));

    expect(cancelPendingInput).not.toHaveBeenCalled();
    expect(toast(m.root).textContent).toBe("");
  });
});

describe("an interrupt while input waits for the modes", () => {
  it("drops a held paste whole: none of it, and no bracket, reaches the program", async () => {
    const m = await mount({ held: true });
    pasteInto(m.textarea, "rm -rf build");

    press(m.textarea, escape);
    fake.announceModes({ bracketedPaste: true });

    expect(fake.sentInput()).toEqual(["\x1b"]);
    expect(toast(m.root).textContent).toBe("Paste cancelled");
  });

  it("drops a held paste for an Escape sent with no key press, read from its bytes", async () => {
    const m = await mount({ held: true });
    pasteInto(m.textarea, "make deploy");
    m.ctx.send(() => enc.encode("\x1b"));
    m.ctx.send(enc.encode("q"));

    fake.announceModes({ bracketedPaste: true });

    expect(fake.sentInput()).toEqual(["\x1b", "q"]);
  });

  it("keeps a paste made after the interrupt", async () => {
    const m = await mount({ held: true });
    press(m.textarea, ctrlC);
    pasteInto(m.textarea, "ok");

    fake.announceModes({ bracketedPaste: false });

    expect(fake.sentInput()).toEqual(["\x03", "ok"]);
  });

  it("a sticky Ctrl+C typed behind a held paste cancels it", async () => {
    const m = await mount({ held: true, toolbar: true });
    pasteInto(m.textarea, "make deploy");
    tap(button(m.root, "kb-ctrl"));
    typeText(m.textarea, "c");

    fake.announceModes({ bracketedPaste: true });

    expect(fake.sentInput()).toEqual(["\x03"]);
    expect(toast(m.root).textContent).toBe("Paste cancelled");
  });

  it("sticky Ctrl takes the character typed after it is armed, not one held before", async () => {
    const m = await mount({ held: true, toolbar: true });
    typeText(m.textarea, "a");
    tap(button(m.root, "kb-ctrl"));
    typeText(m.textarea, "c");

    fake.announceModes();

    expect(fake.sentInput()).toEqual(["a", "\x03"]);
  });

  it("a held sticky Ctrl chord follows the keyboard protocol the modes announce", async () => {
    const m = await mount({ held: true, toolbar: true });
    tap(button(m.root, "kb-ctrl"));
    typeText(m.textarea, "c");

    fake.announceModes({ keyboardFlags: 1 });

    expect(fake.sentInput()).toEqual(["\x1b[99;5u"]);
  });

  it("a sticky Ctrl armed before a paste disarms on it and cancels nothing", async () => {
    const m = await mount({ toolbar: true });
    fake.announceModes();
    tap(button(m.root, "kb-ctrl"));

    pasteInto(m.textarea, "ab");
    typeText(m.textarea, "c");

    expect(cancelPendingInput).not.toHaveBeenCalled();
    expect(fake.sentInput()).toEqual(["ab", "c"]);
  });
});

describe("the pending-paste toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The toast after the engine reports `reports`, under fake timers. */
  async function toastAfter(
    reports: readonly (readonly [number, boolean])[],
  ): Promise<{ el: HTMLElement; root: HTMLElement }> {
    const m = await mount();
    fake.announceModes();
    vi.useFakeTimers();
    const cbs = fake.callbacks();
    for (const [bytes, cancelable] of reports) {
      cbs.onPendingInput?.(bytes, cancelable);
    }
    return { el: toast(m.root), root: m.root };
  }

  it("shows the paste bytes left and how to cancel, and stays up", async () => {
    const { el } = await toastAfter([[2 * MiB, true]]);
    vi.advanceTimersByTime(10_000);
    expect(el.textContent).toBe("Pasting: 2048 KB left. Ctrl+C or Escape cancels");
    expect(el.classList.contains("visible")).toBe(true);
  });

  it("is spoken once, not at every count", async () => {
    const { el, root } = await toastAfter([
      [2 * MiB, true],
      [MiB, true],
    ]);
    const polite = root.querySelector<HTMLElement>(':scope > [aria-live="polite"]');
    vi.advanceTimersByTime(1000);
    expect(polite?.textContent).toBe("Pasting: 2048 KB left. Ctrl+C or Escape cancels");
    expect(el.textContent).toBe("Pasting: 1024 KB left. Ctrl+C or Escape cancels");
    expect(el.getAttribute("aria-live")).toBe("off");
  });

  it("goes away when the paste is all sent", async () => {
    const { el } = await toastAfter([
      [2 * MiB, true],
      [0, false],
    ]);
    expect(el.classList.contains("visible")).toBe(false);
    expect(el.hasAttribute("aria-live")).toBe(false);
  });

  it("is not shown while only typed keys wait", async () => {
    const { el } = await toastAfter([[3, false]]);
    expect(el.classList.contains("visible")).toBe(false);
  });
});
