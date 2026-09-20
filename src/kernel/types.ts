// The kernel/feature contract.
//
// A terminal is a small always-present kernel plus opt-in feature modules. This
// module is the typed spine both sides hang off: the feature interface, the
// context the kernel hands each feature, the typed event bus payloads, and the
// layout-region vocabulary. It is fully typed (no `any`, no stringly-typed
// capability lookup) so a feature's public API is held by reference and a peer
// reads it through a typed token.

import type { LoadingMessages } from "./loading-status.js";
import type {
  ScreenMessage,
  ModesMessage,
  ModeState,
  LineStore,
  StatusStreamCallbacks,
  StoreSnapshot,
  ViewMemory,
} from "@cplieger/web-terminal-engine";

/** Cancels a subscription or registration. Idempotent by convention. */
export type Unsubscribe = () => void;

// --- Layout regions ---

/** The named layout regions the kernel owns. A feature mounts its chrome into
 *  one of these; the region owns position, spacing, stack direction, z-order,
 *  and the keyboard-inset lift. */
export type RegionName =
  | "top-bar" // desktop tab strip
  | "bottom-inset-end" // thumb-zone control stack (keys, scroll-to-bottom), lifts above the keyboard
  | "bottom-switcher" // mobile tab switcher, lifted above the keyboard
  | "overlay" // viewport-clamped non-modal popovers (context menu)
  | "sheet" // modal bottom sheet (tab overview): focus-trapped, scrim
  | "banner"; // connection status + toasts, one shared stacking context

/** A named ordering slot within a region, so features compose in a defined
 *  order instead of guessing z-indices. DOM order within a region always equals
 *  visual order (WCAG 2.4.3). */
export type RegionSlot = string;

// --- Session references ---

/** A reference to a session, carried on switch events and onSwitch. */
export interface SessionRef {
  readonly id: string;
}

/** Read-only view of the active session for features (active id, size, resume
 *  bounds). Features never touch the raw connection/outbox/resume layer. */
export interface SessionView {
  /** Active session id, or null in the unmanaged single-terminal case. */
  readonly id: string | null;
  /** Current terminal size in cells. */
  size(): { cols: number; rows: number };
  /** Highest absolute line index the active store holds (-1 if empty). */
  highestIndex(): number;
}

// --- Connection state (mirrors the kernel's connection-state machine) ---

/** Connection state the kernel owns and broadcasts on `connection:state`. */
export type ConnState =
  | "open"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "restarted"
  // The active session's process has EXITED (the engine's definitive 4001
  // close): not a connectivity problem, so no reconnect is coming. Cleared
  // only by connecting somewhere live (a tab switch / a new session).
  | "ended"
  // The engine refused an explicitly incompatible wire revision. This is a
  // terminal state, not a transient disconnect; page reload/update is required.
  | "incompatible"
  // The pane holds no session (its shown tab left while the terminal stays up):
  // nothing is connecting, so there is nothing to show. Left by the next attach.
  | "idle";

// --- Engine drive handles ---
// The subset of the engine's renderer and scroll controller features may drive;
// the kernel assigns the real instances, so drift is caught there. The connection
// is NOT exposed: features send only through the sanitizing funnel.

/** The render methods features may drive. */
export interface RenderHandle {
  setPredictedCursor(row: number, col: number, active: boolean): void;
  getCursorPx(): { left: number; top: number; cellH: number };
  computeSize(): { cols: number; rows: number };
  /** Point the renderer at a store and rebuild from it (tabs, on switch).
   *  `opts.view` is the per-view scroll memory captureViewMemory() returned when
   *  this store was last active, and passing it makes the swap ATOMIC: the
   *  follow half is adopted synchronously (so the first flush's bottom pin is
   *  gated on the INCOMING view, not the outgoing one) and the position half is
   *  re-asserted across the rebuild's frames until the row it names is built.
   *  Omitting it keeps the pre-3.8 behavior. */
  bind(store: LineStore, opts?: { view?: ViewMemory | null }): void;
  /** Capture the current view as per-view scroll memory: the absolute LINE at
   *  the viewport top plus its on-screen offset, not a pixel scrollTop. Null
   *  when there is nothing to remember (no content rows, or the alternate
   *  screen is active). Pairs with bind's `opts.view`. */
  captureViewMemory(): ViewMemory | null;
  /** The store the renderer is currently bound to. */
  boundStore(): LineStore;
  /** Highest absolute line index the active store holds (-1 if empty). */
  getHighestIndex(): number;
  /** Rows queued for a DOM (re)build but not yet built: non-zero means the
   *  surface is still materializing content the store already holds. Reaches
   *  zero between a replay's chunks, so it is a "this frame's backlog is
   *  drained" signal, not "the restore finished arriving" — pair it with the
   *  resume bounds for the latter. */
  pendingRowCount(): number;
}

/** The scroll methods features may drive. */
export interface ScrollHandle {
  scrollToBottom(): void;
  isUserScrolledUp(): boolean;
  /** The viewport's current scroll offset — the read half of per-tab scroll
   *  memory. The engine's scroll controller owns the container's scrollTop;
   *  features go through this seam, never the DOM element (engine >= v3). */
  currentScrollTop(): number;
  /** Restore an offset AND its follow state together, the only way to express
   *  "holding at the bottom" (a content shrink clamps a scrolled-up reader there
   *  without engaging follow, so position alone cannot say it). NOT the per-view
   *  scroll-memory API: this is a PIXEL offset, so a rebuild clamps it and a tab
   *  whose content grew while backgrounded lands on a different line;
   *  `render.bind(store, { view })` with `render.captureViewMemory()` is what a
   *  consumer wants, and the engine calls this from that path. Declared because
   *  it is part of the engine's scroll surface. */
  restoreView(view: { top: number; following: boolean }): void;
}

/** The engine's mode-state readers a feature may consult (never write): the
 *  connection writes them from the server's modes frames. */
export type ModeReaders = Pick<
  ModeState,
  | "isBracketedPaste"
  | "isApplicationCursor"
  | "getMouseMode"
  | "isMouseSGR"
  | "isMousePixels"
  | "isFocusReporting"
  | "isApplicationKeypad"
  | "isReverseVideo"
  | "getKeyboardFlags"
>;

// --- The shell: panes and the split ---

/** One of the two display panes a terminal can show. */
export type PaneSide = "left" | "right";

/** A pane kernel as the shell and a shell-scoped feature see it. */
export interface PaneHandle {
  /** Left while the split is closed; both sides are assigned at every open. */
  readonly side: PaneSide;
  /** The pane root. */
  readonly root: HTMLElement;
  /** This pane's `.term`. */
  surface(): HTMLElement;
  readonly render: RenderHandle;
  readonly scroll: ScrollHandle;
  readonly modes: ModeReaders;
  /** This pane's active session, or none. */
  readonly session: SessionView;
  /** `shown` has an active session; `hidden` is the pane a closed split hides. */
  state(): "shown" | "empty" | "failed" | "hidden";
  /** This pane's regions. */
  region(name: RegionName, slot?: RegionSlot): HTMLElement;
  on<K extends keyof TerminalEvents>(
    event: K,
    cb: (payload: TerminalEvents[K]) => void,
  ): Unsubscribe;
  /** Show a session here. */
  notifySwitch(session: SessionRef): void;
  /** Make this pane empty: detach the shown session, forget it on this pane's
   *  connection (which closes its socket), clear the screen and go `idle`, so no
   *  wake handler reconnects a pane that holds no session. Idempotent. */
  clearActiveSession(): void;
  /** `sendResize()` when the pane is measurable. */
  announceSize(): void;
  focus(): void;
  send(bytes: Uint8Array): void;
}

/** The split view's state. */
export interface SplitState {
  readonly open: boolean;
  /** Open, but the pane row is under the width two panes need, so one is shown. */
  readonly collapsed: boolean;
  /** The EFFECTIVE left share of the pane row, 0 to 1. */
  readonly ratio: number;
  /** The remembered share the layout record holds. */
  readonly committedRatio: number;
  readonly selected: PaneSide;
}

/** Opens, closes and resizes the two-pane split. On a terminal built without the
 *  split option `enabled` is false and every mutator returns false. */
export interface SplitController {
  readonly enabled: boolean;
  state(): SplitState;
  isOpen(): boolean;
  /** Enabled, closed, and the pane row is wide enough for two panes. */
  canOpen(): boolean;
  /** True when the split is now open; false when nothing changed. */
  open(): boolean;
  /** The selected pane fills the view; false when nothing changed. */
  close(): boolean;
  /** Close one side; the other pane fills the view. */
  closeSide(side: PaneSide): boolean;
  /** Set the left share; `commit` writes the record. False when refused. */
  setRatio(ratio: number, commit: boolean): boolean;
  onChange(cb: (state: SplitState) => void): Unsubscribe;
}

// --- Page attention: the surfaces outside the terminal's own chrome ---

/** How the page's attention surfaces are bound. */
export interface AttentionOptions {
  /** Swap every `link[rel~="icon"]` href to the reported variant: the `favicon`
   *  token of the filename gains `-<icon>` (`/favicon.svg` becomes
   *  `/favicon-input.svg`, `/favicon-32x32.png` becomes `/favicon-input-32x32.png`),
   *  so the consumer serves one file per variant it reports; a link whose filename
   *  does not start with `favicon` is left alone. Off by default because the
   *  variants are the consumer's own assets. */
  readonly icons: boolean;
}

/** What wants the user across the page, as one feature reports it. */
export interface AttentionState {
  /** How many sessions want the user: the document title's `(N) ` prefix and the
   *  installed app's badge number. 0 clears both. */
  readonly count: number;
  /** The icon variant for the most pressing of them, or null for the page's own
   *  icon. Applied only under `AttentionOptions.icons`. */
  readonly icon: string | null;
}

/** Renders an attention state onto the document. */
export interface AttentionReporter {
  /** Render `state`. Idempotent: a state equal to the last one reported touches
   *  nothing, so a status sweep may call it every tick. */
  report(state: AttentionState): void;
}

// --- Browser notifications: the page's one notifier ---

/** The notification a session status event carries (OSC 9 `<message>`). Both
 *  members are optional: an older server, or a status with no notification,
 *  omits them. */
export interface NotificationEvent {
  readonly id: string;
  readonly notification?: string | undefined;
  readonly notificationSeq?: number | undefined;
}

/** What the reporting feature knows about the session at delivery time. */
export interface NotificationView {
  /** The session's tab is on screen. Folded with page visibility: a notification
   *  is suppressed ONLY when the user is already looking at its terminal. */
  readonly sessionIsActive: boolean;
  /** The notification's title. */
  readonly label: string;
  /** Show the session in the page; run when the user clicks the notification. */
  readonly activate: () => void;
}

/** The page's browser notifier. One per terminal, so one permission prompt per
 *  page whichever feature reports the gesture. The notification text is UNTRUSTED
 *  program output and reaches the browser's own surface as data, never the DOM. */
export interface Notifier {
  /** Deliver one status event's notification, if it carries a new one. True when
   *  a browser notification was posted; false for every degraded path (no
   *  notification in the event, a repeat, suppression, no API, no permission, a
   *  throwing constructor). */
  deliver(ev: NotificationEvent, view: NotificationView): boolean;
  /** Note that this page has a session capable of notifying, which is what makes
   *  a permission prompt worth raising at all. */
  arm(): void;
  /** Note a user gesture: the ONLY moment a permission prompt may be raised. */
  gesture(): void;
  /** Drop a closed session's dedupe state. */
  forget(id: string): void;
}

/** The shell a feature reaches through `ctx.shell`: the pane kernels and the
 *  facts shared between them. */
export interface ShellContext {
  /** The shell root; the pane root in the direct-root topology. */
  readonly root: HTMLElement;
  /** Null while that side has no built kernel. */
  pane(side: PaneSide): PaneHandle | null;
  /** Built panes, left first. */
  panes(): readonly PaneHandle[];
  selected(): PaneSide;
  /** False for an invalid value and for an empty, failed, hidden or absent pane. */
  select(side: PaneSide): boolean;
  onSelectionChange(cb: (side: PaneSide) => void): Unsubscribe;
  /** A pane built, hidden, shown or torn down. */
  onPanesChange(cb: () => void): Unsubscribe;
  /** Where a click on `sessionId`'s tab would show it: the first empty pane, left
   *  then right, else the selected pane. */
  targetFor(sessionId: string): PaneSide;
  /** The second half of closing a shown tab: `forgetSession(sessionId)` on every
   *  built pane's connection other than `side` (whose own `clearActiveSession()`
   *  already did it), and the scrollback keeper's forget. */
  dropSessionExcept(sessionId: string, side: PaneSide): void;
  /** Bind the page's attention surfaces (the document-title prefix, the app
   *  badge, the icon links) and get the reporter that drives them. The terminal
   *  is the only writer of `document.title`: a program's OSC 0/2 title replaces
   *  the base and keeps the prefix. The surfaces are restored when the page hides
   *  and on destroy, and repainted on a back-forward cache restore. Keep the
   *  report an AGGREGATE, since a page has one title over many sessions. */
  attention(opts: AttentionOptions): AttentionReporter;
  /** Subscribe to the server's session status stream at `path`. The terminal
   *  holds ONE stream per path for the page and fans it out, because the server
   *  caps its stream subscribers; the first subscriber opens it and the last
   *  one's unsubscribe closes it, as does destroy. A subscriber joining a stream
   *  that has already opened has its `onOpen` called at once, since the stream
   *  carries only future changes and the open is what a consumer resyncs on. */
  subscribeStatus(path: string, callbacks: StatusStreamCallbacks): Unsubscribe;
  /** The page's one browser notifier. A feature reports the events it sees
   *  through `deliver`, a notification-capable session through `arm` and a user
   *  gesture through `gesture`; the terminal decides whether to post and when to
   *  ask for permission. */
  readonly notifications: Notifier;
  readonly split: SplitController;
}

// --- Typed event bus payloads ---

/** The inbound-wire + lifecycle events features can subscribe to via ctx.on.
 *  No `unknown`: each event carries a typed payload. */
export interface TerminalEvents {
  /** A tab switch completed; the payload is the newly-active session. */
  "session:switch": SessionRef;
  /** The kernel's connection state changed. */
  "connection:state": ConnState;
  /** A session's process exited (from the status SSE; reaches background tabs). */
  "session:exited": { session: string };
  /** An OSC title change for a session. */
  "wire:title": { session: string; title: string };
  /** Inbound OSC 52 clipboard content. */
  "wire:clipboard": string;
  /** A modes frame (mouse-mode gating, reverse video). */
  "wire:modes": ModesMessage;
  /** A screen frame (first-paint / activity hooks). */
  "wire:screen": ScreenMessage;
  /** The user scrolled away from / back to the bottom (drives the
   *  scroll-to-bottom affordance). */
  "scroll:state": { scrolledUp: boolean };
  /** The rendered cursor position settled after a flush, so an overlay (the
   *  predicted cursor) can re-position against fresh row geometry. Payload-less. */
  "render:cursor": undefined;
}

// --- Accessibility primitives (kernel-owned, single source) ---

/** Controls the ARIA tablist/tabpanel seam on the kernel's output surface. The
 *  kernel owns the tabpanel (its output surface); `tabs` registers each tab
 *  button through this so it never crosses into kernel-owned DOM. */
export interface TablistController {
  /** The output surface's element id, for a tab's aria-controls. */
  panelId(): string;
  /** Register a tab button: sets role=tab + aria-controls on it and returns a
   *  handle to update its selected state and label, or remove it. */
  registerTab(tab: HTMLElement): TabHandle;
}

/** Handle to one registered tab's ARIA state. */
export interface TabHandle {
  /** Mark this tab selected; the kernel points the panel's aria-labelledby at it. */
  setSelected(selected: boolean): void;
  /** Set the accessible label (used for aria-labelledby on the panel). */
  setLabel(text: string): void;
  /** Enter or leave inline-edit mode. ARIA marks a tab's children presentational,
   *  so a textbox inside a `role="tab"` may get no accessibility-tree node; the
   *  chip drops the tab semantics for the duration and takes `selected` AS OF
   *  NOW on the way back, since the active tab can change while an edit is open
   *  on another chip. */
  setEditing(editing: boolean, selected: boolean): void;
  /** Deregister this tab. */
  remove(): void;
}

// --- The context handed to each feature's setup ---

/** Everything a feature is given at setup: the only surface a feature uses to
 *  affect the terminal. */
export interface TerminalContext {
  /** Mount chrome into a named kernel region; DOM order in a region equals
   *  visual order. Returns a live element the feature appends into. */
  region(name: RegionName, slot?: RegionSlot): HTMLElement;
  /** The terminal scroll surface, for surface-level gestures and for scoping a
   *  selection to the output. Read-only use; features own only their region
   *  chrome. */
  surface(): HTMLElement;

  /** The single sanitizing, session-routed input path: bracket, strip control
   *  bytes, normalize NBSP, apply the col-0 backspace brake. Features never
   *  touch the raw socket. */
  send(bytes: Uint8Array): void;
  /** Paste text through the sanitizing funnel (bracketed-paste + newline
   *  normalization). */
  paste(text: string): void;
  /** Register an outbound-byte transform (e.g. mobileToolbar sticky-Ctrl). The
   *  kernel composes transforms in registration order around send; a transform
   *  returning an empty array drops the input (e.g. the col-0 backspace brake). */
  registerInputTransform(fn: (bytes: Uint8Array) => Uint8Array): Unsubscribe;
  /** Observe accepted outbound bytes (e.g. predictiveEcho advances its cursor). */
  registerInputObserver(fn: (bytes: Uint8Array) => void): Unsubscribe;
  /** Register a keydown handler that runs before the kernel's default key
   *  mapping. Return true to consume the event (the handler owns
   *  preventDefault); the kernel then sends nothing for it. Used by clipboard
   *  (Ctrl+Shift+C/V) and contextMenu (Escape-to-close). Runs in registration
   *  order; the first to return true wins. */
  registerKeydown(fn: (ev: KeyboardEvent) => boolean): Unsubscribe;

  /** Drive the engine renderer (never the raw resume layer). */
  readonly render: RenderHandle;
  /** Drive the engine scroll controller. */
  readonly scroll: ScrollHandle;
  /** Read the engine's mode state (bracketed paste, mouse tracking, DECCKM). */
  readonly modes: ModeReaders;
  /** Read-only active-session view. */
  readonly session: SessionView;
  /** The shell this feature's pane belongs to. A feature with `scope: "shell"`
   *  receives a context whose `surface`, `render`, `scroll`, `modes`, `session`,
   *  `send`, `paste`, `toast` and `announce` resolve to the SELECTED pane at call
   *  time, whose `region` is the shell's own, and whose `on` is the union of every
   *  pane's bus; `ctx.shell.pane(side)` reaches one pane explicitly. */
  readonly shell: ShellContext;

  /** Subscribe to a typed terminal event. Released with the feature. */
  on<K extends keyof TerminalEvents>(e: K, fn: (p: TerminalEvents[K]) => void): Unsubscribe;
  /** Hand the terminal a release for something this feature acquired OUTSIDE
   *  `ctx` (a timer, an observer, a `document` or `window` listener, an outside
   *  subscription), on the line that acquires it. The terminal runs every
   *  release, last registered first, when this feature's `setup` throws and after
   *  its `teardown()` returns, so a half-built feature leaks nothing and a
   *  `teardown` never re-lists what `defer` already holds. */
  defer(release: () => void): void;

  /** Look up a peer feature's typed API by its factory value, or undefined if
   *  that feature is absent or not yet set up. Read lazily (at interaction
   *  time) so ordering within the feature list does not matter at runtime. */
  use<A>(feature: TerminalFeature<A>): A | undefined;

  /** Show a transient toast on the kernel-owned toast surface (a shared
   *  primitive), so a feature signals "Copied" etc. without
   *  owning its own surface and without needing connectionBanner present. */
  toast(message: string, ms?: number): void;
  /** Announce a message on the single kernel-owned polite (or assertive) live
   *  region, so features do not spawn competing aria-live regions. */
  announce(message: string, politeness?: "polite" | "assertive"): void;
  /** Report WHY startup is still waiting, onto the consumer's loading overlay,
   *  which covers every other surface a feature could speak through before the
   *  first frame. Supersedes the kernel's scripted wording; pass the server's own
   *  message where there is one. An unchanged message is a no-op, so a screen
   *  reader is not re-read the same sentence every tick, and so is a call after
   *  the overlay has been dismissed. */
  loadingReason(message: string): void;
  /** The kernel's tablist/tabpanel ARIA controller (used by tabs). */
  tablist(): TablistController;

  /** Construct a LineStore honoring `CreateTerminalOptions.scrollbackLines`, so
   *  one option governs the implicit store and every per-tab store alike. Pass
   *  the session id: it is what lets the store be HYDRATED from
   *  `persistScrollback` and registered for saving. Omitting it yields a correct
   *  but never-persisted store, warned once when persistence is enabled. */
  newLineStore(sessionId?: string): LineStore;

  /** The layout facts a feature keys touch-vs-desktop behavior on. `narrow` is a
   *  ROOT compact in EITHER dimension (the `.wt-narrow` class), root size rather
   *  than viewport size so an embedded panel counts; `coarse` is a live read of
   *  the primary pointer. */
  layout(): { narrow: boolean; coarse: boolean };

  /** Switch the live terminal to a session. The caller binds the renderer to the
   *  session's store first; the kernel re-points the connection, invokes every
   *  feature's onSwitch before input resumes, and emits session:switch for pure
   *  observers. */
  notifySwitch(session: SessionRef): void;
  /** Drop a closed session's resume state on every pane's connection and in the
   *  scrollback keeper. */
  dropSession(id: string): void;

  /** Observe feature errors (a feature's runtime callback threw). */
  onError(fn: (feature: string, err: unknown) => void): Unsubscribe;
}

// --- The feature interface ---

/** A feature is a factory value implementing this: a name and a setup the
 *  kernel runs once. `Api` is the feature's own typed public API (void when it
 *  exposes none). */
export interface TerminalFeature<Api = void> {
  readonly name: string;
  /** Build the feature. A `setup` that throws or rejects releases nothing itself:
   *  everything taken through `ctx` is released by the terminal, and everything
   *  acquired outside `ctx` must be handed to `ctx.defer` at acquisition or it
   *  leaks. */
  setup(ctx: TerminalContext): FeatureInstance<Api> | Promise<FeatureInstance<Api>>;
  /** `"shell"` for a feature set up ONCE per terminal with the shell context (the
   *  tab row, the key toolbar, the status monitor, the animation class); absent for
   *  a feature set up once per pane. */
  readonly scope?: "shell";
  /** Populated after setup with the instance's api, so a consumer holding the
   *  feature value can read it (`tabs.api?.create()`); undefined until then.
   *  Readonly so a feature is covariant in Api. */
  readonly api?: Api;
  /** Present on the ONE feature that owns session selection; createTerminal
   *  throws when two features register. Its presence makes the terminal SKIP
   *  the startup connect to the bare wsPath (which a session-gated server 404s)
   *  and drive the first connect through resolveInitialSession() instead. A
   *  feature sets this OR `paneLayoutOwner`, never both. */
  readonly sessionOwner?: SessionOwnerRegistration;
  /** Present on the feature that owns which session each pane shows (the tabs
   *  feature). Like `sessionOwner` it makes the terminal skip the bare startup
   *  connect; unlike it, the owner shows the initial tabs itself through the pane
   *  handles. At most one owner of either kind per terminal. */
  readonly paneLayoutOwner?: PaneLayoutOwnerRegistration;
}

/** The pane-layout-owner registration: the tabs feature's half of the first
 *  connect, where the server's layout record decides what each pane shows. */
export interface PaneLayoutOwnerRegistration {
  /** Show the initial tabs through the pane handles from the server's layout
   *  record and the session list; resolve true when any pane shows a tab. Called
   *  once, after every shell-scoped setup has resolved. A false or a throw means
   *  nothing could be shown; the terminal dismisses the loading overlay so the
   *  owner's retry chrome is visible. */
  resolveInitialLayout(): Promise<boolean>;
}

/** How the one session-owning feature and the terminal split the first connect:
 *  the feature owns session selection and its bootstrap state, the terminal owns
 *  the connect, so a failed bootstrap is SEEN rather than inferred. */
export interface SessionOwnerRegistration {
  /** Resolve the initial session and bind the renderer to its store, but do NOT
   *  call ctx.notifySwitch for it: the terminal performs the switch with the
   *  returned ref. Null (or a throw, reported through the error channel) means
   *  the bootstrap failed; the terminal dismisses the loading overlay so the
   *  feature's retry chrome is visible. Called exactly once, after every
   *  feature's setup has resolved. */
  resolveInitialSession(): Promise<SessionRef | null>;
}

/** What a feature's setup returns. */
export interface FeatureInstance<Api = void> {
  /** This feature's public API, surfaced on the feature value and via ctx.use. */
  readonly api?: Api;
  /** Remove this feature's DOM and listeners. Run in reverse order on destroy. */
  teardown(): void;
  /** Called at the START of a tab switch, before the connection is re-pointed,
   *  so latched input state (a pending sticky-Ctrl) cannot fire against the
   *  incoming session. Runs for every feature before any onSwitch. */
  onDetach?(): void;
  /** Called by the kernel on a tab switch (attach), after the connection is
   *  re-pointed, for features that must re-point before input resumes
   *  (session:switch on the bus is for pure observers). */
  onSwitch?(session: SessionRef): void;
}

// --- Entry point ---

/** A fatal failure while createTerminal is starting up, delivered so a consumer
 *  never hand-builds its own startup-failure surface. `kernel-init` is a
 *  SYNCHRONOUS throw out of createTerminal (the recovery surface is rendered,
 *  then the error is RETHROWN); `feature-setup` is an async composition failure,
 *  delivered after the terminal has released everything and cleared its root,
 *  with nothing rethrown. Only `kernel-init` can carry an undefined `surface`. */
export type TerminalStartupFailure =
  | {
      readonly phase: "feature-setup";
      /** Name of the feature whose setup threw or rejected. */
      readonly feature: string;
      /** The original thrown or rejected value. */
      readonly cause: unknown;
      /** The element the built-in surface would fill — always the terminal root
       *  in this phase, since the terminal had already mounted. */
      readonly surface: HTMLElement;
    }
  | {
      readonly phase: "kernel-init";
      /** The original thrown value, rethrown to the caller after this returns. */
      readonly cause: unknown;
      /** The element the built-in surface would fill, and the element a handler
       *  claiming the surface (returning true) must render into: usually the
       *  resolved root. `undefined` in two cases, so a handler must check: an
       *  unresolvable mount target in `container` layout (an embedded terminal
       *  never seizes its host page), and a document that already holds a live
       *  terminal, in either layout (the root may be that terminal's). */
      readonly surface: HTMLElement | undefined;
    };

/** One stored scrollback entry: the engine's store snapshot plus the timestamp
 *  the library stamps on it. The timestamp is the library's because the maximum
 *  age is ENFORCED here: the case that motivates persisting (iOS discarding a
 *  backgrounded tab) is the case where no "closed cleanly" path ever runs. */
export interface PersistedScrollback {
  /** `Date.now()` when the library wrote this entry. */
  readonly savedAt: number;
  /** The engine's plain-data store snapshot (structuredClone-safe). */
  readonly snapshot: StoreSnapshot;
}

/** The consumer-supplied storage seam for scrollback persistence. Storage is the
 *  CONSUMER's because a held IndexedDB connection costs bfcache eligibility,
 *  which this library depends on, and because scrollback holds secrets while
 *  browser storage has no at-rest protection. `sessionId` is a real session id,
 *  the one the persisted server epoch is adopted against. `load` is SYNCHRONOUS:
 *  a resume is not restartable, so hydration must complete before it goes out;
 *  asynchronous storage is read into memory before `createTerminal`. Every
 *  callback may throw: any failure means "nothing restored" and a full resume. */
export interface ScrollbackPersistence {
  /** Whatever was stored for a session, or null/undefined. Called once per
   *  session, before that session connects. `unknown`, not `PersistedScrollback`:
   *  an entry coming BACK has been outside this program's memory and is a claim,
   *  which the library's own `JSON.parse`-backed storage cannot promise more of.
   *  A `load` annotated `PersistedScrollback | null` still satisfies this. */
  load(sessionId: string): unknown;
  /** Store an entry, replacing any previous one. THROW when nothing was
   *  persisted: returning normally records "this is on disk", and a failure
   *  reported that way made the library skip the session until its output
   *  advanced again. A throw is warned once and retried on the next pass. */
  save(sessionId: string, entry: PersistedScrollback): void;
  /** Delete a session's entry: on tab close, and when the library rejects a
   *  stored entry, so a bad one is not re-read on every load. */
  drop(sessionId: string): void;
  /** Newest lines to persist per session (default 200). A bound rather than the
   *  whole store because the cost is a repeated serialize on every backgrounding
   *  and timer tick, and the screen plus recent history is what a returning user
   *  needs; the store shows its "earlier output trimmed" marker for the rest.
   *  Non-integer or non-positive values are ignored. */
  lines?: number;
  /** Maximum age of a stored entry (default 7 days), in EITHER direction, so a
   *  clock that moved cannot leave an entry that never expires. */
  maxAgeMs?: number;
  /** Interval for the background save while content is changing (default 10s).
   *  `pagehide` is not guaranteed before a discard, so the timer is what makes a
   *  killed tab have a recent snapshot rather than none. */
  saveIntervalMs?: number;
}

/** Options for createTerminal. */
export interface CreateTerminalOptions {
  /** The feature list, as a FUNCTION so a preset that throws does so INSIDE
   *  createTerminal's failure boundary; omitted means the bare kernel. Invoked
   *  once per pane and must return FRESH feature objects on every call: the
   *  terminal writes each object's `api` after setup and resolves `ctx.use` on
   *  its identity, so a saved array (`const f = presetTabbed(); features: () =>
   *  f`) is refused at `kernel-init`. Features marked `scope: "shell"` are taken
   *  from the first invocation only. */
  features?: () => readonly TerminalFeature<unknown>[];
  /** How the terminal claims space (default "viewport"): a fixed full-viewport
   *  box, or a root filling its parent element (the embedded case). The
   *  matching class (wt-viewport / wt-container) is stamped on the root, and
   *  every piece of chrome positions against the root, never the page. */
  layout?: "viewport" | "container";
  /** WebSocket endpoint path (default "/ws"). */
  wsPath?: string;
  /** CSS font shorthand awaited before the first resize. */
  fontReady?: string;
  /** Retained scrollback lines per terminal and per tab; the engine's default is
   *  5000. The page's dominant memory dial: it bounds the styled runs each store
   *  retains AND the DOM rows the renderer keeps. A HISTORY budget floored at the
   *  live screen, so choose a few multiples of the largest expected height: near
   *  or below it, batched eviction has no headroom and degrades to per-line
   *  churn. A memory-constrained consumer (iOS Safari) passes a smaller budget.
   *  Non-integer or non-positive values are ignored. */
  scrollbackLines?: number;
  /** Persist each session's scrollback across a page discard, through storage
   *  the CONSUMER supplies; see `localScrollbackStorage`. Helps the FRESH-LOAD
   *  case only (iOS evicts backgrounded tabs, and returning re-runs the page):
   *  the resume asks only for what was printed while the tab was gone. Off by
   *  default because `localStorage` is a shared, quota-limited resource an
   *  embedder may depend on, and because enabling it writes terminal output
   *  where that browser can read it without the server. Applies to the implicit
   *  store and to every `ctx.newLineStore(sessionId)` store alike. */
  persistScrollback?: ScrollbackPersistence;
  /** Optional pre-JS loading overlay the terminal fades out on first paint. Give
   *  it the `wt-loading` class and a `wt-loading-bar` child; a progressive status
   *  line is written into it while startup drags on. */
  loading?: HTMLElement;
  /** Reword the loading overlay's progressive status text. Partial: anything
   *  omitted keeps the library default. It only ever appears on a SLOW start; a
   *  live reason pushed through `ctx.loadingReason` supersedes all of it. */
  loadingMessages?: Partial<LoadingMessages>;
  /** Observe or replace the fatal startup surface. Return true after rendering a
   *  replacement recovery surface into `failure.surface`; false or undefined
   *  keeps the built-in Reload surface. A throw here is logged and the built-in
   *  surface shown, so a reporting failure cannot leave the page blank. */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- an observing handler returns nothing; only a literal `true` claims the recovery surface, so forcing `return undefined` on every observer is worse than the union
  onFatalError?: (failure: TerminalStartupFailure) => boolean | void;
  /** Called when the active session's process has ended and nothing is retrying,
   *  the fact the connection banner renders as "Session ended". Observation
   *  only: everything the terminal does about the end happens first and
   *  regardless, and the recovery POLICY (see `TerminalHandle.reattach`) stays
   *  with the host, which alone knows what its endpoint yields on the next
   *  connect. A throw is logged and swallowed. */
  onSessionEnded?: () => void;
  /** Theme overrides: CSS custom properties set on the terminal root, over the
   *  defaults of css/00-tokens.css. The supported keys are published as DATA in
   *  `PUBLIC_THEME_TOKENS`; this type stays an open Record so a theme can be
   *  built dynamically, which means an unknown key applies to nothing. */
  theme?: Readonly<Record<string, string>>;
}

/** The handle createTerminal returns. Feature APIs are not materialized here
 *  (that could not be typed soundly); a consumer holds the feature value and
 *  reads its `api`. */
export interface TerminalHandle {
  /** Focus the terminal input (opens the soft keyboard on touch). */
  focus(): void;
  /** Send bytes to the active session through the sanitizing input funnel, the
   *  same path features use, so transforms apply and the view snaps to the
   *  bottom like typed input. No-op after destroy(). */
  send(bytes: Uint8Array): void;
  /** Reset the LOCAL display: drop the client-side scrollback and screen.
   *  Injects no keystroke; a host that wants a fresh prompt sends one itself.
   *  No-op after destroy(). */
  reset(): void;
  /** Attach again to whatever the server serves now, for the one state the
   *  terminal cannot leave on its own: `ended`. Only a host whose endpoint hands
   *  out a NEW session on the next connect knows a reconnect is worth making, so
   *  it asks. Drops the local scrollback and screen (a stale `haveThrough` would
   *  claim lines the new session never reached), leaves `ended`, then reconnects;
   *  it starts no process. Not for a live session: a needless full replay. No-op
   *  after destroy(). */
  reattach(): void;
  /** Tear down every feature in reverse order, dispose all subscriptions, and
   *  release the kernel's DOM and engine wiring. */
  destroy(): void;
}
