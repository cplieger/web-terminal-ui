import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import { mountTerminal } from "../test-helpers/mount.js";
import type {
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
/** Two frames: a fresh pane's ResizeObserver delivers after layout, between them. */
const settle = (): Promise<void> =>
  new Promise((r) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(r, 0));
    });
  });

interface Registration {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject | null;
  readonly signal: AbortSignal | undefined;
  removed: boolean;
}
/** What the code under test acquired from the platform while the ledger ran, and
 *  which of it is still live: a listener not removed and not under an aborted
 *  signal, an observer observing and not disconnected, an interval not cleared,
 *  a timeout neither cleared nor fired, an animation frame neither cancelled nor
 *  delivered. */
interface Ledger {
  liveListeners(): string[];
  liveObservers(): number;
  liveIntervals(): number;
  liveTimeouts(): number;
  liveFrames(): number;
  /** Make the Nth ResizeObserver construction from now throw. */
  failResizeObserver(nth: number): void;
  /** Make the first listener registration matching `when` throw. */
  failListener(when: (target: EventTarget, type: string) => boolean): void;
  close(): void;
}

function openLedger(): Ledger {
  const listeners: Registration[] = [];
  const observers: { observing: boolean; disconnected: boolean }[] = [];
  const intervals = new Set<number>();
  const timeouts = new Set<number>();
  const frames = new Set<number>();
  let failAt = 0;
  let constructed = 0;
  let failWhen: ((target: EventTarget, type: string) => boolean) | null = null;
  const realAdd = EventTarget.prototype.addEventListener;
  const realRemove = EventTarget.prototype.removeEventListener;
  // The test runner installs its own addEventListener on the window, so the
  // window's registrations bypass the prototype and are recorded through it.
  const realWinAdd = window.addEventListener;
  const realWinRemove = window.removeEventListener;
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCaf = window.cancelAnimationFrame.bind(window);
  const RealRO = ResizeObserver;
  const record = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options: boolean | AddEventListenerOptions | undefined,
  ): void => {
    if (failWhen?.(target, type) === true) {
      failWhen = null;
      throw new Error(`${target.constructor.name} refused ${type}`);
    }
    const signal = typeof options === "object" ? options.signal : undefined;
    listeners.push({ target, type, listener, signal, removed: false });
  };
  const markRemoved = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void => {
    for (const r of listeners) {
      if (r.target === target && r.type === type && r.listener === listener) {
        r.removed = true;
      }
    }
  };
  const addSpy = vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
    this: EventTarget,
    type,
    listener,
    options,
  ) {
    record(this, type, listener, options);
    realAdd.call(this, type, listener, options);
  });
  const removeSpy = vi
    .spyOn(EventTarget.prototype, "removeEventListener")
    .mockImplementation(function (this: EventTarget, type, listener, options) {
      markRemoved(this, type, listener);
      realRemove.call(this, type, listener, options);
    });
  const winAddSpy = vi
    .spyOn(window, "addEventListener")
    .mockImplementation((type, listener, options) => {
      record(window, type, listener, options);
      realWinAdd.call(window, type, listener, options);
    });
  const winRemoveSpy = vi
    .spyOn(window, "removeEventListener")
    .mockImplementation((type, listener, options) => {
      markRemoved(window, type, listener);
      realWinRemove.call(window, type, listener, options);
    });
  const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
  ) => {
    const id = realSetInterval(handler, timeout);
    intervals.add(id);
    return id;
  }) as typeof window.setInterval);
  const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation((id) => {
    if (typeof id === "number") {
      intervals.delete(id);
    }
    realClearInterval(id);
  });
  // A timeout that fires is spent, not leaked; only a pending one counts.
  const timeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id: number = realSetTimeout(() => {
      timeouts.delete(id);
      if (typeof handler === "function") {
        handler(...args);
      }
    }, timeout);
    timeouts.add(id);
    return id;
  }) as typeof window.setTimeout);
  const clearTimeoutSpy = vi.spyOn(window, "clearTimeout").mockImplementation((id) => {
    if (typeof id === "number") {
      timeouts.delete(id);
    }
    realClearTimeout(id);
  });
  const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = realRaf((t) => {
      frames.delete(id);
      cb(t);
    });
    frames.add(id);
    return id;
  });
  const cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
    realCaf(id);
  });
  class LedgerRO extends RealRO {
    private readonly record: { observing: boolean; disconnected: boolean };
    constructor(cb: ResizeObserverCallback) {
      constructed += 1;
      if (constructed === failAt) {
        throw new Error("ResizeObserver refused");
      }
      super(cb);
      this.record = { observing: false, disconnected: false };
      observers.push(this.record);
    }
    override observe(target: Element, options?: ResizeObserverOptions): void {
      this.record.observing = true;
      super.observe(target, options);
    }
    override disconnect(): void {
      this.record.disconnected = true;
      super.disconnect();
    }
  }
  vi.stubGlobal("ResizeObserver", LedgerRO);
  return {
    // The recovery panel's own listeners are acquired after the failure and
    // released with the panel, so they are not the rollback's.
    liveListeners: () =>
      listeners
        .filter(
          (r) =>
            !r.removed &&
            r.signal?.aborted !== true &&
            !(r.target instanceof Element && r.target.closest(".wt-fatal") !== null),
        )
        .map((r) => `${r.target.constructor.name}:${r.type}`),
    liveObservers: () => observers.filter((o) => o.observing && !o.disconnected).length,
    liveIntervals: () => intervals.size,
    liveTimeouts: () => timeouts.size,
    liveFrames: () => frames.size,
    failResizeObserver(nth) {
      failAt = constructed + nth;
    },
    failListener(when) {
      failWhen = when;
    },
    close() {
      addSpy.mockRestore();
      removeSpy.mockRestore();
      winAddSpy.mockRestore();
      winRemoveSpy.mockRestore();
      intervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      timeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      rafSpy.mockRestore();
      cafSpy.mockRestore();
      vi.stubGlobal("ResizeObserver", RealRO);
    },
  };
}

let ledger: Ledger | null = null;

beforeEach(() => {
  fake.reset();
  document.body.replaceChildren();
});

afterEach(() => {
  ledger?.close();
  ledger = null;
  vi.unstubAllGlobals();
});

function rootIn(): HTMLElement {
  const root = document.createElement("div");
  root.style.width = "1000px";
  root.style.height = "600px";
  document.body.appendChild(root);
  return root;
}

/** One fault per acquisition class of buildPane, in build order: the narrow
 *  ResizeObserver (before the engine exists); the engine's construction; the
 *  third of the composition's four textarea listeners (the engine and its focus
 *  listeners exist, and the composition must release the two it took); the
 *  type-to-focus document listener (the composition and every input listener
 *  exist); the viewport's window resize listener (its visual-viewport listeners,
 *  observer and settle timer exist); the last wake listener (the viewport, the
 *  font deadline timer and the browse-cache interval exist). */
type Fault =
  | "resize-observer"
  | "engine"
  | "composition-listener"
  | "document-keydown"
  | "viewport-resize"
  | "window-online";
function arm(fault: Fault, ledger: Ledger): void {
  if (fault === "resize-observer") {
    ledger.failResizeObserver(1);
  } else if (fault === "engine") {
    fake.createTerminalEngine.mockImplementationOnce(() => {
      throw new Error("engine refused");
    });
  } else if (fault === "composition-listener") {
    ledger.failListener(
      (target, type) => target instanceof HTMLTextAreaElement && type === "compositionend",
    );
  } else if (fault === "document-keydown") {
    ledger.failListener((target, type) => target === document && type === "keydown");
  } else if (fault === "viewport-resize") {
    ledger.failListener((target, type) => target === window && type === "resize");
  } else {
    ledger.failListener((target, type) => target === window && type === "online");
  }
}
const FAULTS: Fault[] = [
  "resize-observer",
  "engine",
  "composition-listener",
  "document-keydown",
  "viewport-resize",
  "window-online",
];
/** The faults past the engine step, the ones with an engine to dispose. */
const pastEngine = (fault: Fault): number =>
  fault === "resize-observer" || fault === "engine" ? 0 : 1;
/** The polite region the shell announces "Split open" through re-sets on a
 *  timer; once the text has landed, a pending timeout is nobody's but a leak's. */
async function announced(root: HTMLElement, text: string): Promise<void> {
  const region = root.querySelector(':scope > [aria-live="polite"]');
  for (let i = 0; i < 100 && region?.textContent !== text; i++) {
    await tick();
  }
  expect(region?.textContent).toBe(text);
}

describe("kernel-init in the first pane", () => {
  for (const fault of FAULTS) {
    it(`a throw at ${fault} releases everything acquired before it, reports kernel-init on the root, rethrows, and frees the document`, async () => {
      const root = rootIn();
      const seen: TerminalStartupFailure[] = [];
      ledger = openLedger();
      arm(fault, ledger);

      await expect(
        mountTerminal(root, {
          features: () => [],
          onFatalError(failure) {
            seen.push(failure);
            return false;
          },
        }),
      ).rejects.toThrow(/refused/);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.phase).toBe("kernel-init");
      expect(seen[0]?.surface).toBe(root);
      expect(root.querySelector(".wt-fatal")).not.toBeNull();
      expect(ledger.liveListeners()).toEqual([]);
      expect(ledger.liveObservers()).toBe(0);
      expect(ledger.liveIntervals()).toBe(0);
      expect(ledger.liveTimeouts()).toBe(0);
      expect(ledger.liveFrames()).toBe(0);
      expect(fake.dispose).toHaveBeenCalledTimes(pastEngine(fault));

      // The document is free for a new terminal.
      const again = rootIn();
      const term = await mountTerminal(again, { features: () => [] });
      expect(again.querySelector(".term-input")).not.toBeNull();
      term.destroy();
    });
  }
});

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

async function mountSplit(
  root: HTMLElement,
  onFatalError: (f: TerminalStartupFailure) => boolean,
): Promise<{ term: TerminalHandle; ctx: TerminalContext }> {
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
    features: () => [layoutOwner(), probe],
    onFatalError,
  });
  // The first pane's own observers deliver once its box exists; that settle
  // belongs to the healthy terminal, not to the build the ledger watches.
  await settle();
  if (!ctxRef) {
    throw new Error("the probe feature never ran");
  }
  return { term, ctx: ctxRef };
}

describe("kernel-init in the second pane", () => {
  for (const fault of FAULTS) {
    it(`a throw at ${fault} leaves the second pane's root as the recovery surface with nothing acquired, and the split button discards it`, async () => {
      const root = rootIn();
      const seen: TerminalStartupFailure[] = [];
      const { term, ctx } = await mountSplit(root, (f) => {
        seen.push(f);
        return false;
      });
      ctx.notifySwitch({ id: "a" });
      const primaryEngine = fake.engines[0];
      const enginesBefore = fake.createTerminalEngine.mock.calls.length;
      ledger = openLedger();
      arm(fault, ledger);

      expect(term.split?.open()).toBe(true);
      await announced(root, "Split open");

      const right = root.querySelector<HTMLElement>(":scope > .wt-split-pane.wt-side-right");
      expect(right).not.toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.phase).toBe("kernel-init");
      expect(seen[0]?.surface).toBe(right);
      expect(right?.isConnected).toBe(true);
      expect(ctx.shell.pane("right")).toBeNull();
      const panel = right?.querySelector<HTMLDialogElement>("dialog.wt-fatal");
      expect(panel?.open).toBe(true);
      expect(panel?.matches(":modal")).toBe(false);
      expect(right?.querySelector("#wt-fatal-title-2")).not.toBeNull();
      expect(right?.querySelectorAll("button")).toHaveLength(1);
      // Nothing the failed build acquired survives; the shell's own observer on
      // its root and the handle's listeners predate the ledger.
      expect(ledger.liveListeners()).toEqual([]);
      expect(ledger.liveObservers()).toBe(0);
      expect(ledger.liveIntervals()).toBe(0);
      expect(ledger.liveTimeouts()).toBe(0);
      expect(ledger.liveFrames()).toBe(0);
      // The second pane's engine, when the fault came after it, is disposed once;
      // the first pane's never.
      const secondaryEngine = fake.engines[enginesBefore];
      expect(fake.engines).toHaveLength(enginesBefore + pastEngine(fault));
      expect(secondaryEngine?.dispose.mock.calls.length ?? 0).toBe(pastEngine(fault));
      expect(primaryEngine?.dispose).not.toHaveBeenCalled();
      // The first pane runs on.
      expect(ctx.shell.pane("left")?.state()).toBe("shown");
      expect(root.querySelector(".wt-side-left .term-input")).not.toBeNull();

      // The shared close discards the failed kernel; the next open builds afresh.
      expect(term.split?.close()).toBe(true);
      expect(right?.isConnected).toBe(false);
      expect(secondaryEngine?.dispose.mock.calls.length ?? 0).toBe(pastEngine(fault));
      expect(primaryEngine?.dispose).not.toHaveBeenCalled();
      ledger.close();
      ledger = null;
      expect(term.split?.open()).toBe(true);
      await tick();
      expect(fake.createTerminalEngine.mock.calls.length).toBe(
        enginesBefore + (fault === "resize-observer" ? 1 : 2),
      );
      expect(ctx.shell.pane("right")?.state()).toBe("empty");
    });
  }
});
