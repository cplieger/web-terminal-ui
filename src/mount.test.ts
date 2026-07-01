// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type * as MountModule from "./mount.js";

const sendBinary = vi.fn<(buf: Uint8Array) => boolean>(() => true);
const connectionInit = vi.fn<(callbacks: Parameters<typeof Engine.connection.init>[0]) => void>();

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  return {
    ...actual,
    render: {
      init: vi.fn(),
      updateFontMetrics: vi.fn(),
      setPredictedCursor: vi.fn(),
      computeSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getCursorPx: vi.fn(() => ({ left: 0, top: 0, cellH: 16 })),
      getHighestIndex: vi.fn(() => -1),
      noteResumeBounds: vi.fn(),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      updateReverseVideo: vi.fn(),
      resetScrollback: vi.fn(),
      resetScreen: vi.fn(),
    },
    scroll: { init: vi.fn(), scrollToBottom: vi.fn() },
    connection: {
      init: connectionInit,
      connect: vi.fn(),
      sendBinary,
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
    },
  };
});

let mount: (typeof MountModule)["mount"];
const dec = new TextDecoder();
const sentText = (): string => sendBinary.mock.calls.map((c) => dec.decode(c[0])).join("");

beforeEach(async () => {
  vi.resetModules();
  sendBinary.mockClear();
  connectionInit.mockClear();
  document.body.replaceChildren();
  ({ mount } = await import("./mount.js"));
});

function mountInRoot(): HTMLTextAreaElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  mount(root);
  return root.querySelector(".term-input") as HTMLTextAreaElement;
}

describe("mount: paste is bracketed and sanitized (paste-jacking defense)", () => {
  it("routes an insertFromPaste input event through bracketed-paste + ESC sanitization", () => {
    const ta = mountInRoot();
    ta.dispatchEvent(
      new InputEvent("input", { inputType: "insertFromPaste", data: "ls\n\x1b[201~rm -rf /" }),
    );
    const sent = sentText();
    expect(sent.startsWith("\x1b[200~")).toBe(true);
    expect(sent.endsWith("\x1b[201~")).toBe(true);
    // the injected closing sentinel's ESC is neutralized to U+241B, never sent verbatim
    expect(sent).toContain("\u241B[201~rm -rf /");
    expect(sent).not.toContain("\x1b[201~rm -rf /");
    // CR/LF normalized to a single CR before bracketing
    expect(sent).toContain("ls\r");
  });

  it("sends typed text (insertText) raw, NOT through the bracketed-paste path", () => {
    const ta = mountInRoot();
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "ab" }));
    const sent = sentText();
    expect(sent).toBe("ab");
    expect(sent).not.toContain("\x1b[200~");
  });
});

describe("mount: desktop Ctrl+Shift+V pastes clipboard text through the bracketed path", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("reads the clipboard and sends the bracketed, sanitized result", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve("echo hi\nrm x") },
    });
    const ta = mountInRoot();
    ta.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, code: "KeyV" }));
    await Promise.resolve();
    await Promise.resolve();
    const sent = sentText();
    expect(sent.startsWith("\x1b[200~")).toBe(true);
    expect(sent).toContain("echo hi\rrm x");
    expect(sent.endsWith("\x1b[201~")).toBe(true);
  });
});

describe("mount: font-load failure degrades to fallback metrics", () => {
  it("still builds the terminal subtree when document.fonts is unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(() => mount(root)).not.toThrow();
    expect(root.querySelector(".term-input")).not.toBeNull();
    expect(root.querySelector(".term-output")).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("mount: typed NBSP is normalized to a real space byte (iOS quirk)", () => {
  it("sends U+0020 where the textarea delivered U+00A0", () => {
    const ta = mountInRoot();
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "a\u00A0b" }));
    expect(sentText()).toBe("a b");
    expect(sentText()).not.toContain("\u00A0");
  });
});

describe("mount: a deletion input event is suppressed by inputType (not forwarded as bytes)", () => {
  it("does not send deleteContentBackward even when the textarea holds forwardable content, and re-pads the placeholder", () => {
    const ta = mountInRoot();
    // Leftover content the fallback path WOULD forward as typed bytes; the
    // deletion branch must short-circuit on inputType before reaching it.
    ta.value = "\u00A0typed";
    ta.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward" }));
    expect(sendBinary).not.toHaveBeenCalled();
    expect(ta.value).toBe("\u00A0");
  });
});

describe("mount: web font settles AFTER the first screen frame (cold-cache race)", () => {
  it("fires markReady when onFontSettled runs after a frame already rendered", async () => {
    // Deterministically control font settling so the first screen frame can
    // arrive while fontsLoaded is still false (the cold-cache race: the large
    // .otf loses the load race to the first tiny server frame). markReady is
    // the single load-complete gate (status.setLoaded + loading-overlay fade);
    // it must fire from the LATER of {first frame, font load}, in either order.
    let settleFont!: () => void;
    const fontLoaded = new Promise<FontFace[]>((resolve) => {
      settleFont = () => resolve([]);
    });
    const fontsDesc = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: vi.fn(() => fontLoaded) },
    });

    try {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const overlay = document.createElement("div"); // consumer-owned loading overlay
      mount(root, { loading: overlay });

      // The screen-frame handler mount wired into connection.init.
      const onMessage = connectionInit.mock.calls[0]![0].onMessage;

      // 1) First screen frame arrives BEFORE the font settles: firstFrameRendered
      //    is set, but fontsLoaded is still false, so markReady must NOT fire yet.
      const frame: Engine.ScreenMessage = {
        type: "screen",
        rows: [],
        base: 0,
        cursor: [0, 0],
        changed: [],
      };
      onMessage(frame);
      expect(overlay.classList.contains("fade")).toBe(false);

      // 2) Font settles after the frame. Pre-fix, onFontSettled never called
      //    markReady, so the overlay stayed up and the status banner stayed
      //    permanently suppressed. Post-fix, the later-of-the-two completion
      //    fires markReady -> overlay fades.
      settleFont();
      await fontLoaded;
      await Promise.resolve();

      expect(overlay.classList.contains("fade")).toBe(true);
    } finally {
      if (fontsDesc) {
        Object.defineProperty(document, "fonts", fontsDesc);
      } else {
        Reflect.deleteProperty(document, "fonts");
      }
    }
  });
});

describe("mount: web font settles BEFORE the first screen frame (warm-cache path)", () => {
  it("fires markReady when the screen frame arrives after the font already settled", async () => {
    // The common warm-cache ordering: the cached font resolves first and the
    // first server frame arrives second. markReady is the later-of-two gate
    // (status.setLoaded + loading-overlay fade), so it must fire from the
    // frame side when the font loaded first.
    let settleFont!: () => void;
    const fontLoaded = new Promise<FontFace[]>((resolve) => {
      settleFont = () => resolve([]);
    });
    const fontsDesc = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: vi.fn(() => fontLoaded) },
    });

    try {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const overlay = document.createElement("div"); // consumer-owned loading overlay
      mount(root, { loading: overlay });

      const onMessage = connectionInit.mock.calls[0]![0].onMessage;

      // Font settles first: fontsLoaded is true but no frame has rendered yet,
      // so markReady must NOT fire and the overlay stays up.
      settleFont();
      await fontLoaded;
      await Promise.resolve();
      expect(overlay.classList.contains("fade")).toBe(false);

      // First screen frame arrives second: the later-of-two completion fires
      // markReady from the onMessage handler -> overlay fades.
      const frame: Engine.ScreenMessage = {
        type: "screen",
        rows: [],
        base: 0,
        cursor: [0, 0],
        changed: [],
      };
      onMessage(frame);
      expect(overlay.classList.contains("fade")).toBe(true);
    } finally {
      if (fontsDesc) {
        Object.defineProperty(document, "fonts", fontsDesc);
      } else {
        Reflect.deleteProperty(document, "fonts");
      }
    }
  });
});

describe("mount: col-0 Backspace brakes only at the true origin (row 0, col 0)", () => {
  // Drive the predicted cursor via a server screen frame: cursor is [row, col]
  // and onScreenFrame re-arms prediction (active), exactly as mount wires it.
  function pushCursor(row: number, col: number): void {
    const onMessage = connectionInit.mock.calls[0]![0].onMessage;
    const frame: Engine.ScreenMessage = {
      type: "screen",
      rows: [],
      base: 0,
      cursor: [row, col],
      changed: [],
    };
    onMessage(frame);
  }

  it("sends a Backspace on a wrapped continuation row (predict row>0, col=0)", () => {
    const ta = mountInRoot();
    // Start of a wrapped continuation row: predict.applyInput models a col-0
    // DEL here by wrapping to the previous row's end, so the DEL must cross the
    // wrap and reach the server rather than being braked.
    pushCursor(2, 0);

    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));

    expect(sendBinary).toHaveBeenCalledTimes(1);
    expect(dec.decode(sendBinary.mock.calls[0]![0])).toBe("\x7f");
  });

  it("suppresses a Backspace at the true origin (predict row=0, col=0)", () => {
    const ta = mountInRoot();
    // Empty-line origin: nothing left to delete; the held-Backspace iOS
    // key-repeat brake is preserved, so no DEL reaches the server.
    pushCursor(0, 0);

    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));

    expect(sendBinary).not.toHaveBeenCalled();
  });

  it("sends a Backspace mid-line on the first row (predict row=0, col>0)", () => {
    const ta = mountInRoot();
    // Editing a command mid-line on the first/only row: the cursor is past
    // col 0, so the origin brake must NOT fire and the Backspace must reach
    // the server. The brake applies only at the true origin (row 0, col 0).
    pushCursor(0, 5);

    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));

    expect(sendBinary).toHaveBeenCalledTimes(1);
    expect(dec.decode(sendBinary.mock.calls[0]![0])).toBe("\x7f");
  });
});

describe("mount: clipboard paste failure surfaces a toast", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows 'Paste blocked' when navigator.clipboard.readText rejects", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.reject(new Error("denied")) },
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    mount(root);
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;

    ta.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, code: "KeyV" }));
    // readText() rejects -> .then is skipped -> .catch runs status.toast; let
    // the two-hop rejection settle before asserting the banner text.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const banner = root.querySelector(".conn-banner");
    expect(banner?.textContent).toBe("Paste blocked");
  });
});

describe("mount: clipboard paste degrades to a toast outside a secure context (no navigator.clipboard)", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("surfaces 'Clipboard unavailable' instead of throwing when navigator.clipboard is undefined", () => {
    // Plain-HTTP non-loopback host (a supported web-terminal-server deployment):
    // navigator.clipboard is undefined, so the feature-detect guard must short-
    // circuit to a toast rather than let navigator.clipboard.readText() throw a
    // synchronous TypeError out of the keydown handler (which would skip
    // preventDefault and fire the browser's native paste).
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const root = document.createElement("div");
    document.body.appendChild(root);
    mount(root);
    const ta = root.querySelector(".term-input") as HTMLTextAreaElement;

    ta.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, code: "KeyV" }));

    expect(sendBinary).not.toHaveBeenCalled();
    const banner = root.querySelector(".conn-banner");
    expect(banner?.textContent).toBe("Clipboard unavailable");
  });
});

describe("mount: a never-connecting initial load fades the loading overlay so 'Offline' is not occluded", () => {
  it("dismisses the overlay after INITIAL_FAILURE_LIMIT failed closes while still unloaded", () => {
    // Wiring check for the loading-overlay vs. 'Offline'-banner gap: status.ts
    // surfaces 'Offline' while still !loaded after INITIAL_FAILURE_LIMIT (4)
    // failed initial connects, but the consumer's opaque loading overlay
    // (z-index:200) is removed only by markReady() on a first screen frame. On
    // a socket that never connects no frame arrives, so without this wiring the
    // overlay would occlude the z-index:20 'Offline' banner forever. mount now
    // passes its overlay-teardown helper to status.init as onGiveUp; status
    // fires it once the failure limit is reached while !loaded, so the overlay
    // fades and the 'Offline' banner beneath becomes visible.
    const fontsDesc = Object.getOwnPropertyDescriptor(document, "fonts");
    // Resolve the font load so no console.warn fires; markReady still cannot run
    // because no screen frame is ever delivered (firstFrameRendered stays false),
    // so the terminal stays !loaded — exactly the never-connecting page.
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: vi.fn(() => Promise.resolve([])) },
    });

    try {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const overlay = document.createElement("div"); // consumer-owned loading overlay
      mount(root, { loading: overlay });

      const onClose = connectionInit.mock.calls[0]![0].onClose;

      // Below INITIAL_FAILURE_LIMIT (4): defer to the loading overlay for a
      // merely-slow first connect — it must stay up, not fade.
      onClose();
      onClose();
      onClose();
      expect(overlay.classList.contains("fade")).toBe(false);

      // The 4th unloaded close reaches the limit: status fires onGiveUp -> mount
      // fades the overlay so the 'Offline' banner beneath is revealed.
      onClose();
      expect(overlay.classList.contains("fade")).toBe(true);
    } finally {
      if (fontsDesc) {
        Object.defineProperty(document, "fonts", fontsDesc);
      } else {
        Reflect.deleteProperty(document, "fonts");
      }
    }
  });
});

describe("mount: a touch tap keeps focus on the textarea so the iOS soft keyboard stays open", () => {
  // The tap focuses the hidden textarea in `pointerup`; iOS then fires a
  // synthetic `mousedown` whose default action would blur it (the display-only
  // .term-output / .term are non-focusable), dismissing the just-opened
  // keyboard. mount() cancels that synthetic mousedown's default for touch.
  function pointer(type: string, pointerType: string, x: number, y: number): Event {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "pointerType", { value: pointerType, configurable: true });
    Object.defineProperty(ev, "clientX", { value: x, configurable: true });
    Object.defineProperty(ev, "clientY", { value: y, configurable: true });
    return ev;
  }

  it("prevents the synthetic mousedown default after a touch tap (textarea stays focused)", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    mount(root);
    const term = root.querySelector(".term") as HTMLElement;

    term.dispatchEvent(pointer("pointerdown", "touch", 5, 5));
    term.dispatchEvent(pointer("pointerup", "touch", 5, 5));

    const md = new Event("mousedown", { bubbles: true, cancelable: true });
    term.dispatchEvent(md);
    // Default prevented => WebKit does not run its focus-move, so the textarea
    // focused in pointerup is not blurred and the keyboard is not dismissed.
    expect(md.defaultPrevented).toBe(true);
  });

  it("leaves a real mouse mousedown default intact so desktop drag-to-select still works", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    mount(root);
    const term = root.querySelector(".term") as HTMLElement;

    term.dispatchEvent(pointer("pointerdown", "mouse", 5, 5));

    const md = new Event("mousedown", { bubbles: true, cancelable: true });
    term.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(false);
  });
});
