import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import type { ClipboardApi } from "../features/clipboard.js";
import { contextMenu } from "../features/context-menu.js";
import type {
  CreateTerminalOptions,
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
} from "./types.js";

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
const dec = new TextDecoder();
const sentText = (): string => sendBinary.mock.calls.map((c) => dec.decode(c[0])).join("");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
  document.title = "Served page";
});

/** A root with real geometry; unstyled it would measure 0 by 0. */
function rootIn(): HTMLElement {
  const root = document.createElement("div");
  root.style.width = "1000px";
  root.style.height = "600px";
  document.body.appendChild(root);
  return root;
}

/** An owner that shows one session in the left pane at boot, as the tabs feature
 *  does, so both topologies run managed. */
function showingOwner(id: string): TerminalFeature<void> {
  let ctxRef: TerminalContext | undefined;
  return {
    name: "owner",
    scope: "shell",
    paneLayoutOwner: {
      resolveInitialLayout: () => {
        ctxRef?.notifySwitch({ id });
        return Promise.resolve(true);
      },
      shownIn: () => null,
      showIn: () => false,
    },
    setup(ctx) {
      ctxRef = ctx;
      return { api: undefined, teardown: () => undefined };
    },
  };
}

interface Topology {
  readonly name: string;
  readonly opts: Partial<CreateTerminalOptions>;
}
const TOPOLOGIES: readonly Topology[] = [
  { name: "on the consumer's root", opts: {} },
  { name: "under a shell root with the split closed", opts: { split: true } },
];

interface Mounted {
  readonly root: HTMLElement;
  /** The pane root: the consumer's root, or the one pane under the shell root. */
  readonly pane: HTMLElement;
  readonly term: TerminalHandle;
  readonly textarea: HTMLTextAreaElement;
}

async function mount(
  opts: Partial<CreateTerminalOptions>,
  paneFeatures: () => readonly TerminalFeature<unknown>[] = () => [],
): Promise<Mounted> {
  const root = rootIn();
  const term = await mountTerminal(root, {
    wsPath: "/pty",
    scrollbackLines: 777,
    features: () => [showingOwner("a"), ...paneFeatures()],
    ...opts,
  });
  await tick();
  const pane = root.querySelector<HTMLElement>(":scope > .wt-split-pane") ?? root;
  const textarea = pane.querySelector<HTMLTextAreaElement>(".term-input");
  if (!textarea) {
    throw new Error("no textarea in the pane");
  }
  return { root, pane, term, textarea };
}

/** Tag, classes and role of every element under `el`, in document order. */
function shape(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll<HTMLElement>("*")).map((e) => {
    const classes = Array.from(e.classList).sort().join(".");
    const role = e.getAttribute("role");
    return `${e.tagName.toLowerCase()}${classes === "" ? "" : `.${classes}`}${role === null ? "" : `[${role}]`}`;
  });
}

/** Appends text to the pane's output and selects part of it. */
function selectInOutput(pane: HTMLElement): void {
  const output = pane.querySelector(".term-output");
  if (!output) {
    throw new Error("no .term-output");
  }
  const text = document.createTextNode("line 1 the quick brown fox");
  output.appendChild(text);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 7);
  const sel = window.getSelection();
  if (!sel) {
    throw new Error("no selection");
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

it("builds the same terminal subtree under a shell root as on the consumer's root", async () => {
  const direct = await mount({});
  direct.textarea.blur();
  const reference = shape(direct.pane);
  expect(reference).toContain("textarea.term-input");
  expect(reference).toContain("div.term-output[tabpanel]");
  direct.term.destroy();

  const split = await mount({ split: true });
  split.textarea.blur();
  expect(split.pane.classList.contains("wt-root")).toBe(true);
  expect(split.pane.hasAttribute("inert")).toBe(false);
  expect(shape(split.pane)).toEqual(reference);
});

describe.each(TOPOLOGIES)("$name", ({ opts }) => {
  it("builds the pane's engine from the consumer's options", async () => {
    await mount(opts);
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(1);
    expect(fake.options().wsPath).toBe("/pty");
    expect(fake.options().maxLines).toBe(777);
    expect(fake.options().sessionIdKey).toBe("vterm-session-id");
    expect(fake.connection.setSession).toHaveBeenCalledWith("a");
  });

  it("sends typed text raw and a paste bracketed through the pane's funnel", async () => {
    const { textarea } = await mount(opts);
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "ab" }));
    expect(sentText()).toBe("ab");
    sendBinary.mockClear();
    textarea.dispatchEvent(
      new InputEvent("input", { inputType: "insertFromPaste", data: "ls\n\x1b[201~x" }),
    );
    const sent = sentText();
    expect(sent.startsWith("\x1b[200~")).toBe(true);
    expect(sent.endsWith("\x1b[201~")).toBe(true);
    expect(sent).toContain("ls\r\u241B[201~x");
  });

  it("the handle's send reaches the pane's socket and its focus lands in the pane", async () => {
    const { pane, term, textarea } = await mount(opts);
    term.send(new Uint8Array([0x71]));
    expect(sentText()).toBe("q");
    term.focus();
    expect(document.activeElement).toBe(textarea);
    expect(pane.querySelector(".term")?.classList.contains("focus")).toBe(true);
  });

  it("a program's title becomes the document title", async () => {
    await mount(opts);
    fake.callbacks().onMessage({ type: "title", title: "vim ~/notes" });
    expect(document.title).toBe("vim ~/notes");
  });

  it("type-to-focus takes the keyboard back on a body keystroke over the pane's selection", async () => {
    const { pane, textarea } = await mount(opts);
    textarea.blur();
    selectInOutput(pane);
    const ev = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "getModifierState", { value: () => false });
    document.body.dispatchEvent(ev);
    expect(sentText()).toBe("x");
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it("the pane's context menu opens over its surface and pastes through its clipboard", async () => {
    const paste = vi.fn();
    const clip: TerminalFeature<ClipboardApi> = {
      name: "clipboard",
      setup() {
        return { api: { copy: vi.fn(), paste }, teardown: () => undefined };
      },
    };
    const { pane } = await mount(opts, () => [clip, contextMenu({ clipboard: clip })]);
    pane
      .querySelector(".term")
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
    const menu = pane.querySelector<HTMLElement>(".wt-ctx-menu");
    expect(menu?.classList.contains("visible")).toBe(true);
    const item = [...(menu?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Paste",
    );
    item?.click();
    expect(paste).toHaveBeenCalledTimes(1);
  });
});
