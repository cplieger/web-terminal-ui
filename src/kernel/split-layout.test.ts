import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import { animations } from "../features/animations.js";
import type { TerminalContext, TerminalFeature, TerminalHandle } from "./types.js";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

// Same shape as fatal-panel.test.ts, and deliberately repeated rather than
// shared: a test-support module would need a matching exclude in BOTH publish
// allowlists (package.json `files` and jsr.json `publish.exclude`), and the
// standing rule there is to carry only patterns that match something.
const MANIFESTS = import.meta.glob("../../css/MANIFEST*", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHEETS = import.meta.glob("../../css/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const byName = (mods: Record<string, string>): Map<string | undefined, string> =>
  new Map(Object.entries(mods).map(([p, text]) => [p.split("/").pop(), text]));

// The tabbed component bundle: the one every split-capable consumer serves.
const BUNDLE = ((): string => {
  const manifest = byName(MANIFESTS).get("MANIFEST.tabbed");
  if (manifest === undefined) {
    throw new Error("css/MANIFEST.tabbed is missing");
  }
  const sheets = byName(SHEETS);
  return manifest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((name) => {
      const text = sheets.get(name);
      if (text === undefined) {
        throw new Error(`css/MANIFEST.tabbed names ${name}, which css/ does not contain`);
      }
      return text;
    })
    .join("\n");
})();

let styles: HTMLStyleElement;
beforeAll(() => {
  styles = document.createElement("style");
  styles.textContent = BUNDLE;
  document.head.appendChild(styles);
});
afterAll(() => {
  styles.remove();
});
beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Two frames: a ResizeObserver delivers after layout, between them. */
const settle = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(r, 0));
    });
  });

/** A sized host for a `container` terminal, which fills its parent. */
function hostOf(width: number, height = 600): { host: HTMLElement; root: HTMLElement } {
  const host = document.createElement("div");
  host.style.width = `${String(width)}px`;
  host.style.height = `${String(height)}px`;
  const root = document.createElement("div");
  host.appendChild(root);
  document.body.appendChild(host);
  return { host, root };
}

/** The registration `split: true` requires; it shows nothing itself. */
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

interface Mounted {
  readonly term: TerminalHandle;
  readonly ctx: TerminalContext;
  readonly split: NonNullable<TerminalHandle["split"]>;
}

/** A container-layout split terminal with the animations feature, carrying a
 *  shell-scoped probe that captures its context. */
async function mountSplit(root: HTMLElement, animate = true): Promise<Mounted> {
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
    layout: "container",
    features: () => [layoutOwner(), probe, ...(animate ? [animations()] : [])],
  });
  await tick();
  if (!ctxRef || !term.split) {
    throw new Error("the probe feature never ran");
  }
  return { term, ctx: ctxRef, split: term.split };
}

const paneRoots = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(":scope > .wt-split-pane"));
const ratioVar = (root: HTMLElement): string => root.style.getPropertyValue("--wt-split-ratio");
const widthOf = (el: HTMLElement | undefined): number =>
  Math.round(el?.getBoundingClientRect().width ?? -1);
const leftOf = (el: HTMLElement | undefined): number =>
  Math.round(el?.getBoundingClientRect().left ?? -1);
/** The used track sizes, as the browser resolved them. */
const columnsOf = (root: HTMLElement): number[] =>
  getComputedStyle(root)
    .gridTemplateColumns.split(" ")
    .map((px) => Math.round(Number.parseFloat(px)));

/** A block cursor as the engine paints it, dropped into a pane's `.term`. */
function cursorIn(pane: HTMLElement | undefined): HTMLElement {
  const term = pane?.querySelector<HTMLElement>(".term");
  if (!term) {
    throw new Error("the pane has no .term");
  }
  const cursor = document.createElement("div");
  cursor.className = "term-cursor-overlay visible term-cursor";
  cursor.textContent = "x";
  term.appendChild(cursor);
  return cursor;
}
const TRANSPARENT = "rgba(0, 0, 0, 0)";

describe("the grid", () => {
  it("gives an open split the two panes and the gutter at the effective ratio, in one row", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    expect(widthOf(paneRoots(root)[0])).toBe(1000);

    split.open();
    const [left, right] = paneRoots(root);
    expect(columnsOf(root)).toEqual([495, 10, 495]);
    expect(widthOf(left)).toBe(495);
    expect(widthOf(right)).toBe(495);
    expect(leftOf(right) - leftOf(left)).toBe(505);
    expect(Math.round(left?.getBoundingClientRect().height ?? 0)).toBe(600);
    expect(Math.round(right?.getBoundingClientRect().top ?? -1)).toBe(
      Math.round(left?.getBoundingClientRect().top ?? -2),
    );

    split.setRatio(0.4, true);
    expect(columnsOf(root)).toEqual([396, 10, 594]);
    expect(widthOf(left)).toBe(396);
    expect(widthOf(right)).toBe(594);
  });

  it("takes the hidden pane out of the layout and gives the survivor the whole row", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    split.open();
    const [left, right] = paneRoots(root);

    split.close();

    expect(getComputedStyle(right ?? root).display).toBe("none");
    expect(widthOf(left)).toBe(1000);
    expect(columnsOf(root)).toEqual([1000]);
  });

  it("collapses both panes into one full-width cell with the unselected one hidden in place", async () => {
    const { host, root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    const [left, right] = paneRoots(root);
    expect(ctx.shell.selected()).toBe("right");

    host.style.width = "720px";
    await settle();

    expect(root.classList.contains("wt-split-collapsed")).toBe(true);
    expect(columnsOf(root)).toEqual([720]);
    expect(widthOf(left)).toBe(720);
    expect(widthOf(right)).toBe(720);
    // One shared cell: same column AND same row, at the row's full height.
    expect(leftOf(left)).toBe(leftOf(right));
    expect(Math.round(right?.getBoundingClientRect().top ?? -1)).toBe(
      Math.round(left?.getBoundingClientRect().top ?? -2),
    );
    expect(Math.round(right?.getBoundingClientRect().height ?? 0)).toBe(600);
    expect(getComputedStyle(left ?? root).visibility).toBe("hidden");
    expect(getComputedStyle(left ?? root).pointerEvents).toBe("none");
    expect(getComputedStyle(right ?? root).visibility).toBe("visible");
    expect(getComputedStyle(right ?? root).pointerEvents).toBe("auto");

    // Selection swaps which pane is the visible one, with no other class.
    ctx.shell.select("left");
    expect(getComputedStyle(left ?? root).visibility).toBe("visible");
    expect(getComputedStyle(right ?? root).visibility).toBe("hidden");

    host.style.width = "730px";
    await settle();
    expect(root.classList.contains("wt-split-collapsed")).toBe(false);
    expect(columnsOf(root)).toEqual([360, 10, 360]);
    expect(getComputedStyle(right ?? root).visibility).toBe("visible");
  });
});

describe("the cursor follows selection while the split is open", () => {
  it("fills the selected pane's cursor without focus and hollows the other pane's even with it", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    const [left, right] = paneRoots(root);
    const leftTerm = left?.querySelector<HTMLElement>(".term");
    const rightTerm = right?.querySelector<HTMLElement>(".term");
    const leftCursor = cursorIn(left);
    const rightCursor = cursorIn(right);
    // Neither textarea has focus: 02-terminal.css alone would hollow both.
    leftTerm?.classList.remove("focus");
    rightTerm?.classList.remove("focus");
    expect(ctx.shell.selected()).toBe("right");

    expect(getComputedStyle(rightCursor).backgroundColor).not.toBe(TRANSPARENT);
    expect(getComputedStyle(rightCursor).boxShadow).toBe("none");
    expect(getComputedStyle(leftCursor).backgroundColor).toBe(TRANSPARENT);
    expect(getComputedStyle(leftCursor).boxShadow).toContain("inset");

    // The blink phase still shows in the selected pane.
    rightTerm?.classList.add("cursor-blink-off");
    expect(getComputedStyle(rightCursor).backgroundColor).toBe(TRANSPARENT);
    rightTerm?.classList.remove("cursor-blink-off");

    // Focus in the unselected pane does not fill it; selection does.
    leftTerm?.classList.add("focus");
    expect(getComputedStyle(leftCursor).backgroundColor).toBe(TRANSPARENT);
    expect(getComputedStyle(leftCursor).boxShadow).toContain("inset");
    ctx.shell.select("left");
    expect(getComputedStyle(leftCursor).backgroundColor).not.toBe(TRANSPARENT);
    expect(getComputedStyle(rightCursor).backgroundColor).toBe(TRANSPARENT);
    expect(getComputedStyle(rightCursor).boxShadow).toContain("inset");
  });

  it("leaves 02-terminal.css's focus rule in charge while the split is closed", async () => {
    const { root } = hostOf(1000);
    const { ctx } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    const [pane] = paneRoots(root);
    const cursor = cursorIn(pane);
    const term = pane?.querySelector<HTMLElement>(".term");
    expect(pane?.classList.contains("wt-pane-selected")).toBe(true);

    term?.classList.remove("focus");
    expect(getComputedStyle(cursor).backgroundColor).toBe(TRANSPARENT);
    expect(getComputedStyle(cursor).boxShadow).toContain("inset");
    term?.classList.add("focus");
    expect(getComputedStyle(cursor).backgroundColor).not.toBe(TRANSPARENT);
  });
});

describe("closing with wt-animate", () => {
  it("closes the model at once and slides the columns toward the survivor before hiding the other pane", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root);
    expect(root.classList.contains("wt-animate")).toBe(true);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");
    const [left, right] = paneRoots(root);
    const changes = vi.fn();
    split.onChange(changes);
    const [leftEngine, rightEngine] = fake.engines;
    leftEngine?.connection.forgetSession.mockClear();
    rightEngine?.connection.forgetSession.mockClear();

    expect(split.close()).toBe(true);

    // The model.
    expect(split.isOpen()).toBe(false);
    expect(split.state()).toMatchObject({ open: false, ratio: 0.5, selected: "left" });
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
    expect(ctx.shell.pane("left")?.session.id).toBe("a");
    // The hidden pane's connection forgets its session; the survivor's keeps its own.
    expect(rightEngine?.connection.forgetSession.mock.calls).toEqual([["b"]]);
    expect(leftEngine?.connection.forgetSession).not.toHaveBeenCalled();
    expect(right?.hasAttribute("inert")).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(ctx.shell.targetFor("c")).toBe("left");
    expect(split.setRatio(0.3, true)).toBe(false);
    // The display: still two columns, sliding to the left pane.
    expect(root.classList.contains("wt-split-closing")).toBe(true);
    expect(root.classList.contains("wt-split-open")).toBe(true);
    expect(ratioVar(root)).toBe("1");
    expect(right?.classList.contains("wt-pane-hidden")).toBe(false);
    expect(getComputedStyle(root).transitionProperty).toBe("grid-template-columns");

    await wait(400);

    expect(root.classList.contains("wt-split-closing")).toBe(false);
    expect(root.classList.contains("wt-split-open")).toBe(false);
    expect(right?.classList.contains("wt-pane-hidden")).toBe(true);
    expect(ratioVar(root)).toBe("0.5");
    expect(widthOf(left)).toBe(1000);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("with the right pane surviving the columns slide to 0 and the sides are painted only at the end", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    const [first, second] = paneRoots(root);
    expect(ctx.shell.selected()).toBe("right");

    split.close();

    expect(ctx.shell.pane("left")?.root).toBe(second);
    expect(ctx.shell.pane("left")?.session.id).toBe("b");
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
    expect(second?.classList.contains("wt-pane-selected")).toBe(true);
    expect(ratioVar(root)).toBe("0");
    // The grid columns stay put while the slide runs.
    expect(second?.classList.contains("wt-side-right")).toBe(true);
    expect(first?.classList.contains("wt-side-left")).toBe(true);
    expect(paneRoots(root)).toEqual([first, second]);

    await wait(400);

    expect(second?.classList.contains("wt-side-left")).toBe(true);
    expect(first?.classList.contains("wt-side-right")).toBe(true);
    expect(first?.classList.contains("wt-pane-hidden")).toBe(true);
    expect(paneRoots(root)).toEqual([second, first]);
    expect(widthOf(second)).toBe(1000);
  });

  it("interpolates the track widths, and open() during the slide settles it first", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root);
    // Long enough that a stalled frame cannot run it to the end, and read a tenth
    // of the way in, where the ease-out curve has moved the track by ~75 px.
    root.style.setProperty("--dur-standard", "3s");
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");
    const [, right] = paneRoots(root);

    split.close();
    await wait(300);

    const [leftPx] = columnsOf(root);
    expect(leftPx).toBeGreaterThan(495);
    expect(leftPx).toBeLessThan(990);
    expect(right?.classList.contains("wt-pane-hidden")).toBe(false);

    expect(split.open()).toBe(true);

    expect(root.classList.contains("wt-split-closing")).toBe(false);
    expect(root.classList.contains("wt-split-open")).toBe(true);
    expect(right?.classList.contains("wt-pane-hidden")).toBe(false);
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(ratioVar(root)).toBe("0.5");
    expect(getComputedStyle(root).transitionProperty).not.toBe("grid-template-columns");
    expect(columnsOf(root)).toEqual([495, 10, 495]);
  });

  it("finishes when the transition ends, ahead of the fallback timer", async () => {
    // The token the timer reads says 3 s; the transition actually runs 0.1 s.
    const quick = document.createElement("style");
    quick.textContent =
      ".wt-root.wt-split.wt-animate.wt-split-closing { transition-duration: 0.1s !important; }";
    document.head.appendChild(quick);
    try {
      const { root } = hostOf(1000);
      const { ctx, split } = await mountSplit(root);
      root.style.setProperty("--dur-standard", "3s");
      ctx.notifySwitch({ id: "a" });
      split.open();
      const [, right] = paneRoots(root);

      split.close();
      expect(root.classList.contains("wt-split-closing")).toBe(true);

      await wait(300);
      expect(root.classList.contains("wt-split-closing")).toBe(false);
      expect(root.classList.contains("wt-split-open")).toBe(false);
      expect(right?.classList.contains("wt-pane-hidden")).toBe(true);
    } finally {
      quick.remove();
    }
  });

  it("finishes on the timer when no transitionend arrives", async () => {
    const noSlide = document.createElement("style");
    noSlide.textContent =
      ".wt-root.wt-split.wt-animate.wt-split-closing { transition-property: none !important; }";
    document.head.appendChild(noSlide);
    try {
      const { root } = hostOf(1000);
      const { ctx, split } = await mountSplit(root);
      ctx.notifySwitch({ id: "a" });
      split.open();
      const [, right] = paneRoots(root);

      split.close();
      await wait(100);
      expect(root.classList.contains("wt-split-closing")).toBe(true);
      expect(right?.classList.contains("wt-pane-hidden")).toBe(false);

      await wait(250);
      expect(root.classList.contains("wt-split-closing")).toBe(false);
      expect(root.classList.contains("wt-split-open")).toBe(false);
      expect(right?.classList.contains("wt-pane-hidden")).toBe(true);
    } finally {
      noSlide.remove();
    }
  });

  it("destroy() during the slide drops the pending finish", async () => {
    const { root } = hostOf(1000);
    const { ctx, split, term } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    split.open();
    const [, right] = paneRoots(root);

    split.close();
    term.destroy();
    expect(root.classList.contains("wt-split-closing")).toBe(false);

    await wait(400);
    expect(right?.classList.contains("wt-pane-hidden")).toBe(false);
  });

  it("closes a collapsed split at once, since one pane already fills the row", async () => {
    const { root } = hostOf(720);
    const { ctx, split } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    expect(split.open()).toBe(true);
    expect(split.state().collapsed).toBe(true);
    const [, right] = paneRoots(root);

    split.close();

    expect(root.classList.contains("wt-split-closing")).toBe(false);
    expect(root.classList.contains("wt-split-open")).toBe(false);
    expect(right?.classList.contains("wt-pane-hidden")).toBe(true);
  });
});

const POINTER = 7;
function pressAt(handle: HTMLElement, x: number): void {
  handle.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: POINTER,
      clientX: x,
      clientY: 100,
      bubbles: true,
      cancelable: true,
      isPrimary: true,
    }),
  );
}
function moveTo(x: number): void {
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      pointerId: POINTER,
      clientX: x,
      clientY: 100,
      bubbles: true,
    }),
  );
}
function releaseAt(x: number): void {
  window.dispatchEvent(
    new PointerEvent("pointerup", { pointerId: POINTER, clientX: x, clientY: 100, bubbles: true }),
  );
}
const handleOf = (root: HTMLElement): HTMLElement => {
  const el = root.querySelector<HTMLElement>(":scope > .wt-split-handle");
  if (!el) {
    throw new Error("the shell built no handle");
  }
  return el;
};

describe("the grip handle under the stylesheet", () => {
  it("fills the gutter as a 24 px hit area around a 6 px pill whose accent edge faces the selected pane, and is out of the layout while closed or collapsed", async () => {
    const { host, root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
    const handle = handleOf(root);
    expect(getComputedStyle(handle).display).toBe("none");

    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");

    const box = handle.getBoundingClientRect();
    expect(getComputedStyle(handle).display).toBe("block");
    expect(Math.round(box.width)).toBe(24);
    // Centred on the 10 px gutter that starts at 495: 7 px over each pane's edge.
    expect(Math.round(box.left - root.getBoundingClientRect().left)).toBe(488);
    expect(Math.round(box.height)).toBe(600);
    expect(getComputedStyle(handle).cursor).toBe("col-resize");
    expect(getComputedStyle(handle).touchAction).toBe("none");
    const pill = getComputedStyle(handle, "::before");
    expect(pill.width).toBe("6px");
    expect(pill.borderRadius).toBe("3px");
    expect(pill.top).toBe("12px");
    expect(pill.borderLeftWidth).toBe("2px");
    expect(pill.borderRightWidth).toBe("1px");
    ctx.shell.select("right");
    const faced = getComputedStyle(handle, "::before");
    expect(faced.borderLeftWidth).toBe("1px");
    expect(faced.borderRightWidth).toBe("2px");
    const rest = pill.backgroundColor;
    pressAt(handle, 500);
    expect(getComputedStyle(handle, "::before").backgroundColor).not.toBe(rest);
    releaseAt(500);
    expect(getComputedStyle(handle, "::before").backgroundColor).toBe(rest);

    host.style.width = "720px";
    await settle();
    expect(root.classList.contains("wt-split-collapsed")).toBe(true);
    expect(getComputedStyle(handle).display).toBe("none");
  });

  it("the panes follow the pointer, and the shells are resized mid-drag while the panes' own boxes are still settling", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    await wait(400);
    const resizesPerPane = (): number[] =>
      fake.engines.map((e) => e.connection.sendResize.mock.calls.length);
    for (const e of fake.engines) {
      e.connection.sendResize.mockClear();
    }
    const handle = handleOf(root);
    const [left, right] = paneRoots(root);

    pressAt(handle, 500);
    moveTo(450);
    expect(columnsOf(root)).toEqual([445, 10, 545]);
    expect(widthOf(left)).toBe(445);
    expect(widthOf(right)).toBe(545);
    expect(resizesPerPane()).toEqual([1, 1]);

    // A frame later the panes' ResizeObservers have seen the new boxes and their
    // viewport controllers are mid-transition for 350 ms; the drag still sends.
    await settle();
    await wait(110);
    moveTo(420);
    expect(columnsOf(root)).toEqual([415, 10, 575]);
    expect(resizesPerPane()).toEqual([2, 2]);

    releaseAt(420);
    expect(resizesPerPane()).toEqual([3, 3]);
    expect(split.state()).toMatchObject({ ratio: 415 / 990, committedRatio: 415 / 990 });
  });
});
