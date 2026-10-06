import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { contextMenu } from "../context-menu.js";
import {
  chipOf,
  chips,
  fakeServer,
  mountTabbed,
  openTabMenu,
  paneRoot,
  rootIn,
  until,
  type FakeSessionServer,
  type MountSpec,
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
  expect(matchMedia("(pointer: fine)").matches).toBe(true);
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

const SINGLE: MountSpec = { opts: { split: false } };
const WITH_TERMINAL_MENU: MountSpec = { opts: { split: false }, panes: () => [contextMenu()] };

function pick(root: ParentNode, sel: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) {
    throw new Error(`no ${sel}`);
  }
  return el;
}
const chipClose = (root: HTMLElement, label: string): HTMLElement =>
  pick(chipOf(root, label), ".wt-tab-close");
function rowClose(root: HTMLElement, label: string): HTMLElement {
  const row = [...root.querySelectorAll<HTMLElement>(".wt-switcher-row")].find(
    (r) => r.querySelector(".wt-switcher-row-label")?.textContent === label,
  );
  if (!row) {
    throw new Error(`no listed row ${label}`);
  }
  return pick(row, ".wt-switcher-row-close");
}

// Whether a press focuses a button is up to the browser; Chromium does
// (https://html.spec.whatwg.org/multipage/interaction.html#click-focusable).
function mousePress(btn: HTMLElement): void {
  btn.dispatchEvent(
    new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true, isPrimary: true }),
  );
  btn.focus();
  btn.dispatchEvent(
    new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true, isPrimary: true }),
  );
  btn.click();
}

function openTerminalMenu(root: HTMLElement): HTMLElement {
  pick(root, ".term").dispatchEvent(
    new MouseEvent("contextmenu", { clientX: 20, clientY: 20, bubbles: true, cancelable: true }),
  );
  const menu = pick(root, ".wt-ctx-menu");
  expect(menu.classList.contains("visible")).toBe(true);
  return menu;
}

function blurAll(): void {
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
}

describe("the close button closes its tab and nothing else", () => {
  it("leaves the tab menu raised on another tab open when a chip's x closes its tab", async () => {
    const root = rootIn(1000, 600);
    await mountTabbed(root, server, SINGLE);
    openTabMenu(root, "one");
    const menu = pick(root, ".wt-tab-menu");
    expect(menu.classList.contains("visible")).toBe(true);

    chipClose(root, "two").click();
    await until(() => server.deletes().length === 1);

    expect(server.deletes()).toEqual(["s2"]);
    expect(menu.classList.contains("visible")).toBe(true);
  });

  it("leaves the terminal's menu open when the switcher's active-row x closes the shown tab", async () => {
    const root = rootIn(390, 700);
    await mountTabbed(root, server, WITH_TERMINAL_MENU);
    const menu = openTerminalMenu(root);

    pick(root, ".wt-switcher-current-close").click();
    await until(() => server.deletes().length === 1);

    expect(server.deletes()).toEqual(["s1"]);
    expect(menu.classList.contains("visible")).toBe(true);
  });

  it("leaves the terminal's menu open when a listed row's x closes its tab", async () => {
    const root = rootIn(390, 700);
    await mountTabbed(root, server, WITH_TERMINAL_MENU);
    pick(root, ".wt-switcher-switch").click();
    const menu = openTerminalMenu(root);

    rowClose(root, "two").click();
    await until(() => server.deletes().length === 1);

    expect(server.deletes()).toEqual(["s2"]);
    expect(menu.classList.contains("visible")).toBe(true);
  });
});

describe("closing the shown tab with a mouse focuses the input of the tab shown next", () => {
  it("from the desktop chip's x, though the input did not hold the keyboard before", async () => {
    const root = rootIn(1000, 600);
    await mountTabbed(root, server, SINGLE);
    blurAll();

    mousePress(chipClose(root, "one"));
    await until(() => server.deletes().length === 1);

    expect(chips(root).map((c) => c.classList.contains("wt-tab-active"))).toEqual([true, false]);
    expect(document.activeElement).toBe(pick(root, ".term-input"));
  });

  it("from the switcher's active-row x, though the input did not hold the keyboard before", async () => {
    const root = rootIn(390, 700);
    await mountTabbed(root, server, SINGLE);
    blurAll();

    mousePress(pick(root, ".wt-switcher-current-close"));
    await until(() => server.deletes().length === 1);

    expect(pick(root, ".wt-switcher-label").textContent).toBe("two");
    expect(document.activeElement).toBe(pick(root, ".term-input"));
  });

  it("in split view, into the pane that keeps its tab when the selected pane's tab closes", async () => {
    const root = rootIn(1000, 600);
    const { term, api, ctx } = await mountTabbed(root, server);
    term.split?.open();
    api.snap("s2", "right");
    await until(() => ctx.shell.pane("right")?.state() === "shown");
    ctx.shell.select("right");
    blurAll();

    mousePress(chipClose(root, "two"));
    await until(() => server.deletes().length === 1);

    expect(term.split?.isOpen()).toBe(false);
    expect(document.activeElement).toBe(pick(paneRoot(root, "left"), ".term-input"));
  });
});

describe("closing a tab that is not on screen leaves focus where it was", () => {
  it("from a background chip's x", async () => {
    const root = rootIn(1000, 600);
    await mountTabbed(root, server, SINGLE);
    blurAll();

    chipClose(root, "two").click();
    await until(() => server.deletes().length === 1);

    expect(document.activeElement).toBe(document.body);
  });

  it("from a background chip's x, keeping the keyboard in the input that held it", async () => {
    const root = rootIn(1000, 600);
    await mountTabbed(root, server, SINGLE);
    const input = pick(root, ".term-input");
    input.focus();

    mousePress(chipClose(root, "two"));
    await until(() => server.deletes().length === 1);

    expect(document.activeElement).toBe(input);
  });

  it("from a listed row's x", async () => {
    const root = rootIn(390, 700);
    await mountTabbed(root, server, SINGLE);
    pick(root, ".wt-switcher-switch").click();
    blurAll();

    rowClose(root, "two").click();
    await until(() => server.deletes().length === 1);

    expect(document.activeElement).toBe(document.body);
  });
});
