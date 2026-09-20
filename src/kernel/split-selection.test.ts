import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import type { TerminalContext, TerminalFeature, TerminalHandle } from "./types.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
});

function rootIn(width = 1000, height = 600): HTMLElement {
  const root = document.createElement("div");
  root.style.width = `${String(width)}px`;
  root.style.height = `${String(height)}px`;
  document.body.appendChild(root);
  return root;
}

function layoutOwner(): TerminalFeature<void> {
  return {
    name: "owner",
    scope: "shell",
    paneLayoutOwner: {
      resolveInitialLayout: () => Promise.resolve(false),
      shownIn: () => null,
      showIn: () => false,
    },
    setup() {
      return { api: undefined, teardown: () => undefined };
    },
  };
}

/** A pane feature that records which pane's funnel a byte went through. */
function inputWitness(log: string[]): TerminalFeature<void> {
  return {
    name: "witness",
    setup(ctx) {
      const side = (): string => (ctx.surface().closest(".wt-side-left") ? "left" : "right");
      ctx.registerInputObserver((bytes) => {
        log.push(`${side()}:${String(bytes[0])}`);
      });
      return { api: undefined, teardown: () => undefined };
    },
  };
}

interface Mounted {
  readonly term: TerminalHandle;
  readonly ctx: TerminalContext;
}

async function mountSplit(root: HTMLElement, log: string[] = []): Promise<Mounted> {
  let ctxRef: TerminalContext | undefined;
  const probe: TerminalFeature<void> = {
    name: "shell-probe",
    scope: "shell",
    setup(ctx) {
      ctxRef = ctx;
      return { api: undefined, teardown: () => undefined };
    },
  };
  const term = await mountTerminal(root, {
    split: true,
    features: () => [layoutOwner(), probe, inputWitness(log)],
  });
  await tick();
  if (!ctxRef) {
    throw new Error("the probe feature never ran");
  }
  return { term, ctx: ctxRef };
}

const paneRoot = (root: HTMLElement, side: "left" | "right"): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`:scope > .wt-split-pane.wt-side-${side}`);
  if (!el) {
    throw new Error(`no ${side} pane root`);
  }
  return el;
};
const textareaOf = (root: HTMLElement, side: "left" | "right"): HTMLTextAreaElement => {
  const el = paneRoot(root, side).querySelector<HTMLTextAreaElement>(".term-input");
  if (!el) {
    throw new Error(`no ${side} textarea`);
  }
  return el;
};
const termOf = (root: HTMLElement, side: "left" | "right"): HTMLElement => {
  const el = paneRoot(root, side).querySelector<HTMLElement>(".term");
  if (!el) {
    throw new Error(`no ${side} term`);
  }
  return el;
};

describe("selection indicators", () => {
  it("focus entering the right pane's textarea selects it and puts the focus class on the right terminal only", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    term.split?.open();
    ctx.notifySwitch({ id: "b" });
    textareaOf(root, "left").focus();
    expect(ctx.shell.selected()).toBe("left");
    expect(termOf(root, "left").classList.contains("focus")).toBe(true);

    textareaOf(root, "right").focus();
    expect(ctx.shell.selected()).toBe("right");
    expect(termOf(root, "right").classList.contains("focus")).toBe(true);
    expect(termOf(root, "left").classList.contains("focus")).toBe(false);
    expect(paneRoot(root, "right").classList.contains("wt-pane-selected")).toBe(true);
    expect(paneRoot(root, "left").classList.contains("wt-pane-selected")).toBe(false);
  });

  it("focus the browser delivers into an empty pane goes back to the selected pane's textarea, and selection stays", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    term.split?.open();
    expect(ctx.shell.selected()).toBe("left");
    const empty = paneRoot(root, "right");
    expect(empty.hasAttribute("inert")).toBe(true);
    // An engine without `inert` lets focus in; simulate it by dropping the attribute.
    empty.removeAttribute("inert");

    textareaOf(root, "right").focus();

    expect(document.activeElement).toBe(textareaOf(root, "left"));
    expect(ctx.shell.selected()).toBe("left");
    expect(paneRoot(root, "left").classList.contains("wt-pane-selected")).toBe(true);
  });

  it("the terminal handle's send reaches the selected pane's engine and follows selection", async () => {
    const root = rootIn();
    const log: string[] = [];
    const { term, ctx } = await mountSplit(root, log);
    ctx.notifySwitch({ id: "a" });
    term.split?.open();
    ctx.notifySwitch({ id: "b" });
    expect(ctx.shell.selected()).toBe("right");

    term.send(new Uint8Array([0x41]));
    expect(log).toEqual(["right:65"]);

    ctx.shell.select("left");
    term.send(new Uint8Array([0x42]));
    expect(log).toEqual(["right:65", "left:66"]);
  });
});
