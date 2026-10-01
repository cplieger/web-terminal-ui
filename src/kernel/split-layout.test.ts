import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type {} from "@vitest/browser-playwright";
import { cdp } from "vitest/browser";
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

function accentIn(root: HTMLElement): string {
  const probe = document.createElement("div");
  probe.style.background = "var(--accent)";
  root.appendChild(probe);
  const fill = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return fill;
}

describe("the grid", () => {
  it("gives an open split the two panes and the gutter at the effective ratio, in one row", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
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

  it("takes no font measurement in a pane the closed split hides, where every box measures zero", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    split.open();
    const right = paneRoots(root)[1];
    const hidden = fake.engines.find((e) => right?.contains(e.options.termWrap) === true);
    if (!hidden) {
      throw new Error("no engine drives the right pane");
    }
    await wait(400);

    split.close();
    hidden.renderer.updateFontMetrics.mockClear();
    await settle();
    await wait(400);
    expect(getComputedStyle(right ?? root).display).toBe("none");
    expect(hidden.renderer.updateFontMetrics).not.toHaveBeenCalled();

    split.open();
    await settle();
    await wait(400);
    expect(hidden.renderer.updateFontMetrics).toHaveBeenCalled();
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

  it("interpolates the track widths, and open() during the slide settles it first and slides in again from the right edge", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");
    await wait(300);
    // Long enough that a stalled frame cannot run it to the end, and read a tenth
    // of the way in, where the ease-out curve has moved the track by ~75 px.
    root.style.setProperty("--dur-standard", "3s");
    const [, right] = paneRoots(root);

    split.close();
    await wait(300);

    const [leftPx] = columnsOf(root);
    expect(leftPx).toBeGreaterThan(495);
    expect(leftPx).toBeLessThan(990);
    expect(right?.classList.contains("wt-pane-hidden")).toBe(false);

    expect(split.open()).toBe(true);

    expect(root.classList.contains("wt-split-closing")).toBe(false);
    expect(root.classList.contains("wt-split-opening")).toBe(true);
    expect(root.classList.contains("wt-split-open")).toBe(true);
    expect(right?.classList.contains("wt-pane-hidden")).toBe(false);
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(ratioVar(root)).toBe("0.5");
    expect(getComputedStyle(root).transitionProperty).toBe("grid-template-columns");
    expect(columnsOf(root)).toEqual([990, 10, 0]);
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
      ctx.notifySwitch({ id: "a" });
      split.open();
      await wait(300);
      root.style.setProperty("--dur-standard", "3s");
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

describe("opening with wt-animate", () => {
  async function settledSingle(): Promise<Mounted & { root: HTMLElement }> {
    const { root } = hostOf(1000);
    const mounted = await mountSplit(root);
    mounted.ctx.notifySwitch({ id: "a" });
    await wait(400);
    return { ...mounted, root };
  }

  it("opens the model at once and slides the divider in from the right edge to the share", async () => {
    const { root, ctx, split } = await settledSingle();
    root.style.setProperty("--dur-standard", "3s");
    const changes = vi.fn();
    split.onChange(changes);

    expect(split.open()).toBe(true);

    expect(split.state()).toMatchObject({ open: true, ratio: 0.5, selected: "left" });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(root.classList.contains("wt-split-opening")).toBe(true);
    expect(ratioVar(root)).toBe("0.5");
    expect(getComputedStyle(root).transitionProperty).toBe("grid-template-columns");
    expect(columnsOf(root)).toEqual([990, 10, 0]);

    await wait(300);
    const [leftPx, , rightPx] = columnsOf(root);
    expect(leftPx).toBeGreaterThan(495);
    expect(leftPx).toBeLessThan(990);
    expect(rightPx).toBeGreaterThan(0);
    expect(root.classList.contains("wt-split-opening")).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("announces the sizes of the share it slides to, not of the slide's start", async () => {
    const { root, split } = await settledSingle();
    const [left] = paneRoots(root);
    const widths: number[] = [];
    fake.engines[0]?.connection.sendResize.mockImplementation(() => {
      widths.push(widthOf(left));
    });

    split.open();

    expect(widths).toEqual([495]);
  });

  it("holds every pane's geometry through the slide, so a socket opening meanwhile announces no size", async () => {
    const { root, split } = await settledSingle();
    split.open();
    await wait(300);
    split.close();
    await wait(800);
    const [leftEngine, rightEngine] = fake.engines;
    expect(leftEngine?.options.callbacks.initialSize?.()).not.toBeNull();
    root.style.setProperty("--dur-standard", "3s");

    split.open();

    expect(leftEngine?.options.callbacks.initialSize?.()).toBeNull();
    expect(rightEngine?.options.callbacks.initialSize?.()).toBeNull();
  });

  it("finishes on the timer, announcing every pane at its final size", async () => {
    const { root, ctx, split } = await settledSingle();
    split.open();
    ctx.notifySwitch({ id: "b" });
    const [left, right] = paneRoots(root);
    const sent: [string, number][] = [];
    fake.engines[0]?.connection.sendResize.mockImplementation(() => {
      sent.push(["left", widthOf(left)]);
    });
    fake.engines[1]?.connection.sendResize.mockImplementation(() => {
      sent.push(["right", widthOf(right)]);
    });

    await wait(300);

    expect(root.classList.contains("wt-split-opening")).toBe(false);
    expect(getComputedStyle(root).transitionProperty).not.toBe("grid-template-columns");
    expect(columnsOf(root)).toEqual([495, 10, 495]);
    expect(sent).toEqual([
      ["left", 495],
      ["right", 495],
    ]);
  });

  it("finishes when the transition ends, ahead of the fallback timer", async () => {
    const quick = document.createElement("style");
    quick.textContent =
      ".wt-root.wt-split.wt-animate.wt-split-opening { transition-duration: 0.1s !important; }";
    document.head.appendChild(quick);
    try {
      const { root, split } = await settledSingle();
      root.style.setProperty("--dur-standard", "3s");

      split.open();
      expect(root.classList.contains("wt-split-opening")).toBe(true);
      await wait(300);

      expect(root.classList.contains("wt-split-opening")).toBe(false);
      expect(columnsOf(root)).toEqual([495, 10, 495]);
    } finally {
      quick.remove();
    }
  });

  it("a resize of the share during the slide settles it, and the divider moves at once", async () => {
    const { root, split } = await settledSingle();
    root.style.setProperty("--dur-standard", "3s");
    split.open();

    expect(split.setRatio(0.4, false)).toBe(true);

    expect(root.classList.contains("wt-split-opening")).toBe(false);
    expect(columnsOf(root)).toEqual([396, 10, 594]);
  });

  it("a close during the slide turns it around from where the columns are", async () => {
    const { root, split } = await settledSingle();
    root.style.setProperty("--dur-standard", "3s");
    split.open();
    await wait(300);
    const [before] = columnsOf(root);

    split.close();

    expect(root.classList.contains("wt-split-opening")).toBe(false);
    expect(root.classList.contains("wt-split-closing")).toBe(true);
    expect(getComputedStyle(root).transitionProperty).toBe("grid-template-columns");
    const [after] = columnsOf(root);
    expect(Math.abs((after ?? 0) - (before ?? 0))).toBeLessThan(20);
    expect(after).toBeLessThan(990);
  });

  it("opens a collapsed split at once, since one pane fills the row", async () => {
    const { root } = hostOf(720);
    const { ctx, split } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });

    expect(split.open()).toBe(true);

    expect(split.state().collapsed).toBe(true);
    expect(root.classList.contains("wt-split-opening")).toBe(false);
    expect(columnsOf(root)).toEqual([720]);
  });

  it("without wt-animate the open is instant", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });

    split.open();

    expect(root.classList.contains("wt-split-opening")).toBe(false);
    expect(columnsOf(root)).toEqual([495, 10, 495]);
  });

  it("destroy() during the slide drops the pending finish", async () => {
    const { root, split, term } = await settledSingle();
    split.open();

    term.destroy();

    expect(root.classList.contains("wt-split-opening")).toBe(false);
    const sends = fake.engines.map((e) => e.connection.sendResize.mock.calls.length);
    await wait(400);
    expect(fake.engines.map((e) => e.connection.sendResize.mock.calls.length)).toEqual(sends);
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
  it("fills the gutter as a 24 px hit area around an 8 px bar with dim edges whose accent pill sits on the selected pane's side, and is out of the layout while closed or collapsed", async () => {
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
    const rootLeft = root.getBoundingClientRect().left;
    expect(document.elementFromPoint(rootLeft + 505 + 6, 300)).toBe(handle);
    expect(document.elementFromPoint(rootLeft + 505 + 8, 300)).not.toBe(handle);
    expect(getComputedStyle(handle).cursor).toBe("col-resize");
    expect(getComputedStyle(handle).touchAction).toBe("none");
    const bar = getComputedStyle(handle, "::before");
    expect(bar.width).toBe("8px");
    expect(bar.marginLeft).toBe("8px");
    expect(bar.borderRadius).toBe("4px");
    expect(bar.top).toBe("12px");
    expect(bar.borderLeftWidth).toBe("1px");
    expect(bar.borderRightWidth).toBe("1px");
    expect(bar.borderLeftColor).toBe(bar.borderRightColor);
    const pill = getComputedStyle(handle, "::after");
    expect(pill.width).toBe("2px");
    expect(pill.height).toBe("48px");
    expect(pill.top).toBe("276px");
    // Against the bar's left inner edge (8 px in, past its 1 px edge).
    expect(pill.left).toBe("9px");
    expect(pill.translate).toBe("none");
    expect(pill.backgroundColor).toBe(accentIn(root));
    expect(bar.borderLeftColor).not.toBe(pill.backgroundColor);

    ctx.shell.select("right");
    // Against the right inner edge: 9 + 4 + 2 = 15, the bar's 16 less its edge.
    expect(getComputedStyle(handle, "::after").translate).toBe("4px");
    expect(getComputedStyle(handle, "::before").borderRightWidth).toBe("1px");
    const rest = bar.backgroundColor;
    pressAt(handle, 500);
    expect(getComputedStyle(handle, "::before").backgroundColor).not.toBe(rest);
    releaseAt(500);
    expect(getComputedStyle(handle, "::before").backgroundColor).toBe(rest);

    host.style.width = "720px";
    await settle();
    expect(root.classList.contains("wt-split-collapsed")).toBe(true);
    expect(getComputedStyle(handle).display).toBe("none");
  });

  it("widens the hit area to 44 px under a coarse pointer, still centred on the gutter with the bar where it was", async () => {
    // The page's own pointer cannot be switched without leaking into later files,
    // so the stylesheet's coarse block is applied unconditionally here, and the
    // block's condition is pinned beside it.
    const coarse = Array.from(styles.sheet?.cssRules ?? []).find(
      (r): r is CSSMediaRule =>
        r instanceof CSSMediaRule &&
        Array.from(r.cssRules).some((inner) => inner.cssText.includes(".wt-split-handle")),
    );
    expect(coarse?.conditionText).toBe("(pointer: coarse)");
    const forced = document.createElement("style");
    forced.textContent = Array.from(coarse?.cssRules ?? [])
      .map((r) => r.cssText)
      .join("\n");
    document.head.appendChild(forced);
    try {
      const { root } = hostOf(1000);
      const { ctx, split } = await mountSplit(root, false);
      ctx.notifySwitch({ id: "a" });
      split.open();
      const handle = handleOf(root);

      const box = handle.getBoundingClientRect();
      expect(box.width).toBe(44);
      expect(box.left - root.getBoundingClientRect().left).toBe(478);
      // The margin box is the gutter itself, so an engine that aligns an
      // overflowing grid item safely still centres it.
      const style = getComputedStyle(handle);
      expect(
        box.left - Number.parseFloat(style.marginLeft) - root.getBoundingClientRect().left,
      ).toBe(495);
      expect(
        box.right + Number.parseFloat(style.marginRight) - root.getBoundingClientRect().left,
      ).toBe(505);
      expect(Math.round(box.height)).toBe(600);
      expect(columnsOf(root)).toEqual([495, 10, 495]);
      const bar = getComputedStyle(handle, "::before");
      expect(bar.width).toBe("8px");
      expect(bar.marginLeft).toBe("18px");
      expect(getComputedStyle(handle, "::after").left).toBe("19px");
      const rootLeft = root.getBoundingClientRect().left;
      expect(document.elementFromPoint(rootLeft + 505 + 16, 300)).toBe(handle);
      expect(document.elementFromPoint(rootLeft + 495 - 16, 300)).toBe(handle);
    } finally {
      forced.remove();
    }
  });

  it("with wt-animate the pill slides to the newly selected side over --dur-standard", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");
    await wait(300);
    root.style.setProperty("--dur-standard", "3s");
    const handle = handleOf(root);
    const pill = getComputedStyle(handle, "::after");
    expect(pill.transitionProperty).toBe("translate");
    expect(pill.transitionDuration).toBe("3s");

    ctx.shell.select("right");
    await wait(300);

    const x = Number.parseFloat(pill.translate);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(4);
  });

  it("without wt-animate the pill moves at once", async () => {
    const { root } = hostOf(1000);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");
    const pill = getComputedStyle(handleOf(root), "::after");
    expect(pill.transitionDuration).toBe("0s");

    ctx.shell.select("right");

    expect(pill.translate).toBe("4px");
  });

  it("under prefers-reduced-motion the open and the pill move at once with the animations feature present", async () => {
    const media = cdp();
    await media.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      const { root } = hostOf(1000);
      const { ctx, split } = await mountSplit(root);
      expect(root.classList.contains("wt-animate")).toBe(false);
      ctx.notifySwitch({ id: "a" });

      split.open();
      expect(root.classList.contains("wt-split-opening")).toBe(false);
      expect(columnsOf(root)).toEqual([495, 10, 495]);
      ctx.notifySwitch({ id: "b" });
      // 01-scope.css's kill switch leaves every change a 0.01 ms transition.
      await wait(20);
      expect(getComputedStyle(handleOf(root), "::after").translate).toBe("4px");
    } finally {
      await media.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  it("a release in the grace zone leaves the pane exactly 360 px wide", async () => {
    // On a 1280 px row the unrounded track drew this share at 359.984375 px.
    const { root } = hostOf(1280);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    const handle = handleOf(root);
    const [left, right] = paneRoots(root);

    // The divider starts at 635, so the pointer at x puts it at x + 135.
    pressAt(handle, 500);
    moveTo(165);
    expect(left?.getBoundingClientRect().width).toBe(360);
    releaseAt(165);

    expect(split.isOpen()).toBe(true);
    expect(split.state().committedRatio).toBe(360 / 1270);
    expect(left?.getBoundingClientRect().width).toBe(360);
    expect(right?.getBoundingClientRect().width).toBe(910);
    expect(left?.classList.contains("wt-pane-closing")).toBe(false);
  });

  it("Home on the divider leaves the left pane exactly 360 px wide", async () => {
    const { root } = hostOf(1280);
    const { ctx, split } = await mountSplit(root, false);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    const handle = handleOf(root);
    const [left] = paneRoots(root);
    handle.focus();

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    handle.dispatchEvent(new KeyboardEvent("keyup", { key: "Home", bubbles: true }));

    expect(split.state().committedRatio).toBe(360 / 1270);
    expect(left?.getBoundingClientRect().width).toBe(360);
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
