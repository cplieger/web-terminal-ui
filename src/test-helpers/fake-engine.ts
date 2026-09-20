// A fake `createTerminalEngine` for the kernel-integration suites: every part is
// a set of `vi.fn` spies with the engine's default answers, shared by every engine
// the file builds, so a test asserts on `fake.connection.sendBinary` whichever
// terminal sent. The default implementations are given at construction, which is
// what survives vitest's per-test `mockReset`. Built inside `vi.hoisted` and
// bound to the real module inside the file's `vi.mock` factory, because this
// module must not import the engine itself: that import is the one being mocked.

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

/** One engine the fake built. */
interface FakeEngineRecord {
  readonly engine: TerminalEngine;
  readonly options: TerminalEngineOptions;
  /** The callbacks as the real engine would invoke them: a `screen`, `scroll` or
   *  `modes` frame reaches the renderer spies before the kernel's `onMessage`. */
  readonly callbacks: ConnectionCallbacks;
  readonly modes: ModeState;
}

export interface EngineFakeOptions {
  /** Override mode readers on top of a real mode state (`getMouseMode` answering
   *  a tracking mode, say). */
  modes?: Partial<ModeState>;
  /** Build the REAL mouse controller over the fake's renderer and connection
   *  spies, so a pointer event puts real SGR bytes on `sendEphemeral`. */
  realMouse?: boolean;
}

export interface EngineFake {
  readonly createTerminalEngine: Mock<(opts: TerminalEngineOptions) => TerminalEngine>;
  readonly renderer: Spied<Renderer>;
  readonly scroll: Spied<ScrollController>;
  readonly connection: Spied<Connection>;
  readonly mouse: Spied<MouseController>;
  readonly dispose: Mock<() => void>;
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

export function createEngineFake(fakeOpts: EngineFakeOptions = {}): EngineFake {
  let actual: typeof Engine | null = null;
  const engines: FakeEngineRecord[] = [];
  let bound: LineStore | undefined;
  const store = (): LineStore => {
    if (!actual) {
      throw new Error("fake engine: bindActual() was not called");
    }
    bound ??= new actual.LineStore();
    return bound;
  };

  // Derived from the bound store where the real renderer derives it, so a
  // missing reset or a wrong bind is visible; a constant would hide both.
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
  const dispose = vi.fn();

  const createTerminalEngine = vi.fn((opts: TerminalEngineOptions): TerminalEngine => {
    if (!actual) {
      throw new Error("fake engine: bindActual() was not called");
    }
    const realModes = actual.createModeState(opts.initialModes);
    const modes: ModeState = { ...realModes, ...fakeOpts.modes };
    const consumer = opts.callbacks;
    const callbacks: ConnectionCallbacks = {
      ...consumer,
      onMessage(msg) {
        if (msg.type === "screen") {
          renderer.handleScreen(msg);
        } else if (msg.type === "scroll") {
          renderer.handleScroll(msg);
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
          renderer.updateReverseVideo();
        }
        consumer.onMessage(msg);
      },
    };
    const mouseController: MouseController = fakeOpts.realMouse
      ? actual.createMouseController({
          modes,
          termElement: () => opts.termWrap,
          gridElement: () => opts.output,
          cellSize: () => renderer.cellSize(),
          gridSize: () => renderer.gridSize(),
          sendReport: (data) => connection.sendEphemeral(data),
        })
      : mouse;
    const engine: TerminalEngine = {
      renderer,
      scroll,
      connection,
      mouse: mouseController,
      modes,
      dispose() {
        if (mouseController !== mouse) {
          mouseController.dispose();
        }
        dispose();
      },
    };
    engines.push({ engine, options: opts, callbacks, modes });
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
    renderer,
    scroll,
    connection,
    mouse,
    dispose,
    engines,
    callbacks: () => last().callbacks,
    options: () => last().options,
    modes: () => last().modes,
    engine: () => last().engine,
    reset() {
      engines.length = 0;
      bound = undefined;
    },
    bindActual(a) {
      actual = a;
    },
  };
}
