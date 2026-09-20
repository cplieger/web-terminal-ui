import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { LineStore } from "@cplieger/web-terminal-engine";
import { connectionBanner } from "../connection-banner.js";
import { CUE_SEEN_KEY } from "./model.js";
import type { PersistedScrollback, ScrollbackPersistence } from "../../kernel/types.js";
import {
  chipOf,
  chips,
  engineOn,
  fakeMonitor,
  fakeServer,
  menuItem,
  mountTabbed,
  openTabMenu,
  paneRoot,
  rootIn,
  shown,
  stripSplit,
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

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

beforeEach(() => {
  fake.reset();
  server = fakeServer();
  server.list = [
    { id: "s1", title: "one", createdAt: "1", status: "idle" },
    { id: "s2", title: "two", createdAt: "2", status: "idle" },
    { id: "s3", title: "three", createdAt: "3", status: "idle" },
  ];
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  setVisibility("visible");
  vi.unstubAllGlobals();
});

const panelId = (root: HTMLElement, side: "left" | "right"): string =>
  paneRoot(root, side).querySelector('[role="tabpanel"]')?.id ?? "";
const attrsOf = (el: HTMLElement): string =>
  `${el.className}|${Array.from(el.attributes)
    .filter((a) => a.name !== "class")
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(" ")}`;
const describedBy = (root: HTMLElement, side: "left" | "right"): string => {
  const panel = paneRoot(root, side).querySelector('[role="tabpanel"]');
  const id = panel?.getAttribute("aria-describedby");
  return id === null || id === undefined ? "" : (root.querySelector(`#${id}`)?.textContent ?? "");
};

describe("both shown tabs render alike", () => {
  it("lights both chips identically, marks the row multiselectable, and points each chip at its pane", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    stripSplit(root).click();
    chipOf(root, "two").click();
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");

    const [one, two, three] = chips(root);
    for (const chip of [one, two]) {
      expect(chip?.classList.contains("wt-tab-active")).toBe(true);
      expect(chip?.getAttribute("aria-selected")).toBe("true");
      expect(chip?.getAttribute("aria-expanded")).toBe("true");
    }
    expect(three?.classList.contains("wt-tab-active")).toBe(false);
    expect(three?.getAttribute("aria-selected")).toBe("false");
    expect(three?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector('[role="tablist"]')?.getAttribute("aria-multiselectable")).toBe(
      "true",
    );
    expect(panelId(root, "left")).not.toBe("");
    expect(panelId(root, "left")).not.toBe(panelId(root, "right"));
    expect(one?.getAttribute("aria-controls")).toBe(panelId(root, "left"));
    expect(two?.getAttribute("aria-controls")).toBe(panelId(root, "right"));
    // Every pane is full, so a click on the unshown chip would replace the
    // SELECTED pane's tab: its aria-controls names the right panel.
    expect(three?.getAttribute("aria-controls")).toBe(panelId(root, "right"));
    expect(
      paneRoot(root, "left").querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
    ).toBe(one?.id);
    expect(
      paneRoot(root, "right").querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
    ).toBe(two?.id);

    // Selection is not a property of the row: the shown chips do not change (the
    // unshown chip's aria-controls follows the pane a click would fill, below).
    const before = chips(root).slice(0, 2).map(attrsOf);
    expect(ctx.shell.select("left")).toBe(true);
    expect(chips(root).slice(0, 2).map(attrsOf)).toEqual(before);

    term.split?.close();
    expect(root.querySelector('[role="tablist"]')?.hasAttribute("aria-multiselectable")).toBe(
      false,
    );
    expect(chips(root).some((c) => c.hasAttribute("aria-expanded"))).toBe(false);
    expect(chips(root).filter((c) => c.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  it("an unshown chip names the empty pane while one exists, and follows the selected pane when none does", async () => {
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    stripSplit(root).click();
    // The right pane is empty: it is the one a click would fill.
    expect(chipOf(root, "two").getAttribute("aria-controls")).toBe(panelId(root, "right"));

    chipOf(root, "two").click();
    expect(ctx.shell.selected()).toBe("right");
    expect(chipOf(root, "three").getAttribute("aria-controls")).toBe(panelId(root, "right"));
    ctx.shell.select("left");
    expect(chipOf(root, "three").getAttribute("aria-controls")).toBe(panelId(root, "left"));
  });

  it("describes each tabpanel by its side and whether it is selected", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    expect(describedBy(root, "left")).toBe("");

    stripSplit(root).click();
    chipOf(root, "two").click();
    expect(ctx.shell.selected()).toBe("right");
    expect(describedBy(root, "right")).toBe("Right terminal, selected");
    expect(describedBy(root, "left")).toBe("Left terminal");

    ctx.shell.select("left");
    expect(describedBy(root, "left")).toBe("Left terminal, selected");
    expect(describedBy(root, "right")).toBe("Right terminal");

    term.split?.close();
    expect(describedBy(root, "left")).toBe("");
  });
});

describe("the shared chrome never moves selection", () => {
  it("focus on a tab-menu item, keyboard focus on the split button and a pointer press on it all leave the selected pane alone", async () => {
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    stripSplit(root).click();
    chipOf(root, "two").click();
    ctx.shell.select("left");
    expect(ctx.shell.selected()).toBe("left");
    const wasSelected = (): boolean[] =>
      (["left", "right"] as const).map((side) =>
        paneRoot(root, side).classList.contains("wt-pane-selected"),
      );
    expect(wasSelected()).toEqual([true, false]);

    const items = openTabMenu(root, "two");
    menuItem(items, "Snap to left").focus();
    expect(document.activeElement).toBe(menuItem(items, "Snap to left"));
    expect(ctx.shell.selected()).toBe("left");
    expect(wasSelected()).toEqual([true, false]);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const btn = stripSplit(root);
    btn.focus();
    expect(document.activeElement).toBe(btn);
    expect(ctx.shell.selected()).toBe("left");
    btn.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }),
    );
    expect(ctx.shell.selected()).toBe("left");
    expect(wasSelected()).toEqual([true, false]);
  });
});

describe("an emptied pane stays idle", () => {
  it("holds no session, shows the idle banner state, is inert, and opens no socket on a wake event until a tab is shown in it", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server, { panes: () => [connectionBanner()] });
    term.split?.open();
    const left = ctx.shell.pane("left");
    if (!left) {
      throw new Error("no left pane");
    }
    const leftBanner = paneRoot(root, "left").querySelector<HTMLElement>(".wt-conn-banner");
    const states: string[] = [];
    left.on("connection:state", (s) => {
      states.push(s);
    });
    const leftEngine = engineOn(fake, root, "left");
    const rightEngine = engineOn(fake, root, "right");
    // A first frame on the left engine, so its banner is past the loading gate.
    leftEngine.callbacks.onMessage({
      type: "screen",
      rows: [[]],
      base: 0,
      cursor: [0, 0],
      changed: [0],
    });
    await tick();
    leftEngine.renderer.bind.mockClear();
    leftEngine.renderer.resetScreen.mockClear();
    leftEngine.connection.sendBinary.mockClear();

    menuItem(openTabMenu(root, "one"), "Snap to right").click();
    expect(shown(ctx, "right")).toBe("s1");
    expect(left.state()).toBe("empty");
    expect(left.session.id).toBeNull();
    // The rows of the moved session are gone: a fresh, empty store and a reset screen.
    const fresh = leftEngine.renderer.bind.mock.calls
      .map((c) => c[0])
      .find((s) => s.highestIndex() === -1);
    expect(fresh).toBeInstanceOf(LineStore);
    expect(leftEngine.renderer.resetScreen).toHaveBeenCalled();
    expect(rightEngine.renderer.resetScreen).not.toHaveBeenCalled();
    expect(states[states.length - 1]).toBe("idle");
    expect(leftBanner?.classList.contains("visible")).toBe(false);
    expect(leftBanner?.textContent).toBe("");
    expect(paneRoot(root, "left").hasAttribute("inert")).toBe(true);
    left.send(new Uint8Array([0x41]));
    expect(leftEngine.connection.sendBinary).not.toHaveBeenCalled();

    // Every wake event: the one shown pane (the right) reconnects, the empty one does not.
    leftEngine.connection.reconnectNow.mockClear();
    rightEngine.connection.reconnectNow.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    expect(rightEngine.connection.reconnectNow).toHaveBeenCalledTimes(3);
    expect(leftEngine.connection.reconnectNow).not.toHaveBeenCalled();

    leftEngine.connection.setSession.mockClear();
    rightEngine.connection.setSession.mockClear();
    chipOf(root, "two").click();
    expect(shown(ctx, "left")).toBe("s2");
    expect(leftEngine.connection.setSession.mock.calls).toEqual([["s2"]]);
    expect(rightEngine.connection.setSession).not.toHaveBeenCalled();
    leftEngine.callbacks.onOpen();
    expect(states[states.length - 1]).toBe("open");
    left.send(new Uint8Array([0x41]));
    expect(leftEngine.connection.sendBinary).toHaveBeenCalledTimes(1);
    expect(rightEngine.connection.sendBinary).not.toHaveBeenCalled();
    expect(paneRoot(root, "left").hasAttribute("inert")).toBe(false);
  });
});

describe("the catching-up cue is the pane's", () => {
  const cueVisible = (root: HTMLElement, side: "left" | "right"): boolean =>
    paneRoot(root, side).querySelector(".wt-catchup")?.classList.contains("visible") === true;
  const cueShown = (): Promise<void> => new Promise((r) => setTimeout(r, 200));

  it("a backlog frame on the right engine raises the right pane's cue and not the left's", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    // A warm store, so showing the tab arms nothing on its own.
    const right = engineOn(fake, root, "right");
    right.renderer.getHighestIndex.mockReturnValue(0);
    chipOf(root, "two").click();
    expect(shown(ctx, "right")).toBe("s2");
    await cueShown();
    expect(cueVisible(root, "left")).toBe(false);
    expect(cueVisible(root, "right")).toBe(false);
    // Only the RIGHT renderer reports a backlog.
    right.renderer.pendingRowCount.mockReturnValue(5000);

    right.callbacks.onMessage({
      type: "screen",
      rows: [[]],
      base: 0,
      cursor: [0, 0],
      changed: [0],
    });
    await cueShown();

    expect(paneRoot(root, "right").querySelector(".wt-catchup")?.getAttribute("role")).toBe(
      "status",
    );
    expect(cueVisible(root, "right")).toBe(true);
    expect(cueVisible(root, "left")).toBe(false);
  });

  it("a never-viewed tab shown in the right pane arms that pane's cue alone", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    term.split?.open();

    chipOf(root, "two").click();
    await cueShown();

    expect(cueVisible(root, "right")).toBe(true);
    expect(cueVisible(root, "left")).toBe(false);
  });
});

describe("attention with two shown tabs", () => {
  function stubNotification(): { title: string; body: string | undefined }[] {
    const posts: { title: string; body: string | undefined }[] = [];
    class FakeNotification {
      static permission = "granted";
      constructor(title: string, options?: { body?: string }) {
        posts.push({ title, body: options?.body });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    return posts;
  }
  const cueSeen = (): Record<string, string> =>
    JSON.parse(localStorage.getItem(CUE_SEEN_KEY) ?? "{}") as Record<string, string>;

  it("a completion in the unselected pane raises no cue anywhere and is recorded as seen; an ordinary tab's still does", async () => {
    document.title = "Host page";
    const posts = stubNotification();
    const ownIcon = document.createElement("link");
    ownIcon.rel = "icon";
    ownIcon.setAttribute("href", "/favicon.svg");
    document.head.appendChild(ownIcon);
    try {
      const monitor = fakeMonitor();
      const root = rootIn();
      const { ctx } = await mountTabbed(root, server, {
        before: [monitor.feature],
        tabsOpts: { activityMonitor: monitor.feature, attentionIcons: true },
      });
      stripSplit(root).click();
      chipOf(root, "two").click();
      expect(ctx.shell.selected()).toBe("right");
      const dot = root.querySelector<HTMLElement>(".wt-switcher-switch-dot");

      // s1 is shown in the LEFT pane, which is not selected but is on screen.
      monitor.emit({
        id: "s1",
        status: "done",
        title: "one",
        createdAt: "1",
        notification: "Response complete",
        notificationSeq: 1,
      });
      expect(document.title).toBe("Host page");
      expect(ownIcon.getAttribute("href")).toBe("/favicon.svg");
      expect(dot?.dataset["status"]).toBeUndefined();
      expect(posts).toEqual([]);
      expect(cueSeen()["s1"]).toBe("done");

      // s2, the selected pane's tab, likewise.
      monitor.emit({ id: "s2", status: "done", title: "two", createdAt: "2" });
      expect(dot?.dataset["status"]).toBeUndefined();
      expect(cueSeen()["s2"]).toBe("done");

      // s3 is an ordinary tab: its completion is a background event.
      monitor.emit({
        id: "s3",
        status: "done",
        title: "three",
        createdAt: "3",
        notification: "Response complete",
        notificationSeq: 1,
      });
      expect(document.title).toBe("(1) Host page");
      expect(ownIcon.getAttribute("href")).toBe("/favicon-done.svg");
      expect(dot?.dataset["status"]).toBe("done");
      expect(posts).toEqual([{ title: "three", body: "Response complete" }]);
      expect(cueSeen()["s3"]).toBeUndefined();
    } finally {
      ownIcon.remove();
    }
  });

  it("coming back to the page marks BOTH shown tabs seen", async () => {
    document.title = "Host page";
    const monitor = fakeMonitor();
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server, {
      before: [monitor.feature],
      tabsOpts: { activityMonitor: monitor.feature },
    });
    stripSplit(root).click();
    chipOf(root, "two").click();
    expect(ctx.shell.selected()).toBe("right");

    setVisibility("hidden");
    monitor.emit({ id: "s1", status: "input", title: "one", createdAt: "1" });
    monitor.emit({ id: "s2", status: "input", title: "two", createdAt: "2" });
    monitor.emit({ id: "s3", status: "input", title: "three", createdAt: "3" });
    expect(document.title).toBe("(3) Host page");

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("(1) Host page");
    expect(cueSeen()["s1"]).toBe("input");
    expect(cueSeen()["s2"]).toBe("input");
    expect(cueSeen()["s3"]).toBeUndefined();
  });
});

describe("a tab's scrollback follows it between panes", () => {
  function storage(): ScrollbackPersistence & {
    readonly entries: Map<string, PersistedScrollback>;
  } {
    const entries = new Map<string, PersistedScrollback>();
    return {
      entries,
      load: (id) => entries.get(id) ?? null,
      save: (id, entry) => {
        entries.set(id, entry);
      },
      drop: (id) => {
        entries.delete(id);
      },
    };
  }

  it("the gaining renderer binds the SAME store, and a save after both panes forgot the session still carries its epoch", async () => {
    const persist = storage();
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server, {
      opts: { persistScrollback: persist },
    });
    await tick();
    const leftEngine = engineOn(fake, root, "left");
    const boundAtBoot = leftEngine.renderer.bind.mock.calls[0]?.[0];
    expect(boundAtBoot).toBeInstanceOf(LineStore);
    if (!boundAtBoot) {
      throw new Error("the boot bound no store");
    }
    // Content the left pane received for s1.
    boundAtBoot.applyScroll({
      type: "scroll",
      firstIndex: 0,
      lines: Array.from({ length: 4 }, (_, i) => [
        { t: `L${String(i)}`, f: -1, b: -1, a: 0, uc: -1 },
      ]),
    });
    term.split?.open();
    const rightEngine = engineOn(fake, root, "right");
    // The left connection knows s1's server epoch; the right one has never seen it.
    leftEngine.connection.serverEpochOf.mockImplementation((id: string) =>
      id === "s1" ? 4242 : 0,
    );
    rightEngine.renderer.bind.mockClear();

    menuItem(openTabMenu(root, "one"), "Snap to right").click();
    expect(shown(ctx, "right")).toBe("s1");
    const boundOnTheRight = rightEngine.renderer.bind.mock.calls.map((c) => c[0]);
    expect(boundOnTheRight[boundOnTheRight.length - 1]).toBe(boundAtBoot);
    expect(rightEngine.renderer.boundStore()).toBe(boundAtBoot);
    expect(leftEngine.renderer.boundStore()).not.toBe(boundAtBoot);

    // Neither connection knows the epoch any more (the left forgot the session,
    // the right has had no resume yet): the save is filed under the handed-over one.
    leftEngine.connection.serverEpochOf.mockReturnValue(0);
    window.dispatchEvent(new Event("pagehide"));
    expect(persist.entries.get("s1")?.snapshot.serverEpoch).toBe(4242);
    expect(persist.entries.get("s1")?.snapshot.highest).toBe(3);
    await until(() => shown(ctx, "right") === "s1");
  });
});
