import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type { SessionStatus } from "@cplieger/web-terminal-engine";
import {
  chipOf,
  fakeMonitor,
  fakeServer,
  mountTabbed,
  rootIn,
  shown,
  stripSplit,
  tick,
  until,
  type FakeMonitor,
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

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";
const STALE = "That tab is no longer open";
const SERVED = "Served page";
const basePath = location.pathname + location.search;

let server: FakeSessionServer;
let monitor: FakeMonitor;

const session = (id: string, alias: string | undefined, createdAt: string): SessionStatus =>
  ({
    id,
    title: id,
    createdAt,
    status: "idle",
    ...(alias === undefined ? {} : { alias }),
  }) as SessionStatus;

beforeEach(() => {
  fake.reset();
  server = fakeServer();
  server.list = [session("s1", A, "1"), session("s2", B, "2"), session("s3", C, "3")];
  monitor = fakeMonitor();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
  history.replaceState(null, "", basePath);
  // Every mount takes this as the served title; the afterEach destroy writes it back.
  document.title = SERVED;
});

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", basePath);
});

// A popstate after history.back() or forward() is a queued task; wait for it.
async function travel(go: () => void): Promise<void> {
  const done = new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true });
  });
  go();
  await done;
  await tick();
}

async function typeHash(hash: string): Promise<void> {
  location.hash = hash;
  await tick();
  await tick();
}

const toastText = (root: HTMLElement): string => root.querySelector(".wt-toast")?.textContent ?? "";

async function mount(
  hash = "",
  opts: { width?: number; layout?: "viewport" | "container" } = {},
): ReturnType<typeof mountTabbed> {
  if (hash !== "") {
    history.replaceState(null, "", hash);
  }
  const root = rootIn(opts.width ?? 1000);
  const m = await mountTabbed(root, server, {
    before: [monitor.feature],
    tabsOpts: { activityMonitor: monitor.feature },
    ...(opts.layout === undefined ? {} : { opts: { layout: opts.layout } }),
  });
  await tick();
  return m;
}

describe("boot", () => {
  it("shows the tab the address names over the record, without a history entry, and moves the record to it", async () => {
    server.layout = { open: false, left: "s1", right: null, handle: 0.5, selected: "left" };
    const before = history.length;
    const { ctx } = await mount(`#${B}`);

    expect(shown(ctx, "left")).toBe("s2");
    expect(location.hash).toBe(`#${B}`);
    expect(history.length).toBe(before);
    await until(() => server.writes.length > 0);
    expect(server.writes).toEqual([
      { left: "s2", right: null, handle: 0.5, selected: "left", open: false },
    ]);
  });

  it("opens both panes a split address names, keeping the record's selection and handle when it names the same tabs", async () => {
    server.layout = { open: true, left: "s1", right: "s2", handle: 0.4, selected: "right" };
    const { term, ctx } = await mount(`#${A},${B}`);

    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(term.split?.state().committedRatio).toBe(0.4);
    expect(server.writes).toEqual([]);
  });

  it("selects the left pane and rewrites the record when the split address differs from it", async () => {
    server.layout = { open: true, left: "s1", right: "s2", handle: 0.4, selected: "right" };
    const { ctx } = await mount(`#${C},${A}`);

    expect(shown(ctx, "left")).toBe("s3");
    expect(shown(ctx, "right")).toBe("s1");
    expect(ctx.shell.selected()).toBe("left");
    await until(() => server.writes.length > 0);
    expect(server.writes).toEqual([
      { left: "s3", right: "s1", handle: 0.4, selected: "left", open: true },
    ]);
  });

  it("boots the record's tab on an unknown alias, tells a deep link once and canonicalises in place", async () => {
    const before = history.length;
    const { root, ctx } = await mount("#zzzzzzzz");

    expect(shown(ctx, "left")).toBe("s1");
    expect(toastText(root)).toBe(STALE);
    expect(location.hash).toBe(`#${A}`);
    expect(history.length).toBe(before);
  });

  it("corrects an unknown alias silently on a reload", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { type: "reload" } as unknown as PerformanceEntry,
    ]);
    const { root } = await mount("#zzzzzzzz");

    expect(toastText(root)).toBe("");
    expect(location.hash).toBe(`#${A}`);
  });

  it("boots a live tab without a notice when the address names an ended tab still in the row", async () => {
    server.list = [session("s1", A, "1"), { ...session("s2", B, "2"), status: "exited" }];
    const { root, ctx } = await mount(`#${B}`);

    expect(shown(ctx, "left")).toBe("s1");
    expect(chipOf(root, "s2")).toBeTruthy();
    expect(toastText(root)).toBe("");
    expect(location.hash).toBe(`#${A}`);
  });

  it("treats an inherited property name as an unknown alias", async () => {
    const { root, ctx } = await mount("#constructor");

    expect(shown(ctx, "left")).toBe("s1");
    expect(toastText(root)).toBe(STALE);
    expect(location.hash).toBe(`#${A}`);
  });

  it("writes no fragment when the shown tab has no alias", async () => {
    server.list = [session("s1", undefined, "1"), session("s2", undefined, "2")];
    const { root } = await mount();
    chipOf(root, "s2").click();
    await tick();

    expect(location.hash).toBe("");
  });
});

describe("switching writes the address", () => {
  it("pushes one entry for a tab click", async () => {
    const { root } = await mount();
    const before = history.length;
    chipOf(root, "s2").click();
    await tick();

    expect(location.hash).toBe(`#${B}`);
    expect(history.length).toBe(before + 1);
  });

  it("pushes the split form when the split opens and the single form when it closes", async () => {
    const { root, ctx } = await mount();
    stripSplit(root).click();
    await tick();
    expect(location.hash).toBe(`#${A},${B}`);

    ctx.shell.select("right");
    stripSplit(root).click();
    await tick();
    expect(location.hash).toBe(`#${B}`);
  });

  it("adds nothing for a ratio change, a selection change or a re-click of a shown tab", async () => {
    const { root, term, ctx } = await mount(`#${A},${B}`);
    const before = history.length;
    term.split?.setRatio(0.4, true);
    ctx.shell.select("right");
    chipOf(root, "s1").click();
    await tick();

    expect(location.hash).toBe(`#${A},${B}`);
    expect(history.length).toBe(before);
  });

  it("rewrites the address in place when a shown tab's alias changes, and not for a tab off screen", async () => {
    await mount();
    const before = history.length;
    monitor.emit(session("s3", "sess_offscreen", "3"));
    await tick();
    expect(location.hash).toBe(`#${A}`);

    monitor.emit(session("s1", "sess_thread", "1"));
    await tick();
    expect(location.hash).toBe("#sess_thread");
    expect(history.length).toBe(before);
  });

  it("pushes the new tab's alias when one is created", async () => {
    server.newAlias = "dddddddd";
    const { api } = await mount();
    await api.create();
    await until(() => location.hash === "#dddddddd");

    expect(location.hash).toBe("#dddddddd");
  });
});

describe("the page title", () => {
  it("names the page after the tab shown at load, then the served title", async () => {
    await mount(`#${B}`);
    expect(document.title).toBe("s2 · Served page");
  });

  it("follows a tab switch", async () => {
    const { root } = await mount();
    chipOf(root, "s3").click();
    await tick();
    expect(document.title).toBe("s3 · Served page");
  });

  it("follows the selected pane of a split", async () => {
    const { ctx } = await mount(`#${A},${B}`);
    expect(document.title).toBe("s1 · Served page");
    ctx.shell.select("right");
    await tick();
    expect(document.title).toBe("s2 · Served page");
  });

  it("follows a rename of the active tab, and not of another", async () => {
    await mount();
    monitor.emit({ ...session("s2", B, "2"), title: "background" } as SessionStatus);
    await tick();
    expect(document.title).toBe("s1 · Served page");
    monitor.emit({ ...session("s1", A, "1"), title: "renamed" } as SessionStatus);
    await tick();
    expect(document.title).toBe("renamed · Served page");
  });

  it("puts the attention count before the tab and the served title", async () => {
    const { root } = await mount();
    chipOf(root, "s3").click();
    await tick();
    monitor.emit({ ...session("s1", A, "1"), status: "input" } as SessionStatus);
    await tick();
    expect(document.title).toBe("(1) s3 · Served page");
  });

  it("suffixes a program title once, however often it is repainted", async () => {
    await mount();
    const cbs = fake.callbacks();
    cbs.onMessage({ type: "title", title: "vim" });
    cbs.onMessage({ type: "title", title: "vim" });
    cbs.onMessage({ type: "title", title: "make" });
    expect(document.title).toBe("make · Served page");
  });

  it("goes back to the served title alone when no tab is left", async () => {
    server.list = [session("s1", A, "1")];
    await mount();
    // A program's own window title renames its tab, and must not outlive it.
    fake.callbacks().onMessage({ type: "title", title: "program title" });
    expect(document.title).toBe("program title · Served page");
    monitor.emit({ id: "s1", removed: true } as SessionStatus);
    await until(() => document.title === SERVED);
    expect(document.title).toBe(SERVED);
  });

  it("leaves the title of an embedding page alone", async () => {
    await mount("", { layout: "container" });
    expect(document.title).toBe(SERVED);
  });
});

describe("navigating the address", () => {
  it("swaps the panes in place when the fragment is edited, with no reload and no session request", async () => {
    const { ctx } = await mount(`#${A},${B}`);
    const sentinel = Symbol("same document");
    (window as unknown as Record<string, unknown>)["__wtSentinel"] = sentinel;
    const engines = fake.engines.length;
    const lists = server.lists();
    const calls = server.fetch.mock.calls.length;

    await typeHash(`#${B},${A}`);

    expect(shown(ctx, "left")).toBe("s2");
    expect(shown(ctx, "right")).toBe("s1");
    expect((window as unknown as Record<string, unknown>)["__wtSentinel"]).toBe(sentinel);
    expect(fake.engines.length).toBe(engines);
    expect(server.lists()).toBe(lists);
    expect(server.posts()).toBe(0);
    expect(server.deletes()).toEqual([]);
    // Only the layout record follows; no session is created, listed or closed.
    expect(
      server.fetch.mock.calls.slice(calls).every((c) => String(c[0]).endsWith("/layout")),
    ).toBe(true);
    expect(location.hash).toBe(`#${B},${A}`);
  });

  it("keeps the selected right pane across a swap, and the page title follows it", async () => {
    const { ctx } = await mount(`#${A},${B}`);
    ctx.shell.select("right");
    await tick();

    await typeHash(`#${B},${A}`);

    expect(shown(ctx, "left")).toBe("s2");
    expect(shown(ctx, "right")).toBe("s1");
    expect(ctx.shell.selected()).toBe("right");
    expect(document.title).toBe("s1 · Served page");
  });

  it("loads any combination of open tabs, opening the split for it", async () => {
    const { term, ctx } = await mount();
    await typeHash(`#${A},${C}`);

    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s3");
  });

  it("closes the split for a single-tab fragment", async () => {
    const { term, ctx } = await mount(`#${A},${B}`);
    await typeHash(`#${B}`);

    expect(term.split?.isOpen()).toBe(false);
    expect(shown(ctx, "left")).toBe("s2");
  });

  it("goes back to the previous combination and forward again", async () => {
    const { ctx } = await mount(`#${A},${B}`);
    await typeHash(`#${C},${A}`);

    await travel(() => {
      history.back();
    });
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(location.hash).toBe(`#${A},${B}`);

    await travel(() => {
      history.forward();
    });
    expect(shown(ctx, "left")).toBe("s3");
    expect(shown(ctx, "right")).toBe("s1");
  });

  it("goes back after tab clicks", async () => {
    const { root, ctx } = await mount();
    chipOf(root, "s2").click();
    await tick();
    chipOf(root, "s3").click();
    await tick();

    await travel(() => {
      history.back();
    });
    expect(shown(ctx, "left")).toBe("s2");
    expect(location.hash).toBe(`#${B}`);
  });

  it("corrects a back onto a tab closed since without a notice", async () => {
    const { root, ctx } = await mount();
    chipOf(root, "s2").click();
    await tick();
    chipOf(root, "s1").click();
    await tick();
    monitor.emit({ id: "s2", removed: true } as SessionStatus);
    await tick();

    await travel(() => {
      history.back();
    });
    expect(shown(ctx, "left")).toBe("s1");
    expect(location.hash).toBe(`#${A}`);
    expect(toastText(root)).toBe("");
  });

  it("tells a typed unknown alias once and keeps what is shown", async () => {
    const { root, ctx } = await mount();
    await typeHash("#zzzzzzzz");

    expect(shown(ctx, "left")).toBe("s1");
    expect(toastText(root)).toBe(STALE);
    expect(location.hash).toBe(`#${A}`);
  });

  it("keeps a side empty that the fragment leaves empty", async () => {
    const { term, ctx } = await mount(`#${A},${B}`);
    await typeHash(`#${A},`);
    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(location.hash).toBe(`#${A},`);

    await typeHash(`#,${B}`);
    expect(ctx.shell.pane("left")?.state()).toBe("empty");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(location.hash).toBe(`#,${B}`);
  });

  it("shows one tab and says why when the window is too narrow for a split", async () => {
    const { root, term, ctx } = await mount("", { width: 600 });
    await typeHash(`#${B},${C}`);

    expect(term.split?.isOpen()).toBe(false);
    expect(shown(ctx, "left")).toBe("s2");
    expect(toastText(root)).toBe("Split view needs a wider window");
    expect(location.hash).toBe(`#${B}`);
  });

  it("applies both sides to a collapsed split", async () => {
    server.layout = { open: true, left: "s1", right: "s2", handle: 0.5, selected: "left" };
    const { term, ctx } = await mount("", { width: 720 });
    expect(term.split?.state().collapsed).toBe(true);

    await typeHash(`#${C},${A}`);
    expect(shown(ctx, "left")).toBe("s3");
    expect(shown(ctx, "right")).toBe("s1");
    expect(location.hash).toBe(`#${C},${A}`);
  });

  it("leaves the address alone in an embedded terminal", async () => {
    const { ctx } = await mount(`#${B}`, { layout: "container" });
    expect(shown(ctx, "left")).toBe("s1");
    expect(location.hash).toBe(`#${B}`);

    await typeHash(`#${C}`);
    expect(shown(ctx, "left")).toBe("s1");
  });

  it("stops following the address once destroyed", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const { term } = await mount();
    const listeners = add.mock.calls.filter(
      ([type]) => type === "popstate" || type === "hashchange",
    );
    expect(listeners.map(([type]) => type).sort()).toEqual(["hashchange", "popstate"]);
    const remove = vi.spyOn(window, "removeEventListener");
    term.destroy();

    for (const [type, listener] of listeners) {
      expect(remove).toHaveBeenCalledWith(type, listener);
    }
  });
});
