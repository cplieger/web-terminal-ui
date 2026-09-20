import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import { createSplitHandle, type SplitHandleShell } from "./split-handle.js";
import type {
  CreateTerminalOptions,
  SplitState,
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
} from "./types.js";

const fake = await vi.hoisted(async () => {
  const { createEngineFake } = await import("../test-helpers/fake-engine.js");
  return createEngineFake();
});

vi.mock("@cplieger/web-terminal-engine", async (importActual) => {
  const actual = await importActual<typeof Engine>();
  fake.bindActual(actual);
  return { ...actual, createTerminalEngine: fake.createTerminalEngine };
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Two frames: a ResizeObserver delivers after layout, between them. */
const settle = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(r, 0));
    });
  });
/** The announcer re-sets its live region on a 100 ms timer. */
const announced = (): Promise<void> => new Promise((r) => setTimeout(r, 130));
/** Fonts settled and the viewport controllers' 350 ms settle passed, so a pane
 *  answers `announceSize()` with a send. */
const viewportSettled = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A root with real geometry; unstyled it would measure 0 by 0. */
function rootIn(width = 1000, height = 600): HTMLElement {
  const root = document.createElement("div");
  root.style.width = `${String(width)}px`;
  root.style.height = `${String(height)}px`;
  document.body.appendChild(root);
  return root;
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
  readonly root: HTMLElement;
  readonly term: TerminalHandle;
  readonly ctx: TerminalContext;
  readonly split: NonNullable<TerminalHandle["split"]>;
  readonly handle: HTMLElement;
}

/** A split terminal carrying a shell-scoped probe that captures its context;
 *  `panes` builds the pane features fresh per invocation. */
async function mountSplit(
  root: HTMLElement,
  extra: Partial<CreateTerminalOptions> = {},
  panes: () => readonly TerminalFeature<unknown>[] = () => [],
): Promise<Mounted> {
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
    features: () => [layoutOwner(), probe, ...panes()],
    ...extra,
  });
  await tick();
  if (!ctxRef) {
    throw new Error("the probe feature never ran");
  }
  if (!term.split) {
    throw new Error("the handle carries no split controller");
  }
  const handle = root.querySelector<HTMLElement>(":scope > .wt-split-handle");
  if (!handle) {
    throw new Error("the shell built no handle");
  }
  return { root, term, ctx: ctxRef, split: term.split, handle };
}

/** Two shown panes, `a` on the left and `b` on the right, the left selected,
 *  fonts and viewports settled, and the resize spy cleared. */
async function openWithTwoTabs(width = 1000): Promise<Mounted> {
  const mounted = await mountSplit(rootIn(width));
  mounted.ctx.notifySwitch({ id: "a" });
  mounted.split.open();
  mounted.ctx.notifySwitch({ id: "b" });
  mounted.ctx.shell.select("left");
  await viewportSettled();
  clearResizes();
  return mounted;
}

/** Resize sends per pane since the last clear, [left, right]: engine 0 is the
 *  primary on the left, engine 1 the pane the open built on the right. A "pair"
 *  is one send on each. */
const resizes = (): [number, number] => [
  fake.engines[0]?.connection.sendResize.mock.calls.length ?? 0,
  fake.engines[1]?.connection.sendResize.mock.calls.length ?? 0,
];
const clearResizes = (): void => {
  for (const e of fake.engines) {
    e.connection.sendResize.mockClear();
  }
};

const paneRoots = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(":scope > .wt-split-pane"));
const gridChildren = (root: HTMLElement): Element[] =>
  Array.from(root.children).filter((el) => el.matches(".wt-split-pane, .wt-split-handle"));
const ratioVar = (root: HTMLElement): string => root.style.getPropertyValue("--wt-split-ratio");
const politeText = (root: HTMLElement): string =>
  root.querySelector(':scope > [aria-live="polite"]')?.textContent ?? "";
const textarea = (pane: HTMLElement | undefined): Element | null | undefined =>
  pane?.querySelector(".term-input");

/** A `document.fonts` whose initial load stays pending until `settle()`. `fonts`
 *  is an accessor on Document.prototype, so the restore puts back the descriptor
 *  that was there rather than deleting the platform's own. */
function shadowPendingFonts(): { settle(): void; restore(): void } {
  const saved = Object.getOwnPropertyDescriptor(document, "fonts");
  let settle = (): void => undefined;
  const pending = new Promise<FontFace[]>((resolve) => {
    settle = () => {
      resolve([]);
    };
  });
  Object.defineProperty(document, "fonts", {
    value: { load: () => pending, ready: pending.then(() => undefined) },
    configurable: true,
    writable: true,
  });
  return {
    settle,
    restore() {
      if (saved) {
        Object.defineProperty(document, "fonts", saved);
      } else {
        Reflect.deleteProperty(document, "fonts");
      }
    },
  };
}

const POINTER = 7;
function press(handle: HTMLElement, x: number): PointerEvent {
  const ev = new PointerEvent("pointerdown", {
    pointerId: POINTER,
    clientX: x,
    clientY: 100,
    bubbles: true,
    cancelable: true,
    isPrimary: true,
  });
  handle.dispatchEvent(ev);
  return ev;
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
function release(x: number, type: "pointerup" | "pointercancel" = "pointerup"): void {
  window.dispatchEvent(
    new PointerEvent(type, { pointerId: POINTER, clientX: x, clientY: 100, bubbles: true }),
  );
}
function key(
  handle: HTMLElement,
  type: "keydown" | "keyup",
  name: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const ev = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init });
  handle.dispatchEvent(ev);
  return ev;
}
/** A press and its release. */
function tap(handle: HTMLElement, name: string): void {
  key(handle, "keydown", name);
  key(handle, "keyup", name);
}

describe("the separator", () => {
  it("is a focusable vertical separator valued in whole percents of the effective share and its bounds", async () => {
    const { root, ctx, split, handle } = await mountSplit(rootIn(1000));
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Pane divider");
    expect(handle.getAttribute("tabindex")).toBe("0");

    ctx.notifySwitch({ id: "a" });
    split.open();

    expect(handle.getAttribute("aria-valuenow")).toBe("50");
    expect(handle.getAttribute("aria-valuemin")).toBe("36");
    expect(handle.getAttribute("aria-valuemax")).toBe("64");
    expect(handle.dataset["faces"]).toBe("left");
    split.setRatio(0.4, true);
    expect(handle.getAttribute("aria-valuenow")).toBe("40");
    expect(ratioVar(root)).toBe("0.4");
  });

  it("sits between the left root and the right root at every open, and after a close the survivor still comes first", async () => {
    const { root, ctx, split, handle } = await mountSplit(rootIn(1000));
    ctx.notifySwitch({ id: "a" });
    const first = paneRoots(root)[0];
    split.open();
    const second = paneRoots(root)[1];

    let grid = gridChildren(root);
    expect(grid).toHaveLength(3);
    expect(grid[0]).toBe(first);
    expect(grid[1]).toBe(handle);
    expect(grid[2]).toBe(second);

    // The right pane survives: it becomes the left root, the handle follows it,
    // and the hidden root is last.
    ctx.notifySwitch({ id: "b" });
    expect(ctx.shell.selected()).toBe("right");
    split.close();
    grid = gridChildren(root);
    expect(grid[0]).toBe(second);
    expect(grid[1]).toBe(handle);
    expect(grid[2]).toBe(first);
    expect(handle.dataset["faces"]).toBe("left");

    split.open();
    grid = gridChildren(root);
    expect(grid[0]).toBe(second);
    expect(grid[1]).toBe(handle);
    expect(grid[2]).toBe(first);
    expect(ctx.shell.pane("left")?.session.id).toBe("b");
  });

  it("faces the selected pane, and focusing it selects nothing and announces nothing", async () => {
    const { root, ctx, split, handle } = await mountSplit(rootIn(1000));
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    expect(handle.dataset["faces"]).toBe("right");
    ctx.shell.select("left");
    expect(handle.dataset["faces"]).toBe("left");
    ctx.shell.select("right");
    await announced();
    expect(politeText(root)).toBe("Right terminal selected");

    handle.focus();
    await announced();

    expect(document.activeElement).toBe(handle);
    expect(ctx.shell.selected()).toBe("right");
    expect(handle.dataset["faces"]).toBe("right");
    expect(politeText(root)).toBe("Right terminal selected");
  });

  it("rewrites the bounds on a resize and clamps the value with the var", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    split.setRatio(0.4, true);

    root.style.width = "800px";
    await settle();

    expect(handle.getAttribute("aria-valuemin")).toBe("46");
    expect(handle.getAttribute("aria-valuemax")).toBe("54");
    expect(handle.getAttribute("aria-valuenow")).toBe("46");
    expect(ratioVar(root)).toBe(String(360 / 790));
    expect(split.state().committedRatio).toBe(0.4);

    root.style.width = "730px";
    await settle();
    expect(handle.getAttribute("aria-valuemin")).toBe("50");
    expect(handle.getAttribute("aria-valuemax")).toBe("50");
    expect(handle.getAttribute("aria-valuenow")).toBe("50");
  });
});

describe("the drag", () => {
  it("a press without a move, or a move under 8 px, sends and commits nothing; 8 px starts the drag", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);

    const down = press(handle, 500);
    expect(down.defaultPrevented).toBe(true);
    expect(handle.classList.contains("wt-handle-held")).toBe(true);
    release(500);
    expect(handle.classList.contains("wt-handle-held")).toBe(false);
    expect(ratioVar(root)).toBe("0.5");
    expect(resizes()).toEqual([0, 0]);
    expect(split.state().committedRatio).toBe(0.5);

    press(handle, 500);
    moveTo(507);
    expect(ratioVar(root)).toBe("0.5");
    release(507);
    expect(resizes()).toEqual([0, 0]);
    expect(split.state().committedRatio).toBe(0.5);

    press(handle, 500);
    moveTo(508);
    expect(ratioVar(root)).toBe(String(503 / 990));
    // One pair: both panes, at once.
    expect(resizes()).toEqual([1, 1]);
    release(508);
    expect(resizes()).toEqual([2, 2]);
    expect(split.state().committedRatio).toBe(503 / 990);
    expect(handle.getAttribute("aria-valuenow")).toBe("51");
  });

  it("the panes follow every move while the shells are resized at most once per 100 ms, and once more on release", async () => {
    const { root, handle } = await openWithTwoTabs(1000);
    vi.useFakeTimers();

    press(handle, 500);
    const values = new Set<string>();
    for (let i = 0; i < 30; i++) {
      moveTo(508 + i * 4);
      values.add(ratioVar(root));
      vi.advanceTimersByTime(10);
    }

    expect(values.size).toBe(30);
    // The first move, then the 100, 200 and 300 ms marks: four pairs.
    expect(resizes()).toEqual([4, 4]);

    // One more move right at the 300 ms mark schedules a trailing call; the
    // release cancels it and sends its own pair instead.
    moveTo(508 + 30 * 4);
    expect(resizes()).toEqual([4, 4]);
    release(508 + 30 * 4);
    expect(resizes()).toEqual([5, 5]);
    vi.advanceTimersByTime(500);
    expect(resizes()).toEqual([5, 5]);
  });

  it("throttles the resize on the frame's clock and timers when the shell is mounted in another document", async () => {
    const frame = document.createElement("iframe");
    frame.style.width = "1000px";
    frame.style.height = "600px";
    document.body.appendChild(frame);
    const inner = frame.contentDocument;
    const innerWin = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!inner || !innerWin) {
      throw new Error("no frame document");
    }
    const frameRoot = inner.createElement("div");
    frameRoot.style.width = "1000px";
    frameRoot.style.height = "600px";
    inner.body.appendChild(frameRoot);
    const mounted = await mountSplit(frameRoot);
    mounted.ctx.notifySwitch({ id: "a" });
    mounted.split.open();
    mounted.ctx.notifySwitch({ id: "b" });
    mounted.ctx.shell.select("left");
    await viewportSettled();
    clearResizes();

    let frameNow = 50_000;
    const frameClock = vi.spyOn(innerWin.Date, "now").mockImplementation(() => frameNow);
    const frameTimeouts = vi.spyOn(innerWin, "setTimeout");
    const moveInFrame = (x: number): void => {
      innerWin.dispatchEvent(
        new innerWin.PointerEvent("pointermove", {
          pointerId: POINTER,
          clientX: x,
          clientY: 100,
          bubbles: true,
        }),
      );
    };
    vi.useFakeTimers();
    try {
      mounted.handle.dispatchEvent(
        new innerWin.PointerEvent("pointerdown", {
          pointerId: POINTER,
          clientX: 500,
          clientY: 100,
          bubbles: true,
          cancelable: true,
          isPrimary: true,
        }),
      );
      moveInFrame(510);
      expect(resizes()).toEqual([1, 1]);
      // A second move inside the interval: the trailing call is the frame's timer,
      // and the importing page's clock holds nothing.
      moveInFrame(514);
      expect(frameTimeouts.mock.calls.map((c) => c[1])).toEqual([100]);
      expect(vi.getTimerCount()).toBe(0);
      // The interval passes in the frame while the page's clock stands still: the
      // next move sends at once.
      frameNow += 100;
      moveInFrame(518);
      expect(resizes()).toEqual([2, 2]);
    } finally {
      vi.useRealTimers();
      frameClock.mockRestore();
      frameTimeouts.mockRestore();
      mounted.term.destroy();
      frame.remove();
    }
  });

  it("a pointer past the row's edge pins the divider at the edge", async () => {
    const { root, ctx, split, handle } = await openWithTwoTabs(1000);
    const [left, right] = paneRoots(root);

    press(handle, 500);
    moveTo(5000);
    expect(ratioVar(root)).toBe("1");
    expect(right?.classList.contains("wt-pane-closing")).toBe(true);
    moveTo(-5000);
    expect(ratioVar(root)).toBe("0");
    expect(left?.classList.contains("wt-pane-closing")).toBe(true);
    expect(right?.classList.contains("wt-pane-closing")).toBe(false);
    release(-5000);

    expect(split.isOpen()).toBe(false);
    expect(ctx.shell.pane("left")?.session.id).toBe("b");
  });

  it("sends nothing while the fonts are still loading, and sends once they have", async () => {
    const restoreFonts = shadowPendingFonts();
    try {
      const { handle } = await openWithTwoTabs(1000);

      press(handle, 500);
      moveTo(450);
      release(450);
      expect(resizes()).toEqual([0, 0]);

      restoreFonts.settle();
      // The fonts land, and the throttle interval since the silent release passes.
      await new Promise((r) => setTimeout(r, 110));
      press(handle, 450);
      moveTo(400);
      expect(resizes()).toEqual([1, 1]);
    } finally {
      restoreFonts.restore();
    }
  });

  it("resizes the shells mid-drag although the pane boxes are still changing under the pointer", async () => {
    const { handle } = await openWithTwoTabs(1000);

    press(handle, 500);
    moveTo(450);
    expect(resizes()).toEqual([1, 1]);
    // A frame later the panes' own ResizeObservers have seen the first move and
    // their viewport controllers are mid-transition for 350 ms.
    await settle();
    await new Promise((r) => setTimeout(r, 110));
    moveTo(420);

    expect(resizes()).toEqual([2, 2]);
  });

  it("a press with another button starts no drag", async () => {
    const { root, handle } = await openWithTwoTabs(1000);

    const down = new PointerEvent("pointerdown", {
      pointerId: POINTER,
      button: 2,
      clientX: 500,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    handle.dispatchEvent(down);
    moveTo(401);

    expect(down.defaultPrevented).toBe(false);
    expect(handle.classList.contains("wt-handle-held")).toBe(false);
    expect(ratioVar(root)).toBe("0.5");
  });

  it("a drag that never dips commits the released share", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    const changes = vi.fn<(state: SplitState) => void>();
    split.onChange(changes);

    press(handle, 500);
    moveTo(401);
    expect(ratioVar(root)).toBe("0.4");
    expect(split.state()).toMatchObject({ ratio: 0.4, committedRatio: 0.5 });
    release(401);

    expect(split.state()).toMatchObject({ ratio: 0.4, committedRatio: 0.4 });
    expect(ratioVar(root)).toBe("0.4");
    expect(handle.getAttribute("aria-valuenow")).toBe("40");
    expect(changes.mock.calls.at(-1)?.[0].committedRatio).toBe(0.4);
    expect(resizes()).toEqual([2, 2]);
  });

  it("a drag released after the row shrank commits the share measured against the row's new width", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    split.setRatio(0.4, true);
    root.style.width = "800px";
    await settle();
    expect(split.state()).toMatchObject({ ratio: 360 / 790, committedRatio: 0.4 });

    press(handle, 365);
    moveTo(405);
    release(405);
    expect(split.state()).toMatchObject({ ratio: 400 / 790, committedRatio: 400 / 790 });
    expect(ratioVar(root)).toBe(String(400 / 790));
    expect(handle.getAttribute("aria-valuenow")).toBe("51");
  });

  it("dims the left pane squeezed under 360 px and closes it on release, the right pane filling the view", async () => {
    const { root, ctx, split, handle } = await openWithTwoTabs(1000);
    const [left, right] = paneRoots(root);

    press(handle, 500);
    moveTo(305);
    expect(ratioVar(root)).toBe(String(300 / 990));
    expect(left?.classList.contains("wt-pane-closing")).toBe(true);
    expect(right?.classList.contains("wt-pane-closing")).toBe(false);
    expect(split.isOpen()).toBe(true);

    release(305);

    expect(split.isOpen()).toBe(false);
    expect(handle.classList.contains("wt-handle-held")).toBe(false);
    expect(left?.classList.contains("wt-pane-closing")).toBe(false);
    // The squeezed pane closed although it was the selected one.
    expect(ctx.shell.pane("left")?.root).toBe(right);
    expect(ctx.shell.pane("left")?.session.id).toBe("b");
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
    expect(ratioVar(root)).toBe("0.5");
  });

  it("dims the right pane squeezed under 360 px and closes that side", async () => {
    const { root, ctx, split, handle } = await openWithTwoTabs(1000);
    const [left, right] = paneRoots(root);

    press(handle, 500);
    moveTo(695);
    expect(right?.classList.contains("wt-pane-closing")).toBe(true);
    expect(left?.classList.contains("wt-pane-closing")).toBe(false);
    release(695);

    expect(split.isOpen()).toBe(false);
    expect(right?.classList.contains("wt-pane-closing")).toBe(false);
    expect(ctx.shell.pane("left")?.session.id).toBe("a");
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
  });

  it("a dip under the minimum that comes back snaps the divider to where it was and commits nothing", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    split.setRatio(0.4, true);
    const [left] = paneRoots(root);
    const changes = vi.fn<(state: SplitState) => void>();
    split.onChange(changes);

    press(handle, 500);
    moveTo(404);
    expect(left?.classList.contains("wt-pane-closing")).toBe(true);
    moveTo(554);
    expect(ratioVar(root)).toBe(String(450 / 990));
    expect(left?.classList.contains("wt-pane-closing")).toBe(false);
    release(554);

    expect(split.isOpen()).toBe(true);
    expect(ratioVar(root)).toBe("0.4");
    expect(split.state()).toMatchObject({ ratio: 0.4, committedRatio: 0.4 });
    expect(handle.getAttribute("aria-valuenow")).toBe("40");
    expect(changes.mock.calls.every(([state]) => state.committedRatio === 0.4)).toBe(true);
  });

  it("a release under the minimum whose close the split refuses (the survivor has failed) snaps the divider back and closes nothing", async () => {
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
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, ctx, split, handle } = await mountSplit(
      rootIn(1000),
      { onFatalError: () => true },
      () => [boom()],
    );
    ctx.notifySwitch({ id: "a" });
    split.open();
    await tick();
    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    await viewportSettled();
    clearResizes();
    const [left] = paneRoots(root);

    press(handle, 500);
    moveTo(305);
    expect(ratioVar(root)).toBe(String(300 / 990));
    expect(left?.classList.contains("wt-pane-closing")).toBe(true);
    release(305);

    expect(split.isOpen()).toBe(true);
    expect(ctx.shell.pane("left")?.session.id).toBe("a");
    expect(ctx.shell.pane("left")?.state()).toBe("shown");
    expect(handle.classList.contains("wt-handle-held")).toBe(false);
    expect(left?.classList.contains("wt-pane-closing")).toBe(false);
    expect(ratioVar(root)).toBe("0.5");
    expect(split.state()).toMatchObject({ ratio: 0.5, committedRatio: 0.5 });
    expect(handle.getAttribute("aria-valuenow")).toBe("50");
    // The healthy pane was resized on the move and once more on the release;
    // the failed pane's engine is gone and receives nothing.
    expect(resizes()).toEqual([2, 0]);
  });

  it("pointercancel ends the drag as a release does", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);

    press(handle, 500);
    moveTo(401);
    release(401, "pointercancel");

    expect(handle.classList.contains("wt-handle-held")).toBe(false);
    expect(split.state().committedRatio).toBe(0.4);
    expect(ratioVar(root)).toBe("0.4");
    // The gesture is over: a stray move changes nothing.
    moveTo(305);
    expect(ratioVar(root)).toBe("0.4");
  });

  it("a split closed under the pointer ends the drag: no dim, no resize, and the release decides nothing", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    press(handle, 500);
    moveTo(300);
    const [left] = paneRoots(root);
    expect(left?.classList.contains("wt-pane-closing")).toBe(true);

    split.close();
    clearResizes();

    expect(handle.classList.contains("wt-handle-held")).toBe(false);
    expect(left?.classList.contains("wt-pane-closing")).toBe(false);
    moveTo(200);
    expect(left?.classList.contains("wt-pane-closing")).toBe(false);
    expect(resizes()).toEqual([0, 0]);
    release(200);
    expect(resizes()).toEqual([0, 0]);
    expect(split.isOpen()).toBe(false);
    expect(root.querySelector(":scope > .wt-split-pane:not(.wt-pane-hidden)")).toBe(left);
  });
});

describe("the keyboard", () => {
  it("ArrowLeft moves the divider 16 px at once, sends one resize pair, and commits on the key's release", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    handle.focus();

    const down = key(handle, "keydown", "ArrowLeft");

    expect(down.defaultPrevented).toBe(true);
    expect(ratioVar(root)).toBe(String(479 / 990));
    expect(handle.getAttribute("aria-valuenow")).toBe("48");
    expect(resizes()).toEqual([1, 1]);
    expect(split.state().committedRatio).toBe(0.5);

    key(handle, "keyup", "ArrowLeft");
    expect(split.state().committedRatio).toBe(479 / 990);
    expect(resizes()).toEqual([2, 2]);
  });

  it("ArrowRight mirrors it", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    handle.focus();

    tap(handle, "ArrowRight");

    expect(ratioVar(root)).toBe(String(511 / 990));
    expect(handle.getAttribute("aria-valuenow")).toBe("52");
    expect(split.state().committedRatio).toBe(511 / 990);
  });

  it.each([["Tab"], ["Enter"], ["F6"], ["a"]])("leaves %s to the browser", async (name) => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    handle.focus();

    const down = key(handle, "keydown", name);
    key(handle, "keyup", name);

    expect(down.defaultPrevented).toBe(false);
    expect(ratioVar(root)).toBe("0.5");
    expect(split.state().committedRatio).toBe(0.5);
    expect(resizes()).toEqual([0, 0]);
  });

  it("Home takes the left pane to 360 px, where a further ArrowLeft changes, sends and writes nothing", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    const [left] = paneRoots(root);
    handle.focus();

    tap(handle, "Home");
    expect(ratioVar(root)).toBe(String(360 / 990));
    expect(handle.getAttribute("aria-valuenow")).toBe("36");
    expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemin"));
    expect(split.state().committedRatio).toBe(360 / 990);

    clearResizes();
    const changes = vi.fn();
    split.onChange(changes);
    tap(handle, "ArrowLeft");

    expect(ratioVar(root)).toBe(String(360 / 990));
    expect(resizes()).toEqual([0, 0]);
    expect(changes).not.toHaveBeenCalled();
    expect(split.state().committedRatio).toBe(360 / 990);
    expect(left?.classList.contains("wt-pane-closing")).toBe(false);
    expect(split.isOpen()).toBe(true);
  });

  it("End takes the right pane to 360 px, where a further ArrowRight is refused the same way", async () => {
    const { root, split, handle } = await openWithTwoTabs(1000);
    handle.focus();

    tap(handle, "End");
    expect(ratioVar(root)).toBe(String(630 / 990));
    expect(handle.getAttribute("aria-valuenow")).toBe("64");
    expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemax"));

    const changes = vi.fn();
    split.onChange(changes);
    tap(handle, "ArrowRight");

    expect(ratioVar(root)).toBe(String(630 / 990));
    expect(changes).not.toHaveBeenCalled();
    expect(split.state().committedRatio).toBe(630 / 990);
  });

  it("nine ArrowLeft presses from the middle stop at 360 px instead of closing the pane", async () => {
    const { root, ctx, split, handle } = await openWithTwoTabs(1000);
    handle.focus();

    for (let i = 0; i < 8; i++) {
      tap(handle, "ArrowLeft");
    }
    expect(ratioVar(root)).toBe(String(367 / 990));
    tap(handle, "ArrowLeft");

    expect(ratioVar(root)).toBe(String(360 / 990));
    expect(split.isOpen()).toBe(true);
    expect(ctx.shell.pane("left")?.state()).toBe("shown");
    expect(ctx.shell.pane("right")?.state()).toBe("shown");
    expect(paneRoots(root).some((p) => p.classList.contains("wt-pane-closing"))).toBe(false);
  });

  it("a held key sends at most ten resize pairs a second and commits once, on its release", async () => {
    const { root, split, handle } = await openWithTwoTabs(1250);
    handle.focus();
    tap(handle, "Home");
    expect(split.state().committedRatio).toBe(360 / 1240);
    clearResizes();
    const changes = vi.fn<(state: SplitState) => void>();
    split.onChange(changes);
    vi.useFakeTimers();
    // The Home release sent a pair just now; the throttle interval passes first.
    vi.advanceTimersByTime(100);

    for (let i = 0; i < 30; i++) {
      key(handle, "keydown", "ArrowRight", { repeat: i > 0 });
      vi.advanceTimersByTime(33);
    }

    expect(ratioVar(root)).toBe(String(840 / 1240));
    expect(split.state().committedRatio).toBe(360 / 1240);
    // The first press, then the nine 100 ms marks the 990 ms of repeats reach.
    expect(resizes()).toEqual([10, 10]);

    key(handle, "keyup", "ArrowRight");

    expect(resizes()).toEqual([11, 11]);
    expect(split.state().committedRatio).toBe(840 / 1240);
    expect(changes.mock.calls.filter(([s]) => s.committedRatio !== 360 / 1240)).toHaveLength(1);
  });

  it("a blur while a nudge is pending commits once, and the keyup after it writes nothing", async () => {
    const { split, handle } = await openWithTwoTabs(1000);
    handle.focus();
    const changes = vi.fn();
    split.onChange(changes);

    key(handle, "keydown", "ArrowLeft");
    expect(split.state().committedRatio).toBe(0.5);
    handle.blur();
    expect(split.state().committedRatio).toBe(479 / 990);
    const afterBlur = changes.mock.calls.length;

    key(handle, "keyup", "ArrowLeft");

    expect(changes).toHaveBeenCalledTimes(afterBlur);
    expect(split.state().committedRatio).toBe(479 / 990);
  });
});

describe("focus when the handle leaves the layout", () => {
  it("a collapse while the handle has focus moves focus to the selected pane's textarea", async () => {
    const { root, handle } = await openWithTwoTabs(1000);
    const [left] = paneRoots(root);
    handle.focus();
    expect(document.activeElement).toBe(handle);

    root.style.width = "720px";
    await settle();

    expect(root.classList.contains("wt-split-collapsed")).toBe(true);
    expect(document.activeElement).toBe(textarea(left));
  });

  it("a close while the handle has focus moves focus to the survivor's textarea", async () => {
    const { root, ctx, split, handle } = await openWithTwoTabs(1000);
    const [, right] = paneRoots(root);
    ctx.shell.select("right");
    handle.focus();

    split.close();

    expect(document.activeElement).toBe(textarea(right));
  });

  it("destroy() removes the handle with the rest of the shell", async () => {
    const { root, term, handle } = await openWithTwoTabs(1000);
    term.destroy();
    expect(handle.isConnected).toBe(false);
    expect(root.querySelector(".wt-split-handle")).toBeNull();
  });
});

describe("construction is transactional", () => {
  interface HandleShell {
    readonly shell: SplitHandleShell;
    /** The release the controller handed the handle for its one subscription. */
    readonly offChange: Mock<() => void>;
    subscriptions(): number;
  }
  /** The three shell members the handle reads, over an open 50/50 split whose
   *  controller records its subscriptions. */
  function handleShell(root: HTMLElement): HandleShell {
    const offChange = vi.fn<() => void>();
    let subscriptions = 0;
    const state: SplitState = {
      open: true,
      collapsed: false,
      ratio: 0.5,
      committedRatio: 0.5,
      selected: "left",
    };
    return {
      shell: {
        root,
        panes: () => [],
        split: {
          enabled: true,
          state: () => state,
          isOpen: () => true,
          canOpen: () => false,
          open: () => false,
          close: () => false,
          closeSide: () => false,
          setRatio: () => false,
          onChange() {
            subscriptions += 1;
            return offChange;
          },
        },
      },
      offChange,
      subscriptions: () => subscriptions,
    };
  }
  interface Taken {
    readonly type: string;
    readonly signal: AbortSignal | undefined;
  }
  /** Record every listener the handle's own element takes, and refuse the one
   *  for `refuse`. */
  function watchHandleElement(refuse: string | null): Taken[] {
    const taken: Taken[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag !== "div") {
        return el;
      }
      const realAdd = el.addEventListener.bind(el);
      vi.spyOn(el, "addEventListener").mockImplementation((type, listener, options) => {
        if (type === refuse) {
          throw new Error(`refused ${type}`);
        }
        taken.push({ type, signal: typeof options === "object" ? options.signal : undefined });
        realAdd(type, listener, options);
      });
      return el;
    });
    return taken;
  }
  const REGISTRATIONS = ["pointerdown", "keydown", "keyup", "blur"] as const;

  for (const fault of REGISTRATIONS) {
    it(`a throw registering ${fault} releases the split subscription and the listeners taken before it`, () => {
      const { shell, offChange, subscriptions } = handleShell(rootIn());
      const taken = watchHandleElement(fault);

      expect(() => createSplitHandle(shell)).toThrow(`refused ${fault}`);

      expect(subscriptions()).toBe(1);
      expect(offChange).toHaveBeenCalledTimes(1);
      expect(taken.map((t) => t.type)).toEqual(
        REGISTRATIONS.slice(0, REGISTRATIONS.indexOf(fault)),
      );
      expect(taken.map((t) => t.signal?.aborted)).toEqual(taken.map(() => true));
    });
  }

  it("dispose() releases the subscription and every listener a completed construction took", () => {
    const { shell, offChange, subscriptions } = handleShell(rootIn());
    const taken = watchHandleElement(null);

    const handle = createSplitHandle(shell);
    shell.root.append(handle.element);
    expect(subscriptions()).toBe(1);
    expect(taken.map((t) => t.type)).toEqual([...REGISTRATIONS]);
    expect(taken.map((t) => t.signal?.aborted)).toEqual(taken.map(() => false));

    handle.dispose();

    expect(offChange).toHaveBeenCalledTimes(1);
    expect(taken.map((t) => t.signal?.aborted)).toEqual(taken.map(() => true));
    expect(handle.element.isConnected).toBe(false);
  });
});
