// Type-only imports from the engine: the suite builds this inside `vi.hoisted`
// and hands the real module over through `bindActual`, because a runtime import
// here would be the very import its `vi.mock` replaces.

import { vi, type Mock } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type {
  Connection,
  ConnectionCallbacks,
  LineStore,
  ModeState,
  MouseController,
  Renderer,
  ScrollController,
  TerminalEngine,
  TerminalEngineOptions,
} from "@cplieger/web-terminal-engine";

type Spied<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K];
};

/** The collaborators one engine is built from, each a set of spies. */
interface EngineParts {
  readonly renderer: Spied<Renderer>;
  readonly scroll: Spied<ScrollController>;
  readonly connection: Spied<Connection>;
  readonly mouse: Spied<MouseController>;
  /** The engine's own `dispose`. */
  readonly dispose: Mock<() => void>;
}

/** One engine the fake built. */
export interface FakeEngineRecord extends EngineParts {
  readonly engine: TerminalEngine;
  readonly options: TerminalEngineOptions;
  /** The callbacks as the real engine would invoke them: a `screen`, `scroll` or
   *  `modes` frame reaches the renderer spies before the kernel's `onMessage`,
   *  and a resume's bounds reach `noteResumeBounds` before `onResumeBounds`. */
  readonly callbacks: ConnectionCallbacks;
  readonly modes: ModeState;
}

export interface EngineFakeOptions {
  /** Override mode readers on top of a real mode state (`getMouseMode` answering
   *  a tracking mode, say). */
  modes?: Partial<ModeState>;
  /** Build the REAL mouse controller over the engine's renderer and connection
   *  spies, so a pointer event puts real SGR bytes on `sendEphemeral`. */
  realMouse?: boolean;
}

/** The fake. Its own `EngineParts` members are the FIRST engine's (the primary
 *  pane's), adopted by the first build after `reset()`; every later engine has
 *  parts of its own on its `engines` record. */
export interface EngineFake extends EngineParts {
  readonly createTerminalEngine: Mock<(opts: TerminalEngineOptions) => TerminalEngine>;
  /** Every engine built so far, oldest first. */
  readonly engines: FakeEngineRecord[];
  /** The last engine's callbacks; throws when none was built. */
  callbacks(): ConnectionCallbacks;
  /** The last engine's options; throws when none was built. */
  options(): TerminalEngineOptions;
  /** The last engine's mode state. */
  modes(): ModeState;
  /** The last engine. */
  engine(): TerminalEngine;
  /** Forget the engines built so far (a `beforeEach`). */
  reset(): void;
  /** Hand the real module over, from the `vi.mock` factory's `importActual`. */
  bindActual(actual: typeof Engine): void;
}

interface PartsInternal extends EngineParts {
  /** Forget the bound store. */
  resetState(): void;
  /** Whether the engine built from these parts has been disposed. */
  disposed(): boolean;
  /** Take these parts for a new engine; `realMouse` is the controller its
   *  `dispose` releases, when one was built. */
  adopt(realMouse: MouseController | null): void;
}

export function createEngineFake(fakeOpts: EngineFakeOptions = {}): EngineFake {
  let actual: typeof Engine | null = null;
  const engines: FakeEngineRecord[] = [];
  const module = (): typeof Engine => {
    if (!actual) {
      throw new Error("fake engine: bindActual() was not called");
    }
    return actual;
  };

  function newParts(): PartsInternal {
    let bound: LineStore | undefined;
    const store = (): LineStore => {
      bound ??= new (module().LineStore)();
      return bound;
    };
    // Derived from the bound store where the real renderer derives it, so a
    // missing reset or a wrong bind is visible; a constant would hide both. Every
    // default is given to `vi.fn` here, the one form the per-test `mockReset` keeps.
    const renderer: Spied<Renderer> = {
      resetScreen: vi.fn(),
      resetScrollback: vi.fn(() => {
        store().reset();
      }),
      bind: vi.fn((next: LineStore) => {
        bound = next;
      }),
      boundStore: vi.fn(() => store()),
      rebuild: vi.fn(),
      getHighestIndex: vi.fn(() => store().highestIndex()),
      getReplayBoundary: vi.fn(() => -1),
      noteResumeBounds: vi.fn(),
      handleHistoryReply: vi.fn(),
      applyResumeTransition: vi.fn(),
      noteSolicited: vi.fn(),
      clearSolicited: vi.fn(),
      dropBrowseCache: vi.fn(),
      lastBrowseActivityMs: vi.fn(() => 0),
      browseCacheSize: vi.fn(() => 0),
      replayMaxForResume: vi.fn(() => 1500),
      pendingRowCount: vi.fn(() => 0),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      handleScrollPosition: vi.fn(),
      captureViewMemory: vi.fn(() => null),
      pendingRestoreAbs: vi.fn(() => null),
      maybeFetchHistory: vi.fn(),
      updateFontMetrics: vi.fn(),
      computeSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      gridSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getCursorPx: vi.fn(() => ({ left: 0, top: 0, cellH: 16 })),
      cellSize: vi.fn(() => ({ width: 8, height: 17 })),
      setPredictedCursor: vi.fn(),
      updateReverseVideo: vi.fn(),
      dispose: vi.fn(),
    };
    const scroll: Spied<ScrollController> = {
      noteContentShrink: vi.fn(),
      reconcileScrollRange: vi.fn(),
      stickToBottom: vi.fn(),
      scrollToBottom: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      adjustForContentShift: vi.fn(),
      restoreView: vi.fn(),
      dispose: vi.fn(),
    };
    const connection: Spied<Connection> = {
      sendBinary: vi.fn(() => true),
      sendEphemeral: vi.fn(() => true),
      setClientFocus: vi.fn(),
      sendResize: vi.fn(),
      reconnectNow: vi.fn(),
      setSession: vi.fn(),
      forgetSession: vi.fn(),
      adoptPersistedEpoch: vi.fn(),
      historyBudget: vi.fn(() => 0),
      requestHistory: vi.fn(() => false),
      serverEpochOf: vi.fn(() => 0),
      currentSessionId: vi.fn(() => "session-under-test"),
      disconnect: vi.fn(),
      connect: vi.fn(),
      dispose: vi.fn(),
    };
    const mouse: Spied<MouseController> = {
      resyncGesture: vi.fn(),
      disarmGesture: vi.fn(),
      dispose: vi.fn(),
    };
    let realMouse: MouseController | null = null;
    let disposed = true;
    const dispose = vi.fn(() => {
      realMouse?.dispose();
      disposed = true;
    });
    return {
      renderer,
      scroll,
      connection,
      mouse,
      dispose,
      resetState() {
        bound = undefined;
        realMouse = null;
        disposed = true;
      },
      disposed: () => disposed,
      adopt(controller) {
        realMouse = controller;
        disposed = false;
      },
    };
  }
  const primary = newParts();
  const built: PartsInternal[] = [];

  const createTerminalEngine = vi.fn((opts: TerminalEngineOptions): TerminalEngine => {
    const engineModule = module();
    // The primary parts belong to the first engine of the terminal alive now: a
    // terminal mounted after the previous one was destroyed adopts them again.
    const parts = built.every((p) => p.disposed()) ? primary : newParts();
    const realModes = engineModule.createModeState(opts.initialModes);
    const modes: ModeState = { ...realModes, ...fakeOpts.modes };
    const consumer = opts.callbacks;
    const callbacks: ConnectionCallbacks = {
      ...consumer,
      onMessage(msg) {
        if (msg.type === "screen") {
          parts.renderer.handleScreen(msg);
        } else if (msg.type === "scroll") {
          parts.renderer.handleScroll(msg);
        } else if (msg.type === "modes") {
          modes.applySnapshot({
            bracketedPaste: msg.bracketedPaste,
            applicationCursor: msg.applicationCursor,
            mouseSGR: msg.mouseSGR,
            focusReporting: msg.focusReporting,
            mouseMode: msg.mouseMode,
            applicationKeypad: msg.applicationKeypad,
            reverseVideo: msg.reverseVideo,
            mousePixels: msg.mousePixels,
            keyboardFlags: msg.keyboardFlags,
          });
          parts.renderer.updateReverseVideo();
        }
        consumer.onMessage(msg);
      },
      onResumeBounds(committed, oldest) {
        parts.renderer.noteResumeBounds(committed, oldest);
        consumer.onResumeBounds?.(committed, oldest);
      },
    };
    let mouseController: MouseController = parts.mouse;
    if (fakeOpts.realMouse) {
      mouseController = engineModule.createMouseController({
        modes,
        termElement: () => opts.termWrap,
        gridElement: () => opts.output,
        cellSize: () => parts.renderer.cellSize(),
        gridSize: () => parts.renderer.gridSize(),
        sendReport: (data) => parts.connection.sendEphemeral(data),
      });
    }
    parts.adopt(fakeOpts.realMouse ? mouseController : null);
    built.push(parts);
    const engine: TerminalEngine = {
      renderer: parts.renderer,
      scroll: parts.scroll,
      connection: parts.connection,
      mouse: mouseController,
      modes,
      dispose: parts.dispose,
    };
    engines.push({
      engine,
      options: opts,
      callbacks,
      modes,
      renderer: parts.renderer,
      scroll: parts.scroll,
      connection: parts.connection,
      mouse: parts.mouse,
      dispose: parts.dispose,
    });
    return engine;
  });

  const last = (): FakeEngineRecord => {
    const rec = engines[engines.length - 1];
    if (!rec) {
      throw new Error("fake engine: no engine has been built");
    }
    return rec;
  };

  return {
    createTerminalEngine,
    renderer: primary.renderer,
    scroll: primary.scroll,
    connection: primary.connection,
    mouse: primary.mouse,
    dispose: primary.dispose,
    engines,
    callbacks: () => last().callbacks,
    options: () => last().options,
    modes: () => last().modes,
    engine: () => last().engine,
    reset() {
      engines.length = 0;
      built.length = 0;
      primary.resetState();
    },
    bindActual(a) {
      actual = a;
    },
  };
}
