import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { MIN_PANE_PX, SPLIT_GUTTER_PX } from "../../kernel/layout-policy.js";
import {
  announced,
  chipOf,
  gate,
  fakeMonitor,
  fakeServer,
  jsonResponse,
  lateRejecting,
  menuItem,
  mountTabbed,
  openTabMenu,
  politeText,
  rootIn,
  settle,
  shown,
  tick,
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
  fake.reset();
  server = fakeServer();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the read", () => {
  it("applies an open record: both panes shown, the handle remembered and clamped, the selected side, and no PUT", async () => {
    server.layout = { open: true, left: "s1", right: "s2", handle: 0.3, selected: "right" };
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    await tick();

    expect(server.lists()).toBe(1);
    expect(server.layoutReads()).toBe(1);
    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(term.split?.state().committedRatio).toBe(0.3);
    expect(term.split?.state().ratio).toBe(MIN_PANE_PX / (1000 - SPLIT_GUTTER_PX));
    expect(root.style.getPropertyValue("--wt-split-ratio")).toBe(
      String(MIN_PANE_PX / (1000 - SPLIT_GUTTER_PX)),
    );
    expect(server.writes).toEqual([]);
  });

  it("applies the restored selection with no pane-selection announcement: the live region carries the split state alone", async () => {
    server.layout = { open: true, left: "s1", right: "s2", handle: 0.5, selected: "right" };
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    await announced();

    expect(ctx.shell.selected()).toBe("right");
    expect(root.querySelector(".wt-split-handle")?.getAttribute("data-faces")).toBe("right");
    expect(politeText(root)).toBe("Split open");
  });

  it("treats a side naming a session the list lacks as empty", async () => {
    server.layout = { open: true, left: "s1", right: "ghost", handle: 0.5, selected: "left" };
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    await tick();

    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(ctx.shell.selected()).toBe("left");
    expect(server.writes).toEqual([]);
  });

  it("opens the split collapsed when the record is open and the row is too narrow for two panes", async () => {
    server.layout = { open: true, left: "s1", right: "s2", handle: 0.5, selected: "left" };
    const root = rootIn(720);
    const { term, ctx } = await mountTabbed(root, server);
    await tick();

    expect(term.split?.isOpen()).toBe(true);
    expect(term.split?.state().collapsed).toBe(true);
    expect(root.classList.contains("wt-split-collapsed")).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(server.writes).toEqual([]);
  });

  it("a server without the route boots the oldest live tab with the split closed and warns once", async () => {
    server.layout = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    await tick();

    expect(term.split?.isOpen()).toBe(false);
    expect(shown(ctx, "left")).toBe("s1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("/api/sessions/layout");
    expect(server.writes).toEqual([]);
    warn.mockRestore();
  });
});

describe("the writes", () => {
  it("a snap writes the whole record once, and creates or closes no session", async () => {
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    await tick();
    expect(server.writes).toEqual([]);

    menuItem(openTabMenu(root, "two"), "Snap to right").click();
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    await until(() => server.writes.length > 0);
    await tick();
    expect(server.writes).toEqual([
      { left: "s1", right: "s2", handle: 0.5, selected: "right", open: true },
    ]);
    expect(server.posts()).toBe(0);
    expect(server.deletes()).toEqual([]);
  });

  it("closing the selected pane's tab while the other is empty writes nothing until the replacement exists, then once", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    await until(() => server.writes.length === 1);
    const held = gate();
    server.postGate = held;

    menuItem(openTabMenu(root, "one"), "Close").click();
    await until(() => server.deletes().includes("s1"));
    await until(() => server.posts() === 1);
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBeNull();
    await tick();
    expect(server.writes).toHaveLength(1);

    held.resolve();
    await until(() => shown(ctx, "right") === "s-new");
    await until(() => server.writes.length === 2);
    expect(server.writes[1]).toEqual({
      left: null,
      right: "s-new",
      handle: 0.5,
      selected: "right",
      open: true,
    });
  });

  it("closing the UNSELECTED pane's shown tab writes the emptied side once, selection unchanged", async () => {
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    menuItem(openTabMenu(root, "two"), "Snap to right").click();
    await until(() => server.writes.length === 1);
    await tick();
    expect(ctx.shell.selected()).toBe("right");

    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.deletes().includes("s1"));
    await until(() => server.writes.length === 2);
    await tick();
    expect(shown(ctx, "left")).toBeNull();
    expect(ctx.shell.selected()).toBe("right");
    expect(server.writes).toHaveLength(2);
    expect(server.writes[1]).toEqual({
      left: null,
      right: "s2",
      handle: 0.5,
      selected: "right",
      open: true,
    });
  });

  it("'Close others' removing the UNSELECTED pane's shown tab writes the emptied side once, selection unchanged", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    menuItem(openTabMenu(root, "two"), "Snap to right").click();
    await until(() => server.writes.length === 1);
    await tick();
    expect(ctx.shell.selected()).toBe("right");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    menuItem(openTabMenu(root, "two"), "Close others").click();
    await until(() => server.deletes().length === 2);
    await until(() => server.writes.length === 2);
    await tick();
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(server.posts()).toBe(0);
    expect(server.writes).toHaveLength(2);
    expect(server.writes[1]).toEqual({
      left: null,
      right: "s2",
      handle: 0.5,
      selected: "right",
      open: true,
    });
  });

  it("a removed status for the UNSELECTED pane's shown tab writes the emptied side once, with no DELETE", async () => {
    const monitor = fakeMonitor();
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server, {
      tabsOpts: { activityMonitor: monitor.feature },
      before: [monitor.feature],
    });
    menuItem(openTabMenu(root, "two"), "Snap to right").click();
    await until(() => server.writes.length === 1);
    await tick();

    monitor.emit({ id: "s1", title: "one", createdAt: "1", status: "idle", removed: true });
    await until(() => server.writes.length === 2);
    await tick();
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBe("s2");
    expect(server.deletes()).toEqual([]);
    expect(server.writes).toHaveLength(2);
    expect(server.writes[1]).toEqual({
      left: null,
      right: "s2",
      handle: 0.5,
      selected: "right",
      open: true,
    });
  });

  it("a shown but UNSELECTED pane whose setup rejects writes the emptied side once, selection unchanged", async () => {
    const late = lateRejecting();
    const root = rootIn();
    const { ctx, api } = await mountTabbed(root, server, {
      opts: { onFatalError: () => true },
      panes: () => [late.feature()],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(api.snap("s2", "right")).toBe(true);
    api.switchTo("s1");
    await until(() => server.writes.length >= 1);
    await tick();
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("left");
    const before = server.writes.length;

    late.reject();
    await tick();
    await tick();

    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    expect(ctx.shell.selected()).toBe("left");
    expect(server.writes).toHaveLength(before + 1);
    expect(server.writes[before]).toEqual({
      left: "s1",
      right: null,
      handle: 0.5,
      selected: "left",
      open: true,
    });
  });

  it("closing the split while no pane shows a tab writes nothing; the record resumes with the next shown tab", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    await until(() => server.writes.length === 1);
    const held = gate();
    server.postGate = held;

    menuItem(openTabMenu(root, "one"), "Close").click();
    await until(() => server.posts() === 1);
    expect(ctx.shell.panes().every((p) => p.state() === "empty")).toBe(true);

    expect(term.split?.close()).toBe(true);
    await tick();
    await tick();
    expect(server.writes).toHaveLength(1);

    held.resolve();
    await until(() => shown(ctx, "left") === "s-new");
    await until(() => server.writes.length === 2);
    expect(server.writes[1]).toEqual({
      left: "s-new",
      right: null,
      handle: 0.5,
      selected: "left",
      open: false,
    });
  });

  it("a 409 re-lists once and writes again from the reconciled row", async () => {
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    await tick();
    const listsBefore = server.lists();
    server.putOnce = 409;
    // The server dropped s2 meanwhile: the re-list no longer carries it.
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];

    chipOf(root, "two").click();
    await until(() => server.writes.length === 2);
    await tick();

    expect(server.lists()).toBe(listsBefore + 1);
    expect(server.writes[0]).toEqual({
      left: "s2",
      right: null,
      handle: 0.5,
      selected: "left",
      open: false,
    });
    expect(server.writes[1]).toEqual({
      left: "s1",
      right: null,
      handle: 0.5,
      selected: "left",
      open: false,
    });
    expect(shown(ctx, "left")).toBe("s1");
    await tick();
    await tick();
    expect(server.writes).toHaveLength(2);
  });

  it("a 500 warns once, and the next change writes again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    await tick();
    server.putStatus = 500;

    chipOf(root, "two").click();
    await until(() => server.writes.length === 1);
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("could not write the pane layout");

    term.split?.open();
    await until(() => server.writes.length === 2);
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(server.writes[1]?.open).toBe(true);
    warn.mockRestore();
  });

  it("one PUT is in flight at a time: changes during it are sent once it lands, so the latest state is always the last write", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    await tick();
    const held = gate();
    server.putGate = held;

    chipOf(root, "two").click();
    await until(() => server.writes.length === 1);
    // Two more changes while the first PUT hangs: neither goes out yet.
    chipOf(root, "three").click();
    await tick();
    chipOf(root, "one").click();
    await tick();
    await tick();
    expect(server.writes).toHaveLength(1);
    expect(shown(ctx, "left")).toBe("s1");

    // The slow first PUT answers; exactly one more PUT follows, carrying the state
    // as it is NOW, not the intermediate one.
    server.putGate = null;
    held.resolve();
    await until(() => server.writes.length === 2);
    await tick();
    await tick();
    expect(server.writes).toHaveLength(2);
    expect(server.writes[1]?.left).toBe("s1");
  });

  it("a 409 that lands while a re-list is already running waits for THAT listing and writes the reconciled row once", async () => {
    const monitor = fakeMonitor();
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server, {
      before: [monitor.feature],
      tabsOpts: { activityMonitor: monitor.feature },
    });
    await tick();
    // The server dropped s2 meanwhile; the listing that says so is slow.
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const listGate = gate();
    server.fetch.mockImplementationOnce(async () => {
      await listGate.promise;
      return jsonResponse(server.list, 200);
    });
    monitor.open();
    await tick();
    const listsBefore = server.lists();
    server.putOnce = 409;

    chipOf(root, "two").click();
    await until(() => server.writes.length === 1);
    await tick();
    await tick();
    expect(server.writes).toHaveLength(1);

    listGate.resolve();
    await until(() => server.writes.length === 2);
    await tick();
    await tick();
    expect(server.lists()).toBe(listsBefore);
    expect(server.writes[1]).toMatchObject({ left: "s1", right: null, open: false });
    expect(shown(ctx, "left")).toBe("s1");
    expect(server.writes).toHaveLength(2);
  });

  it("a layout 409 that lands after teardown starts no re-list", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    await tick();
    const held = gate();
    server.putGate = held;
    server.putOnce = 409;

    chipOf(root, "two").click();
    await until(() => server.writes.length === 1);
    const listsBefore = server.lists();
    term.destroy();
    held.resolve();
    await tick();
    await tick();
    await tick();
    expect(server.lists()).toBe(listsBefore);
    expect(server.writes).toHaveLength(1);
  });

  it("an order 409 that lands after teardown starts no re-list", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    await tick();
    const held = gate();
    server.orderGate = held;
    server.orderStatus = 409;

    menuItem(openTabMenu(root, "one"), "Move right").click();
    await until(() => server.fetch.mock.calls.some((c) => String(c[0]).endsWith("/order")));
    const listsBefore = server.lists();
    term.destroy();
    held.resolve();
    await tick();
    await tick();
    await tick();
    expect(server.lists()).toBe(listsBefore);
  });

  it("a collapse under the width two panes need, and the restore above it, write nothing", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    menuItem(openTabMenu(root, "two"), "Snap to right").click();
    await until(() => server.writes.length === 1);
    await tick();

    root.style.width = "720px";
    await settle();
    expect(term.split?.state().collapsed).toBe(true);
    root.style.width = "730px";
    await settle();
    expect(term.split?.state().collapsed).toBe(false);
    await tick();
    expect(server.writes).toHaveLength(1);
  });
});
