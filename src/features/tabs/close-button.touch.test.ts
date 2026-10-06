import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import {
  chipOf,
  chips,
  fakeMonitor,
  fakeServer,
  mountTabbed,
  paneRoot,
  rootIn,
  until,
  type FakeSessionServer,
  type Mounted,
} from "./test-helpers/split.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

let server: FakeSessionServer;
beforeEach(() => {
  expect(matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(matchMedia("(pointer: fine)").matches).toBe(false);
  fake.reset();
  server = fakeServer();
  server.list = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
    { id: "s3", title: "three", createdAt: "3", status: "idle" },
  ];
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function pick(root: ParentNode, sel: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) {
    throw new Error(`no ${sel}`);
  }
  return el;
}

// Whether a press focuses a button is up to the browser; Chromium does
// (https://html.spec.whatwg.org/multipage/interaction.html#click-focusable).
function tap(btn: HTMLElement): void {
  btn.dispatchEvent(
    new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, isPrimary: true }),
  );
  btn.focus();
  btn.dispatchEvent(
    new PointerEvent("pointerup", { pointerType: "touch", bubbles: true, isPrimary: true }),
  );
  btn.click();
}

const inputs = (root: HTMLElement): Element[] => [...root.querySelectorAll(".term-input")];

interface Surface {
  readonly name: string;
  mount(): Promise<{
    root: HTMLElement;
    close: HTMLElement;
    typing: HTMLElement;
    next: () => HTMLElement;
  }>;
}
const SURFACES: readonly Surface[] = [
  {
    name: "the desktop strip's chip x (a wide touch screen)",
    async mount() {
      const root = rootIn(1000, 600);
      await mountTabbed(root, server, { opts: { split: false } });
      return {
        root,
        close: pick(chipOf(root, "one"), ".wt-tab-close"),
        typing: pick(root, ".term-input"),
        next: () => pick(root, ".term-input"),
      };
    },
  },
  {
    name: "the switcher's active-row x (a phone)",
    async mount() {
      const root = rootIn(390, 700);
      await mountTabbed(root, server, { opts: { split: false } });
      return {
        root,
        close: pick(root, ".wt-switcher-current-close"),
        typing: pick(root, ".term-input"),
        next: () => pick(root, ".term-input"),
      };
    },
  },
  {
    name: "the selected pane's chip x in split view",
    async mount() {
      const root = rootIn(1000, 600);
      const m: Mounted = await mountTabbed(root, server);
      m.term.split?.open();
      m.api.snap("s2", "right");
      await until(() => m.ctx.shell.pane("right")?.state() === "shown");
      m.ctx.shell.select("left");
      return {
        root,
        close: pick(chipOf(root, "one"), ".wt-tab-close"),
        typing: pick(paneRoot(root, "left"), ".term-input"),
        next: () => pick(paneRoot(root, "left"), ".term-input"),
      };
    },
  },
];

describe.each(SURFACES)("closing the shown tab with a tap on $name", (surface) => {
  it("does not focus any terminal input when none held the keyboard before the tap", async () => {
    const { root, close } = await surface.mount();
    (document.activeElement as HTMLElement | null)?.blur();

    tap(close);
    await until(() => server.deletes().length === 1);

    expect(server.deletes()).toEqual(["s1"]);
    expect(inputs(root)).not.toContain(document.activeElement);
  });

  it("keeps the keyboard up, in the next shown tab's input, when the input held it at the tap", async () => {
    const { close, typing, next } = await surface.mount();
    typing.focus();
    expect(document.activeElement).toBe(typing);

    tap(close);
    await until(() => server.deletes().length === 1);

    expect(server.deletes()).toEqual(["s1"]);
    expect(document.activeElement).toBe(next());
  });
});

interface Background {
  readonly name: string;
  mount(): Promise<{ root: HTMLElement; close: HTMLElement; input: HTMLElement }>;
}
const BACKGROUND: readonly Background[] = [
  {
    name: "a background chip's x (a wide touch screen)",
    async mount() {
      const root = rootIn(1000, 600);
      await mountTabbed(root, server, { opts: { split: false } });
      return {
        root,
        close: pick(chipOf(root, "two"), ".wt-tab-close"),
        input: pick(root, ".term-input"),
      };
    },
  },
  {
    name: "a listed row's x (a phone)",
    async mount() {
      const root = rootIn(390, 700);
      await mountTabbed(root, server, { opts: { split: false } });
      pick(root, ".wt-switcher-switch").click();
      const row = [...root.querySelectorAll<HTMLElement>(".wt-switcher-row")].find(
        (r) => r.querySelector(".wt-switcher-row-label")?.textContent === "two",
      );
      if (!row) {
        throw new Error("no listed row two");
      }
      return {
        root,
        close: pick(row, ".wt-switcher-row-close"),
        input: pick(root, ".term-input"),
      };
    },
  },
];

describe.each(BACKGROUND)("closing a tab not on screen with a tap on $name", (surface) => {
  it("keeps the keyboard up in the shown tab's input when it held it at the tap", async () => {
    const { close, input } = await surface.mount();
    input.focus();
    expect(document.activeElement).toBe(input);

    tap(close);
    await until(() => server.deletes().length === 1);

    expect(server.deletes()).toEqual(["s2"]);
    expect(document.activeElement).toBe(input);
  });

  it("does not focus any terminal input when none held the keyboard before the tap", async () => {
    const { root, close } = await surface.mount();
    (document.activeElement as HTMLElement | null)?.blur();

    tap(close);
    await until(() => server.deletes().length === 1);

    expect(server.deletes()).toEqual(["s2"]);
    expect(inputs(root)).not.toContain(document.activeElement);
  });
});

describe("a close the reader did not press", () => {
  it("does not raise the keyboard the reader put away when the server ends the shown tab", async () => {
    const monitor = fakeMonitor();
    const root = rootIn(1000, 600);
    await mountTabbed(root, server, {
      opts: { split: false },
      tabsOpts: { activityMonitor: monitor.feature },
      before: [monitor.feature],
    });
    const input = pick(root, ".term-input");
    input.focus();
    tap(chipOf(root, "two"));
    expect(document.activeElement).toBe(input);
    input.blur();

    monitor.emit({ id: "s2", title: "two", createdAt: "2", status: "exited", removed: true });
    await until(() => chips(root).length === 2);

    expect(server.deletes()).toEqual([]);
    expect(inputs(root)).not.toContain(document.activeElement);
  });

  it("does not move the keyboard into the terminal when the server ends a tab being renamed", async () => {
    const monitor = fakeMonitor();
    const root = rootIn(1000, 600);
    await mountTabbed(root, server, {
      opts: { split: false },
      tabsOpts: { activityMonitor: monitor.feature },
      before: [monitor.feature],
    });
    const input = pick(root, ".term-input");
    input.focus();
    const chip = chipOf(root, "one");
    tap(chip);
    chip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const field = pick(chip, ".wt-tab-rename");
    expect(document.activeElement).toBe(field);

    monitor.emit({ id: "s1", title: "one", createdAt: "1", status: "exited", removed: true });
    await until(() => chips(root).length === 2);

    expect(server.deletes()).toEqual([]);
    expect(inputs(root)).not.toContain(document.activeElement);
  });
});
