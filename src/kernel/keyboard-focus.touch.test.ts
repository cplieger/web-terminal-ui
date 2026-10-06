// Chromium cannot run iOS's selection gestures, so the seam asserted is the
// textarea's focus (pane.ts `focusFromGesture` owns why it decides selection):
// let go once a hardware keyboard is seen, taken on a tap while none is.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import { mobileToolbar } from "../features/mobile-toolbar.js";
import { softKeyboard, type SoftKeyboard } from "../features/tabs/test-helpers/paint.js";
import type { TerminalContext, TerminalFeature } from "./types.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const { sendBinary, setClientFocus } = fake.connection;
const dec = new TextDecoder();
const sentText = (): string => sendBinary.mock.calls.map((c) => dec.decode(c[0])).join("");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  expect(matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(matchMedia("(pointer: fine)").matches).toBe(false);
  expect(matchMedia("(any-pointer: fine)").matches).toBe(false);
  expect(matchMedia("(any-hover: hover)").matches).toBe(false);
  fake.reset();
  document.body.replaceChildren();
});

interface Mounted {
  root: HTMLElement;
  input: HTMLTextAreaElement;
  /** A row of output text, the press target. */
  row: HTMLElement;
  ctx: TerminalContext;
}

async function mount(extra: () => TerminalFeature<unknown>[] = () => []): Promise<Mounted> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  let captured: TerminalContext | undefined;
  const probe: TerminalFeature<void> = {
    name: "probe",
    setup(ctx) {
      captured = ctx;
      return { teardown: () => undefined };
    },
  };
  await mountTerminal(root, { features: () => [...extra(), probe] });
  // A pane feature's setup can follow a shell feature's by a task.
  await tick();
  if (!captured) {
    throw new Error("the probe feature never ran");
  }
  const input = root.querySelector<HTMLTextAreaElement>(".term-input");
  const output = root.querySelector(".term-output");
  if (!input || !output) {
    throw new Error("no terminal");
  }
  const row = document.createElement("div");
  row.textContent = "line 1 the quick brown fox";
  output.appendChild(row);
  return { root, input, row, ctx: captured };
}

function latch(m: Mounted): void {
  m.input.focus();
  m.input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      code: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    }),
  );
  sendBinary.mockClear();
  expect(document.activeElement).toBe(m.input);
}

function pointer(type: string, target: Element, timeStamp: number, pointerType = "touch"): void {
  const ev = new PointerEvent(type, { bubbles: true, pointerType, clientX: 100, clientY: 100 });
  Object.defineProperty(ev, "timeStamp", { value: timeStamp });
  target.dispatchEvent(ev);
}

function tap(target: Element, opts: { heldMs?: number; pointerType?: string } = {}): MouseEvent {
  pointer("pointerdown", target, 1000, opts.pointerType);
  pointer("pointerup", target, 1000 + (opts.heldMs ?? 40), opts.pointerType);
  const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(mousedown);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return mousedown;
}

function typeOnBody(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(ev);
  return ev;
}

function selectIn(el: Element): void {
  const text = el.firstChild;
  if (!text) {
    throw new Error("nothing to select");
  }
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 6);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

describe("with a hardware keyboard seen, a press on the output lets go of focus", () => {
  it("leaves the input unfocused after a tap, and lets the mousedown through", async () => {
    const m = await mount();
    latch(m);

    const mousedown = tap(m.row);

    expect(document.activeElement).not.toBe(m.input);
    expect(mousedown.defaultPrevented).toBe(false);
  });

  it("blurs at the press, before a long-press can ask to select", async () => {
    const m = await mount();
    latch(m);

    pointer("pointerdown", m.row, 1000);
    expect(document.activeElement).not.toBe(m.input);
    pointer("pointerup", m.row, 1900);
    expect(document.activeElement).not.toBe(m.input);
  });

  it("keeps focus at a press on the scroll surface beside the output, where nothing can be selected", async () => {
    const m = await mount();
    latch(m);
    const term = m.root.querySelector(".term");
    if (!term) {
      throw new Error("no .term");
    }

    pointer("pointerdown", term, 1000);

    expect(document.activeElement).toBe(m.input);
  });

  it("keeps focus at a press on a link in the output, which is the link's to open", async () => {
    const m = await mount();
    latch(m);
    const link = document.createElement("a");
    link.className = "term-link";
    link.href = "https://example.com/";
    link.textContent = "example.com";
    m.row.appendChild(link);

    pointer("pointerdown", link, 1000);

    expect(document.activeElement).toBe(m.input);
  });

  it("reports the focus loss once, when the press ends", async () => {
    const m = await mount();
    latch(m);
    setClientFocus.mockClear();

    pointer("pointerdown", m.row, 1000);
    expect(setClientFocus).not.toHaveBeenCalled();
    pointer("pointerup", m.row, 1040);
    await tick();

    expect(setClientFocus.mock.calls).toEqual([[false]]);
  });

  it("sends the first key typed after the tap exactly once and takes focus back", async () => {
    const m = await mount();
    latch(m);
    tap(m.row);
    expect(document.activeElement).not.toBe(m.input);

    const ev = typeOnBody({ key: "a", code: "KeyA" });

    expect(sentText()).toBe("a");
    expect(sendBinary).toHaveBeenCalledOnce();
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(m.input);
  });

  it("leaves Cmd+C to the browser", async () => {
    const m = await mount();
    latch(m);
    tap(m.row);
    expect(document.activeElement).not.toBe(m.input);

    typeOnBody({ key: "c", code: "KeyC", metaKey: true });

    expect(sentText()).toBe("");
    expect(document.activeElement).toBe(document.body);
  });

  it("hands a dead key to the input to compose, sending nothing", async () => {
    const m = await mount();
    latch(m);
    tap(m.row);
    expect(document.activeElement).not.toBe(m.input);

    const ev = typeOnBody({ key: "Dead", code: "KeyE", altKey: true });

    expect(sentText()).toBe("");
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(m.input);
  });

  it("leaves the keys alone after a press in the host page", async () => {
    const m = await mount();
    latch(m);
    tap(m.row);
    expect(document.activeElement).not.toBe(m.input);
    const host = document.createElement("div");
    document.body.appendChild(host);
    pointer("pointerdown", host, 2000);

    typeOnBody({ key: "a", code: "KeyA" });

    expect(sentText()).toBe("");
    expect(document.activeElement).not.toBe(m.input);
  });
});

describe("a selection is never followed by a gesture's focus", () => {
  it("not on returning to the page after a long-press made one", async () => {
    const m = await mount();
    m.input.blur();
    pointer("pointerdown", m.row, 1000);
    const changed = new Promise((r) => {
      document.addEventListener("selectionchange", r, { once: true });
    });
    selectIn(m.row);
    await changed;
    pointer("pointerup", m.row, 1900);
    await tick();
    window.getSelection()?.removeAllRanges();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(document.activeElement).not.toBe(m.input);
  });

  it("not on returning to the page while a selection is live", async () => {
    const m = await mount();
    m.input.blur();
    selectIn(m.row);

    document.dispatchEvent(new Event("visibilitychange"));

    expect(document.activeElement).not.toBe(m.input);
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });
});

describe("a touch-only user with the on-screen keyboard", () => {
  let kb: SoftKeyboard | null = null;
  afterEach(() => {
    kb?.restore();
    kb = null;
  });

  it("focuses the input on a tap and keeps the mousedown cancelled", async () => {
    const m = await mount();
    m.input.blur();

    const mousedown = tap(m.row);

    expect(document.activeElement).toBe(m.input);
    expect(mousedown.defaultPrevented).toBe(true);
  });

  it("clears a selection on a tap without focusing", async () => {
    const m = await mount();
    m.input.blur();
    selectIn(m.row);

    tap(m.row);

    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(document.activeElement).not.toBe(m.input);
  });

  it("does not focus on a long-press, which is native selection's", async () => {
    const m = await mount();
    m.input.blur();

    tap(m.row, { heldMs: 900 });

    expect(document.activeElement).not.toBe(m.input);
  });

  it("keeps the input focused through a long-press, so the on-screen keyboard stays up", async () => {
    const m = await mount();
    m.input.focus();

    tap(m.row, { heldMs: 900 });

    expect(document.activeElement).toBe(m.input);
  });

  it.each([
    ["Unidentified", 229],
    ["a", 229],
    ["Backspace", 0],
    ["Enter", 0],
  ] as const)("never reads a soft-keyboard %s as a hardware keyboard", async (key, keyCode) => {
    kb = softKeyboard();
    const m = await mount();
    m.input.focus();
    kb.open(300);
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { value: keyCode });

    m.input.dispatchEvent(ev);

    expect(m.ctx.shell.keyboard.hardwareSeen()).toBe(false);
  });

  it("never latches on the undocked iPad keyboard's Tab, which has a real code and no inset, so a tap still focuses", async () => {
    const m = await mount();
    m.input.focus();

    m.input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }),
    );

    expect(m.ctx.shell.keyboard.hardwareSeen()).toBe(false);
    m.input.blur();
    const mousedown = tap(m.row);
    expect(document.activeElement).toBe(m.input);
    expect(mousedown.defaultPrevented).toBe(true);
  });

  it.each(["kb-esc", "kb-up"])(
    "keeps the input focused through the toolbar's %s, which sends without a keydown",
    async (id) => {
      const m = await mount(() => [mobileToolbar()]);
      m.input.focus();
      const button = m.root.querySelector(`#${id}`);
      if (!button) {
        throw new Error(`no #${id}`);
      }
      const down = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
      });

      button.dispatchEvent(down);

      expect(down.defaultPrevented).toBe(true);
      expect(sendBinary).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(m.input);
      expect(m.ctx.shell.keyboard.hardwareSeen()).toBe(false);
    },
  );

  it("publishes the on-screen keyboard's inset", async () => {
    kb = softKeyboard();
    const m = await mount();
    m.input.focus();

    kb.open(300);

    expect(m.root.style.getPropertyValue("--kb-inset")).toBe("300px");
  });
});

// Android under `interactive-widget=resizes-content`: the keyboard shrinks the
// layout viewport with the visual one, so the visual inset reads 0.
describe("an Android keyboard that resizes the content", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  interface Layout {
    width: number;
    height: number;
    resize(width: number, height: number): void;
  }

  function contentResizingKeyboard(): Layout {
    const vv = softKeyboard();
    const { innerWidth: width, innerHeight: height } = window;
    const saved = {
      width: Object.getOwnPropertyDescriptor(window, "innerWidth"),
      height: Object.getOwnPropertyDescriptor(window, "innerHeight"),
    };
    restore = () => {
      for (const [prop, desc] of [
        ["innerWidth", saved.width],
        ["innerHeight", saved.height],
      ] as const) {
        if (desc) {
          Object.defineProperty(window, prop, desc);
        } else {
          Reflect.deleteProperty(window, prop);
        }
      }
      vv.restore();
    };
    return {
      width,
      height,
      resize(w, h) {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
        Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
        vv.open(0);
      },
    };
  }

  const keyboards: [string, (l: Layout) => void][] = [
    ["a floating keyboard, which resizes nothing", (l) => l.resize(l.width, l.height)],
    ["a 120px keyboard", (l) => l.resize(l.width, l.height - 120)],
    [
      "a rotation to portrait with a 200px keyboard up, then a 60px shrink",
      (l) => {
        l.resize(l.width, l.height - 200);
        l.resize(l.height, l.width - 300);
        l.resize(l.height, l.width - 240);
      },
    ],
  ];
  const onScreenKeys = ["ArrowLeft", "Escape", "Tab"];

  it.each(
    keyboards.flatMap(([name, open]) => onScreenKeys.map((key) => [key, name, open] as const)),
  )(
    "never latches on an on-screen %s, which has no physical code, over %s",
    async (key, _name, open) => {
      const layout = contentResizingKeyboard();
      const m = await mount();
      m.input.focus();
      open(layout);

      m.input.dispatchEvent(new KeyboardEvent("keydown", { key, code: "", bubbles: true }));

      expect(m.ctx.shell.keyboard.hardwareSeen()).toBe(false);
      m.input.blur();
      const mousedown = tap(m.row);
      expect(document.activeElement).toBe(m.input);
      expect(mousedown.defaultPrevented).toBe(true);
    },
  );

  it("latches on a hardware arrow with its physical code, in a window made shorter at the same width", async () => {
    const layout = contentResizingKeyboard();
    const m = await mount();
    m.input.focus();
    layout.resize(layout.width, layout.height - 300);

    m.input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", bubbles: true }),
    );

    expect(m.ctx.shell.keyboard.hardwareSeen()).toBe(true);
    tap(m.row);
    expect(document.activeElement).not.toBe(m.input);
  });

  it("clears a latch at the first on-screen key once the hardware keyboard is gone", async () => {
    const layout = contentResizingKeyboard();
    const m = await mount();
    latch(m);
    layout.resize(layout.width, layout.height);

    m.input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", code: "", bubbles: true }),
    );

    expect(m.ctx.shell.keyboard.hardwareSeen()).toBe(false);
    m.input.blur();
    tap(m.row);
    expect(document.activeElement).toBe(m.input);
  });
});
