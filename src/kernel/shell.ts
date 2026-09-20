import {
  LineStore,
  connectStatusStream,
  type EventSourceLike,
} from "@cplieger/web-terminal-engine";
import {
  applyTheme,
  buildPane,
  type PaneKernel,
  type PaneServices,
  type StoreRegistry,
} from "./pane.js";
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
import { clampRatio, isNarrow, isPaneSide, MIN_SPLIT_AREA_PX } from "./layout-policy.js";
import { fadeOutOverlay, renderFatalStartupInto } from "./fatal.js";
import { browserAttentionSinks, createAttention, type AttentionSurface } from "./attention.js";
import { createRegions, type Regions } from "./regions.js";
import { createAnnouncer, createTablist, type Announcer, type PaneTablist } from "./a11y.js";
import { createSplitHandle, type SplitHandle } from "./split-handle.js";
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
  TerminalStartupFailure,
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

/** The `split` option as an untyped caller (an inline page script) may spell it. */
function resolveSplitOption(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error("web-terminal-ui: split must be true or false");
  }
  return value;
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A CSS `<time>` (`0.2s`, `200ms`) in milliseconds; 0 for anything else. */
function cssTimeMs(value: string): number {
  const m = /^\s*(\d*\.?\d+)(m?s)\s*$/.exec(value);
  if (m === null) {
    return 0;
  }
  const n = Number(m[1]);
  return m[2] === "s" ? n * 1000 : n;
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
const SESSION_ID_KEYS = ["vterm-session-id", "vterm-session-id:2"] as const;

/** One pane's place in the shell: its root, its kernel once built, and the side
 *  the shell has assigned it. */
interface Slot {
  /** 0 for the pane built with the terminal, 1 for the one the first open builds. */
  readonly index: 0 | 1;
  side: PaneSide;
  readonly root: HTMLElement;
  /** Null before the build and after a build that threw. */
  kernel: PaneKernel | null;
  /** The pane's startup failed and its root is the recovery surface. */
  failed: boolean;
  loadingFailed: boolean;
  baseTitle: string;
  connection: PaneKernel["connection"] | null;
  tablist: PaneTablist | null;
}

type PaneFailure =
  | { readonly phase: "kernel-init"; readonly cause: unknown }
  | { readonly phase: "feature-setup"; readonly feature: string; readonly cause: unknown };

/** A close whose columns are still sliding: the model is closed already and the
 *  display finishes when the transition ends, on the fallback timer, or on
 *  `settle()`. */
interface ClosingTransition {
  /** The ratio the columns slide to: 1 when the left pane survives, 0 when the right does. */
  readonly toward: 0 | 1;
  /** Finish the display now. */
  settle(): void;
  /** Drop the pending finish without running it. */
  abort(): void;
}

/** A shell-scoped feature's registration on every built pane and on every pane
 *  built later, released as one. */
interface PaneRegistration {
  readonly register: (p: PaneKernel) => Unsubscribe;
  readonly offs: Map<PaneKernel, Unsubscribe>;
}

/** Build the terminal in `root`: the shell that owns the document-level facts
 *  (title, loading overlay, status stream, notifier, scrollback keeper, the
 *  shell-scoped features), its panes, and the feature lifecycle. Without the
 *  split option `root` is the one pane's root; with it `root` is the shell root
 *  holding a pane root per pane and the shared chrome. Registers the document;
 *  `destroy()` releases it. Transactional: a throw releases everything acquired
 *  before it, the registration included. */
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
  const splitEnabled = resolveSplitOption(opts.split);
  // Every page service binds to the ROOT's realm, never the importing one, so
  // a terminal in another document owns that document's title and lifecycle.
  const doc = root.ownerDocument;
  const win = windowOf(doc);
  // Read before any pane or attention mark writes the title: a pane built later
  // starts from the served title, not from a title carrying another pane's base
  // and the attention count.
  const servedTitle = doc.title;
  let destroyed = false;
  // A live read for post-await and post-callback checks: a plain variable read is
  // narrowed to always-false by TS CFA, which cannot model destroy() firing
  // during an await or inside a consumer's handler.
  const isDestroyed = (): boolean => destroyed;

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
  if (splitEnabled && owner?.paneLayoutOwner === undefined) {
    throw new Error("web-terminal-ui: split requires the tabs feature (tabs() or a tabbed preset)");
  }
  const managed = owner !== undefined;
  const scrollbackLines = optionalPositiveIntOption(opts.scrollbackLines, "scrollbackLines");
  // The terminal writes each feature object's `api` and resolves `ctx.use` on
  // its identity, so a pane feature object serves one pane only.
  const usedPaneFeatures = new WeakSet<TerminalFeature<unknown>>();
  for (const f of featureList) {
    if (f.scope !== "shell") {
      usedPaneFeatures.add(f);
    }
  }

  liveShells.set(doc, true);
  held.push(() => {
    liveShells.delete(doc);
  });

  const shellRoot = root;
  let shellRegions: Regions | null = null;
  let announcer: Announcer | null = null;
  if (splitEnabled) {
    // Written here AND by each kernel on its pane root: `.wt-root` redeclares
    // every token, so a theme written only here would be reset at the pane.
    applyTheme(shellRoot, opts.theme);
    shellRoot.classList.add(
      "wt-root",
      "wt-split",
      layoutMode === "container" ? "wt-container" : "wt-viewport",
    );
    shellRoot.replaceChildren();
    held.push(() => {
      shellRoot.classList.remove(
        "wt-narrow",
        "wt-split-open",
        "wt-split-collapsed",
        "wt-split-closing",
      );
      shellRoot.style.removeProperty("--wt-split-ratio");
      shellRoot.replaceChildren();
    });
    const regions = createRegions(shellRoot);
    shellRegions = regions;
    held.push(() => {
      regions.destroy();
    });
    const shellAnnouncer = createAnnouncer(shellRoot);
    announcer = shellAnnouncer;
    held.push(() => {
      shellAnnouncer.destroy();
    });
  }
  const paneOpts: CreateTerminalOptions = splitEnabled ? { ...opts, layout: "container" } : opts;

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
  // Only a pane with a live connect can still deliver a first frame; an empty or
  // hidden one never reports failure, so it must not hold the overlay up.
  function settleLoading(): void {
    const pending = slots.some((s) => !s.loadingFailed && s.kernel?.connectionInitiated() === true);
    if (!pending && slots.some((s) => s.loadingFailed)) {
      dismissLoadingOverlay();
    }
  }

  const slots: Slot[] = [];
  const slotAt = (side: PaneSide): Slot | undefined => slots.find((s) => s.side === side);
  const paneAt = (side: PaneSide): PaneKernel | undefined => slotAt(side)?.kernel ?? undefined;
  const builtPanes = (): PaneKernel[] => {
    const out: PaneKernel[] = [];
    for (const side of ["left", "right"] as const) {
      const p = paneAt(side);
      if (p) {
        out.push(p);
      }
    }
    return out;
  };
  const connections = (): PaneKernel["connection"][] =>
    slots.flatMap((s) => (s.connection === null ? [] : [s.connection]));
  let selectedSide: PaneSide = "left";
  const selectionListeners = new Set<(side: PaneSide) => void>();
  const panesListeners = new Set<() => void>();
  let closing: ClosingTransition | null = null;
  held.push(() => {
    closing?.abort();
    closing = null;
  });
  const selectedPane = (): PaneKernel => {
    const p = paneAt(selectedSide) ?? slots[0]?.kernel ?? undefined;
    if (!p) {
      throw new Error("web-terminal-ui: the terminal has no pane");
    }
    return p;
  };
  function paintSide(slot: Slot): void {
    slot.root.classList.toggle("wt-side-left", slot.side === "left");
    slot.root.classList.toggle("wt-side-right", slot.side === "right");
  }
  // The side is the model's at once; its grid column follows when no closing
  // transition holds the columns where they were.
  function setSide(slot: Slot, side: PaneSide): void {
    slot.side = side;
    if (closing === null) {
      paintSide(slot);
    }
  }
  function firePanesChange(): void {
    for (const cb of [...panesListeners]) {
      cb();
    }
  }

  let titleMark = "";
  function paintTitle(): void {
    const next =
      titleMark + (slotAt(selectedSide)?.baseTitle ?? slots[0]?.baseTitle ?? servedTitle);
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
  // The stream opens on the root's window, not the importing page's.
  const eventSourceIn = (url: string): EventSourceLike => {
    const es = new win.EventSource(url);
    return {
      addEventListener: (type, listener) => {
        es.addEventListener(type, listener as EventListener);
      },
      close: () => {
        es.close();
      },
      get readyState() {
        return es.readyState;
      },
    };
  };
  const statusShare = createStatusShare((path, callbacks) =>
    connectStatusStream(path, callbacks, eventSourceIn),
  );
  held.push(() => {
    statusShare.dispose();
  });
  const notifications = createNotifier(browserNotifierEnv(doc));

  let splitOpen = false;
  let collapsed = false;
  let committedRatio = 0.5;
  /** The share a drag is previewing, unclamped so a pane can dip under the
   *  minimum before the release decides between a close and a snap back. */
  let previewRatio: number | null = null;
  const changeListeners = new Set<(state: SplitState) => void>();
  const rowWidth = (): number => shellRoot.clientWidth;
  // Two ratios: a resize must keep both panes at the minimum without rewriting
  // the share the person chose, which the record holds.
  const effectiveRatio = (): number =>
    splitOpen ? (previewRatio ?? clampRatio(committedRatio, rowWidth())) : 0.5;
  const splitState = (): SplitState => ({
    open: splitOpen,
    collapsed,
    ratio: effectiveRatio(),
    committedRatio,
    selected: selectedSide,
  });
  function applyRatioVar(): void {
    shellRoot.style.setProperty("--wt-split-ratio", String(closing?.toward ?? effectiveRatio()));
  }
  /** How long a close slides, from the same token the stylesheet's transition
   *  reads; 0 without `wt-animate`, and the change is then instant. */
  function closingDurationMs(): number {
    if (!shellRoot.classList.contains("wt-animate")) {
      return 0;
    }
    return cssTimeMs(win.getComputedStyle(shellRoot).getPropertyValue("--dur-standard"));
  }
  function beginClosing(toward: 0 | 1, durationMs: number, tail: () => void): void {
    shellRoot.classList.add("wt-split-closing");
    const stop = (): void => {
      win.clearTimeout(timer);
      shellRoot.removeEventListener("transitionend", onEnd);
      closing = null;
    };
    const settle = (): void => {
      stop();
      tail();
    };
    const onEnd = (ev: TransitionEvent): void => {
      if (ev.target === shellRoot && ev.propertyName === "grid-template-columns") {
        settle();
      }
    };
    shellRoot.addEventListener("transitionend", onEnd);
    // An engine that applies a track-list change at once fires no transitionend.
    const timer = win.setTimeout(settle, durationMs);
    closing = { toward, settle, abort: stop };
  }
  function fireSplitChange(): void {
    if (changeListeners.size === 0) {
      return;
    }
    const state = splitState();
    for (const cb of [...changeListeners]) {
      cb(state);
    }
  }
  // Selection never rests on an empty, failed or hidden pane, enforced by `inert`
  // on such a pane root and by the refusal in `select`; an invalid value names no
  // pane. The Tab stop is decided here too, because `inert` alone would leave an
  // empty pane's input reachable on an engine without it.
  function syncFocusReach(slot: Slot): void {
    if (!splitEnabled || slot.kernel === null) {
      return;
    }
    const state = slot.kernel.state();
    slot.root.toggleAttribute(
      "inert",
      state === "empty" ||
        state === "hidden" ||
        (collapsed && state === "shown" && slot.side !== selectedSide),
    );
    slot.kernel.setTabStop(splitOpen && state === "shown");
  }
  function syncSelection(): void {
    for (const slot of slots) {
      if (splitEnabled) {
        const selected = slot.side === selectedSide;
        slot.root.classList.toggle("wt-pane-selected", selected);
        slot.tablist?.setDescription(
          splitOpen
            ? `${slot.side === "left" ? "Left" : "Right"} terminal${selected ? ", selected" : ""}`
            : "",
        );
      }
      syncFocusReach(slot);
    }
  }
  const anyShown = (): boolean => builtPanes().some((p) => p.state() === "shown");
  /** Move selection to `side`, whatever that pane's state: the one transition
   *  every indicator, listener and the record follow. */
  function applySelection(side: PaneSide): void {
    if (side === selectedSide) {
      return;
    }
    selectedSide = side;
    paintTitle();
    syncSelection();
    announcer?.announce(side === "left" ? "Left terminal selected" : "Right terminal selected");
    for (const cb of [...selectionListeners]) {
      cb(side);
    }
    fireSplitChange();
  }
  // While no pane shows a tab (both emptied, a replacement on its way), selection
  // may rest on the empty pane the replacement is headed for, so the handle faces
  // where the new tab will land.
  function select(side: PaneSide): boolean {
    if (!isPaneSide(side)) {
      return false;
    }
    const state = paneAt(side)?.state();
    if (state !== "shown" && !(state === "empty" && !anyShown())) {
      return false;
    }
    applySelection(side);
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
  // A focused element that leaves the layout drops focus to the body, so the
  // survivor takes it first.
  function keepFocusOn(survivor: Slot, leaving: (el: Element) => boolean): void {
    const active = doc.activeElement;
    if (active !== null && leaving(active)) {
      survivor.kernel?.focus();
    }
  }
  // Only the handle and the hidden or new root move: a live pane moved in the
  // DOM would lose focus and scroll state, and an empty hidden one has neither.
  function placeAfter(first: Slot, second: Slot): void {
    first.root.after(...(handle === null ? [] : [handle.element]), second.root);
  }

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
  /** The server epoch a pane knew for a session it forgot while the tab lives on
   *  (a snap, a close of the split): the next pane to show it is seeded from here,
   *  and a save filed after the pane is gone still finds it. */
  const knownEpoch = new Map<string, number>();
  const keeper =
    opts.persistScrollback !== undefined
      ? createScrollbackKeeper(
          opts.persistScrollback,
          scrollbackLines,
          {
            adoptPersistedEpoch(sessionId, epoch) {
              for (const c of connections()) {
                c.adoptPersistedEpoch(sessionId, epoch);
              }
            },
            serverEpochOf(sessionId) {
              for (const c of connections()) {
                const epoch = c.serverEpochOf(sessionId);
                if (epoch !== 0) {
                  return epoch;
                }
              }
              return knownEpoch.get(sessionId) ?? 0;
            },
          },
          win,
        )
      : null;
  held.push(() => {
    keeper?.stop();
    knownStores.clear();
    unverifiedRestores.clear();
    knownEpoch.clear();
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
            ? paneAt(caller)
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
    for (const c of connections()) {
      c.forgetSession(id);
    }
    knownEpoch.delete(id);
    keeper?.forget(id);
  }

  const shellKeydown: ((ev: KeyboardEvent) => boolean)[] = [];
  const errorHandlers = new Set<(feature: string, err: unknown) => void>();
  const paneRegistrations = new Set<PaneRegistration>();
  held.push(() => {
    shellKeydown.length = 0;
    errorHandlers.clear();
    selectionListeners.clear();
    panesListeners.clear();
    changeListeners.clear();
    paneRegistrations.clear();
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
    const reg: PaneRegistration = { register, offs: new Map() };
    for (const p of builtPanes()) {
      reg.offs.set(p, register(p));
    }
    paneRegistrations.add(reg);
    return () => {
      paneRegistrations.delete(reg);
      for (const off of reg.offs.values()) {
        off();
      }
      reg.offs.clear();
    };
  }

  const split: SplitController = splitEnabled
    ? {
        enabled: true,
        state: splitState,
        isOpen: () => splitOpen,
        canOpen: () => !splitOpen && !destroyed && rowWidth() >= MIN_SPLIT_AREA_PX,
        open: openSplit,
        close: closeSplit,
        closeSide,
        setRatio,
        onChange(cb) {
          changeListeners.add(cb);
          return () => changeListeners.delete(cb);
        },
      }
    : disabledSplit();
  const shellContext: ShellContext = {
    root: shellRoot,
    pane: (side) => paneAt(side) ?? null,
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
      for (const slot of slots) {
        if (slot.side !== side) {
          slot.connection?.forgetSession(sessionId);
        }
      }
      knownEpoch.delete(sessionId);
      keeper?.forget(sessionId);
    },
    attention,
    subscribeStatus: (path, callbacks) => statusShare.subscribe(path, callbacks),
    notifications,
    split,
    restoreSplit: (committed, selected) =>
      splitEnabled && isPaneSide(selected) && openSplitAt(committed, selected),
  };
  // One row controller over every pane's tabpanel: a chip names the panel of the
  // pane showing it, or the one a click would fill.
  const rowTablist = createTablist(
    (side) => slotAt(side ?? targetFor())?.tablist ?? slots[0]?.tablist ?? null,
  );
  const handle: SplitHandle | null = splitEnabled ? createSplitHandle(shellContext) : null;
  if (handle !== null) {
    held.push(() => {
      handle.dispose();
    });
  }
  const isHandle = (el: Element): boolean => el === handle?.element;

  function servicesFor(slot: Slot): PaneServices {
    return {
      get side() {
        return slot.side;
      },
      shell: shellContext,
      sessionIdKey: SESSION_ID_KEYS[slot.index],
      managed,
      scrollbackLines,
      narrowProbe: () => isNarrow(shellRoot.clientWidth, slot.root.clientHeight),
      titleBase(text) {
        slot.baseTitle = text;
        paintTitle();
      },
      loading: {
        reason: (message) => {
          loadingStatus.reason(message);
        },
        firstFrame: dismissLoadingOverlay,
        failed() {
          slot.loadingFailed = true;
          settleLoading();
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
      registerTablist(controller) {
        slot.tablist = controller;
      },
      tablist: () => rowTablist,
      onKeydown(ev) {
        for (const h of shellKeydown) {
          if (h(ev)) {
            return true;
          }
        }
        return false;
      },
      onPointerDown() {
        select(slot.side);
      },
      onFocusIn() {
        // An engine without `inert` still delivers focus into an empty pane.
        if (!select(slot.side)) {
          const selected = paneAt(selectedSide);
          if (selected !== undefined && selected !== slot.kernel) {
            selected.focus();
          }
        }
      },
      onSessionChange() {
        syncFocusReach(slot);
        settleLoading();
      },
      noteEpoch(sessionId, epoch) {
        if (epoch !== 0) {
          knownEpoch.set(sessionId, epoch);
        }
      },
      knownEpoch: (sessionId) => knownEpoch.get(sessionId) ?? 0,
      registerConnection(connection) {
        slot.connection = connection;
      },
      stores,
      dropSession,
      reportError,
      onError,
    };
  }
  function newSlot(index: 0 | 1, side: PaneSide, slotRoot: HTMLElement): Slot {
    const slot: Slot = {
      index,
      side,
      root: slotRoot,
      kernel: null,
      failed: false,
      loadingFailed: false,
      baseTitle: servedTitle,
      connection: null,
      tablist: null,
    };
    if (splitEnabled) {
      slotRoot.classList.add("wt-split-pane");
      setSide(slot, side);
    }
    return slot;
  }
  function buildKernel(slot: Slot): PaneKernel {
    const kernel = buildPane(slot.root, paneOpts, servicesFor(slot));
    slot.kernel = kernel;
    held.push(() => {
      kernel.cleanupRuntime();
    });
    for (const reg of paneRegistrations) {
      reg.offs.set(kernel, reg.register(kernel));
    }
    return kernel;
  }
  // A pane leaving the layout with the only shown tab hands it to an empty live
  // survivor through the layout owner, so the terminal still shows one tab.
  function rehomeShownTab(leaving: Slot, survivor: Slot): void {
    const onlyShown = leaving.kernel?.session.id ?? null;
    if (onlyShown !== null && survivor.kernel?.state() === "empty") {
      owner?.paneLayoutOwner?.showIn(survivor.side, onlyShown);
    }
  }
  /** A second pane that fails while the split is closed has no place on screen,
   *  so it is discarded at once and the next open builds a fresh one. When the
   *  close kept the failing pane as the single view, the healthy hidden pane
   *  returns as the selected single view and takes the shown tab first. */
  function discardClosedPane(slot: Slot, survivor: Slot): void {
    closing?.settle();
    if (survivor.kernel?.state() === "hidden") {
      survivor.root.classList.remove("wt-pane-hidden");
      survivor.kernel.setHidden(false);
      setSide(survivor, "left");
      setSide(slot, "right");
      selectedSide = "left";
      rehomeShownTab(slot, survivor);
    }
    keepFocusOn(survivor, (el) => slot.root.contains(el));
    teardownSlot(slot);
    paintTitle();
    syncSelection();
  }
  /** The second pane's startup failure, which a pane feature can deliver after
   *  the pane was shown and selected: the tab must not go down with the kernel,
   *  nor typing keep routing to it. While the split is open the pane's root stays
   *  in the grid as the recovery surface and the terminal keeps running on the
   *  first pane. */
  function failPane(slot: Slot, failure: PaneFailure): void {
    if (destroyed) {
      return;
    }
    slot.failed = true;
    const survivor = slots.find((s) => s !== slot);
    const discarded = !splitOpen && survivor !== undefined;
    if (discarded) {
      discardClosedPane(slot, survivor);
    } else {
      if (survivor !== undefined) {
        rehomeShownTab(slot, survivor);
      }
      slot.kernel?.markFailed();
      slot.kernel?.cleanupRuntime();
      // A build that threw before stamping them still needs the panel's style scope.
      slot.root.classList.add("wt-root", "wt-container");
      slot.root.removeAttribute("inert");
      if (slot.side === selectedSide && survivor !== undefined) {
        applySelection(survivor.side);
      }
    }
    slot.loadingFailed = true;
    settleLoading();
    const surface = discarded ? undefined : slot.root;
    const report: TerminalStartupFailure =
      failure.phase === "kernel-init"
        ? { phase: "kernel-init", cause: failure.cause, surface }
        : { phase: "feature-setup", feature: failure.feature, cause: failure.cause, surface };
    let handled = false;
    try {
      handled = opts.onFatalError?.(report) === true;
    } catch (handlerErr) {
      console.error("web-terminal-ui: onFatalError handler failed", handlerErr);
    }
    // Non-modal: a top-layer dialog would make the tab row inert and the shared
    // split button, this pane's one close path, unreachable.
    if (!handled && !discarded && !isDestroyed()) {
      renderFatalStartupInto(slot.root, { modal: false, idSuffix: "-2" });
    }
    firePanesChange();
  }
  async function setupPaneFeatures(
    slot: Slot,
    features: readonly TerminalFeature<unknown>[],
  ): Promise<void> {
    const kernel = slot.kernel;
    if (kernel === null) {
      return;
    }
    for (const feature of features) {
      if (destroyed || kernel.isDestroyed()) {
        return;
      }
      const outcome = await kernel.setupFeature(feature);
      if (outcome.status === "failed") {
        failPane(slot, { phase: "feature-setup", feature: outcome.feature, cause: outcome.cause });
        return;
      }
      if (outcome.status === "aborted") {
        return;
      }
    }
  }
  function buildSecondary(slot: Slot): void {
    let paneFeatures: TerminalFeature<unknown>[];
    try {
      paneFeatures = resolveFeatures(opts.features).filter((f) => f.scope !== "shell");
      for (const f of paneFeatures) {
        if (usedPaneFeatures.has(f)) {
          throw new Error(
            `web-terminal-ui: features() must return new feature objects for each pane; ${f.name} was already used by another pane`,
          );
        }
      }
      for (const f of paneFeatures) {
        usedPaneFeatures.add(f);
      }
      buildKernel(slot);
    } catch (cause) {
      failPane(slot, { phase: "kernel-init", cause });
      return;
    }
    void setupPaneFeatures(slot, paneFeatures);
  }
  function teardownSlot(slot: Slot): void {
    const kernel = slot.kernel;
    if (kernel !== null) {
      for (const reg of paneRegistrations) {
        reg.offs.get(kernel)?.();
        reg.offs.delete(kernel);
      }
      kernel.destroy();
    }
    slot.root.remove();
    const i = slots.indexOf(slot);
    if (i >= 0) {
      slots.splice(i, 1);
    }
  }

  const primary = newSlot(0, "left", splitEnabled ? doc.createElement("div") : root);
  slots.push(primary);
  if (handle !== null) {
    shellRoot.prepend(primary.root, handle.element);
  }
  const primaryKernel = buildKernel(primary);
  syncSelection();

  function openSplit(): boolean {
    return openSplitAt(0.5, "left");
  }
  function openSplitAt(ratio: number, selected: PaneSide): boolean {
    if (splitOpen || destroyed || !isRatio(ratio)) {
      return false;
    }
    closing?.settle();
    const showing = slotAt("left") ?? primary;
    let other = slots.find((s) => s !== showing);
    if (other === undefined) {
      other = newSlot(1, "right", doc.createElement("div"));
      slots.push(other);
    }
    setSide(showing, "left");
    setSide(other, "right");
    selectedSide = "left";
    placeAfter(showing, other);
    other.root.classList.remove("wt-pane-hidden");
    other.kernel?.setHidden(false);
    splitOpen = true;
    collapsed = rowWidth() < MIN_SPLIT_AREA_PX;
    committedRatio = ratio;
    previewRatio = null;
    shellRoot.classList.add("wt-split-open");
    shellRoot.classList.toggle("wt-split-collapsed", collapsed);
    applyRatioVar();
    if (other.kernel === null && !other.failed) {
      buildSecondary(other);
    }
    // A restored selection is part of the open, not a change to announce; a
    // side whose pane failed to build holds nothing to select.
    if (slotAt(selected)?.failed !== true) {
      selectedSide = selected;
    }
    paintTitle();
    syncSelection();
    for (const p of builtPanes()) {
      p.announceSize();
    }
    announcer?.announce("Split open");
    firePanesChange();
    fireSplitChange();
    return true;
  }
  /** `survivor` fills the view; `leaving` is emptied and hidden, or torn down when
   *  its startup failed so the next open builds a fresh one. The model closes at
   *  once; with `wt-animate` the columns slide first and the display follows. */
  function finishClose(survivor: Slot, leaving: Slot): void {
    keepFocusOn(survivor, (el) => leaving.root.contains(el) || isHandle(el));
    leaving.kernel?.clearActiveSession();
    leaving.kernel?.setHidden(true);
    const durationMs = leaving.failed || collapsed ? 0 : closingDurationMs();
    const tail = (): void => {
      if (leaving.failed) {
        teardownSlot(leaving);
      } else {
        leaving.root.classList.add("wt-pane-hidden");
        placeAfter(survivor, leaving);
      }
      for (const slot of slots) {
        paintSide(slot);
      }
      shellRoot.classList.remove("wt-split-open", "wt-split-closing");
      applyRatioVar();
      survivor.kernel?.announceSize();
    };
    const animated = durationMs > 0;
    if (animated) {
      beginClosing(survivor.side === "left" ? 1 : 0, durationMs, tail);
    }
    setSide(survivor, "left");
    setSide(leaving, "right");
    selectedSide = "left";
    splitOpen = false;
    collapsed = false;
    committedRatio = 0.5;
    previewRatio = null;
    shellRoot.classList.remove("wt-split-collapsed");
    applyRatioVar();
    paintTitle();
    syncSelection();
    if (!animated) {
      tail();
    }
    announcer?.announce("Split closed");
    firePanesChange();
    fireSplitChange();
  }
  function closeSplit(): boolean {
    if (!splitOpen || destroyed) {
      return false;
    }
    const survivor = slotAt(selectedSide) ?? primary;
    const leaving = slots.find((s) => s !== survivor);
    if (leaving === undefined) {
      return false;
    }
    finishClose(survivor, leaving);
    return true;
  }
  function closeSide(side: PaneSide): boolean {
    if (!isPaneSide(side) || !splitOpen || destroyed) {
      return false;
    }
    const squeezed = slotAt(side);
    const survivor = slots.find((s) => s !== squeezed);
    if (squeezed === undefined || survivor === undefined || survivor.failed) {
      return false;
    }
    rehomeShownTab(squeezed, survivor);
    finishClose(survivor, squeezed);
    return true;
  }
  function setRatio(ratio: number, commit: boolean): boolean {
    if (!isRatio(ratio) || !splitOpen || collapsed || destroyed) {
      return false;
    }
    if (commit) {
      committedRatio = ratio;
      previewRatio = null;
    } else {
      previewRatio = ratio;
    }
    applyRatioVar();
    fireSplitChange();
    return true;
  }
  function paintShellNarrow(): void {
    shellRoot.classList.toggle(
      "wt-narrow",
      isNarrow(shellRoot.clientWidth, shellRoot.clientHeight),
    );
  }
  function onShellResize(): void {
    if (destroyed) {
      return;
    }
    paintShellNarrow();
    for (const p of builtPanes()) {
      p.updateNarrow();
    }
    if (!splitOpen) {
      return;
    }
    const wasCollapsed = collapsed;
    collapsed = rowWidth() < MIN_SPLIT_AREA_PX;
    shellRoot.classList.toggle("wt-split-collapsed", collapsed);
    applyRatioVar();
    if (collapsed !== wasCollapsed) {
      const selected = slotAt(selectedSide);
      if (collapsed && selected !== undefined) {
        keepFocusOn(
          selected,
          (el) => isHandle(el) || slots.some((s) => s !== selected && s.root.contains(el)),
        );
      }
      syncSelection();
      // A collapsed pane shares the visible cell, so the one size it sends is
      // the full width it will have if the split closes; a `display: none` pane
      // would send the minimum grid to a live PTY.
      for (const p of builtPanes()) {
        p.announceSize();
      }
    }
    fireSplitChange();
  }
  if (splitEnabled) {
    paintShellNarrow();
    const observer = new win.ResizeObserver(onShellResize);
    observer.observe(shellRoot);
    held.push(() => {
      observer.disconnect();
    });
  }

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
  const shellLayout = (): { narrow: boolean; coarse: boolean } => ({
    narrow: isNarrow(shellRoot.clientWidth, shellRoot.clientHeight),
    coarse: typeof win.matchMedia === "function" && win.matchMedia("(pointer: coarse)").matches,
  });
  /** The context a shell-scoped feature receives: every pane-facing member
   *  resolves the SELECTED pane at call time. */
  function makeShellContext(featureName: string, scope: CleanupScope): TerminalContext {
    const track = (off: Unsubscribe): Unsubscribe => {
      scope.push(off);
      return off;
    };
    return {
      region: (name, slot) =>
        shellRegions === null ? primaryKernel.region(name, slot) : shellRegions.region(name, slot),
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
      tablist: () => rowTablist,
      newLineStore: (sessionId) => stores.newLineStore(sessionId),
      layout: shellLayout,
      notifySwitch(session) {
        // A session is never shown twice: a click on a shown tab selects its pane.
        const showing = builtPanes().find((p) => p.session.id === session.id);
        if (showing !== undefined) {
          select(showing.side);
          return;
        }
        const target = paneAt(targetFor()) ?? primaryKernel;
        target.notifySwitch(session);
        select(target.side);
      },
      dropSession,
      onError: (fn) => track(onError(fn)),
    };
  }

  let rootReleased = false;
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
    primaryKernel.markFailed();
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

  // Features set up in the background; first paint is never gated on them.
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
          : await primaryKernel.setupFeature(feature);
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
          primaryKernel.notifySwitch(resolved);
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
      for (const slot of slots) {
        slot.kernel?.destroy();
      }
      if (splitEnabled) {
        shellRoot.classList.remove("wt-root", "wt-split", "wt-viewport", "wt-container");
      }
    },
    ...(splitEnabled ? { split } : {}),
  };
}
