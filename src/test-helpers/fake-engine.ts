// Type-only imports from the engine: the suite builds this inside `vi.hoisted`
// and hands the real module over through `bindActual`, because a runtime import
// here would be the very import its `vi.mock` replaces.

import { vi, type Mock } from "vitest";
import type * as Engine from "@cplieger/web-terminal-engine";
import type {
  Connection,
  ConnectionCallbacks,
  DeferredInput,
  LineStore,
  ModeSnapshot,
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
  /** The callbacks as the real engine would invoke them: a `screen`, `scroll`,
   *  `grid` or `modes` frame reaches the renderer spies or the mode state (which
   *  a modes or screen frame makes known) before the kernel's `onMessage`,
   *  and a resume's bounds reach `noteResumeBounds` before `onResumeBounds`. */
  readonly callbacks: ConnectionCallbacks;
  /** Unknown from creation, `connect`, `reconnectNow` and `setSession` (which
   *  also restores power-on values) until a frame, under `holdModes`. */
  readonly modes: ModeState;
  /** `EngineFake.sentInput` for this engine's connection. */
  sentInput(): string[];
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
  /** Until `reset()`, a new engine, `connect` and `setSession` leave the modes
   *  unknown until the test delivers a modes or screen frame, as a server's
   *  round trip does. Otherwise the fake answers at once with power-on modes. */
  holdModes(): void;
  /** Deliver a modes frame (power-on values plus `patch`) to the last engine,
   *  as its server announces a program's modes. */
  announceModes(patch?: Partial<ModeSnapshot>): void;
  /** What the primary connection's `sendBinary` calls put on the wire, in call
   *  order: each input once encoded (body, then tail). As the real connection,
   *  an input waits in its session's queue until that session's modes are
   *  known, a cancel drops a waiting paste, `forgetSession` its queue, and
   *  `restartServer` the input it drops. */
  sentInput(): string[];
  /** The sizes the primary connection put on the wire, oldest first: as the real
   *  one, `sendResize` sends nothing while no socket is open and the consumer's
   *  `computeSize` unless this socket already sent that size, and
   *  `lastAnnouncedSize` answers the newest. */
  announcedSizes(): { cols: number; rows: number }[];
  /** Open a new socket on the primary connection and resume it at once, as the
   *  real one orders it: the consumer's `initialSize` goes on the wire, then
   *  `onOpen` fires, then `onInputReady` when that size was sent. */
  openSocket(): void;
  /** Open a new socket whose resumeAck names a new server process, as the real
   *  connection handles it: the shown session's input, queued or sent since its
   *  last restart, is dropped (the fake's server acks nothing), then
   *  `onServerRestart` fires, then `onInputReady` when a size was sent. */
  restartServer(): void;
  /** Forget the engines built so far (a `beforeEach`). */
  reset(): void;
  /** Hand the real module over, from the `vi.mock` factory's `importActual`. */
  bindActual(actual: typeof Engine): void;
}

type QueuedInput = Uint8Array | DeferredInput;

interface PartsInternal extends EngineParts {
  /** Forget the bound store. */
  resetState(): void;
  /** Whether the engine built from these parts has been disposed. */
  disposed(): boolean;
  /** Take these parts for a new engine; `realMouse` is the controller its
   *  `dispose` releases, when one was built, `modes` the state its connection
   *  marks unknown, and `consumer` the callbacks a reconnect reports to. */
  adopt(realMouse: MouseController | null, modes: ModeState, consumer: ConnectionCallbacks): void;
  /** The socket closed (onClose, onWireIncompatible), before its callback
   *  runs, as the real connection's close handler does. */
  markClosed(): void;
  /** The session ended (onProcessExit): `reconnectNow` refuses until
   *  `connect`, `setSession` or `forgetSession`, as the real connection does. */
  markEnded(): void;
  /** See `EngineFake.announcedSizes`. */
  announcedSizes(): { cols: number; rows: number }[];
  /** See `EngineFake.openSocket`. */
  openSocket(): void;
  /** See `EngineFake.sentInput`. */
  sentInput(): string[];
  /** See `EngineFake.restartServer`. */
  restartServer(): void;
}

const UNMANAGED_ID = "session-under-test";

export function createEngineFake(fakeOpts: EngineFakeOptions = {}): EngineFake {
  let actual: typeof Engine | null = null;
  let holdingModes = false;
  const engines: FakeEngineRecord[] = [];
  const module = (): typeof Engine => {
    if (!actual) {
      throw new Error("fake engine: bindActual() was not called");
    }
    return actual;
  };

  function newParts(): PartsInternal {
    let bound: LineStore | undefined;
    let liveModes: ModeState | null = null;
    let consumer: ConnectionCallbacks | null = null;
    let ended = false;
    // Null after the shown session is forgotten; the next read re-mints the
    // unmanaged id, as the real currentSessionId does.
    let currentId: string | null = UNMANAGED_ID;
    const active = (): string => (currentId ??= UNMANAGED_ID);
    // Connected or connecting: the states in which the real setSession keeps the
    // socket for the same id.
    let attached = false;
    const wireSizes: { cols: number; rows: number }[] = [];
    // Per session, the inputs waiting for that session's modes, every input a
    // restart would drop, and what each input put on the wire once encoded.
    const waiting = new Map<string, QueuedInput[]>();
    const unacked = new Map<string, QueuedInput[]>();
    const wire = new WeakMap<QueuedInput, string>();
    const dec = new TextDecoder();
    const encodeWaiting = (): void => {
      const queue = waiting.get(active());
      if (liveModes?.isKnown() !== true || queue === undefined) {
        return;
      }
      while (queue.length > 0) {
        const input = queue.shift();
        if (input === undefined) {
          break;
        }
        if (input instanceof Uint8Array) {
          wire.set(input, dec.decode(input));
          continue;
        }
        const out = input.encode();
        if (out !== null && out.body.length > 0) {
          wire.set(
            input,
            dec.decode(out.body) + (out.tail === undefined ? "" : dec.decode(out.tail)),
          );
        }
      }
    };
    let socketOpen = false;
    let socketAnnounced = false;
    /** Puts `size` on the socket; true when it is the socket's first. The fake's
     *  socket is always resumed, so its input starts there (`onInputReady`). */
    const putSize = (size: { cols: number; rows: number }): boolean => {
      wireSizes.push({ ...size });
      const first = !socketAnnounced;
      socketAnnounced = true;
      return first;
    };
    /** A new socket's open, then its resumeAck: `onResume` is what that ack
     *  does before the socket's input starts. */
    const openResumed = (onResume: () => void): void => {
      socketOpen = true;
      attached = true;
      socketAnnounced = false;
      const size = consumer?.initialSize?.() ?? null;
      const sized = size !== null && putSize(size);
      consumer?.onOpen?.();
      onResume();
      if (sized) {
        consumer?.onInputReady?.({ ...size });
      }
    };
    const answerModes = (): void => {
      if (!holdingModes) {
        liveModes?.setKnown(true);
      }
    };
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
      applyResumeTransition: vi.fn(() => false),
      noteSolicited: vi.fn(),
      clearSolicited: vi.fn(),
      dropBrowseCache: vi.fn(),
      lastBrowseActivityMs: vi.fn(() => 0),
      browseCacheSize: vi.fn(() => 0),
      replayMaxForResume: vi.fn(() => 1500),
      pendingRowCount: vi.fn(() => 0),
      handleScreen: vi.fn(),
      handleScroll: vi.fn(),
      handleGrid: vi.fn(),
      clearGrid: vi.fn(),
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
      dispose: vi.fn(),
    };
    const scroll: Spied<ScrollController> = {
      noteContentShrink: vi.fn(),
      reconcileScrollRange: vi.fn(),
      stickToBottom: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollByPage: vi.fn(),
      isUserScrolledUp: vi.fn(() => false),
      currentScrollTop: vi.fn(() => 0),
      adjustForContentShift: vi.fn(),
      restoreView: vi.fn(),
      dispose: vi.fn(),
    };
    const connection: Spied<Connection> = {
      sendBinary: vi.fn((input: QueuedInput) => {
        const id = active();
        const queue = waiting.get(id) ?? [];
        waiting.set(id, queue);
        queue.push(input);
        const sent = unacked.get(id) ?? [];
        unacked.set(id, sent);
        sent.push(input);
        encodeWaiting();
        return true;
      }),
      cancelPendingInput: vi.fn(() => {
        const id = active();
        const queue = waiting.get(id) ?? [];
        const kept = queue.filter((i) => i instanceof Uint8Array || i.paste !== true);
        waiting.set(id, kept);
        return kept.length !== queue.length;
      }),
      pendingInputBytes: vi.fn(() => 0),
      holdInput: vi.fn(() => () => undefined),
      sendEphemeral: vi.fn(() => true),
      setClientFocus: vi.fn(),
      sendResize: vi.fn(() => {
        const size = consumer?.computeSize();
        const last = wireSizes.at(-1);
        if (
          !socketOpen ||
          size === undefined ||
          (socketAnnounced && last?.cols === size.cols && last.rows === size.rows)
        ) {
          return;
        }
        if (putSize(size)) {
          consumer?.onInputReady?.({ ...size });
        }
      }),
      lastAnnouncedSize: vi.fn(() => {
        const last = wireSizes.at(-1);
        return last === undefined ? null : { ...last };
      }),
      // The fake's socket is always resumed, so its input starts at its first size.
      inputReady: vi.fn(() => socketOpen && socketAnnounced),
      reconnectNow: vi.fn(() => {
        if (ended) {
          return;
        }
        socketOpen = false;
        attached = true;
        liveModes?.setKnown(false);
        answerModes();
        consumer?.onConnecting?.();
      }),
      setSession: vi.fn((id: string) => {
        ended = false;
        const switched = id !== currentId || !attached;
        if (switched) {
          socketOpen = false;
          attached = true;
        }
        currentId = id;
        liveModes?.setKnown(false);
        liveModes?.applySnapshot(module().POWER_ON_MODES);
        answerModes();
        if (switched) {
          consumer?.onConnecting?.();
        }
      }),
      forgetSession: vi.fn((id: string) => {
        ended = false;
        if (id === currentId) {
          socketOpen = false;
          attached = false;
          currentId = null;
        }
        waiting.delete(id);
        unacked.delete(id);
      }),
      historyBudget: vi.fn(() => 0),
      requestHistory: vi.fn(() => false),
      currentSessionId: vi.fn(() => active()),
      disconnect: vi.fn(() => {
        socketOpen = false;
        attached = false;
      }),
      connect: vi.fn(() => {
        ended = false;
        socketOpen = false;
        attached = true;
        liveModes?.setKnown(false);
        answerModes();
        consumer?.onConnecting?.();
      }),
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
      socketOpen = false;
      attached = false;
    });
    return {
      renderer,
      scroll,
      connection,
      mouse,
      dispose,
      resetState() {
        bound = undefined;
        currentId = UNMANAGED_ID;
        attached = false;
        liveModes = null;
        consumer = null;
        ended = false;
        realMouse = null;
        disposed = true;
        wireSizes.length = 0;
        socketOpen = false;
        socketAnnounced = false;
        waiting.clear();
        unacked.clear();
      },
      disposed: () => disposed,
      adopt(controller, modes, callbacks) {
        realMouse = controller;
        liveModes = modes;
        modes.subscribe(encodeWaiting);
        consumer = callbacks;
        disposed = false;
      },
      markClosed() {
        socketOpen = false;
        attached = false;
      },
      markEnded() {
        ended = true;
        socketOpen = false;
        attached = false;
      },
      announcedSizes: () => wireSizes.map((size) => ({ ...size })),
      restartServer() {
        openResumed(() => {
          const id = active();
          for (const input of unacked.get(id) ?? []) {
            wire.delete(input);
          }
          unacked.delete(id);
          waiting.delete(id);
          consumer?.onServerRestart?.();
        });
      },
      sentInput: () =>
        connection.sendBinary.mock.calls.flatMap(([input]) => {
          const sent = wire.get(input);
          return sent === undefined ? [] : [sent];
        }),
      openSocket() {
        openResumed(() => undefined);
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
    modes.setKnown(!holdingModes);
    const consumer = opts.callbacks;
    const callbacks: ConnectionCallbacks = {
      ...consumer,
      onMessage(msg) {
        if (msg.type === "screen") {
          parts.renderer.handleScreen(msg);
          modes.setKnown(true);
        } else if (msg.type === "scroll") {
          parts.renderer.handleScroll(msg);
        } else if (msg.type === "grid") {
          parts.renderer.handleGrid(msg);
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
          modes.setKnown(true);
        }
        consumer.onMessage(msg);
      },
      onResumeBounds(committed, oldest) {
        parts.renderer.noteResumeBounds(oldest);
        consumer.onResumeBounds?.(committed, oldest);
      },
    };
    callbacks.onClose = () => {
      parts.markClosed();
      consumer.onClose();
    };
    if (consumer.onWireIncompatible !== undefined) {
      const onWireIncompatible = consumer.onWireIncompatible.bind(consumer);
      callbacks.onWireIncompatible = (detail) => {
        parts.markClosed();
        onWireIncompatible(detail);
      };
    }
    if (consumer.onProcessExit !== undefined) {
      const onProcessExit = consumer.onProcessExit.bind(consumer);
      callbacks.onProcessExit = () => {
        parts.markEnded();
        onProcessExit();
      };
    }
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
    parts.adopt(fakeOpts.realMouse ? mouseController : null, modes, consumer);
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
      sentInput: () => parts.sentInput(),
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
    holdModes() {
      holdingModes = true;
    },
    announceModes(patch = {}) {
      last().callbacks.onMessage({ type: "modes", ...module().POWER_ON_MODES, ...patch });
    },
    sentInput: () => primary.sentInput(),
    restartServer() {
      primary.restartServer();
    },
    announcedSizes: () => primary.announcedSizes(),
    openSocket() {
      primary.openSocket();
    },
    reset() {
      holdingModes = false;
      engines.length = 0;
      built.length = 0;
      primary.resetState();
    },
    bindActual(a) {
      actual = a;
    },
  };
}
