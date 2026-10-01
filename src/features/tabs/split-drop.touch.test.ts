import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type {} from "@vitest/browser-playwright";
import {
  activeLabels,
  chipOf,
  dragAt,
  fakeDataTransfer,
  fakeServer,
  mountTabbed,
  rootIn,
  shown,
  type FakeSessionServer,
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
  expect(matchMedia("(any-pointer: fine)").matches).toBe(false);
  fake.reset();
  server = fakeServer();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dropping a tab onto a split half on a touch device", () => {
  // A touch-and-hold drag of a strip chip emits the same HTML5 dragstart /
  // dragover / drop as a mouse, so the drop path is shared; a 1000 x 600 root is
  // wide and tall enough to keep the desktop strip (an iPad), not the switcher.
  it("keeps the single view's tab on the far pane when another tab is dropped on a half", async () => {
    const root = rootIn(1000, 600);
    const { term, ctx } = await mountTabbed(root, server);
    chipOf(root, "two").click();
    expect(term.split?.isOpen()).toBe(false);
    expect(shown(ctx, "left")).toBe("s2");
    const chip = chipOf(root, "one");
    const dt = fakeDataTransfer();
    const rect = root.getBoundingClientRect();
    const leftX = rect.left + rect.width * 0.25;

    dragAt("dragstart", dt, chip, leftX);
    dragAt("dragover", dt, root, leftX);
    dragAt("drop", dt, root, leftX);
    dragAt("dragend", dt, chip, leftX);
    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("left");
    expect(activeLabels(root)).toEqual(["one", "two"]);
  });
});
