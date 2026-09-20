// The mouse-reporting seam: the engine's mouse controller reports over the
// pane's transport, and the kernel owns the pointer shape that tells the user
// who a click belongs to.
//
// The engine's mouse controller and mode state are REAL here, over the fake's
// renderer and connection spies: a mocked encoder could not show that a modes
// frame plus a real mousedown puts real SGR bytes on the transport, which is the
// whole defect this seam had.
//
// The stylesheet is loaded because the pointer shape is a CSS fact: the kernel
// toggles one class and the cascade decides three cursors from it (the grid, a
// link inside the grid, and the resting state). Reading the rules back as text
// would assert the declarations exist, not that they win.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import type {
  CreateTerminalOptions,
  SessionRef,
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
} from "./types.js";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  return createEngineFake({ realMouse: true });
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const { sendBinary, sendEphemeral, setClientFocus } = fake.connection;
const { scrollToBottom } = fake.scroll;
// Deliberately DIFFERENT row counts: computeSize is what this client would fit,
// gridSize is what is rendered, and the two disagree whenever another attached
// client resized the session or a local resize is still unanswered. The row hit
// test anchors on the number it is given, so a kernel wired to the wrong one
// reports a different row for every press below.
fake.renderer.computeSize.mockImplementation(() => ({ cols: 80, rows: 30 }));

const MANIFESTS = import.meta.glob("../../css/MANIFEST*", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHEETS = import.meta.glob("../../css/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const byName = (mods: Record<string, string>): Map<string | undefined, string> =>
  new Map(Object.entries(mods).map(([p, text]) => [p.split("/").pop(), text]));

// The full-page manifest, whose order IS the cascade, so it is read rather than
// restated.
const BUNDLE = ((): string => {
  const manifest = byName(MANIFESTS).get("MANIFEST");
  if (manifest === undefined) {
    throw new Error("css/MANIFEST is missing");
  }
  const sheets = byName(SHEETS);
  return manifest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((name) => {
      const text = sheets.get(name);
      if (text === undefined) {
        throw new Error(`css/MANIFEST names ${name}, which css/ does not contain`);
      }
      return text;
    })
    .join("\n");
})();

let styles: HTMLStyleElement;
/** Undoes the `document.fonts` shadow installed in beforeEach. */
let restoreFonts: () => void = () => undefined;

/** Installs a font load that has already resolved, so the kernel's font gate opens
 *  without reaching for the @font-face URLs page.css declares (which resolve to
 *  nothing here and would each log a network failure). `fonts` is an accessor on
 *  Document.prototype, so the restore removes the own shadow rather than deleting
 *  the platform's real FontFaceSet. */
function shadowFonts(): () => void {
  const saved = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    value: { load: () => Promise.resolve([]) },
    configurable: true,
    writable: true,
  });
  return () => {
    if (saved) {
      Object.defineProperty(document, "fonts", saved);
    } else {
      Reflect.deleteProperty(document, "fonts");
    }
  };
}

beforeAll(() => {
  styles = document.createElement("style");
  styles.textContent = BUNDLE;
  document.head.appendChild(styles);
});

afterAll(() => {
  styles.remove();
});

interface Terminal {
  readonly term: TerminalHandle;
  readonly termWrap: HTMLElement;
  readonly outputEl: HTMLElement;
  readonly input: HTMLTextAreaElement;
}

function pick(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`the kernel built no ${selector}`);
  }
  return el;
}

/** Mounts a terminal and gives its grid the geometry the hit test is measured
 *  against: 80x24 cells of 8x17px, anchored at the viewport origin, matching the
 *  RENDERED grid the mocked gridSize announces. Stated rather than inherited,
 *  because an empty `.term-output` is zero-height, so every reported row would be
 *  a clamp. */
async function mountGrid(
  features: TerminalFeature<unknown>[] = [],
  over: Partial<CreateTerminalOptions> = {},
): Promise<Terminal> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const term = await mountTerminal(root, { features: () => features, ...over });
  const outputEl = pick(root, ".term-output");
  Object.assign(outputEl.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: "640px",
    height: "408px",
  });
  return {
    term,
    termWrap: pick(root, ".term"),
    outputEl,
    input: pick(root, ".term-input") as HTMLTextAreaElement,
  };
}

beforeEach(() => {
  fake.reset();
  // computeSize is re-declared here because vitest resets every spy's
  // implementation to its construction default before each test.
  fake.renderer.computeSize.mockImplementation(() => ({ cols: 80, rows: 30 }));
  document.body.replaceChildren();
  restoreFonts = shadowFonts();
});

afterEach(() => {
  restoreFonts();
  restoreFonts = () => undefined;
});

function modesFrame(over: Partial<Engine.ModesMessage> = {}): Engine.ModesMessage {
  return {
    type: "modes",
    bracketedPaste: true,
    applicationCursor: false,
    applicationKeypad: false,
    mouseSGR: false,
    focusReporting: false,
    reverseVideo: false,
    mousePixels: false,
    mouseMode: 0,
    keyboardFlags: 0,
    ...over,
  };
}

/** Delivers a modes frame the way the transport does: the mode state is applied
 *  FIRST, then the frame is forwarded to the kernel. */
function deliverModes(frame: Engine.ModesMessage): void {
  fake.callbacks().onMessage(frame);
}

/**
 * The engine's socket-open callback, which is what a reconnect reaches.
 *
 * Not where the gesture resync happens: the resumeAck is what declares the
 * server's capabilities, so the kernel waits for it (driveResumeAck below).
 */
function driveOpen(): void {
  fake.callbacks().onOpen();
}

/**
 * The first frame of every attach, carrying the server's capability declaration.
 * `received: 0` is a fresh ledger; nothing here depends on the byte counts.
 */
function driveResumeAck(): void {
  fake.callbacks().onMessage({ type: "resumeAck", received: 0 });
}

/** A left press at a point inside the grid built by mountTerminal. */
function pressAt(el: HTMLElement, clientX: number, clientY: number, shiftKey = false): void {
  el.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      clientY,
      shiftKey,
    }),
  );
}

/** Every report the mouse module handed the transport. Reports go out as
 *  EPHEMERAL input, so `sendBinary` (the reliable outbox) is where they must NOT
 *  appear. */
function sent(): string[] {
  return sendEphemeral.mock.calls.map(([data]) => data);
}

function addLink(outputEl: HTMLElement): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "term-link";
  link.href = "https://example.com/docs";
  link.textContent = "docs";
  outputEl.appendChild(link);
  return link;
}

describe("mouse module installation", () => {
  it("detaches on destroy, so a re-mount cannot report through the old element", async () => {
    const { outputEl, term } = await mountGrid();
    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true }));
    term.destroy();
    sendEphemeral.mockClear();

    pressAt(outputEl, 76, 80);

    expect(sent()).toEqual([]);
  });
});

describe("mouse reports on the wire", () => {
  it("puts a press on the transport as an SGR 1006 report", async () => {
    const { outputEl } = await mountGrid();
    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true }));
    sendEphemeral.mockClear();

    // (76, 80) in a 640x408 grid of 8x17 cells: column 10, and row 5 counted from
    // the grid's BOTTOM edge, which is where the screen window sits. The count is
    // the RENDERED 24 rows; against the measured 30 the same press reports row 11.
    pressAt(outputEl, 76, 80);

    expect(sent()).toEqual(["\x1b[<0;10;5M"]);
  });

  it("does not snap the view to the bottom for a report", async () => {
    // The kernel's own send funnel re-engages follow on every accepted byte, which
    // would jump the viewport on every motion report. Mouse bytes bypass it.
    const { outputEl } = await mountGrid();
    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true }));
    scrollToBottom.mockClear();

    pressAt(outputEl, 76, 80);

    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("sends nothing while no application holds the mouse", async () => {
    const { outputEl } = await mountGrid();
    deliverModes(modesFrame({ mouseMode: 0, mouseSGR: true }));
    sendEphemeral.mockClear();

    pressAt(outputEl, 76, 80);

    expect(sent()).toEqual([]);
  });

  it("leaves a shifted press to the browser, so text is still selectable", async () => {
    const { outputEl } = await mountGrid();
    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true }));
    sendEphemeral.mockClear();

    pressAt(outputEl, 76, 80, true);

    expect(sent()).toEqual([]);
  });

  it("reports the widget's focus to the transport, and writes no DEC 1004 bytes", async () => {
    // CSI I / CSI O assert the TERMINAL's focus, and the server is the party that
    // knows it: it holds every attached client's report plus its own hold. So the
    // kernel reports its widget's state and the server decides what the
    // application is told.
    const { termWrap } = await mountGrid();
    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true, focusReporting: true }));
    setClientFocus.mockClear();
    sendBinary.mockClear();
    sendEphemeral.mockClear();

    termWrap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    termWrap.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    expect(setClientFocus.mock.calls).toEqual([[true], [false]]);
    expect(sendBinary).not.toHaveBeenCalled();
    expect(sent()).toEqual([]);
  });

  it("seeds the widget's focus before the first focus event", async () => {
    // A terminal mounted with its textarea already focused would otherwise report
    // blurred until the user clicked away, so an application enabling DEC 1004 on
    // startup would be told the opposite of the truth.
    await mountGrid();

    expect(setClientFocus).toHaveBeenCalled();
    expect(setClientFocus.mock.calls[0]).toEqual([false]);
  });

  it("treats focus moving WITHIN the terminal as no blur at all", async () => {
    // The hidden textarea lives inside the scroll container, so a focus move
    // between the terminal's own elements bubbles a focusout here. Reporting it
    // would tell the application the terminal lost focus while the user is typing
    // into it.
    const { termWrap, input } = await mountGrid();
    setClientFocus.mockClear();

    termWrap.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: input }));

    expect(setClientFocus).not.toHaveBeenCalled();
  });

  it("withholds the blur a press causes and the focus its own click restores", async () => {
    // The churn this removes: a press over the display-only output blurs the
    // hidden textarea, the click handler restores it, and reporting both told an
    // application FocusLost then FocusGained for every click (measured at 3600
    // reports in 90s of clicking). The terminal never lost focus; xterm.js emits
    // nothing here because its textarea keeps focus through the click.
    const { termWrap, outputEl, input } = await mountGrid();
    deliverModes(modesFrame({ focusReporting: true }));
    input.focus();
    setClientFocus.mockClear();

    termWrap.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }));
    termWrap.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(setClientFocus).not.toHaveBeenCalled();
    termWrap.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true }));
    // What the browser does next, in the same task: the click handler focuses the
    // textarea again, so the gesture's end state is focused.
    outputEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One report of the END state, and it matches what was already reported, so
    // nothing reaches the application.
    expect(setClientFocus.mock.calls).toEqual([[true]]);
  });

  it("reports the blur when the gesture ends with focus genuinely gone", async () => {
    // The other half, and why the blur is deferred rather than dropped: the click
    // handler declines to restore focus while a selection exists (focusing the
    // textarea would collapse it), so the terminal really is blurred and the
    // application has to be told.
    const { termWrap, input } = await mountGrid();
    deliverModes(modesFrame({ focusReporting: true }));
    input.focus();
    setClientFocus.mockClear();

    termWrap.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }));
    input.blur();
    termWrap.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    termWrap.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setClientFocus.mock.calls).toEqual([[false]]);
  });

  it("cancels an in-flight gesture when the socket comes back", async () => {
    // A press whose release never reached the server leaves the application
    // holding a button down for the rest of the session. The engine reports the
    // PRESENT state once the resumeAck has declared the server's capabilities, so
    // a button the browser now says is up gets one release at the coordinates its
    // press reported. The open alone is deliberately not enough: the ephemeral
    // channel is not known yet there, so the release would ride the reliable
    // outbox and become the one replayable mouse report.
    const { outputEl } = await mountGrid();
    deliverModes(modesFrame({ mouseMode: 1002, mouseSGR: true }));
    outputEl.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: 76,
        clientY: 80,
      }),
    );
    // The release happened off this element (a drag out of the page), so all the
    // browser ever tells us is that the button is no longer held.
    outputEl.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        buttons: 0,
        clientX: 76,
        clientY: 80,
      }),
    );
    expect(sent()).toEqual(["\x1b[<0;10;5M"]);
    sendEphemeral.mockClear();

    // Neither kernel-visible edge triggers it. The transport owns the trigger
    // (connection fires it at the end of its resumeAck handling, where `upgraded`
    // and the capability bits are both set), so a kernel-side call would be a
    // second one on the wrong edge.
    driveOpen();
    driveResumeAck();
    expect(sent()).toEqual([]);

    fake.engine().mouse.resyncGesture();

    expect(sent()).toEqual(["\x1b[<0;10;5m"]);
  });

  it("disarms a held gesture on a session switch, so the incoming open reports nothing", async () => {
    // `mouse.init` runs once per terminal while sessions multiplex over the socket,
    // so a record kept across the switch would make the incoming session's open
    // synthesize a release for a press its application never saw. Tracking is
    // still on here, so the disarm is the only thing that can silence it.
    let ctx: TerminalContext | undefined;
    const owner: TerminalFeature = {
      name: "session-owner",
      sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
      setup(c) {
        ctx = c;
        return { teardown: () => undefined };
      },
    };
    const { outputEl } = await mountGrid([owner]);
    if (ctx === undefined) {
      throw new Error("the owner feature never ran");
    }
    deliverModes(modesFrame({ mouseMode: 1002, mouseSGR: true }));
    outputEl.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: 76,
        clientY: 80,
      }),
    );
    outputEl.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        buttons: 0,
        clientX: 76,
        clientY: 80,
      }),
    );
    expect(sent()).toEqual(["\x1b[<0;10;5M"]);
    sendEphemeral.mockClear();

    ctx.notifySwitch({ id: "session-2" });
    fake.engine().mouse.resyncGesture();

    expect(sent()).toEqual([]);
  });

  it("keeps the keyboard on the hidden textarea after a reported press", async () => {
    // The engine cancels the mousedown default, which also suppresses the
    // browser's own focus move. The click that follows is what restores it.
    const { outputEl, input } = await mountGrid();
    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true }));
    input.blur();
    expect(document.activeElement).not.toBe(input);

    pressAt(outputEl, 76, 80);
    outputEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(document.activeElement).toBe(input);
  });
});

describe("pointer shape", () => {
  it("rests on an I-beam over the grid, and a pointer over a link", async () => {
    const { outputEl } = await mountGrid();
    const link = addLink(outputEl);

    expect(getComputedStyle(outputEl).cursor).toBe("text");
    expect(getComputedStyle(link).cursor).toBe("pointer");
  });

  it("swaps both to an arrow while an application holds the mouse", async () => {
    // The arrow is the honest affordance: a plain click goes to the application,
    // so the I-beam promises a selection it does not make and the link's pointer
    // promises a navigation that does not happen.
    const { outputEl } = await mountGrid();
    const link = addLink(outputEl);

    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true }));

    expect(getComputedStyle(outputEl).cursor).toBe("default");
    expect(getComputedStyle(link).cursor).toBe("default");
  });

  it("restores both when the application releases the mouse", async () => {
    const { outputEl } = await mountGrid();
    const link = addLink(outputEl);
    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true }));

    deliverModes(modesFrame({ mouseMode: 0 }));

    expect(getComputedStyle(outputEl).cursor).toBe("text");
    expect(getComputedStyle(link).cursor).toBe("pointer");
  });

  it("keeps the grid selectable while an application holds the mouse", async () => {
    // Shift+drag is the only way to copy text from under a TUI that owns the
    // mouse, so the tracking rule must not blanket selection off.
    const { outputEl } = await mountGrid();

    deliverModes(modesFrame({ mouseMode: 1003, mouseSGR: true }));

    expect(getComputedStyle(outputEl).userSelect).toBe("text");
  });

  it("re-derives the shape on a session switch, which carries no modes frame", async () => {
    // connection.setSession restores the incoming session's mode mirror
    // synchronously and delivers nothing, so a shape driven off frames alone would
    // keep the outgoing tab's pointer.
    let ctx: TerminalContext | undefined;
    const owner: TerminalFeature = {
      name: "session-owner",
      sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
      setup(c) {
        ctx = c;
        return { teardown: () => undefined };
      },
    };
    const { outputEl } = await mountGrid([owner]);
    if (ctx === undefined) {
      throw new Error("the owner feature never ran");
    }
    // What setSession does for a session that already had tracking on.
    fake.modes().applySnapshot({ ...fake.modes().snapshot(), mouseMode: 1003, mouseSGR: true });
    expect(getComputedStyle(outputEl).cursor).toBe("text");

    const session: SessionRef = { id: "session-2" };
    ctx.notifySwitch(session);

    expect(getComputedStyle(outputEl).cursor).toBe("default");
  });
});
