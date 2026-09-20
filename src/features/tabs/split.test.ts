import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { tabs } from "./index.js";
import { mountTerminal } from "../../test-helpers/mount.js";
import type { FakeEngineRecord } from "../../test-helpers/fake-engine.js";
import type {
  PaneSide,
  PersistedScrollback,
  ScrollbackPersistence,
  TerminalContext,
  TerminalFeature,
  TerminalStartupFailure,
} from "../../kernel/types.js";
import {
  activeLabels,
  announced,
  chipOf,
  chips,
  engineOn as engineOnPane,
  gate,
  fakeMonitor,
  fakeServer,
  jsonResponse,
  lateRejecting,
  menuItem,
  mountTabbed,
  openTabMenu,
  paneRoot,
  politeText,
  rootIn,
  separatorOf,
  settle,
  shown,
  stripSplit,
  textareaOf,
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

/** Every engine read names its pane: sides are assigned at each open and close,
 *  so a fixed engine index or the fake's primary alias would drift. */
const engineOn = (root: HTMLElement, side: PaneSide): FakeEngineRecord =>
  engineOnPane(fake, root, side);
/** The ids each pane's connection was told to forget since the last clear. */
const forgets = (root: HTMLElement): { left: string[]; right: string[] } => ({
  left: engineOn(root, "left").connection.forgetSession.mock.calls.map((c) => c[0]),
  right: engineOn(root, "right").connection.forgetSession.mock.calls.map((c) => c[0]),
});
const clearForgets = (): void => {
  for (const e of fake.engines) {
    e.connection.forgetSession.mockClear();
  }
};

let server: FakeSessionServer;

beforeEach(() => {
  fake.reset();
  server = fakeServer();
  vi.stubGlobal("fetch", server.fetch);
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const switcherSplit = (root: HTMLElement): HTMLButtonElement => {
  const btn = root.querySelector<HTMLButtonElement>(".wt-switcher-bar > .wt-switcher-split");
  if (!btn) {
    throw new Error("no switcher split button");
  }
  return btn;
};
const paneRoots = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(":scope > .wt-split-pane"));
/** Activate a focused button the way a keyboard does: the keydown, then the
 *  click the button dispatches for it. */
function pressKey(el: HTMLElement, key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  el.click();
  return ev;
}
/** The elements Tab visits after `from`, in document order: a non-negative
 *  tabIndex, not hidden, not disabled, not inside an inert subtree, and able to
 *  take focus when asked. The divider is skipped while the split is closed: the
 *  stylesheet, not loaded here, gives it `display: none` then. */
function tabStops(from: HTMLElement, count: number): HTMLElement[] {
  const all = Array.from(document.body.querySelectorAll<HTMLElement>("*"));
  const start = all.indexOf(from);
  const out: HTMLElement[] = [];
  for (const el of all.slice(start + 1)) {
    if (
      el.tabIndex < 0 ||
      el.hidden ||
      el.closest("[inert]") !== null ||
      (el instanceof HTMLButtonElement && el.disabled) ||
      (el.classList.contains("wt-split-handle") &&
        !el.parentElement?.classList.contains("wt-split-open"))
    ) {
      continue;
    }
    el.focus();
    if (document.activeElement === el) {
      out.push(el);
      if (out.length === count) {
        break;
      }
    }
  }
  return out;
}
function stubMedia(answers: Record<string, boolean>): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: answers[query] ?? false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}
interface FakeDataTransfer {
  effectAllowed: string;
  dropEffect: string;
  data: Record<string, string>;
  setData(type: string, value: string): void;
  setDragImage(): void;
}
function fakeDataTransfer(): FakeDataTransfer {
  return {
    effectAllowed: "",
    dropEffect: "",
    data: {},
    setData(type, value) {
      this.data[type] = value;
    },
    setDragImage() {
      /* the ghost is not under test */
    },
  };
}
function dragAt(
  type: string,
  dt: FakeDataTransfer,
  target: Element,
  clientX: number,
  clientY = 300,
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dt });
  Object.defineProperty(e, "clientX", { value: clientX });
  Object.defineProperty(e, "clientY", { value: clientY });
  target.dispatchEvent(e);
  return e;
}

describe("the split button", () => {
  it("is an ordinary button in the strip after the '+', labelled 'Split view' with aria-expanded, and absent without the option", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    const btn = stripSplit(root);
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("aria-label")).toBe("Split view");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.hasAttribute("tabindex")).toBe(false);
    expect(btn.hidden).toBe(false);
    expect(btn.previousElementSibling?.classList.contains("wt-tab-new")).toBe(true);
    expect(btn.nextElementSibling?.classList.contains("wt-tab-kb")).toBe(true);
    term.destroy();

    const plain = rootIn();
    await mountTerminal(plain, { features: () => [tabs()] });
    await until(() => plain.querySelectorAll(".wt-tab").length === 2);
    expect(plain.querySelector(".wt-tab-split")).toBeNull();
    expect(plain.querySelector(".wt-switcher-split")).toBeNull();
  });

  it("a click opens the split with the shown tab on the left and an empty right pane, and a second click closes it onto the selected pane", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    const btn = stripSplit(root);
    expect(shown(ctx, "left")).toBe("s1");

    btn.click();
    expect(term.split?.isOpen()).toBe(true);
    expect(root.classList.contains("wt-split-open")).toBe(true);
    expect(paneRoots(root)).toHaveLength(2);
    expect(shown(ctx, "left")).toBe("s1");
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(paneRoot(root, "right").hasAttribute("inert")).toBe(true);
    expect(ctx.shell.selected()).toBe("left");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    // The new pane's surface clears the strip like the first one's.
    expect(
      paneRoot(root, "right").querySelector(".term")?.classList.contains("wt-with-tabbar"),
    ).toBe(true);
    await announced();
    expect(politeText(root)).toBe("Split open");

    // Fill the right pane, select it, then close from the button: the selected
    // pane's tab fills the view and the other pane's tab becomes ordinary.
    chipOf(root, "two").click();
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(activeLabels(root)).toEqual(["one", "two"]);
    const losing = engineOn(root, "left");
    const survivor = engineOn(root, "right");
    for (const e of [losing, survivor]) {
      e.connection.forgetSession.mockClear();
      e.connection.sendResize.mockClear();
    }

    btn.click();
    expect(term.split?.isOpen()).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // The emptied pane's connection forgets its session; the survivor's keeps s2.
    expect(losing.connection.forgetSession.mock.calls).toEqual([["s1"]]);
    expect(survivor.connection.forgetSession).not.toHaveBeenCalled();
    expect(shown(ctx, "left")).toBe("s2");
    expect(shown(ctx, "right")).toBeNull();
    expect(activeLabels(root)).toEqual(["two"]);
    expect(chips(root)).toHaveLength(2);
    expect(root.style.getPropertyValue("--wt-split-ratio")).toBe("0.5");
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
    expect(paneRoot(root, "right").hasAttribute("inert")).toBe(true);
    // One resize reaches the survivor, now the full-width left pane; none the hidden one.
    expect(survivor.connection.sendResize).toHaveBeenCalledTimes(1);
    expect(losing.connection.sendResize).not.toHaveBeenCalled();
    expect(engineOn(root, "left")).toBe(survivor);
    await announced();
    expect(politeText(root)).toBe("Split closed");
  });

  it("carries hidden under 730 px of row width, open or closed, and loses it at 730 px", async () => {
    const root = rootIn(720);
    const { term } = await mountTabbed(root, server);
    const strip = stripSplit(root);
    const sw = switcherSplit(root);
    expect(strip.hidden).toBe(true);
    expect(sw.hidden).toBe(true);
    expect(term.split?.canOpen()).toBe(false);

    root.style.width = "730px";
    await settle();
    expect(strip.hidden).toBe(false);
    expect(sw.hidden).toBe(false);

    expect(term.split?.open()).toBe(true);
    root.style.width = "720px";
    await settle();
    expect(term.split?.state().collapsed).toBe(true);
    expect(strip.hidden).toBe(true);
    expect(sw.hidden).toBe(true);
  });

  it("the switcher bar's button sits between the keyboard and switch buttons and toggles the split like the strip's", async () => {
    const root = rootIn(1000, 400);
    const { term, ctx } = await mountTabbed(root, server);
    const sw = switcherSplit(root);
    expect(sw.getAttribute("aria-label")).toBe("Split view");
    expect(sw.hasAttribute("tabindex")).toBe(false);
    expect(sw.previousElementSibling?.classList.contains("wt-switcher-kb")).toBe(true);
    expect(sw.nextElementSibling?.classList.contains("wt-switcher-switch")).toBe(true);
    expect(root.classList.contains("wt-narrow")).toBe(true);
    expect(sw.hidden).toBe(false);

    sw.click();
    expect(term.split?.isOpen()).toBe(true);
    expect(sw.getAttribute("aria-expanded")).toBe("true");
    expect(stripSplit(root).getAttribute("aria-expanded")).toBe("true");
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    sw.click();
    expect(term.split?.isOpen()).toBe(false);
    expect(sw.getAttribute("aria-expanded")).toBe("false");
    expect(shown(ctx, "left")).toBe("s1");
  });

  it("is reached by Tab after the selected chip and the '+', and Enter or Space toggles the split leaving focus on it", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    const btn = stripSplit(root);
    const input = textareaOf(root, "left");
    input.focus();
    expect(document.activeElement).toBe(input);
    const stops = tabStops(input, 3);
    expect(stops[0]).toBe(chipOf(root, "one"));
    expect(stops[1]?.classList.contains("wt-tab-new")).toBe(true);
    expect(stops[2]).toBe(btn);
    expect(document.activeElement).toBe(btn);

    pressKey(btn, "Enter");
    expect(term.split?.isOpen()).toBe(true);
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    await announced();
    expect(politeText(root)).toBe("Split open");

    pressKey(btn, "Enter");
    expect(term.split?.isOpen()).toBe(false);
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await announced();
    expect(politeText(root)).toBe("Split closed");

    pressKey(btn, " ");
    expect(term.split?.isOpen()).toBe(true);
    expect(document.activeElement).toBe(btn);
    pressKey(btn, " ");
    expect(term.split?.isOpen()).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it("a pointer press on it leaves focus in the terminal", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    const btn = stripSplit(root);
    const input = textareaOf(root, "left");
    input.focus();
    const down = new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    btn.click();
    expect(term.split?.isOpen()).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("a press held on any bar button across teardown ends with the terminal: every press's window listeners are aborted", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    const pressSignals: AbortSignal[] = [];
    const addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener, options) => {
        if (type === "pointerup" && typeof options === "object" && options.signal) {
          pressSignals.push(options.signal);
        }
        EventTarget.prototype.addEventListener.call(window, type, listener, options);
      });
    try {
      const bars = [
        ".wt-tab-new",
        ".wt-tab-split",
        ".wt-tab-kb",
        ".wt-switcher-new",
        ".wt-switcher-split",
        ".wt-switcher-kb",
        ".wt-switcher-switch",
      ];
      for (const sel of bars) {
        const el = root.querySelector<HTMLElement>(sel);
        if (!el) {
          throw new Error(`no ${sel}`);
        }
        el.dispatchEvent(
          new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }),
        );
      }
      expect(pressSignals).toHaveLength(bars.length);
      expect(pressSignals.filter((s) => s.aborted)).toHaveLength(0);

      term.destroy();
      expect(pressSignals.filter((s) => s.aborted)).toHaveLength(bars.length);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("with the split open, Tab runs left input, divider, right input, then the chrome; an empty right pane adds no stop", async () => {
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    stripSplit(root).click();
    await tick();
    let stops = tabStops(paneRoot(root, "left"), 5);
    expect(stops[0]).toBe(textareaOf(root, "left"));
    expect(stops[1]).toBe(separatorOf(root));
    expect(stops[2]).toBe(chipOf(root, "one"));
    expect(stops[3]?.classList.contains("wt-tab-new")).toBe(true);
    expect(stops[4]).toBe(stripSplit(root));

    chipOf(root, "two").click();
    await until(() => shown(ctx, "right") === "s2");
    stops = tabStops(paneRoot(root, "left"), 6);
    expect(stops[0]).toBe(textareaOf(root, "left"));
    expect(stops[1]).toBe(separatorOf(root));
    expect(stops[2]).toBe(textareaOf(root, "right"));
    expect(stops[3]).toBe(chipOf(root, "one"));
    expect(stops[4]).toBe(chipOf(root, "two"));
    expect(stops[5]?.classList.contains("wt-tab-new")).toBe(true);
    expect(ctx.shell.selected()).toBe("right");
  });

  it("a pane input leaves the Tab order when its pane empties and when the split closes, even without inert", async () => {
    const root = rootIn();
    const { ctx, api } = await mountTabbed(root, server);
    stripSplit(root).click();
    await tick();
    chipOf(root, "two").click();
    await until(() => shown(ctx, "right") === "s2");
    expect(textareaOf(root, "right").tabIndex).toBe(0);

    api.snap("s2", "left");
    await until(() => shown(ctx, "right") === null);
    paneRoot(root, "right").removeAttribute("inert");
    expect(textareaOf(root, "right").tabIndex).toBe(-1);
    expect(tabStops(separatorOf(root), 1)[0]).toBe(chipOf(root, "two"));

    stripSplit(root).click();
    await tick();
    expect(textareaOf(root, "left").tabIndex).toBe(-1);
    expect(tabStops(paneRoot(root, "left"), 1)[0]).toBe(chipOf(root, "two"));
  });
});

describe("the tab-click rule", () => {
  it("fills the empty pane first, then replaces the selected pane's tab, and a click on a shown tab selects its pane", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();

    chipOf(root, "two").click();
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(activeLabels(root)).toEqual(["one", "two"]);

    ctx.shell.select("left");
    chipOf(root, "three").click();
    expect(shown(ctx, "left")).toBe("s3");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("left");
    expect(activeLabels(root)).toEqual(["two", "three"]);
    expect(chips(root)).toHaveLength(3);

    for (const e of fake.engines) {
      e.connection.setSession.mockClear();
    }
    chipOf(root, "two").click();
    expect(ctx.shell.selected()).toBe("right");
    for (const e of fake.engines) {
      expect(e.connection.setSession).not.toHaveBeenCalled();
    }
    expect(shown(ctx, "left")).toBe("s3");
    expect(shown(ctx, "right")).toBe("s2");
  });

  it("'+' follows the same rule: the empty pane first, else the selected pane", async () => {
    const root = rootIn();
    const { term, ctx, api } = await mountTabbed(root, server);
    term.split?.open();

    await api.create();
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s-new");
    expect(ctx.shell.selected()).toBe("right");

    ctx.shell.select("left");
    server.list = [];
    server.fetch.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse({ id: "s-later", title: "", createdAt: "10", status: "idle" }, 201),
      ),
    );
    await api.create();
    expect(shown(ctx, "left")).toBe("s-later");
    expect(shown(ctx, "right")).toBe("s-new");
    expect(chips(root)).toHaveLength(4);
  });

  it("while collapsed an empty hidden pane is still filled first and becomes the visible pane; with both shown the visible pane's tab is replaced", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    root.style.width = "720px";
    await settle();
    expect(term.split?.state().collapsed).toBe(true);
    expect(paneRoot(root, "right").hasAttribute("inert")).toBe(true);

    chipOf(root, "two").click();
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(paneRoot(root, "right").classList.contains("wt-pane-selected")).toBe(true);
    expect(paneRoot(root, "left").classList.contains("wt-pane-selected")).toBe(false);
    expect(paneRoot(root, "left").hasAttribute("inert")).toBe(true);
    expect(paneRoot(root, "right").hasAttribute("inert")).toBe(false);

    chipOf(root, "three").click();
    expect(shown(ctx, "right")).toBe("s3");
    expect(shown(ctx, "left")).toBe("s1");
    expect(ctx.shell.selected()).toBe("right");
    expect(activeLabels(root)).toEqual(["one", "three"]);
  });
});

describe("the snap items", () => {
  it("lists Snap to left and Snap to right after Move right, a separator before Close, and disables the side a tab is shown on", async () => {
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    const items = openTabMenu(root, "one");
    const labels = items.map((el) => (el instanceof HTMLButtonElement ? el.textContent : "---"));
    expect(labels).toEqual([
      "Rename\u2026",
      "Use automatic name",
      "---",
      "Move left",
      "Move right",
      "Snap to left",
      "Snap to right",
      "---",
      "Close",
      "Close others",
      "Close to the right",
      "Close to the left",
      "Close all",
    ]);
    expect(menuItem(items, "Snap to left").disabled).toBe(true);
    expect(menuItem(items, "Snap to right").disabled).toBe(false);
    expect(menuItem(items, "Snap to right").getAttribute("role")).toBe("menuitem");

    // On an unshown chip both sides are offered.
    const other = openTabMenu(root, "two");
    expect(menuItem(other, "Snap to left").disabled).toBe(false);
    expect(menuItem(other, "Snap to right").disabled).toBe(false);
    expect(shown(ctx, "left")).toBe("s1");
  });

  it("snapping the selected pane's tab to the right empties the left, shows it on the right and selects the right, forgetting before attaching", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    const left = engineOn(root, "left");
    const right = engineOn(root, "right");
    // One log across both engines, naming the side each call reached.
    const calls: string[] = [];
    for (const [side, e] of [
      ["left", left],
      ["right", right],
    ] as const) {
      e.connection.forgetSession.mockClear();
      e.connection.setSession.mockClear();
      e.connection.forgetSession.mockImplementation((id: string) => {
        calls.push(`${side}:forget:${id}`);
      });
      e.connection.setSession.mockImplementation((id: string) => {
        calls.push(`${side}:set:${id}`);
      });
    }

    menuItem(openTabMenu(root, "one"), "Snap to right").click();
    expect(root.querySelector(".wt-tab-menu")?.classList.contains("visible")).toBe(false);
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBe("s1");
    expect(ctx.shell.selected()).toBe("right");
    // The losing pane forgets, then the gaining pane attaches; no other call.
    expect(calls).toEqual(["left:forget:s1", "right:set:s1"]);
    expect(activeLabels(root)).toEqual(["one"]);
    expect(paneRoot(root, "left").hasAttribute("inert")).toBe(true);
  });

  it("snapping an unshown tab while closed opens the split and shows it on the named side, replacing what was there", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    expect(term.split?.isOpen()).toBe(false);

    menuItem(openTabMenu(root, "two"), "Snap to left").click();
    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s2");
    expect(shown(ctx, "right")).toBeNull();
    expect(ctx.shell.selected()).toBe("left");
    expect(activeLabels(root)).toEqual(["two"]);
    expect(chips(root)).toHaveLength(2);
    await until(() => server.writes.length > 0);
    expect(server.writes).toEqual([
      { left: "s2", right: null, handle: 0.5, selected: "left", open: true },
    ]);
  });

  it("with both panes shown, snapping the right tab to the left leaves the right pane empty rather than swapping", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    chipOf(root, "two").click();
    expect(shown(ctx, "right")).toBe("s2");

    menuItem(openTabMenu(root, "two"), "Snap to left").click();
    expect(shown(ctx, "left")).toBe("s2");
    expect(shown(ctx, "right")).toBeNull();
    expect(ctx.shell.selected()).toBe("left");
    expect(activeLabels(root)).toEqual(["two"]);
  });

  it("disables both items while the row is under 730 px, open or closed, and snap() refuses then", async () => {
    const root = rootIn(720);
    const { term, api } = await mountTabbed(root, server);
    let items = openTabMenu(root, "two");
    expect(menuItem(items, "Snap to left").disabled).toBe(true);
    expect(menuItem(items, "Snap to right").disabled).toBe(true);
    expect(api.snap("s2", "right")).toBe(false);
    expect(term.split?.isOpen()).toBe(false);

    root.style.width = "1000px";
    await settle();
    term.split?.open();
    root.style.width = "720px";
    await settle();
    items = openTabMenu(root, "two");
    expect(menuItem(items, "Snap to left").disabled).toBe(true);
    expect(menuItem(items, "Snap to right").disabled).toBe(true);
  });

  it("snap() refuses an unknown id and an invalid side and changes nothing", async () => {
    const root = rootIn();
    const { term, ctx, api } = await mountTabbed(root, server);
    expect(api.snap("nope", "left")).toBe(false);
    expect(api.snap("s2", "middle" as PaneSide)).toBe(false);
    expect(api.snap("s2", 42 as unknown as PaneSide)).toBe(false);
    expect(term.split?.isOpen()).toBe(false);
    expect(shown(ctx, "left")).toBe("s1");
    await tick();
    expect(server.writes).toEqual([]);
  });

  it("a snap of a tab onto the side that already shows it selects that side and returns true", async () => {
    const root = rootIn();
    const { term, ctx, api } = await mountTabbed(root, server);
    term.split?.open();
    chipOf(root, "two").click();
    expect(ctx.shell.selected()).toBe("right");
    for (const e of fake.engines) {
      e.connection.setSession.mockClear();
    }
    expect(api.snap("s1", "left")).toBe(true);
    expect(ctx.shell.selected()).toBe("left");
    for (const e of fake.engines) {
      expect(e.connection.setSession).not.toHaveBeenCalled();
    }
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
  });

  it("a keyboard-opened menu offers the snap items enabled, and Enter on one snaps with focus landing in the snapped pane", async () => {
    stubMedia({ "(any-pointer: fine)": true });
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    const chip = chipOf(root, "one");
    expect(chip.tabIndex).toBe(0);
    chip.focus();
    expect(document.activeElement).toBe(chip);

    const items = openTabMenu(root, "one", { button: 0 });
    expect(root.querySelector(".wt-tab-menu")?.classList.contains("visible")).toBe(true);
    const labels = items
      .filter((el) => el instanceof HTMLButtonElement)
      .map((el) => el.textContent);
    expect(labels.indexOf("Snap to left")).toBe(labels.indexOf("Move right") + 1);
    expect(labels.indexOf("Snap to right")).toBe(labels.indexOf("Snap to left") + 1);
    const right = menuItem(items, "Snap to right");
    expect(right.disabled).toBe(false);
    expect(menuItem(items, "Snap to left").disabled).toBe(true);
    expect(right.tabIndex).toBe(0);

    right.focus();
    pressKey(right, "Enter");
    expect(root.querySelector(".wt-tab-menu")?.classList.contains("visible")).toBe(false);
    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "right")).toBe("s1");
    expect(shown(ctx, "left")).toBeNull();
    expect(ctx.shell.selected()).toBe("right");
    expect(document.activeElement).toBe(textareaOf(root, "right"));
  });

  it("a long-press menu offers the snap items enabled and survives its own trailing click", async () => {
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    const bar = root.querySelector<HTMLElement>(".wt-tab-bar");
    if (!bar) {
      throw new Error("no tab bar");
    }
    bar.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
    const items = openTabMenu(root, "two", { button: 0 });
    const menu = root.querySelector(".wt-tab-menu");
    expect(menu?.classList.contains("visible")).toBe(true);
    expect(menuItem(items, "Snap to left").disabled).toBe(false);
    expect(menuItem(items, "Snap to right").disabled).toBe(false);

    // The release of the long press and the click it emits: swallowed, not a dismiss.
    bar.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }));
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu?.classList.contains("visible")).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
  });

  it("a snap hands the losing pane's server epoch to the gaining pane before it attaches", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    const left = engineOn(root, "left");
    const right = engineOn(root, "right");
    // Only the LEFT connection knows s1's epoch; the right has never seen it.
    left.connection.serverEpochOf.mockImplementation((id: string) => (id === "s1" ? 4242 : 0));
    const calls: string[] = [];
    for (const [side, e] of [
      ["left", left],
      ["right", right],
    ] as const) {
      e.connection.adoptPersistedEpoch.mockImplementation((id: string, epoch: number) => {
        calls.push(`${side}:adopt:${id}:${String(epoch)}`);
      });
      e.connection.setSession.mockImplementation((id: string) => {
        calls.push(`${side}:set:${id}`);
      });
    }

    menuItem(openTabMenu(root, "one"), "Snap to right").click();
    expect(shown(ctx, "right")).toBe("s1");
    expect(calls).toEqual(["right:adopt:s1:4242", "right:set:s1"]);
  });
});

describe("drag and drop onto a half", () => {
  it("highlights the half under the pointer during a drag, snaps on drop and clears the highlight; the strip preview reverts", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    const chip = chipOf(root, "two");
    const dt = fakeDataTransfer();
    const rect = root.getBoundingClientRect();
    const leftX = rect.left + rect.width * 0.25;
    const rightX = rect.left + rect.width * 0.75;

    dragAt("dragstart", dt, chip, leftX);
    const over = dragAt("dragover", dt, root, leftX);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe("move");
    expect(root.classList.contains("wt-drop-left")).toBe(true);
    expect(root.classList.contains("wt-drop-right")).toBe(false);

    dragAt("dragover", dt, root, rightX);
    expect(root.classList.contains("wt-drop-left")).toBe(false);
    expect(root.classList.contains("wt-drop-right")).toBe(true);

    const bar = root.querySelector(".wt-tab-bar");
    const swBar = root.querySelector(".wt-switcher-bar");
    if (!bar || !swBar) {
      throw new Error("no bar");
    }
    dragAt("dragover", dt, bar, rightX, 5);
    expect(root.classList.contains("wt-drop-left")).toBe(false);
    expect(root.classList.contains("wt-drop-right")).toBe(false);
    dragAt("dragover", dt, root, rightX);
    dragAt("dragover", dt, swBar, rightX, 590);
    expect(root.classList.contains("wt-drop-left")).toBe(false);
    expect(root.classList.contains("wt-drop-right")).toBe(false);

    dragAt("dragover", dt, root, rightX);
    dragAt("drop", dt, root, rightX);
    expect(root.classList.contains("wt-drop-left")).toBe(false);
    expect(root.classList.contains("wt-drop-right")).toBe(false);
    expect(term.split?.isOpen()).toBe(true);
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");

    dragAt("dragend", dt, chip, rightX);
    expect(chips(root).map((c) => c.querySelector(".wt-tab-label")?.textContent)).toEqual([
      "one",
      "two",
    ]);
    expect(chip.classList.contains("wt-tab-dragging")).toBe(false);
  });

  it("a drag abandoned over a half leaves no highlight, and under 730 px no half arms and a drop is inert", async () => {
    const root = rootIn();
    const { term } = await mountTabbed(root, server);
    const chip = chipOf(root, "two");
    const dt = fakeDataTransfer();
    const rect = root.getBoundingClientRect();
    const leftX = rect.left + rect.width * 0.25;

    dragAt("dragstart", dt, chip, leftX);
    dragAt("dragover", dt, root, leftX);
    expect(root.classList.contains("wt-drop-left")).toBe(true);
    dragAt("dragend", dt, chip, leftX);
    expect(root.classList.contains("wt-drop-left")).toBe(false);
    expect(term.split?.isOpen()).toBe(false);

    root.style.width = "720px";
    await settle();
    dragAt("dragstart", dt, chip, 100);
    const over = dragAt("dragover", dt, root, 100);
    expect(over.defaultPrevented).toBe(true);
    expect(root.classList.contains("wt-drop-left")).toBe(false);
    expect(root.classList.contains("wt-drop-right")).toBe(false);
    dragAt("drop", dt, root, 100);
    dragAt("dragend", dt, chip, 100);
    expect(term.split?.isOpen()).toBe(false);
  });

  it("destroy() during a drag leaves the consumer's root with the classes it came with, the drop highlight included", async () => {
    const root = rootIn();
    root.className = "host";
    const { term } = await mountTabbed(root, server);
    const chip = chipOf(root, "two");
    const dt = fakeDataTransfer();
    const rect = root.getBoundingClientRect();
    const rightX = rect.left + rect.width * 0.75;

    dragAt("dragstart", dt, chip, rightX);
    dragAt("dragover", dt, root, rightX);
    expect(root.classList.contains("wt-drop-right")).toBe(true);

    term.destroy();

    expect(Array.from(root.classList)).toEqual(["host"]);
  });
});

describe("the closing rules while the split is open", () => {
  it("(1) closing the selected pane's tab while the other shows one empties the pane, promotes nothing, creates nothing and selects the other", async () => {
    stubMedia({ "(any-pointer: fine)": true });
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
      { id: "s4", title: "four", createdAt: "4", status: "idle" },
    ];
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    chipOf(root, "two").click();
    ctx.shell.select("left");
    clearForgets();
    const postsBefore = server.posts();

    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.deletes().includes("s1"));
    await tick();
    // Exactly one forget per connection: the showing pane's through its own
    // emptying, the other pane's through dropSessionExcept.
    expect(forgets(root)).toEqual({ left: ["s1"], right: ["s1"] });
    expect(shown(ctx, "left")).toBeNull();
    expect(ctx.shell.pane("left")?.state()).toBe("empty");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(term.split?.isOpen()).toBe(true);
    expect(server.posts()).toBe(postsBefore);
    expect(chips(root).map((c) => c.querySelector(".wt-tab-label")?.textContent)).toEqual([
      "two",
      "three",
      "four",
    ]);
    expect(activeLabels(root)).toEqual(["two"]);
    expect(document.activeElement).toBe(textareaOf(root, "right"));
  });

  it("(2) closing the shown tab while the other pane is empty promotes no ordinary tab: one create lands the new tab in the other pane", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    const postsBefore = server.posts();

    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => shown(ctx, "right") === "s-new");
    expect(server.posts()).toBe(postsBefore + 1);
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBe("s-new");
    expect(ctx.shell.selected()).toBe("right");
    expect(chips(root).map((c) => c.querySelector(".wt-tab-label")?.textContent)).toEqual([
      "two",
      "New tab",
    ]);
    expect(server.deletes()).toEqual(["s1"]);
  });

  it("(2b) a failing create leaves both panes empty with the row's tabs untouched, and the next tab click fills the left pane", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    server.postStatus = 500;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.deletes().includes("s1"));
    await tick();
    await until(() => server.posts() === 1);
    await tick();
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBeNull();
    expect(term.split?.isOpen()).toBe(true);
    expect(chips(root).map((c) => c.querySelector(".wt-tab-label")?.textContent)).toEqual(["two"]);
    expect(activeLabels(root)).toEqual([]);

    chipOf(root, "two").click();
    expect(shown(ctx, "left")).toBe("s2");
    expect(shown(ctx, "right")).toBeNull();
    expect(ctx.shell.selected()).toBe("left");
  });

  it("(3) closing the only tab overall while the other pane is empty creates once and lands the new tab in the other pane", async () => {
    server.list = [{ id: "s1", title: "one", createdAt: "1", status: "idle" }];
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    const postsBefore = server.posts();

    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.deletes().includes("s1"));
    await tick();
    expect(server.posts()).toBe(postsBefore + 1);
    expect(shown(ctx, "right")).toBe("s-new");
    expect(shown(ctx, "left")).toBeNull();
    expect(ctx.shell.selected()).toBe("right");
    expect(chips(root)).toHaveLength(1);
  });

  it("(4) closing an unshown tab changes neither pane and forgets it once per built pane", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    chipOf(root, "two").click();
    clearForgets();

    chipOf(root, "three").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.deletes().includes("s3"));
    await tick();
    expect(forgets(root)).toEqual({ left: ["s3"], right: ["s3"] });
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(chips(root)).toHaveLength(2);
  });

  it("(5) a removed status for a shown session follows the closing rules with no DELETE; for an ordinary session neither pane changes", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const monitor = fakeMonitor();
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server, {
      tabsOpts: { activityMonitor: monitor.feature },
      before: [monitor.feature],
    });
    term.split?.open();
    chipOf(root, "two").click();
    ctx.shell.select("left");
    clearForgets();

    monitor.emit({ id: "s3", title: "three", createdAt: "3", status: "idle", removed: true });
    await tick();
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(chips(root)).toHaveLength(2);
    expect(forgets(root)).toEqual({ left: ["s3"], right: ["s3"] });
    clearForgets();

    monitor.emit({ id: "s1", title: "one", createdAt: "1", status: "idle", removed: true });
    await tick();
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(forgets(root)).toEqual({ left: ["s1"], right: ["s1"] });
    expect(server.deletes()).toEqual([]);
    expect(server.posts()).toBe(0);
  });

  it("(6) a status event never refills a pane the closing rules emptied, and does show the first live tab after a bootstrap that showed nothing", async () => {
    const monitor = fakeMonitor();
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server, {
      tabsOpts: { activityMonitor: monitor.feature },
      before: [monitor.feature],
    });
    term.split?.open();
    server.postStatus = 500;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.posts() === 1);
    await tick();
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBeNull();

    monitor.emit({ id: "s2", title: "two", createdAt: "2", status: "idle" });
    monitor.emit({ id: "s5", title: "five", createdAt: "5", status: "idle" });
    await tick();
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBeNull();
    expect(chips(root)).toHaveLength(2);
    term.destroy();

    // A bootstrap with nothing listed and a failing create shows nothing; the
    // first status event afterwards picks the first live tab.
    fake.reset();
    server.list = [];
    const late = fakeMonitor();
    const root2 = rootIn();
    let ctxRef: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "shell-probe",
      scope: "shell",
      setup(ctx) {
        ctxRef = ctx;
        return { api: undefined, teardown: () => undefined };
      },
    };
    await mountTerminal(root2, {
      split: true,
      features: () => [probe, late.feature, tabs({ activityMonitor: late.feature })],
    });
    await until(() => server.posts() === 2);
    await tick();
    expect(ctxRef?.shell.pane("left")?.state()).toBe("empty");
    late.emit({ id: "s7", title: "seven", createdAt: "7", status: "idle" });
    await tick();
    expect(ctxRef?.shell.pane("left")?.session.id).toBe("s7");
  });

  it("with the split closed the one-pane rule holds: the neighbor is promoted", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { ctx } = await mountTabbed(root, server);
    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.deletes().includes("s1"));
    await tick();
    expect(shown(ctx, "left")).toBe("s2");
    expect(server.posts()).toBe(0);
  });

  it("selection and the replacement move before the DELETE answers, so a slow server never leaves selection on the emptied pane", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { term, ctx, api } = await mountTabbed(root, server);
    term.split?.open();
    chipOf(root, "two").click();
    ctx.shell.select("left");
    server.deleteGate = gate();

    // Case 1: the other pane shows a tab, so selection moves to it at once.
    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.deletes().includes("s1"));
    expect(ctx.shell.selected()).toBe("right");
    expect(ctx.shell.pane("left")?.state()).toBe("empty");
    expect(server.posts()).toBe(0);

    // Case 2: the other pane is empty, so the replacement's POST goes out while
    // the DELETE is still pending.
    chipOf(root, "two").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.deletes().includes("s2"));
    await tick();
    expect(server.posts()).toBe(1);
    expect(server.deleteGate).not.toBeNull();
    await until(() => shown(ctx, "left") === "s-new");
    expect(ctx.shell.selected()).toBe("left");

    // The closed split follows the one-pane rule the same way.
    server.deleteGate.resolve();
    await tick();
    term.split?.close();
    server.deleteGate = gate();
    void api.close("s-new");
    await until(() => server.deletes().includes("s-new"));
    expect(shown(ctx, "left")).toBe("s3");
    server.deleteGate.resolve();
  });

  it("while the replacement's POST is held, selection, the handle's edge and the facade already face the pane the new tab is headed for", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    const held = gate();
    server.postGate = held;
    const changes = vi.fn();
    term.split?.onChange(changes);

    chipOf(root, "one").querySelector<HTMLElement>(".wt-tab-close")?.click();
    await until(() => server.posts() === 1);
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBeNull();
    expect(ctx.shell.pane("left")?.state()).toBe("empty");
    // Both panes are empty and the POST has not answered: the one state in which
    // selection rests on an empty pane, and it is the pane the tab is headed for.
    expect(ctx.shell.selected()).toBe("right");
    expect(term.split?.state().selected).toBe("right");
    expect(separatorOf(root).getAttribute("data-faces")).toBe("right");
    expect(paneRoot(root, "right").classList.contains("wt-pane-selected")).toBe(true);
    expect(paneRoot(root, "left").classList.contains("wt-pane-selected")).toBe(false);
    expect(ctx.surface()).toBe(paneRoot(root, "right").querySelector(".term"));
    expect(changes.mock.calls[changes.mock.calls.length - 1]?.[0]).toMatchObject({
      selected: "right",
    });

    held.resolve();
    await until(() => shown(ctx, "right") === "s-new");
    expect(shown(ctx, "left")).toBeNull();
    expect(ctx.shell.selected()).toBe("right");
    expect(separatorOf(root).getAttribute("data-faces")).toBe("right");
  });

  it("closing the split from the handle's side hands the only shown tab to the survivor", async () => {
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    expect(shown(ctx, "left")).toBe("s1");
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    const squeezed = engineOn(root, "left");
    const survivor = engineOn(root, "right");
    for (const e of [squeezed, survivor]) {
      e.connection.setSession.mockClear();
      e.connection.forgetSession.mockClear();
    }

    expect(term.split?.closeSide("left")).toBe(true);
    expect(term.split?.isOpen()).toBe(false);
    expect(shown(ctx, "left")).toBe("s1");
    expect(activeLabels(root)).toEqual(["one"]);
    // The survivor is the kernel that was the right pane: the one attach reached
    // it, after the squeezed pane forgot the session, and it now holds the left.
    expect(survivor.connection.setSession.mock.calls).toEqual([["s1"]]);
    expect(squeezed.connection.forgetSession.mock.calls).toEqual([["s1"]]);
    expect(squeezed.connection.setSession).not.toHaveBeenCalled();
    expect(engineOn(root, "left")).toBe(survivor);
  });

  it("'Close others' while split empties the other pane and keeps the split", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    chipOf(root, "two").click();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    menuItem(openTabMenu(root, "two"), "Close others").click();
    await until(() => server.deletes().length === 2);
    await tick();
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("right");
    expect(term.split?.isOpen()).toBe(true);
    expect(chips(root)).toHaveLength(1);
    expect(server.posts()).toBe(0);
  });

  it("'Close others' on an ordinary tab that closes both shown tabs promotes nothing and creates once", async () => {
    server.list = [
      { id: "s1", title: "one", createdAt: "1", status: "idle" },
      { id: "s2", title: "two", createdAt: "2", status: "idle" },
      { id: "s3", title: "three", createdAt: "3", status: "idle" },
    ];
    const root = rootIn();
    const { term, ctx } = await mountTabbed(root, server);
    term.split?.open();
    chipOf(root, "two").click();
    ctx.shell.select("left");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    menuItem(openTabMenu(root, "three"), "Close others").click();
    await until(() => server.deletes().length === 2);
    await until(() => shown(ctx, "left") === "s-new");
    expect(server.posts()).toBe(1);
    expect(shown(ctx, "left")).toBe("s-new");
    expect(shown(ctx, "right")).toBeNull();
    expect(term.split?.isOpen()).toBe(true);
    expect(chips(root).map((c) => c.querySelector(".wt-tab-label")?.textContent)).toEqual([
      "three",
      "New tab",
    ]);
  });
});

describe("a failed second pane", () => {
  it("is closed through the shared split button: its kernel is torn down, the primary keeps running, and the next open builds a fresh one", async () => {
    const root = rootIn();
    let setups = 0;
    const boom = (): TerminalFeature<void> => ({
      name: "boom",
      setup() {
        setups += 1;
        if (setups === 2) {
          throw new Error("second pane only");
        }
        return { api: undefined, teardown: () => undefined };
      },
    });
    const seen: TerminalStartupFailure[] = [];
    const { term, ctx } = await mountTabbed(root, server, {
      opts: {
        onFatalError(failure) {
          seen.push(failure);
        },
      },
      panes: () => [boom()],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const btn = stripSplit(root);

    btn.click();
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ phase: "feature-setup", feature: "boom" });
    const right = paneRoots(root)[1];
    const dialog = right?.querySelector<HTMLDialogElement>("dialog.wt-fatal");
    expect(dialog?.open).toBe(true);
    expect(dialog?.matches(":modal")).toBe(false);
    expect(dialog?.querySelectorAll("button")).toHaveLength(1);
    expect(right?.querySelector("#wt-fatal-title-2")).not.toBeNull();
    expect(root.querySelector("#wt-fatal-title")).toBeNull();
    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    // The failed pane's own engine is disposed; the primary's runs on.
    const [primaryEngine, failedEngine] = fake.engines;
    expect(failedEngine?.dispose).toHaveBeenCalledTimes(1);
    expect(primaryEngine?.dispose).not.toHaveBeenCalled();

    // A non-modal panel: focus walks from its Reload button to the shared split
    // button in the tab row.
    const reload = dialog?.querySelector<HTMLElement>("button");
    expect(document.activeElement).toBe(reload);
    if (!reload) {
      throw new Error("no reload button");
    }
    expect(tabStops(reload, 3)).toContain(btn);
    reload.focus();
    expect(document.activeElement).toBe(reload);

    btn.click();
    expect(term.split?.isOpen()).toBe(false);
    expect(paneRoots(root)).toHaveLength(1);
    expect(right?.isConnected).toBe(false);
    expect(ctx.shell.pane("right")).toBeNull();
    expect(failedEngine?.dispose).toHaveBeenCalledTimes(1);
    expect(primaryEngine?.dispose).not.toHaveBeenCalled();
    expect(shown(ctx, "left")).toBe("s1");
    expect(document.activeElement).toBe(textareaOf(root, "left"));

    btn.click();
    await tick();
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(3);
    expect(seen).toHaveLength(1);
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
  });

  it("that held the only shown tab hands it to the empty survivor before failing, which is selected and receives the typing", async () => {
    const root = rootIn();
    const late = lateRejecting();
    const { ctx, api } = await mountTabbed(root, server, {
      opts: { onFatalError: () => true },
      panes: () => [late.feature()],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(api.snap("s1", "right")).toBe(true);
    expect(shown(ctx, "left")).toBeNull();
    expect(shown(ctx, "right")).toBe("s1");
    expect(ctx.shell.selected()).toBe("right");
    await until(() => server.writes.length >= 1);
    await tick();
    const writes = server.writes.length;
    const left = engineOn(root, "left");
    const failing = fake.engines[1];
    left.connection.setSession.mockClear();
    left.connection.sendBinary.mockClear();

    late.reject();
    await tick();
    await tick();

    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    expect(shown(ctx, "left")).toBe("s1");
    expect(ctx.shell.selected()).toBe("left");
    expect(paneRoot(root, "left").hasAttribute("inert")).toBe(false);
    expect(left.connection.setSession.mock.calls).toEqual([["s1"]]);
    ctx.send(new Uint8Array([0x41]));
    expect(left.connection.sendBinary).toHaveBeenCalledTimes(1);
    expect(failing?.connection.sendBinary).not.toHaveBeenCalled();
    expect(server.writes).toHaveLength(writes + 1);
    expect(server.writes[writes]).toEqual({
      left: "s1",
      right: null,
      handle: 0.5,
      selected: "left",
      open: true,
    });
  });

  it("that fails after the split closed onto it is discarded: the healthy pane returns as the selected single view showing the tab, and the next open builds afresh", async () => {
    const root = rootIn();
    const late = lateRejecting();
    const seen: TerminalStartupFailure[] = [];
    const { term, ctx, api } = await mountTabbed(root, server, {
      opts: {
        onFatalError(failure) {
          seen.push(failure);
        },
      },
      panes: () => [late.feature()],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(api.snap("s1", "right")).toBe(true);
    expect(ctx.shell.selected()).toBe("right");
    // The pending pane is selected, so the close keeps it as the single view and
    // hides the healthy primary.
    stripSplit(root).click();
    expect(term.split?.isOpen()).toBe(false);
    const [primary, failing] = fake.engines;
    const failingRoot = paneRoot(root, "left");
    expect(ctx.shell.pane("left")?.session.id).toBe("s1");
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
    const healthyRoot = ctx.shell.pane("right")?.root;
    await until(() => server.writes.at(-1)?.open === false);
    const writes = server.writes.length;
    primary?.connection.setSession.mockClear();
    primary?.connection.sendBinary.mockClear();
    textareaOf(root, "left").focus();
    expect(failingRoot.contains(document.activeElement)).toBe(true);

    late.reject();
    await tick();
    await tick();

    // Selection and the tab are on the healthy pane, now the visible single view.
    const survivor = ctx.shell.pane(ctx.shell.selected());
    expect(survivor?.root).toBe(healthyRoot);
    expect(survivor?.state()).toBe("shown");
    expect(survivor?.session.id).toBe("s1");
    expect(ctx.shell.selected()).toBe("left");
    expect(shown(ctx, "left")).toBe("s1");
    expect(term.split?.isOpen()).toBe(false);
    expect(paneRoots(root)).toHaveLength(1);
    expect(failingRoot.isConnected).toBe(false);
    expect(root.querySelector("dialog.wt-fatal")).toBeNull();
    expect(ctx.shell.pane("right")).toBeNull();
    expect(activeLabels(root)).toEqual(["one"]);
    expect(healthyRoot?.classList.contains("wt-pane-hidden")).toBe(false);
    expect(healthyRoot?.classList.contains("wt-pane-selected")).toBe(true);
    expect(healthyRoot?.hasAttribute("inert")).toBe(false);
    expect(primary?.connection.setSession.mock.calls).toEqual([["s1"]]);
    expect(failing?.dispose).toHaveBeenCalledTimes(1);
    expect(primary?.dispose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textareaOf(root, "left"));
    ctx.send(new Uint8Array([0x41]));
    expect(primary?.connection.sendBinary).toHaveBeenCalledTimes(1);
    expect(failing?.connection.sendBinary).not.toHaveBeenCalled();
    await until(() => server.writes.length > writes);
    expect(server.writes.at(-1)).toEqual({
      left: "s1",
      right: null,
      handle: 0.5,
      selected: "left",
      open: false,
    });
    // A pane with no place on screen has no surface for a panel.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ phase: "feature-setup", feature: "late", surface: undefined });

    stripSplit(root).click();
    await tick();
    expect(term.split?.isOpen()).toBe(true);
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(3);
    expect(seen).toHaveLength(1);
    expect(ctx.shell.pane("left")?.session.id).toBe("s1");
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
  });

  it("that fails while hidden by a closed split is discarded in place, and the next open builds afresh", async () => {
    const root = rootIn();
    const late = lateRejecting();
    const seen: TerminalStartupFailure[] = [];
    const { term, ctx } = await mountTabbed(root, server, {
      opts: {
        onFatalError(failure) {
          seen.push(failure);
        },
      },
      panes: () => [late.feature()],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stripSplit(root).click();
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    const hiddenRoot = paneRoot(root, "right");
    // The primary stays selected, so the close hides the pending pane.
    stripSplit(root).click();
    expect(term.split?.isOpen()).toBe(false);
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");

    late.reject();
    await tick();
    await tick();

    expect(paneRoots(root)).toHaveLength(1);
    expect(hiddenRoot.isConnected).toBe(false);
    expect(root.querySelector("dialog.wt-fatal")).toBeNull();
    expect(ctx.shell.pane("right")).toBeNull();
    expect(shown(ctx, "left")).toBe("s1");
    expect(ctx.shell.selected()).toBe("left");
    expect(fake.engines[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(fake.engines[0]?.dispose).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ phase: "feature-setup", feature: "late", surface: undefined });

    stripSplit(root).click();
    await tick();
    expect(term.split?.isOpen()).toBe(true);
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(3);
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
  });

  it("that showed an UNSELECTED tab keeps that tab's server epoch: the survivor is seeded before it attaches, and a save is filed under it", async () => {
    const entries = new Map<string, PersistedScrollback>();
    const persist: ScrollbackPersistence = {
      load: (id) => entries.get(id) ?? null,
      save: (id, entry) => {
        entries.set(id, entry);
      },
      drop: (id) => {
        entries.delete(id);
      },
    };
    const root = rootIn();
    const late = lateRejecting();
    const { ctx, api } = await mountTabbed(root, server, {
      opts: { onFatalError: () => true, persistScrollback: persist },
      panes: () => [late.feature()],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(api.snap("s2", "right")).toBe(true);
    api.switchTo("s1");
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBe("s2");
    expect(ctx.shell.selected()).toBe("left");
    const left = engineOn(root, "left");
    const failing = engineOn(root, "right");
    // Only the failing pane's connection knows s2's epoch.
    failing.connection.serverEpochOf.mockImplementation((id: string) => (id === "s2" ? 4242 : 0));
    failing.renderer.boundStore().applyScroll({
      type: "scroll",
      firstIndex: 0,
      lines: [[{ t: "L0", f: -1, b: -1, a: 0, uc: -1 }]],
    });
    const calls: string[] = [];
    left.connection.adoptPersistedEpoch.mockImplementation((id: string, epoch: number) => {
      calls.push(`adopt:${id}:${String(epoch)}`);
    });
    left.connection.setSession.mockImplementation((id: string) => {
      calls.push(`set:${id}`);
    });

    late.reject();
    await tick();
    await tick();
    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    expect(shown(ctx, "left")).toBe("s1");
    expect(activeLabels(root)).toEqual(["one"]);

    chipOf(root, "two").click();
    expect(shown(ctx, "left")).toBe("s2");
    expect(calls).toEqual(["adopt:s2:4242", "set:s2"]);

    window.dispatchEvent(new Event("pagehide"));
    expect(entries.get("s2")?.snapshot.serverEpoch).toBe(4242);
  });

  it("is never a snap target: the api, the menu item and a drop onto its half all refuse and move nothing", async () => {
    const root = rootIn();
    let setups = 0;
    const boom = (): TerminalFeature<void> => ({
      name: "boom",
      setup() {
        setups += 1;
        if (setups === 2) {
          throw new Error("second pane only");
        }
        return { api: undefined, teardown: () => undefined };
      },
    });
    const { term, ctx, api } = await mountTabbed(root, server, {
      opts: { onFatalError: () => true },
      panes: () => [boom()],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stripSplit(root).click();
    await tick();
    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    const writes = server.writes.length;

    const attachedS2 = (): boolean =>
      fake.engines.some((e) => e.connection.setSession.mock.calls.some((c) => c[0] === "s2"));

    expect(api.snap("s2", "right")).toBe(false);
    expect(shown(ctx, "left")).toBe("s1");
    expect(shown(ctx, "right")).toBeNull();
    expect(ctx.shell.selected()).toBe("left");
    expect(attachedS2()).toBe(false);

    const items = openTabMenu(root, "two");
    menuItem(items, "Snap to right").click();
    expect(shown(ctx, "left")).toBe("s1");
    expect(attachedS2()).toBe(false);

    const dt = fakeDataTransfer();
    const rect = root.getBoundingClientRect();
    const rightX = rect.left + rect.width * 0.75;
    const chip = chipOf(root, "two");
    dragAt("dragstart", dt, chip, rightX);
    dragAt("dragover", dt, root, rightX);
    dragAt("drop", dt, root, rightX);
    dragAt("dragend", dt, chip, rightX);
    expect(shown(ctx, "left")).toBe("s1");
    expect(attachedS2()).toBe(false);
    await tick();
    expect(server.writes).toHaveLength(writes);
    expect(term.split?.isOpen()).toBe(true);
  });
});
