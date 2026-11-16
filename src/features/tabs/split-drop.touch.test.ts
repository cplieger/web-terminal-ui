import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type {} from "@vitest/browser-playwright";
import {
  activeLabels,
  chipOf,
  chips,
  dragAt,
  fakeDataTransfer,
  fakeServer,
  mountTabbed,
  rootIn,
  shown,
  until,
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
  // Synthetic HTML5 drag events, as a mouse emits; a touch drag reaches the same
  // drop handlers through the pointer path (strip-drag.touch.test.ts). A 1000 x
  // 600 root is wide and tall enough to keep the desktop strip (an iPad), not the
  // switcher.
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

  it("with one tab, a drop on the right half creates a tab for the left pane and opens the split", async () => {
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const root = rootIn(1000, 600);
    const { term, ctx } = await mountTabbed(root, server);
    const chip = chipOf(root, "one");
    const dt = fakeDataTransfer();
    const rect = root.getBoundingClientRect();
    const rightX = rect.left + rect.width * 0.75;

    dragAt("dragstart", dt, chip, rightX);
    dragAt("dragover", dt, root, rightX);
    dragAt("drop", dt, root, rightX);
    dragAt("dragend", dt, chip, rightX);
    await until(() => shown(ctx, "left") === "s-new");
    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "right")).toBe("s1");
    expect(shown(ctx, "left")).toBe("s-new");
    expect(chips(root)).toHaveLength(2);
    expect(server.posts()).toBe(1);
  });

  it("with one tab, a drop on the left half keeps the tab on the left and creates a tab for the right pane", async () => {
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const root = rootIn(1000, 600);
    const { term, ctx } = await mountTabbed(root, server);
    const chip = chipOf(root, "one");
    const dt = fakeDataTransfer();
    const rect = root.getBoundingClientRect();
    const leftX = rect.left + rect.width * 0.25;

    dragAt("dragstart", dt, chip, leftX);
    dragAt("dragover", dt, root, leftX);
    dragAt("drop", dt, root, leftX);
    dragAt("dragend", dt, chip, leftX);
    await until(() => shown(ctx, "right") === "s-new");
    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(chips(root)).toHaveLength(2);
    expect(server.posts()).toBe(1);
  });
});
