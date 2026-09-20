// The shell: one object per terminal that owns the page-level facts (the
// document title, the loading overlay, the status stream, the browser notifier,
// the scrollback keeper, the shell-scoped features) and the pane kernels under
// it. Without a split option it has one pane and no element of its own: the
// consumer's root is the pane root, and the shell context resolves every member
// to that pane.

import { LineStore, connectStatusStream } from "@cplieger/web-terminal-engine";
import { buildPane, type PaneKernel, type PaneServices, type StoreRegistry } from "./pane.js";
import { createStatusShare } from "./status-share.js";
import { browserNotifierEnv, createNotifier } from "./notify.js";
import { attachLoadingStatus, DEFAULT_LOADING_MESSAGES } from "./loading-status.js";
import {
  createCleanupScope,
  createFeatureHost,
  type CleanupScope,
  type FeatureSetupOutcome,
} from "./feature-host.js";
import { createScrollbackKeeper } from "./scrollback.js";
import { optionalPositiveIntOption } from "./options.js";
import { isNarrow } from "./layout-policy.js";
import { fadeOutOverlay, renderFatalStartupInto } from "./fatal.js";
import { browserAttentionSinks, createAttention, type AttentionSurface } from "./attention.js";
import { windowOf } from "./realm.js";
import type {
  AttentionOptions,
  AttentionReporter,
  CreateTerminalOptions,
  PaneSide,
  ShellContext,
  SplitController,
  SplitState,
  TerminalContext,
  TerminalEvents,
  TerminalFeature,
  TerminalHandle,
  Unsubscribe,
} from "./types.js";

// The title, the overlay, the status stream and the notification permission are
// the DOCUMENT's, so their owner is one per document; the key IS the document.
const liveShells = new WeakMap<Document, true>();

/** Whether `doc` already holds a terminal that has not been destroyed. */
export function hasLiveShell(doc: Document): boolean {
  return liveShells.has(doc);
}

/** Build the feature list. `features` is a FUNCTION so a preset that throws does
 *  so inside createTerminal's failure boundary. */
function resolveFeatures(
  features: CreateTerminalOptions["features"],
): readonly TerminalFeature<unknown>[] {
  return features === undefined ? [] : features();
}

/** The controller a terminal built without the split option carries. */
function disabledSplit(): SplitController {
  const state: SplitState = {
    open: false,
    collapsed: false,
    ratio: 0.5,
    committedRatio: 0.5,
    selected: "left",
  };
  return {
    enabled: false,
    state: () => state,
    isOpen: () => false,
    canOpen: () => false,
    open: () => false,
    close: () => false,
    closeSide: () => false,
    setRatio: () => false,
    onChange: () => () => undefined,
  };
}

const IMPLICIT_STORE_KEY = "\u0000implicit";

/** Build the terminal in `root`: the shell, its one pane, and the feature
 *  lifecycle. Registers the document; `destroy()` releases it. Transactional:
 *  a throw releases everything acquired before it, the registration included. */
export function createShell(root: HTMLElement, opts: CreateTerminalOptions): TerminalHandle {
  // One list of what the shell holds, drained by the throw path and the destroy
  // path alike, so a half-built shell cannot leak or keep its document claimed.
  const held = createCleanupScope((err) => {
    console.error("web-terminal-ui: release failed during teardown", err);
  });
  try {
    return createShellInto(root, opts, held);
  } catch (err) {
    held.drain();
    throw err;
  }
}

function createShellInto(
  root: HTMLElement,
  opts: CreateTerminalOptions,
  held: CleanupScope,
): TerminalHandle {
  const featureList = resolveFeatures(opts.features);
  const layoutMode = opts.layout ?? "viewport";
  // Every page service binds to the ROOT's realm, never the importing one, so
  // a terminal in another document owns that document's title and lifecycle.
  const doc = root.ownerDocument;
  const win = windowOf(doc);
  let destroyed = false;

  // At most one feature owns the first connect, whichever registration it uses.
  for (const f of featureList) {
    if (f.sessionOwner !== undefined && f.paneLayoutOwner !== undefined) {
      throw new Error(`web-terminal-ui: ${f.name} registers both sessionOwner and paneLayoutOwner`);
    }
  }
  const owners = featureList.filter(
    (f) => f.sessionOwner !== undefined || f.paneLayoutOwner !== undefined,
  );
  if (owners.length > 1) {
    throw new Error(
      `web-terminal-ui: multiple session-owning features: ${owners.map((f) => f.name).join(", ")}`,
    );
  }
  const owner = owners[0];
  const managed = owner !== undefined;
  const scrollbackLines = optionalPositiveIntOption(opts.scrollbackLines, "scrollbackLines");

  liveShells.set(doc, true);
  held.push(() => {
    liveShells.delete(doc);
  });

  // --- Loading overlay ---
  const loadingStatus = attachLoadingStatus(opts.loading, {
    ...DEFAULT_LOADING_MESSAGES,
    ...opts.loadingMessages,
  });
  held.push(() => {
    loadingStatus.stop();
  });
  let overlayDismissed = false;
  function dismissLoadingOverlay(): void {
    loadingStatus.stop();
    if (!opts.loading || overlayDismissed) {
      return;
    }
    overlayDismissed = true;
    fadeOutOverlay(opts.loading);
  }
  const failedPanes = new Set<PaneSide>();

  // --- Title: the attention mark, then the selected pane's base ---
  const baseTitle: Record<PaneSide, string> = { left: doc.title, right: doc.title };
  let titleMark = "";
  function paintTitle(): void {
    const next = titleMark + baseTitle[selectedSide];
    // The title doubles as the browser-tab label and the bookmark name, and this
    // runs on every status sweep, so an unchanged assignment must not churn it.
    if (doc.title !== next) {
      doc.title = next;
    }
  }
  const attentionSurfaces = new Set<AttentionSurface>();
  // The badge is OS-level and the icon links outlive the terminal; the base
  // title belongs to the document.
  held.push(() => {
    for (const surface of attentionSurfaces) {
      surface.dispose();
    }
    attentionSurfaces.clear();
  });
  function attention(options: AttentionOptions): AttentionReporter {
    // A setup still running past destroy() gets a reporter that writes nothing.
    if (destroyed) {
      return { report: () => undefined };
    }
    const surface = createAttention(
      browserAttentionSinks(
        (text) => {
          titleMark = text;
          paintTitle();
        },
        options,
        doc,
      ),
      win,
    );
    attentionSurfaces.add(surface);
    return surface;
  }
  const statusShare = createStatusShare(connectStatusStream);
  held.push(() => {
    statusShare.dispose();
  });
  const notifications = createNotifier(browserNotifierEnv(doc));

  // --- Panes and selection ---
  const panes: Partial<Record<PaneSide, PaneKernel>> = {};
  /** Every built pane's connection, registered before that pane's first connect. */
  const connections = new Map<PaneSide, PaneKernel["connection"]>();
  const builtPanes = (): PaneKernel[] => {
    const out: PaneKernel[] = [];
    for (const side of ["left", "right"] as const) {
      const p = panes[side];
      if (p) {
        out.push(p);
      }
    }
    return out;
  };
  let selectedSide: PaneSide = "left";
  const selectionListeners = new Set<(side: PaneSide) => void>();
  const panesListeners = new Set<() => void>();
  const selectedPane = (): PaneKernel => {
    const p = panes[selectedSide] ?? panes.left;
    if (!p) {
      throw new Error("web-terminal-ui: the terminal has no pane");
    }
    return p;
  };
  // Selection never rests on an empty, failed or hidden pane; an invalid value
  // names no pane and is refused the same way.
  function select(side: PaneSide): boolean {
    if (panes[side]?.state() !== "shown") {
      return false;
    }
    if (side === selectedSide) {
      return true;
    }
    selectedSide = side;
    paintTitle();
    for (const cb of [...selectionListeners]) {
      cb(side);
    }
    return true;
  }
  function targetFor(): PaneSide {
    for (const p of builtPanes()) {
      if (p.state() === "empty") {
        return p.side;
      }
    }
    return selectedSide;
  }

  // --- Stores: the keeper and the registry ---
  /** Every store handed out, held WEAKLY and keyed by session, so a closed tab's
   *  store stays collectable. */
  const knownStores = new Map<string, WeakRef<LineStore>>();
  /** Restored scrollbacks not yet confirmed by a resume for THAT session. */
  const unverifiedRestores = new Set<string>();
  function liveStores(): LineStore[] {
    const out: LineStore[] = [];
    for (const [key, ref] of knownStores) {
      const store = ref.deref();
      if (store === undefined) {
        knownStores.delete(key);
        continue;
      }
      out.push(store);
    }
    return out;
  }
  const keeper =
    opts.persistScrollback !== undefined
      ? createScrollbackKeeper(opts.persistScrollback, scrollbackLines, {
          adoptPersistedEpoch(sessionId, epoch) {
            for (const c of connections.values()) {
              c.adoptPersistedEpoch(sessionId, epoch);
            }
          },
          serverEpochOf(sessionId) {
            for (const c of connections.values()) {
              const epoch = c.serverEpochOf(sessionId);
              if (epoch !== 0) {
                return epoch;
              }
            }
            return 0;
          },
        })
      : null;
  held.push(() => {
    keeper?.stop();
    knownStores.clear();
    unverifiedRestores.clear();
    connections.clear();
  });
  const stores: StoreRegistry = {
    persisting: keeper !== null,
    newLineStore(sessionId) {
      const track = (store: LineStore, key: string): LineStore => {
        knownStores.set(key, new WeakRef(store));
        return store;
      };
      if (keeper !== null) {
        if (sessionId !== undefined) {
          const store = keeper.storeFor(sessionId);
          if (store.highestIndex() >= 0) {
            unverifiedRestores.add(sessionId);
          }
          return track(store, sessionId);
        }
        keeper.noteMissingSessionId();
      }
      return track(new LineStore(scrollbackLines), sessionId ?? IMPLICIT_STORE_KEY);
    },
    implicitStore(sessionId, current) {
      if (keeper === null) {
        return null;
      }
      const restored = keeper.storeFor(sessionId);
      if (restored.highestIndex() >= 0) {
        knownStores.set(sessionId, new WeakRef(restored));
        unverifiedRestores.add(sessionId);
        return restored;
      }
      keeper.track(sessionId, current);
      return null;
    },
    verified(sessionId) {
      unverifiedRestores.delete(sessionId);
    },
    discardUnverified(scope, caller) {
      const ids = scope === "page" ? [...unverifiedRestores] : [scope.session];
      for (const id of ids) {
        if (!unverifiedRestores.delete(id)) {
          continue;
        }
        const store = knownStores.get(id)?.deref();
        const holder =
          store === undefined
            ? panes[caller]
            : builtPanes().find((p) => p.render.boundStore() === store);
        if (holder !== undefined) {
          holder.reset();
          continue;
        }
        store?.reset();
      }
    },
    backgroundStores(bound) {
      return liveStores().filter((store) => store !== bound);
    },
    flush() {
      keeper?.flush();
    },
  };
  function dropSession(id: string): void {
    for (const c of connections.values()) {
      c.forgetSession(id);
    }
    keeper?.forget(id);
  }

  // --- Shell-scoped feature registrations that reach every pane ---
  const shellKeydown: ((ev: KeyboardEvent) => boolean)[] = [];
  const errorHandlers = new Set<(feature: string, err: unknown) => void>();
  held.push(() => {
    shellKeydown.length = 0;
    errorHandlers.clear();
    selectionListeners.clear();
    panesListeners.clear();
  });
  function reportError(feature: string, err: unknown): void {
    if (errorHandlers.size === 0) {
      console.error(`web-terminal-ui: feature "${feature}" error`, err);
      return;
    }
    for (const fn of [...errorHandlers]) {
      try {
        fn(feature, err);
      } catch (handlerErr) {
        // A reporting failure must not turn the feature failure into an
        // unhandled rejection or stop fatal-startup cleanup.
        console.error("web-terminal-ui: feature error handler failed", handlerErr);
      }
    }
  }
  function onError(fn: (feature: string, err: unknown) => void): Unsubscribe {
    errorHandlers.add(fn);
    return () => errorHandlers.delete(fn);
  }
  function onEveryPane(register: (p: PaneKernel) => Unsubscribe): Unsubscribe {
    const offs = builtPanes().map(register);
    return () => {
      for (const off of offs) {
        off();
      }
    };
  }

  const split = disabledSplit();
  const shellContext: ShellContext = {
    root,
    pane: (side) => panes[side] ?? null,
    panes: builtPanes,
    selected: () => selectedSide,
    select,
    onSelectionChange(cb) {
      selectionListeners.add(cb);
      return () => selectionListeners.delete(cb);
    },
    onPanesChange(cb) {
      panesListeners.add(cb);
      return () => panesListeners.delete(cb);
    },
    targetFor,
    dropSessionExcept(sessionId, side) {
      for (const [paneSide, c] of connections) {
        if (paneSide !== side) {
          c.forgetSession(sessionId);
        }
      }
      keeper?.forget(sessionId);
    },
    attention,
    subscribeStatus: (path, callbacks) => statusShare.subscribe(path, callbacks),
    notifications,
    split,
  };

  const services: PaneServices = {
    side: "left",
    shell: shellContext,
    sessionIdKey: "vterm-session-id",
    managed,
    scrollbackLines,
    narrowProbe: () => isNarrow(root.clientWidth, root.clientHeight),
    titleBase(text) {
      baseTitle.left = text;
      paintTitle();
    },
    loading: {
      reason: (message) => {
        loadingStatus.reason(message);
      },
      firstFrame: dismissLoadingOverlay,
      failed() {
        failedPanes.add("left");
        if (builtPanes().every((p) => failedPanes.has(p.side))) {
          dismissLoadingOverlay();
        }
      },
    },
    onSessionEnded() {
      // The host's turn is LAST and a throwing handler cannot take the banner
      // down with it.
      if (opts.onSessionEnded !== undefined) {
        try {
          opts.onSessionEnded();
        } catch (err) {
          console.error("web-terminal-ui: onSessionEnded handler failed", err);
        }
      }
    },
    registerTablist() {
      /* one pane: its own tablist is the shell's */
    },
    onKeydown(ev) {
      for (const h of shellKeydown) {
        if (h(ev)) {
          return true;
        }
      }
      return false;
    },
    onPointerDown() {
      select("left");
    },
    onFocusIn() {
      select("left");
    },
    registerConnection(connection) {
      connections.set("left", connection);
    },
    stores,
    dropSession,
    reportError,
    onError,
  };
  const pane = buildPane(root, opts, services);
  panes.left = pane;
  held.push(() => {
    pane.cleanupRuntime();
  });

  // --- The shell context a shell-scoped feature receives ---
  // Every pane-facing member resolves the SELECTED pane at call time.
  const shellHost = createFeatureHost(reportError);
  held.push(() => {
    shellHost.teardownAll();
  });
  const renderFacade: TerminalContext["render"] = {
    setPredictedCursor: (row, col, active) => {
      selectedPane().render.setPredictedCursor(row, col, active);
    },
    getCursorPx: () => selectedPane().render.getCursorPx(),
    computeSize: () => selectedPane().render.computeSize(),
    bind: (store, o) => {
      selectedPane().render.bind(store, o);
    },
    captureViewMemory: () => selectedPane().render.captureViewMemory(),
    boundStore: () => selectedPane().render.boundStore(),
    getHighestIndex: () => selectedPane().render.getHighestIndex(),
    pendingRowCount: () => selectedPane().render.pendingRowCount(),
  };
  const scrollFacade: TerminalContext["scroll"] = {
    scrollToBottom: () => {
      selectedPane().scroll.scrollToBottom();
    },
    isUserScrolledUp: () => selectedPane().scroll.isUserScrolledUp(),
    currentScrollTop: () => selectedPane().scroll.currentScrollTop(),
    restoreView: (view) => {
      selectedPane().scroll.restoreView(view);
    },
  };
  const modesFacade: TerminalContext["modes"] = {
    isBracketedPaste: () => selectedPane().modes.isBracketedPaste(),
    isApplicationCursor: () => selectedPane().modes.isApplicationCursor(),
    getMouseMode: () => selectedPane().modes.getMouseMode(),
    isMouseSGR: () => selectedPane().modes.isMouseSGR(),
    isMousePixels: () => selectedPane().modes.isMousePixels(),
    isFocusReporting: () => selectedPane().modes.isFocusReporting(),
    isApplicationKeypad: () => selectedPane().modes.isApplicationKeypad(),
    isReverseVideo: () => selectedPane().modes.isReverseVideo(),
    getKeyboardFlags: () => selectedPane().modes.getKeyboardFlags(),
  };
  function makeShellContext(featureName: string, scope: CleanupScope): TerminalContext {
    const track = (off: Unsubscribe): Unsubscribe => {
      scope.push(off);
      return off;
    };
    return {
      region: (name, slot) => pane.region(name, slot),
      surface: () => selectedPane().surface(),
      send: (bytes) => {
        selectedPane().send(bytes);
      },
      paste: (text) => {
        selectedPane().paste(text);
      },
      registerInputTransform: (fn) => track(onEveryPane((p) => p.addInputTransform(fn))),
      registerInputObserver: (fn) => track(onEveryPane((p) => p.addInputObserver(fn))),
      registerKeydown(fn) {
        shellKeydown.push(fn);
        return track(() => {
          const i = shellKeydown.indexOf(fn);
          if (i >= 0) {
            shellKeydown.splice(i, 1);
          }
        });
      },
      render: renderFacade,
      scroll: scrollFacade,
      modes: modesFacade,
      session: {
        get id() {
          return selectedPane().session.id;
        },
        size: () => selectedPane().session.size(),
        highestIndex: () => selectedPane().session.highestIndex(),
      },
      shell: shellContext,
      on: <K extends keyof TerminalEvents>(e: K, fn: (p: TerminalEvents[K]) => void) =>
        track(onEveryPane((p) => p.busOn(featureName, e, fn))),
      defer(release) {
        scope.push(release);
      },
      use<A>(feature: TerminalFeature<A>): A | undefined {
        return shellHost.use(feature) as A | undefined;
      },
      toast: (message, ms) => {
        selectedPane().toast(message, ms);
      },
      announce: (message, politeness) => {
        selectedPane().announce(message, politeness);
      },
      loadingReason: (message) => {
        loadingStatus.reason(message);
      },
      tablist: () => pane.tablist(),
      newLineStore: (sessionId) => stores.newLineStore(sessionId),
      layout: () => pane.layout(),
      notifySwitch(session) {
        const target = panes[targetFor()] ?? pane;
        target.notifySwitch(session);
        select(target.side);
      },
      dropSession,
      onError: (fn) => track(onError(fn)),
    };
  }

  // --- Lifecycle ---
  let rootReleased = false;
  // A live read for post-await checks: a plain variable read is narrowed to
  // always-false by TS CFA, which cannot model destroy() firing during an await.
  const isDestroyed = (): boolean => destroyed;
  function cleanupRuntime(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    // The tracked stores are about to become unreachable, and the connections
    // whose epochs the save is filed under go with the drain.
    keeper?.flush();
    held.drain();
  }

  function enterFatalStartup(feature: string, cause: unknown): void {
    if (destroyed) {
      return;
    }
    pane.markFailed();
    cleanupRuntime();
    dismissLoadingOverlay();
    let handled = false;
    try {
      handled =
        opts.onFatalError?.({ phase: "feature-setup", feature, cause, surface: root }) === true;
    } catch (handlerErr) {
      console.error("web-terminal-ui: onFatalError handler failed", handlerErr);
    }
    // A handler may call destroy() while taking over.
    if (!handled && !rootReleased) {
      renderFatalStartupInto(root, { modal: layoutMode === "viewport" });
    }
  }

  // Features set up in the background; first paint is never gated on them. One
  // pass in the consumer's order: a shell-scoped feature with the shell context,
  // a pane feature with its pane's.
  async function setupAll(): Promise<FeatureSetupOutcome> {
    for (const feature of featureList) {
      if (destroyed) {
        return { status: "aborted" };
      }
      const outcome =
        feature.scope === "shell"
          ? await shellHost.setup(
              feature,
              (scope) => makeShellContext(feature.name, scope),
              () => destroyed,
            )
          : await pane.setupFeature(feature);
      if (outcome.status !== "ready") {
        return outcome;
      }
    }
    return { status: "ready" };
  }

  // Under an owner the shell drives the first connect: a bare connect to the
  // wsPath would open a socket a session-gated server 404s. A null or false
  // resolution means the bootstrap failed; the owner keeps its retry chrome
  // alive and the overlay comes down so it is visible.
  void setupAll().then(async (outcome) => {
    if (outcome.status === "failed") {
      enterFatalStartup(outcome.feature, outcome.cause);
      return;
    }
    if (outcome.status === "aborted" || owner === undefined || isDestroyed()) {
      return;
    }
    let shown = false;
    try {
      if (owner.sessionOwner !== undefined) {
        const resolved = await owner.sessionOwner.resolveInitialSession();
        if (resolved && !isDestroyed()) {
          pane.notifySwitch(resolved);
          shown = true;
        }
      } else if (owner.paneLayoutOwner !== undefined) {
        shown = await owner.paneLayoutOwner.resolveInitialLayout();
      }
    } catch (err) {
      reportError(owner.name, err);
    }
    if (isDestroyed()) {
      return;
    }
    if (!shown && !builtPanes().some((p) => p.connectionInitiated())) {
      dismissLoadingOverlay();
    }
  });

  return {
    focus() {
      selectedPane().focus();
    },
    send(bytes) {
      if (destroyed) {
        return;
      }
      selectedPane().send(bytes);
    },
    reset() {
      if (destroyed) {
        return;
      }
      selectedPane().reset();
    },
    reattach() {
      if (destroyed) {
        return;
      }
      selectedPane().reattach();
    },
    destroy() {
      if (rootReleased) {
        return;
      }
      rootReleased = true;
      cleanupRuntime();
      for (const p of builtPanes()) {
        p.destroy();
      }
    },
  };
}
