import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import { clipboard } from "../features/clipboard.js";
import { contextMenu } from "../features/context-menu.js";
import { MIN_SPLIT_AREA_PX } from "./layout-policy.js";
import type {
  CreateTerminalOptions,
  PaneSide,
  TerminalContext,
  TerminalFeature,
  TerminalHandle,
  TerminalStartupFailure,
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
/** A pane announces its size only once its viewport controller's 350 ms settle
 *  after a build or a resize has passed. */
const viewportSettled = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
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
}

/** An owner that shows one session in the left pane at boot, so the overlay
 *  waits for a frame as it does under the tabs feature. */
function showingOwner(id: string): TerminalFeature<void> {
  let ctxRef: TerminalContext | undefined;
  return {
    name: "owner",
    scope: "shell",
    paneLayoutOwner: {
      resolveInitialLayout: () => {
        ctxRef?.notifySwitch({ id });
        return Promise.resolve(true);
      },
      shownIn: () => null,
      showIn: () => false,
    },
    setup(ctx) {
      ctxRef = ctx;
      return { api: undefined, teardown: () => undefined };
    },
  };
}

/** A split terminal carrying a shell-scoped probe that captures its context. */
async function mountSplit(
  root: HTMLElement,
  extra: Partial<CreateTerminalOptions> = {},
  paneFeatures: () => readonly TerminalFeature<unknown>[] = () => [],
  owner: TerminalFeature<void> = layoutOwner(),
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
    features: () => [owner, probe, ...paneFeatures()],
    ...extra,
  });
  await tick();
  if (!ctxRef) {
    throw new Error("the probe feature never ran");
  }
  return { root, term, ctx: ctxRef };
}

const paneRoots = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(":scope > .wt-split-pane"));
const ratioVar = (root: HTMLElement): string => root.style.getPropertyValue("--wt-split-ratio");
const politeText = (root: HTMLElement): string =>
  root.querySelector(':scope > [aria-live="polite"]')?.textContent ?? "";
const controller = (term: TerminalHandle): NonNullable<TerminalHandle["split"]> => {
  if (!term.split) {
    throw new Error("the handle carries no split controller");
  }
  return term.split;
};

describe("the two topologies", () => {
  it("without the option the root is the pane root, the handle has no controller and the shell's controller is disabled", async () => {
    const root = rootIn();
    let ctxRef: TerminalContext | undefined;
    const probe: TerminalFeature<void> = {
      name: "shell-probe",
      scope: "shell",
      setup(ctx) {
        ctxRef = ctx;
        return { api: undefined, teardown: () => undefined };
      },
    };
    const term = await mountTerminal(root, { features: () => [probe] });
    await tick();

    expect("split" in term).toBe(false);
    expect(root.classList.contains("wt-split")).toBe(false);
    expect(root.querySelector(".wt-split-pane")).toBeNull();
    expect(root.querySelector(".term-input")).not.toBeNull();
    // The shared chrome's regions are the pane's own.
    expect(ctxRef?.region("top-bar").closest(".wt-root")).toBe(root);
    const split = ctxRef?.shell.split;
    expect(split?.enabled).toBe(false);
    expect(split?.canOpen()).toBe(false);
    expect(split?.open()).toBe(false);
    expect(split?.isOpen()).toBe(false);
    expect(split?.close()).toBe(false);
    expect(split?.closeSide("left")).toBe(false);
    expect(split?.setRatio(0.4, true)).toBe(false);
    expect(split?.state()).toEqual({
      open: false,
      collapsed: false,
      ratio: 0.5,
      committedRatio: 0.5,
      selected: "left",
    });
    expect(root.hasAttribute("inert")).toBe(false);
  });

  it("with the option the root is the shell root holding one pane root, the shared chrome's regions and an enabled controller", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);

    expect(root.classList.contains("wt-root")).toBe(true);
    expect(root.classList.contains("wt-split")).toBe(true);
    expect(root.classList.contains("wt-viewport")).toBe(true);
    const panes = paneRoots(root);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.classList.contains("wt-root")).toBe(true);
    expect(panes[0]?.classList.contains("wt-container")).toBe(true);
    expect(panes[0]?.classList.contains("wt-side-left")).toBe(true);
    expect(root.querySelectorAll(".term-input")).toHaveLength(1);
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(1);
    expect(fake.options().sessionIdKey).toBe("vterm-session-id");
    // The regions a shell-scoped feature mounts into sit beside the panes, not
    // inside one.
    const bar = ctx.region("top-bar");
    expect(bar.closest(".wt-root")).toBe(root);
    expect(panes[0]?.contains(bar)).toBe(false);
    expect(ctx.shell.root).toBe(root);
    const split = controller(term);
    expect(split).toBe(ctx.shell.split);
    expect(split.enabled).toBe(true);
    expect(split.isOpen()).toBe(false);
    expect(split.canOpen()).toBe(true);
    expect(ctx.shell.pane("left")?.side).toBe("left");
    expect(ctx.shell.pane("right")).toBeNull();
    expect(ctx.shell.panes()).toHaveLength(1);
  });

  it("writes the theme on the shell root and on the pane root, since the pane root redeclares every token", async () => {
    const root = rootIn();
    await mountSplit(root, { theme: { "--accent": "red", ignored: "x" } });
    expect(root.style.getPropertyValue("--accent")).toBe("red");
    expect(paneRoots(root)[0]?.style.getPropertyValue("--accent")).toBe("red");
  });

  it("keeps an empty pane inert and makes it live when a session is shown in it", async () => {
    const root = rootIn();
    const { ctx } = await mountSplit(root);
    const pane = paneRoots(root)[0];
    expect(pane?.hasAttribute("inert")).toBe(true);
    ctx.notifySwitch({ id: "a" });
    expect(pane?.hasAttribute("inert")).toBe(false);
    ctx.shell.pane("left")?.clearActiveSession();
    expect(pane?.hasAttribute("inert")).toBe(true);
  });

  it("destroy() leaves the consumer's root as it found it and disposes each pane's engine once", async () => {
    const root = rootIn();
    root.className = "mine";
    const { term } = await mountSplit(root);
    controller(term).open();
    const [leftEngine, rightEngine] = fake.engines;
    term.destroy();
    expect(root.className).toBe("mine");
    expect(root.childElementCount).toBe(0);
    expect(ratioVar(root)).toBe("");
    expect(fake.engines).toHaveLength(2);
    expect(leftEngine?.dispose).toHaveBeenCalledTimes(1);
    expect(rightEngine?.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("the split option is validated at kernel-init", () => {
  it.each([["true"], [1], [{}], [null]])(
    "refuses %p through onFatalError with the consumer's root as the surface",
    async (value) => {
      const root = rootIn();
      const seen: TerminalStartupFailure[] = [];
      await expect(
        mountTerminal(root, {
          features: () => [layoutOwner()],
          split: value as unknown as boolean,
          onFatalError(failure) {
            seen.push(failure);
          },
        }),
      ).rejects.toThrow(/split must be true or false/);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.phase).toBe("kernel-init");
      expect(seen[0]?.surface).toBe(root);
      expect(root.querySelector("dialog.wt-fatal")).not.toBeNull();
    },
  );

  it("requires the tabs feature: no owner at all", async () => {
    const root = rootIn();
    await expect(mountTerminal(root, { split: true, features: () => [] })).rejects.toThrow(
      /split requires the tabs feature/,
    );
    expect(fake.createTerminalEngine).not.toHaveBeenCalled();
  });

  it("requires the tabs feature: a plain session owner is not enough", async () => {
    const root = rootIn();
    const owner: TerminalFeature<void> = {
      name: "custom-owner",
      sessionOwner: { resolveInitialSession: () => Promise.resolve(null) },
      setup() {
        return { api: undefined, teardown: () => undefined };
      },
    };
    await expect(mountTerminal(root, { split: true, features: () => [owner] })).rejects.toThrow(
      /split requires the tabs feature/,
    );
  });

  it("a plain session owner still boots a single-pane terminal without the option", async () => {
    const root = rootIn();
    const owner: TerminalFeature<void> = {
      name: "custom-owner",
      sessionOwner: { resolveInitialSession: () => Promise.resolve({ id: "s1" }) },
      setup() {
        return { api: undefined, teardown: () => undefined };
      },
    };
    await mountTerminal(root, { features: () => [owner] });
    await tick();
    await tick();
    expect(fake.connection.setSession).toHaveBeenCalledWith("s1");
  });
});

describe("open(): the second pane", () => {
  it("builds the second kernel on the right, keeps the showing one on the left and leaves the new pane empty and inert", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    const first = paneRoots(root)[0];
    ctx.notifySwitch({ id: "a" });
    fake.connection.setSession.mockClear();

    expect(split.open()).toBe(true);

    expect(root.classList.contains("wt-split-open")).toBe(true);
    expect(root.classList.contains("wt-split-collapsed")).toBe(false);
    const panes = paneRoots(root);
    expect(panes).toHaveLength(2);
    expect(panes[0]).toBe(first);
    expect(panes[0]?.classList.contains("wt-side-left")).toBe(true);
    expect(panes[1]?.classList.contains("wt-side-right")).toBe(true);
    expect(panes[1]?.classList.contains("wt-root")).toBe(true);
    expect(panes[1]?.classList.contains("wt-container")).toBe(true);
    expect(panes[1]?.hasAttribute("inert")).toBe(true);
    expect(panes[0]?.hasAttribute("inert")).toBe(false);
    expect(panes[0]?.classList.contains("wt-pane-selected")).toBe(true);
    expect(panes[1]?.classList.contains("wt-pane-selected")).toBe(false);
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(2);
    expect(fake.options().sessionIdKey).toBe("vterm-session-id:2");
    expect(root.querySelectorAll(".term-input")).toHaveLength(2);
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(ctx.shell.pane("left")?.state()).toBe("shown");
    expect(ctx.shell.pane("left")?.session.id).toBe("a");
    expect(ctx.shell.panes().map((p) => p.side)).toEqual(["left", "right"]);
    expect(ctx.shell.selected()).toBe("left");
    // The session moved nowhere: neither engine attached anything.
    expect(fake.connection.setSession).not.toHaveBeenCalled();
    expect(fake.engines[1]?.connection.setSession).not.toHaveBeenCalled();
    expect(split.state()).toEqual({
      open: true,
      collapsed: false,
      ratio: 0.5,
      committedRatio: 0.5,
      selected: "left",
    });
    expect(ratioVar(root)).toBe("0.5");
    expect(split.canOpen()).toBe(false);
    await announced();
    expect(politeText(root)).toBe("Split open");
  });

  it("fires onChange and onPanesChange once each, and refuses a second open", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    const changes = vi.fn();
    const panes = vi.fn();
    split.onChange(changes);
    ctx.shell.onPanesChange(panes);

    expect(split.open()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]?.[0]).toMatchObject({ open: true, selected: "left" });
    expect(panes).toHaveBeenCalledTimes(1);

    expect(split.open()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(2);
  });

  it("sets up the pane features of a fresh thunk invocation in the new pane, and the shell-scoped ones once", async () => {
    const root = rootIn();
    const thunk = vi.fn();
    const paneSetups: TerminalContext[] = [];
    const shellSetups = vi.fn();
    const paneFeature = (): TerminalFeature<void> => ({
      name: "pane-probe",
      setup(ctx) {
        paneSetups.push(ctx);
        return { api: undefined, teardown: () => undefined };
      },
    });
    const shellFeature = (): TerminalFeature<void> => ({
      name: "shell-twice",
      scope: "shell",
      setup() {
        shellSetups();
        return { api: undefined, teardown: () => undefined };
      },
    });
    const { term } = await mountSplit(root, {}, () => {
      thunk();
      return [paneFeature(), shellFeature()];
    });
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(paneSetups).toHaveLength(1);

    controller(term).open();
    await tick();

    expect(thunk).toHaveBeenCalledTimes(2);
    expect(shellSetups).toHaveBeenCalledTimes(1);
    expect(paneSetups).toHaveLength(2);
    expect(paneSetups[1]?.surface()).toBe(paneRoots(root)[1]?.querySelector(".term"));
  });

  it("registrations a shell-scoped feature made before the open reach the pane built later", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const switches: string[] = [];
    ctx.on("session:switch", (s) => {
      switches.push(s.id);
    });
    ctx.registerInputTransform((bytes) => new Uint8Array([...bytes, 0x21]));

    controller(term).open();
    const right = ctx.shell.pane("right");
    right?.notifySwitch({ id: "b" });
    right?.send(new Uint8Array([0x41]));

    expect(switches).toEqual(["b"]);
    // Through the right pane's own engine, transformed; nothing reaches the left's.
    expect(fake.engines[1]?.connection.sendBinary.mock.calls).toEqual([
      [new Uint8Array([0x41, 0x21])],
    ]);
    expect(fake.engines[0]?.connection.sendBinary).not.toHaveBeenCalled();
  });

  it("refuses a thunk that hands a pane feature object to a second pane, naming it, and the first pane keeps running", async () => {
    const root = rootIn();
    const c = clipboard();
    const menu = contextMenu({ clipboard: c });
    const seen: TerminalStartupFailure[] = [];
    const { term, ctx } = await mountSplit(
      root,
      {
        onFatalError(failure) {
          seen.push(failure);
        },
      },
      () => [c, menu],
    );
    ctx.notifySwitch({ id: "a" });

    expect(controller(term).open()).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.phase).toBe("kernel-init");
    expect(String((seen[0]?.cause as Error).message)).toMatch(
      /features\(\) must return new feature objects for each pane; clipboard was already used/,
    );
    const right = paneRoots(root)[1];
    expect(seen[0]?.surface).toBe(right);
    expect(right?.isConnected).toBe(true);
    // The panel: Reload only, non-modal, its ids suffixed so the primary's stay unique.
    const dialog = right?.querySelector<HTMLDialogElement>("dialog.wt-fatal");
    expect(dialog?.open).toBe(true);
    expect(dialog?.matches(":modal")).toBe(false);
    expect(dialog?.querySelectorAll("button")).toHaveLength(1);
    expect(right?.querySelector("#wt-fatal-title-2")).not.toBeNull();
    expect(right?.querySelector("#wt-fatal-message-2")).not.toBeNull();
    expect(right?.hasAttribute("inert")).toBe(false);
    // Not a target and not selectable.
    expect(ctx.shell.pane("right")).toBeNull();
    expect(ctx.shell.select("right")).toBe(false);
    expect(ctx.shell.targetFor("z")).toBe("left");
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(1);
    expect(ctx.shell.pane("left")?.session.id).toBe("a");
  });

  it("a second pane whose feature setup throws keeps its root as the recovery surface; close() discards it and the next open() rebuilds", async () => {
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
    const { term, ctx } = await mountSplit(
      root,
      {
        onFatalError(failure) {
          seen.push(failure);
        },
      },
      () => [boom()],
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ctx.notifySwitch({ id: "a" });
    const split = controller(term);

    expect(split.open()).toBe(true);
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ phase: "feature-setup", feature: "boom" });
    const right = paneRoots(root)[1];
    expect(seen[0]?.surface).toBe(right);
    expect(right?.querySelector("dialog.wt-fatal")?.matches(":modal")).toBe(false);
    expect(right?.querySelector("#wt-fatal-title-2")).not.toBeNull();
    // The failed pane's engine is disposed; the primary's keeps running.
    expect(fake.engines[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(fake.engines[0]?.dispose).not.toHaveBeenCalled();
    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    expect(ctx.shell.select("right")).toBe(false);
    expect(ctx.shell.targetFor("z")).toBe("left");
    expect(ctx.shell.pane("left")?.session.id).toBe("a");

    expect(split.close()).toBe(true);
    expect(paneRoots(root)).toHaveLength(1);
    expect(right?.isConnected).toBe(false);
    expect(ctx.shell.pane("right")).toBeNull();
    expect(fake.engines[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(fake.engines[0]?.dispose).not.toHaveBeenCalled();

    expect(split.open()).toBe(true);
    await tick();
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(3);
    expect(seen).toHaveLength(1);
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(paneRoots(root)[1]?.querySelector("dialog.wt-fatal")).toBeNull();
  });

  /** A pane feature whose second setup (the second pane's) stays pending until
   *  `reject()` is called, so the pane can be shown and selected first. */
  function lateRejecting(): { feature: () => TerminalFeature<void>; reject: () => void } {
    let setups = 0;
    let rejectSecond: ((err: Error) => void) | undefined;
    return {
      feature: () => ({
        name: "late",
        setup() {
          setups += 1;
          if (setups === 2) {
            return new Promise((_, reject) => {
              rejectSecond = reject;
            });
          }
          return { api: undefined, teardown: () => undefined };
        },
      }),
      reject() {
        if (!rejectSecond) {
          throw new Error("the second setup never started");
        }
        rejectSecond(new Error("second pane, later"));
      },
    };
  }

  it("a second pane whose feature setup rejects AFTER it was shown and selected hands selection to the surviving pane", async () => {
    const root = rootIn();
    const late = lateRejecting();
    const { term, ctx } = await mountSplit(root, {}, () => [late.feature()]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ctx.notifySwitch({ id: "a" });
    controller(term).open();
    ctx.notifySwitch({ id: "b" });
    await announced();
    expect(ctx.shell.selected()).toBe("right");
    const selections = vi.fn();
    ctx.shell.onSelectionChange(selections);
    const changes = vi.fn();
    controller(term).onChange(changes);
    fake.engines[0]?.connection.sendBinary.mockClear();

    late.reject();
    await tick();

    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    expect(ctx.shell.selected()).toBe("left");
    expect(controller(term).state().selected).toBe("left");
    expect(root.querySelector(".wt-split-handle")?.getAttribute("data-faces")).toBe("left");
    const [left, right] = paneRoots(root);
    expect(left?.classList.contains("wt-pane-selected")).toBe(true);
    expect(right?.classList.contains("wt-pane-selected")).toBe(false);
    expect(selections).toHaveBeenCalledTimes(1);
    expect(selections).toHaveBeenCalledWith("left");
    expect(changes).toHaveBeenCalled();
    expect(changes.mock.calls[changes.mock.calls.length - 1]?.[0]).toMatchObject({
      selected: "left",
    });
    await announced();
    expect(politeText(root)).toBe("Left terminal selected");
    // Typing reaches the survivor, not the cleaned kernel.
    ctx.send(new Uint8Array([0x41]));
    expect(fake.engines[0]?.connection.sendBinary).toHaveBeenCalledTimes(1);
    expect(fake.engines[1]?.connection.sendBinary).not.toHaveBeenCalled();
  });

  it("a second pane whose feature setup rejects after the first pane gave up settles the loading overlay", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const late = lateRejecting();
    const { term, ctx } = await mountSplit(
      root,
      { loading },
      () => [late.feature()],
      showingOwner("a"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    controller(term).open();
    ctx.shell.pane("right")?.notifySwitch({ id: "b" });
    await tick();
    for (let i = 0; i < 4; i++) {
      fake.engines[0]?.callbacks.onClose();
    }
    await tick();
    expect(loading.classList.contains("fade")).toBe(false);

    late.reject();
    await tick();

    expect(ctx.shell.pane("right")?.state()).toBe("failed");
    expect(loading.classList.contains("fade")).toBe(true);
  });
});

describe("the controller refuses what it cannot do", () => {
  it("closes nothing while closed, and refuses a bad side or an absent pane", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    const changes = vi.fn();
    split.onChange(changes);

    ctx.notifySwitch({ id: "a" });
    expect(split.close()).toBe(false);
    expect(split.closeSide("left")).toBe(false);
    expect(split.closeSide("right")).toBe(false);
    expect(ctx.shell.select("up" as PaneSide)).toBe(false);
    expect(ctx.shell.select("right")).toBe(false);

    split.open();
    changes.mockClear();
    expect(split.closeSide("left " as PaneSide)).toBe(false);
    expect(split.closeSide(42 as unknown as PaneSide)).toBe(false);
    // The right pane is empty beside a shown left pane.
    expect(ctx.shell.select("right")).toBe(false);
    expect(root.classList.contains("wt-split-open")).toBe(true);
    expect(changes).not.toHaveBeenCalled();
  });

  it("lets selection rest on an empty pane only while no pane shows a tab", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.shell.pane("left")?.clearActiveSession();
    await announced();
    const changes = vi.fn();
    split.onChange(changes);

    expect(ctx.shell.select("right")).toBe(true);

    expect(ctx.shell.selected()).toBe("right");
    expect(split.state().selected).toBe("right");
    expect(root.querySelector(".wt-split-handle")?.getAttribute("data-faces")).toBe("right");
    expect(paneRoots(root)[1]?.classList.contains("wt-pane-selected")).toBe(true);
    expect(paneRoots(root)[1]?.hasAttribute("inert")).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    await announced();
    expect(politeText(root)).toBe("Right terminal selected");

    // A shown pane ends the exception: the empty one is refused again. The new
    // tab fills the first empty pane, the left.
    ctx.notifySwitch({ id: "b" });
    expect(ctx.shell.pane("left")?.session.id).toBe("b");
    expect(ctx.shell.selected()).toBe("left");
    expect(ctx.shell.select("right")).toBe(false);
  });

  it("refuses a ratio that is not a finite share of the row, and any ratio while closed", async () => {
    const root = rootIn();
    const { term } = await mountSplit(root);
    const split = controller(term);
    const changes = vi.fn();
    split.onChange(changes);

    expect(split.setRatio(0.4, true)).toBe(false);
    expect(ratioVar(root)).toBe("");

    split.open();
    changes.mockClear();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      expect(split.setRatio(bad, true)).toBe(false);
      expect(split.setRatio(bad, false)).toBe(false);
    }
    expect(split.setRatio("0.4" as unknown as number, true)).toBe(false);
    expect(ratioVar(root)).toBe("0.5");
    expect(split.state().committedRatio).toBe(0.5);
    expect(changes).not.toHaveBeenCalled();
  });
});

describe("the ratio: the remembered share and the effective one", () => {
  it("commits a share, previews one without committing, and reports both", async () => {
    const root = rootIn();
    const { term } = await mountSplit(root);
    const split = controller(term);
    split.open();
    const changes = vi.fn();
    split.onChange(changes);

    expect(split.setRatio(0.4, true)).toBe(true);
    expect(ratioVar(root)).toBe("0.4");
    expect(split.state()).toMatchObject({ ratio: 0.4, committedRatio: 0.4 });
    expect(changes).toHaveBeenCalledTimes(1);

    // A drag preview follows the pointer past the minimum; the record does not.
    expect(split.setRatio(0.2, false)).toBe(true);
    expect(ratioVar(root)).toBe("0.2");
    expect(split.state()).toMatchObject({ ratio: 0.2, committedRatio: 0.4 });

    expect(split.setRatio(0.45, true)).toBe(true);
    expect(split.state()).toMatchObject({ ratio: 0.45, committedRatio: 0.45 });
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("keeps both panes at the minimum across a resize without rewriting the remembered share", async () => {
    const root = rootIn(1000);
    const { term } = await mountSplit(root);
    const split = controller(term);
    split.open();
    split.setRatio(0.4, true);
    const changes = vi.fn();
    split.onChange(changes);

    root.style.width = "800px";
    await settle();
    expect(ratioVar(root)).toBe(String(360 / 790));
    expect(split.state()).toMatchObject({
      ratio: 360 / 790,
      committedRatio: 0.4,
      collapsed: false,
    });
    expect(changes).toHaveBeenCalled();

    root.style.width = "1000px";
    await settle();
    expect(ratioVar(root)).toBe("0.4");
    expect(split.state().committedRatio).toBe(0.4);

    root.style.width = `${String(MIN_SPLIT_AREA_PX)}px`;
    await settle();
    expect(ratioVar(root)).toBe("0.5");
    expect(split.state()).toMatchObject({ ratio: 0.5, committedRatio: 0.4, collapsed: false });
  });

  it("a committed share under the minimum shows as the minimum and stays remembered", async () => {
    const root = rootIn(1000);
    const { term } = await mountSplit(root);
    const split = controller(term);
    split.open();
    split.setRatio(0.3, true);
    expect(ratioVar(root)).toBe(String(360 / 990));
    expect(split.state()).toMatchObject({ ratio: 360 / 990, committedRatio: 0.3 });
  });

  it("restoreSplit opens at the remembered share, collapsed included, where open() resets it to 0.5", async () => {
    const root = rootIn(1000);
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);

    expect(ctx.shell.restoreSplit(0.3, "left")).toBe(true);
    expect(split.state()).toMatchObject({ open: true, ratio: 360 / 990, committedRatio: 0.3 });
    // Open already: refused, and the share is untouched.
    expect(ctx.shell.restoreSplit(0.4, "left")).toBe(false);
    expect(split.state().committedRatio).toBe(0.3);

    split.close();
    for (const bad of [Number.NaN, -0.1, 1.1, "0.4" as unknown as number]) {
      expect(ctx.shell.restoreSplit(bad, "left")).toBe(false);
      expect(split.isOpen()).toBe(false);
    }
    for (const bad of ["up", 42, null] as unknown as PaneSide[]) {
      expect(ctx.shell.restoreSplit(0.3, bad)).toBe(false);
      expect(split.isOpen()).toBe(false);
    }
    expect(split.open()).toBe(true);
    expect(split.state().committedRatio).toBe(0.5);
    split.close();

    // A narrow row opens collapsed and still remembers the record's share, so the
    // row widening again shows it rather than 0.5.
    root.style.width = "720px";
    await settle();
    expect(ctx.shell.restoreSplit(0.3, "left")).toBe(true);
    expect(split.state()).toMatchObject({ open: true, collapsed: true, committedRatio: 0.3 });
    root.style.width = "1000px";
    await settle();
    expect(split.state()).toMatchObject({ collapsed: false, ratio: 360 / 990 });
  });

  it("restoreSplit opens with the remembered side selected and announces the split state alone, where open() selects the left", async () => {
    const root = rootIn(1000);
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    const selections = vi.fn();
    ctx.shell.onSelectionChange(selections);

    expect(ctx.shell.restoreSplit(0.5, "right")).toBe(true);
    expect(ctx.shell.selected()).toBe("right");
    expect(split.state().selected).toBe("right");
    expect(root.querySelector(".wt-split-handle")?.getAttribute("data-faces")).toBe("right");
    const [left, right] = paneRoots(root);
    expect(left?.classList.contains("wt-pane-selected")).toBe(false);
    expect(right?.classList.contains("wt-pane-selected")).toBe(true);
    expect(selections).not.toHaveBeenCalled();
    await announced();
    expect(politeText(root)).toBe("Split open");
    // The restored side fills first and stays selected once it shows a tab.
    ctx.shell.pane("right")?.notifySwitch({ id: "b" });
    expect(ctx.shell.selected()).toBe("right");
    expect(right?.hasAttribute("inert")).toBe(false);

    split.close();
    expect(split.open()).toBe(true);
    expect(ctx.shell.selected()).toBe("left");
  });

  it("restoreSplit leaves selection on the live pane when the remembered side fails to build, and announces no selection", async () => {
    const root = rootIn(1000);
    const c = clipboard();
    const menu = contextMenu({ clipboard: c });
    const { term, ctx } = await mountSplit(root, { onFatalError: () => true }, () => [c, menu]);
    const selections = vi.fn();
    ctx.shell.onSelectionChange(selections);

    expect(ctx.shell.restoreSplit(0.5, "right")).toBe(true);

    expect(ctx.shell.pane("right")).toBeNull();
    expect(ctx.shell.selected()).toBe("left");
    expect(controller(term).state().selected).toBe("left");
    expect(paneRoots(root)[0]?.classList.contains("wt-pane-selected")).toBe(true);
    expect(selections).not.toHaveBeenCalled();
    await announced();
    expect(politeText(root)).toBe("Split open");
  });
});

describe("the narrow rule", () => {
  it("collapses an open split under the width two panes need and restores it above", async () => {
    const root = rootIn(1000);
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    expect(ctx.shell.selected()).toBe("right");
    const [left, right] = paneRoots(root);
    const changes = vi.fn();
    split.onChange(changes);
    await viewportSettled();
    const resizesPerPane = (): number[] =>
      fake.engines.map((e) => e.connection.sendResize.mock.calls.length);
    const clearResizes = (): void => {
      for (const e of fake.engines) {
        e.connection.sendResize.mockClear();
      }
    };
    clearResizes();

    root.style.width = "720px";
    await settle();
    expect(root.classList.contains("wt-split-collapsed")).toBe(true);
    expect(root.classList.contains("wt-split-open")).toBe(true);
    expect(split.state()).toMatchObject({ open: true, collapsed: true, ratio: 0.5 });
    expect(split.canOpen()).toBe(false);
    // The unselected pane takes no focus and no pointer; the selected one does.
    expect(left?.hasAttribute("inert")).toBe(true);
    expect(right?.hasAttribute("inert")).toBe(false);
    expect(right?.classList.contains("wt-pane-selected")).toBe(true);
    expect(changes).toHaveBeenCalled();
    // A collapsed split refuses a ratio.
    expect(split.setRatio(0.4, true)).toBe(false);
    // Both sockets stay; both panes were told their new size once their boxes settled.
    for (const e of fake.engines) {
      expect(e.connection.forgetSession).not.toHaveBeenCalled();
    }
    await viewportSettled();
    expect(resizesPerPane().every((n) => n >= 1)).toBe(true);
    expect(resizesPerPane()).toHaveLength(2);

    clearResizes();
    root.style.width = "730px";
    await settle();
    expect(root.classList.contains("wt-split-collapsed")).toBe(false);
    expect(split.state().collapsed).toBe(false);
    expect(left?.hasAttribute("inert")).toBe(false);
    await viewportSettled();
    expect(resizesPerPane().every((n) => n >= 1)).toBe(true);
  });

  it("opens collapsed on a row that is too narrow, and a selection change swaps the visible pane", async () => {
    const root = rootIn(720);
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    ctx.notifySwitch({ id: "a" });
    expect(split.canOpen()).toBe(false);

    expect(split.open()).toBe(true);
    expect(split.state()).toMatchObject({ open: true, collapsed: true });
    expect(root.classList.contains("wt-split-collapsed")).toBe(true);

    // The empty hidden pane is still the target: filling it selects it and makes it the visible pane.
    expect(ctx.shell.targetFor("b")).toBe("right");
    ctx.notifySwitch({ id: "b" });
    const [left, right] = paneRoots(root);
    expect(ctx.shell.selected()).toBe("right");
    expect(right?.classList.contains("wt-pane-selected")).toBe(true);
    expect(right?.hasAttribute("inert")).toBe(false);
    expect(left?.hasAttribute("inert")).toBe(true);

    expect(ctx.shell.select("left")).toBe(true);
    expect(left?.hasAttribute("inert")).toBe(false);
    expect(right?.hasAttribute("inert")).toBe(true);
  });

  it("paints wt-narrow on the shell root from the shell root's own size", async () => {
    const root = rootIn(1000, 400);
    await mountSplit(root);
    await settle();
    expect(root.classList.contains("wt-narrow")).toBe(true);
    root.style.height = "800px";
    await settle();
    expect(root.classList.contains("wt-narrow")).toBe(false);
  });
});

describe("selection", () => {
  it("follows a shown pane, announces a change once and never a repeat, and never rests on an empty pane", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    ctx.notifySwitch({ id: "a" });
    split.open();
    await announced();
    const selections = vi.fn();
    ctx.shell.onSelectionChange(selections);

    expect(ctx.shell.select("right")).toBe(false);
    ctx.notifySwitch({ id: "b" });
    expect(ctx.shell.selected()).toBe("right");
    expect(selections).toHaveBeenCalledTimes(1);
    expect(selections).toHaveBeenCalledWith("right");
    await announced();
    expect(politeText(root)).toBe("Right terminal selected");

    expect(ctx.shell.select("right")).toBe(true);
    expect(selections).toHaveBeenCalledTimes(1);

    expect(ctx.shell.select("left")).toBe(true);
    expect(selections).toHaveBeenCalledTimes(2);
    const [left, right] = paneRoots(root);
    expect(left?.classList.contains("wt-pane-selected")).toBe(true);
    expect(right?.classList.contains("wt-pane-selected")).toBe(false);
    expect(split.state().selected).toBe("left");
  });

  it("a switch to a session a pane already shows selects that pane and attaches nothing", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    controller(term).open();
    ctx.notifySwitch({ id: "b" });
    for (const e of fake.engines) {
      e.connection.setSession.mockClear();
    }

    ctx.notifySwitch({ id: "a" });

    expect(ctx.shell.selected()).toBe("left");
    for (const e of fake.engines) {
      expect(e.connection.setSession).not.toHaveBeenCalled();
    }
    expect(ctx.shell.pane("left")?.session.id).toBe("a");
    expect(ctx.shell.pane("right")?.session.id).toBe("b");
  });

  it("the selected pane's title is the document's, and the shell context's send reaches it", async () => {
    const root = rootIn();
    document.title = "Page";
    const { term, ctx } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    controller(term).open();
    ctx.notifySwitch({ id: "b" });
    fake.callbacks().onMessage({ type: "title", title: "right program" } as never);
    expect(document.title).toBe("right program");

    ctx.shell.select("left");
    expect(document.title).toBe("Page");

    // The shell context's send follows selection: the right pane's engine first,
    // the left's after the change, and never both.
    const [leftEngine, rightEngine] = fake.engines;
    ctx.send(new Uint8Array([0x41]));
    expect(leftEngine?.connection.sendBinary.mock.calls).toEqual([[new Uint8Array([0x41])]]);
    expect(rightEngine?.connection.sendBinary).not.toHaveBeenCalled();
    ctx.shell.select("right");
    ctx.send(new Uint8Array([0x42]));
    expect(rightEngine?.connection.sendBinary.mock.calls).toEqual([[new Uint8Array([0x42])]]);
    expect(leftEngine?.connection.sendBinary).toHaveBeenCalledTimes(1);
  });

  it("a pointer press in a pane selects it; focus entering it does too", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    controller(term).open();
    ctx.notifySwitch({ id: "b" });
    const [left, right] = paneRoots(root);

    const ev = new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" });
    left?.querySelector(".term-output")?.dispatchEvent(ev);
    expect(ctx.shell.selected()).toBe("left");
    expect(ev.defaultPrevented).toBe(false);

    right?.querySelector<HTMLElement>(".term-input")?.focus();
    expect(ctx.shell.selected()).toBe("right");
  });

  it("focus landing on a control in a pane's own regions selects that pane", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    controller(term).open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");
    const button = document.createElement("button");
    ctx.shell.pane("right")?.region("bottom-inset-end", "probe").appendChild(button);

    button.focus();

    expect(document.activeElement).toBe(button);
    expect(ctx.shell.selected()).toBe("right");
  });

  it("a pane built at the first open starts from the served title, not from the marked one", async () => {
    const root = rootIn();
    document.title = "Served";
    const { term, ctx } = await mountSplit(root);
    ctx.notifySwitch({ id: "a" });
    ctx.shell.attention({ icons: false }).report({ count: 2, icon: null });
    expect(document.title).toBe("(2) Served");

    controller(term).open();
    ctx.notifySwitch({ id: "b" });

    expect(ctx.shell.selected()).toBe("right");
    expect(document.title).toBe("(2) Served");
  });

  it("a managed pane sends nothing before its first session and nothing once emptied", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    fake.connection.sendBinary.mockClear();

    ctx.send(new Uint8Array([0x41]));
    expect(fake.connection.sendBinary).not.toHaveBeenCalled();

    ctx.notifySwitch({ id: "a" });
    ctx.send(new Uint8Array([0x41]));
    expect(fake.connection.sendBinary).toHaveBeenCalledTimes(1);

    controller(term).open();
    ctx.shell.pane("left")?.clearActiveSession();
    ctx.shell.pane("left")?.send(new Uint8Array([0x41]));
    expect(fake.connection.sendBinary).toHaveBeenCalledTimes(1);
    expect(fake.engines[1]?.connection.sendBinary).not.toHaveBeenCalled();
  });
});

describe("close(): the selected pane fills the view", () => {
  it("empties and hides the other pane, keeps its kernel, and shows it again on the next open", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");
    const [left, right] = paneRoots(root);
    const changes = vi.fn();
    const panes = vi.fn();
    split.onChange(changes);
    ctx.shell.onPanesChange(panes);
    await viewportSettled();
    const [leftEngine, rightEngine] = fake.engines;
    for (const e of fake.engines) {
      e.connection.forgetSession.mockClear();
      e.connection.sendResize.mockClear();
    }

    expect(split.close()).toBe(true);

    // The hidden pane's connection forgets b; the survivor's connection is untouched.
    expect(rightEngine?.connection.forgetSession.mock.calls).toEqual([["b"]]);
    expect(leftEngine?.connection.forgetSession).not.toHaveBeenCalled();
    expect(right?.classList.contains("wt-pane-hidden")).toBe(true);
    expect(right?.hasAttribute("inert")).toBe(true);
    expect(right?.classList.contains("wt-side-right")).toBe(true);
    expect(left?.classList.contains("wt-side-left")).toBe(true);
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
    expect(ctx.shell.pane("right")?.session.id).toBeNull();
    expect(ctx.shell.pane("left")?.session.id).toBe("a");
    expect(root.classList.contains("wt-split-open")).toBe(false);
    expect(ratioVar(root)).toBe("0.5");
    expect(split.state()).toEqual({
      open: false,
      collapsed: false,
      ratio: 0.5,
      committedRatio: 0.5,
      selected: "left",
    });
    expect(leftEngine?.dispose).not.toHaveBeenCalled();
    expect(rightEngine?.dispose).not.toHaveBeenCalled();
    // One resize reaches the survivor, and none the hidden pane.
    expect(leftEngine?.connection.sendResize).toHaveBeenCalledTimes(1);
    expect(rightEngine?.connection.sendResize).not.toHaveBeenCalled();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(panes).toHaveBeenCalledTimes(1);
    await announced();
    expect(politeText(root)).toBe("Split closed");

    expect(split.open()).toBe(true);
    expect(paneRoots(root)[1]).toBe(right);
    expect(right?.classList.contains("wt-pane-hidden")).toBe(false);
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    expect(fake.createTerminalEngine).toHaveBeenCalledTimes(2);
  });

  it("with the right pane selected, its kernel survives as the left pane, first in the DOM", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    const [first, second] = paneRoots(root);
    expect(ctx.shell.selected()).toBe("right");

    expect(split.close()).toBe(true);

    expect(ctx.shell.selected()).toBe("left");
    expect(ctx.shell.pane("left")?.root).toBe(second);
    expect(ctx.shell.pane("left")?.session.id).toBe("b");
    expect(ctx.shell.pane("right")?.root).toBe(first);
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
    expect(paneRoots(root)).toEqual([second, first]);
    expect(second?.classList.contains("wt-side-left")).toBe(true);
    expect(first?.classList.contains("wt-side-right")).toBe(true);
    // The survivor never moved in the DOM; the hidden root did.
    expect(second?.classList.contains("wt-pane-selected")).toBe(true);

    // Reopening gives the same kernel the left side: no session moves.
    for (const e of fake.engines) {
      e.connection.setSession.mockClear();
    }
    expect(split.open()).toBe(true);
    expect(ctx.shell.pane("left")?.session.id).toBe("b");
    expect(ctx.shell.pane("right")?.state()).toBe("empty");
    for (const e of fake.engines) {
      expect(e.connection.setSession).not.toHaveBeenCalled();
    }
  });

  it("moves focus out of the pane about to hide before it goes", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    ctx.shell.select("left");
    const [left, right] = paneRoots(root);
    right?.querySelector<HTMLElement>(".term-input")?.focus();
    expect(ctx.shell.selected()).toBe("right");
    ctx.shell.select("left");

    split.close();

    expect(document.activeElement).toBe(left?.querySelector(".term-input"));
  });

  it("closeSide() closes the named pane whether or not it was selected, and the other fills the view", async () => {
    const root = rootIn();
    const { term, ctx } = await mountSplit(root);
    const split = controller(term);
    ctx.notifySwitch({ id: "a" });
    split.open();
    ctx.notifySwitch({ id: "b" });
    expect(ctx.shell.selected()).toBe("right");
    for (const e of fake.engines) {
      e.connection.forgetSession.mockClear();
    }

    expect(split.closeSide("right")).toBe(true);

    expect(fake.engines[1]?.connection.forgetSession.mock.calls).toEqual([["b"]]);
    expect(fake.engines[0]?.connection.forgetSession).not.toHaveBeenCalled();
    expect(ctx.shell.pane("left")?.session.id).toBe("a");
    expect(ctx.shell.pane("right")?.state()).toBe("hidden");
    expect(split.isOpen()).toBe(false);
    expect(ctx.shell.selected()).toBe("left");
  });
});

describe("the loading overlay over two panes", () => {
  const screenFrame = (): Engine.ServerMessage => ({
    type: "screen",
    rows: [[]],
    base: 0,
    cursor: [0, 0],
    changed: [0],
  });

  it("comes down on the first frame from EITHER pane", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const { term, ctx } = await mountSplit(root, { loading }, () => [], showingOwner("a"));
    await tick();
    expect(loading.classList.contains("fade")).toBe(false);

    controller(term).open();
    ctx.shell.pane("right")?.notifySwitch({ id: "b" });
    await tick();
    expect(loading.classList.contains("fade")).toBe(false);

    fake.engines[1]?.callbacks.onMessage(screenFrame());
    await tick();
    expect(loading.classList.contains("fade")).toBe(true);
  });

  it("stays up while one pane may still connect, and comes down once every built pane has given up", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const { term, ctx } = await mountSplit(root, { loading }, () => [], showingOwner("a"));
    controller(term).open();
    ctx.shell.pane("right")?.notifySwitch({ id: "b" });
    await tick();

    // The kernel gives a socket four failed attempts before the first frame.
    for (let i = 0; i < 4; i++) {
      fake.engines[0]?.callbacks.onClose();
    }
    await tick();
    expect(loading.classList.contains("fade")).toBe(false);

    for (let i = 0; i < 4; i++) {
      fake.engines[1]?.callbacks.onClose();
    }
    await tick();
    expect(loading.classList.contains("fade")).toBe(true);
  });

  it("comes down when the first pane gives up beside an EMPTY second pane, which can never frame", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const { term } = await mountSplit(root, { loading }, () => [], showingOwner("a"));
    controller(term).open();
    await tick();

    for (let i = 0; i < 4; i++) {
      fake.engines[0]?.callbacks.onClose();
    }
    await tick();
    expect(loading.classList.contains("fade")).toBe(true);
  });

  it("comes down when the one pane still connecting is emptied after the other gave up", async () => {
    const root = rootIn();
    const loading = document.createElement("div");
    document.body.appendChild(loading);
    const { term, ctx } = await mountSplit(root, { loading }, () => [], showingOwner("a"));
    controller(term).open();
    ctx.shell.pane("right")?.notifySwitch({ id: "b" });
    await tick();
    for (let i = 0; i < 4; i++) {
      fake.engines[0]?.callbacks.onClose();
    }
    await tick();
    expect(loading.classList.contains("fade")).toBe(false);

    ctx.shell.pane("right")?.clearActiveSession();
    await tick();
    expect(loading.classList.contains("fade")).toBe(true);
  });
});
