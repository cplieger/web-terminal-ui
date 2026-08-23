// The v3 kernel/feature contract (design section 22.4).
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
  LineStore,
  StoreSnapshot,
  ViewMemory,
} from "@cplieger/web-terminal-engine";

/** Cancels a subscription or registration. Idempotent by convention. */
export type Unsubscribe = () => void;

// --- Layout regions (section 22.13) ---

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
  | "incompatible";

// --- Engine drive handles ---
//
// Features drive the engine's render and scroll surfaces through these handles:
// the subset of the engine's render/scroll modules features legitimately need.
// The kernel assigns the real engine namespaces here, so TS verifies they
// satisfy the subset (drift is caught at the kernel). The connection layer is
// deliberately NOT exposed: features send only through ctx.send / ctx.paste (the
// sanitizing funnel) and never touch the raw outbox/resume layer or the binary
// frame format (section 22.9).

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
  /** Restore a saved offset; follow/hold re-derives from the resulting scroll
   *  event exactly as for a user scroll — the write half of scroll memory.
   *
   *  @deprecated A pixel offset cannot identify a reading position: replayed
   *  into a surface whose rows are still building it is silently clamped, and
   *  replayed into one whose content grew it points at a different line. Use
   *  render.captureViewMemory() + render.bind(store, { view }), which restore a
   *  LINE. Removed in the next major. */
  restoreScrollTop(top: number): void;
  /** Restore an offset AND its follow state together, which is the only way to
   *  express "holding at the bottom" (a content shrink clamps a scrolled-up reader
   *  there without engaging follow, so position alone cannot say it).
   *
   *  NOT the per-view scroll-memory API: this is still a PIXEL offset, with the
   *  same defect as `restoreScrollTop` above — a rebuild clamps it and a tab whose
   *  content grew while backgrounded lands on a different line. `render.bind(store,
   *  { view })` with `render.captureViewMemory()` is what a consumer wants; the
   *  engine calls this internally from that path. Declared here because it is part
   *  of the engine's scroll surface, not because a consumer should reach for it. */
  restoreView(view: { top: number; following: boolean }): void;
}

// --- Typed event bus payloads (section 22.4) ---

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
  /** Enter or leave inline-edit mode. A textbox is not valid content for
   *  `role="tab"` (ARIA marks a tab's children presentational, so a focusable
   *  descendant may get no accessibility-tree node at all), so a feature that
   *  puts an input inside its chip drops the tab semantics for the duration.
   *
   *  One atomic transition each way. On: `role` and `aria-selected` are removed
   *  and the chip leaves the roving sequence while the field owns focus. Off: the
   *  role is restored along with `aria-selected` and the roving tabindex derived
   *  from `selected` AS OF NOW — the active tab can change while an edit is open
   *  on a different chip, so the caller passes the current state rather than the
   *  handle replaying the state it saw at entry. */
  setEditing(editing: boolean, selected: boolean): void;
  /** Deregister this tab. */
  remove(): void;
}

// --- The context handed to each feature's setup ---

/** Everything a feature is given at setup. The only surface features use to
 *  affect the terminal; it closes the round-3 holes (typed APIs by reference,
 *  ctx.use tokens, a typed bus, a defined lifecycle, kernel-owned a11y). */
export interface TerminalContext {
  /** Mount chrome into a named kernel region; DOM order in a region equals
   *  visual order. Returns a live element the feature appends into. */
  region(name: RegionName, slot?: RegionSlot): HTMLElement;
  /** The terminal scroll surface, for features that attach surface-level
   *  gestures (contextMenu right-click / long-press, the tabs swipe) or scope a
   *  selection to the output. Read-only use; features own only their region
   *  chrome (section 22.9, single-operator trust). */
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
  /** Read-only active-session view. */
  readonly session: SessionView;

  /** Subscribe to a typed terminal event. Auto-disposed on destroy. */
  on<K extends keyof TerminalEvents>(e: K, fn: (p: TerminalEvents[K]) => void): Unsubscribe;

  /** Look up a peer feature's typed API by its factory value, or undefined if
   *  that feature is absent or not yet set up. Read lazily (at interaction
   *  time) so ordering within the feature list does not matter at runtime. */
  use<A>(feature: TerminalFeature<A>): A | undefined;

  /** Show a transient toast on the kernel-owned toast surface (a shared
   *  primitive, section 22.3), so a feature signals "Copied" etc. without
   *  owning its own surface and without needing connectionBanner present. */
  toast(message: string, ms?: number): void;
  /** Announce a message on the single kernel-owned polite (or assertive) live
   *  region, so features do not spawn competing aria-live regions. */
  announce(message: string, politeness?: "polite" | "assertive"): void;
  /** Report WHY startup is still waiting, onto the consumer's loading overlay.
   *
   *  For the window before the first frame, when the overlay covers every
   *  surface a feature could otherwise speak through: the toast layer and the
   *  connection banner both live inside .wt-root and paint UNDER it, so a
   *  feature that retries for minutes has no visible channel without this.
   *  Supersedes the kernel's own scripted wording (and stops its rotation),
   *  because a reason the SERVER gave is always better than a guess -- pass the
   *  server's own message where there is one. Safe to call on every tick of a
   *  retry loop: an unchanged message is a no-op, so a screen reader is not
   *  re-read the same sentence every few seconds. Also a no-op once the overlay
   *  has been dismissed, so a late retry cannot resurrect it. */
  loadingReason(message: string): void;
  /** Set the prefix the kernel composes onto the document title, or "" to clear
   *  it. The kernel is the only writer of `document.title`: it holds the base
   *  (the served `<title>`, replaced by a program's OSC 0/2 window title) and
   *  this prefix, and re-composes on either change. A feature that assigned
   *  `document.title` directly would be erased by the next OSC 2 from any shell
   *  or editor running in a session, with no ordering that avoids it.
   *
   *  Idempotent and safe on every status tick: an unchanged result is not
   *  re-assigned, because the title doubles as the browser-tab label and the
   *  bookmark name. Cleared automatically when the terminal is destroyed.
   *
   *  Keep it an AGGREGATE. A page has one title while this UI multiplexes many
   *  sessions, so any per-session value has to pick a session arbitrarily (see
   *  the standing decision against writing progress here in features/tabs). */
  titlePrefix(text: string): void;
  /** The kernel's tablist/tabpanel ARIA controller (used by tabs). */
  tablist(): TablistController;

  /** Construct a LineStore honoring the terminal's configured retained-line
   *  cap (`CreateTerminalOptions.scrollbackLines`; engine default when unset).
   *  A feature that keeps per-session stores (tabs' switching cache) creates
   *  every store through this factory, so ONE consumer option governs the
   *  kernel's implicit store and every per-tab store alike — the two cannot
   *  drift.
   *
   *  Pass the session id the store belongs to. It is optional only so an
   *  existing feature keeps compiling; a feature that owns sessions should
   *  always pass it, because it is what lets the kernel return a store HYDRATED
   *  from `CreateTerminalOptions.persistScrollback` (and register it for
   *  saving). Omitting it yields a correct but always-empty store, so that
   *  feature's sessions silently opt out of persistence — the kernel warns once
   *  when persistence is enabled and an id is withheld. */
  newLineStore(sessionId?: string): LineStore;

  /** The current layout facts a feature keys touch-vs-desktop behavior on.
   *  `narrow` is a ROOT compact in EITHER dimension against the kernel's
   *  breakpoints: skinny (width, a portrait phone or a narrow embedded panel)
   *  or short (height, a landscape phone) — the same fact the .wt-narrow root
   *  class exposes to CSS; root size, not viewport size, so an embedded
   *  terminal in a narrow panel counts as narrow. `coarse` is the primary
   *  pointer's coarseness (a live media-query read). Read lazily at
   *  interaction time. */
  layout(): { narrow: boolean; coarse: boolean };

  /** Switch the live terminal to a session. tabs binds the renderer to the
   *  session's cached store (ctx.render.bind) first, then calls this; the kernel
   *  reconnects the terminal WS to that session (connection.setSession, using
   *  its per-tab resume state), invokes every feature's onSwitch (ordered,
   *  before input resumes), and emits session:switch for pure observers
   *  (sections 5, 22.4). Updates the active session the SessionView reports.
   *  This is how tabs drives the reconnect-on-switch swap without touching the
   *  raw connection layer (section 22.9). */
  notifySwitch(session: SessionRef): void;
  /** Drop a session's per-tab resume state (on tab close), so its outbox and
   *  byte counters are released. The kernel routes this to the connection
   *  layer; features never touch it directly. */
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
  setup(ctx: TerminalContext): FeatureInstance<Api> | Promise<FeatureInstance<Api>>;
  /** Populated by the kernel after setup with the instance's api, so a consumer
   *  holding the feature value can read it (e.g. `tabs.api?.create()`). Read
   *  it lazily; it is undefined until the kernel has run this feature's setup.
   *  Readonly so a feature is covariant in Api (a TerminalFeature<X> is a
   *  TerminalFeature<unknown>); the kernel sets it through a narrow cast. */
  readonly api?: Api;
  /** Present on the ONE feature that owns session selection (at most one per
   *  terminal; createTerminal throws when two features register). Its presence
   *  makes the kernel SKIP the startup connect to the bare wsPath (which a
   *  session-gated server 404s, churning the reconnect backoff); the kernel
   *  instead drives the first connect through resolveInitialSession() once
   *  feature setup completes. Single-terminal presets leave it unset so the
   *  kernel connects to the bare wsPath at startup. */
  readonly sessionOwner?: SessionOwnerRegistration;
}

/** The session-owner registration: how the one session-owning feature and the
 *  kernel split the first connect. The feature owns session selection (list /
 *  spawn / pick) and its own bootstrap state; the kernel owns the connect
 *  itself, so a failed bootstrap is SEEN by the kernel (which dismisses the
 *  loading overlay) instead of inferred from a missing side effect. */
export interface SessionOwnerRegistration {
  /** Resolve the initial session: list (or spawn) one, build per-session
   *  state, and bind the renderer to the session's store (ctx.render.bind) —
   *  but do NOT call ctx.notifySwitch for it. The kernel performs the switch
   *  with the returned ref through the same path notifySwitch uses. Return
   *  null when no session could be resolved (the bootstrap failed): the
   *  feature keeps its retry chrome alive, and the kernel dismisses the
   *  loading overlay so that chrome is visible. A throw is treated as null
   *  (and reported through the feature-error channel). Called exactly once,
   *  after every feature's setup has resolved. */
  resolveInitialSession(): Promise<SessionRef | null>;
}

/** What a feature's setup returns: its optional typed API, a teardown, and an
 *  optional onSwitch the kernel invokes on a tab switch. */
export interface FeatureInstance<Api = void> {
  /** This feature's public API, surfaced on the feature value and via ctx.use. */
  readonly api?: Api;
  /** Remove this feature's DOM and listeners. Run in reverse order on destroy. */
  teardown(): void;
  /** Called by the kernel at the START of a tab switch (detach), before the
   *  connection is re-pointed at the incoming session, for features holding
   *  latched input state that must not fire against the next session: the mobile
   *  toolbar disarms its one-shot sticky-Ctrl here so a pending Ctrl cannot
   *  become an accidental Ctrl+C to the wrong agent (design 5.1). Runs for every
   *  feature before any onSwitch. */
  onDetach?(): void;
  /** Called by the kernel on a tab switch (attach), after the connection is
   *  re-pointed, for features that must re-point before input resumes
   *  (session:switch on the bus is for pure observers). */
  onSwitch?(session: SessionRef): void;
}

// --- Entry point ---

/** A fatal failure while createTerminal is starting up.
 *
 *  Two phases can fail, and both are delivered here so a consumer never has to
 *  hand-build its own startup-failure surface. That sentence used to be
 *  aspirational: resolving the mount target and constructing the feature list
 *  both happened at the CALL SITE, outside this boundary, so a consumer really
 *  did need its own surface for those two — and every consumer that built one
 *  restated this library's copy and re-decided its focus and ARIA behavior.
 *  createTerminal now takes a selector and a feature THUNK, which pulls both
 *  failures inside, and the promise holds literally.
 *
 *  - `kernel-init`: a SYNCHRONOUS throw out of createTerminal (an unresolvable
 *    mount selector, a throwing preset or feature constructor, an invalid
 *    feature list, a DOM invariant). The kernel renders the recovery surface and
 *    then RETHROWS, so a caller with its own handling still sees the error.
 *  - `feature-setup`: an async feature-composition failure. The kernel has
 *    already stopped the connection, released every listener and singleton,
 *    torn down completed features, and cleared the terminal root when it
 *    delivers this value. Nothing is rethrown; the failure is asynchronous.
 *
 *  Discriminate on `phase`: `feature-setup` names the offending feature,
 *  `kernel-init` has no feature to name because composition never began, and
 *  only `kernel-init` can carry an undefined `surface`. */
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
       *  claiming the surface (returning true) must render into. Usually the
       *  resolved root — but when the MOUNT TARGET itself could not be resolved
       *  there is no root, so in `viewport` layout this is a fresh full-viewport
       *  element the kernel appended to the body, and in `container` layout it is
       *  `undefined`: an embedded terminal is one panel in a host application, so
       *  a missing mount target is reported and rethrown but never answered by
       *  seizing the host's page. A handler that renders its own UI must
       *  therefore check for undefined. */
      readonly surface: HTMLElement | undefined;
    };

/** One stored scrollback entry: the engine's store snapshot plus the timestamp
 *  the library stamps on it.
 *
 *  The timestamp is the library's, not the consumer's, because the maximum age
 *  is ENFORCED here rather than documented as someone else's job. The case that
 *  motivates persisting at all — iOS discarding a backgrounded tab — is exactly
 *  the case where no "closed cleanly" path ever runs, so without an age bound
 *  the consumer's storage accumulates snapshots for sessions that stopped
 *  existing weeks ago. A rejected entry is also dropped through
 *  `ScrollbackPersistence.drop`, which makes collection-on-access automatic; a
 *  consumer that wants to sweep proactively has `savedAt` to sweep by. */
export interface PersistedScrollback {
  /** `Date.now()` when the library wrote this entry. */
  readonly savedAt: number;
  /** The engine's plain-data store snapshot (structuredClone-safe). */
  readonly snapshot: StoreSnapshot;
}

/** The consumer-supplied storage seam for scrollback persistence
 *  (`CreateTerminalOptions.persistScrollback`).
 *
 *  Storage is the CONSUMER's, deliberately, for two reasons. Chrome's
 *  page-lifecycle guidance is to close IndexedDB connections on freeze because a
 *  held connection affects bfcache eligibility, and this library depends on
 *  bfcache (it reconnects and re-measures on `pageshow`) — so the library must
 *  not own a database. And terminal scrollback contains secrets while browser
 *  storage has no meaningful at-rest protection, which makes "where does this
 *  live, and for how long" a decision for the application, not its terminal
 *  widget.
 *
 *  `sessionId` is a real session id, never a key of the consumer's invention:
 *  the same id the tabs feature uses, or — for a single unmanaged terminal — the
 *  engine's per-tab id from `connection.currentSessionId()`. That is load-bearing
 *  rather than tidy, because the id is also what the persisted server epoch is
 *  adopted against. A consumer may of course prefix it inside its own storage.
 *
 *  `load` is SYNCHRONOUS, which is a real constraint and worth understanding
 *  before fighting it: hydration has to complete before the resume goes out, and
 *  a resume is not restartable — a store hydrated after `haveThrough` was sent
 *  has already lost the argument. A consumer whose storage is asynchronous
 *  (IndexedDB) reads its snapshots into memory before calling `createTerminal`
 *  and answers from there, which is also the shape that holds no database
 *  connection open.
 *
 *  Every callback may throw or return nonsense without consequence: the library
 *  treats any failure as "nothing was restored" and takes a full resume, exactly
 *  as if persistence were switched off. */
export interface ScrollbackPersistence {
  /** Return whatever was stored for a session, or null/undefined when there is
   *  nothing. Called once per session, before that session connects.
   *
   *  `unknown`, not `PersistedScrollback`, and the asymmetry with `save` below is
   *  the point: an entry going OUT was produced by the engine and is proven, while
   *  an entry coming BACK has been outside this program's memory and is a claim.
   *  Declaring the proven type on both sides told the compiler the returned value
   *  was verified — which no implementation of this seam can promise, this
   *  library's own `localScrollbackStorage` least of all, since it hands back a
   *  `JSON.parse` result. The kernel parsed it anyway, and because the type said
   *  otherwise it did so in helpers that each re-established the shape from
   *  scratch: measured 2026-08, 15 of `scrollback.ts`'s 19 permanently unkillable
   *  mutants were those duplicate checks.
   *
   *  Nothing is lost by an implementation: a `load` annotated
   *  `PersistedScrollback | null` still satisfies this, so a consumer that holds
   *  real entries in memory keeps its own type checking. What goes is only the
   *  false guarantee at the boundary that cannot honour it.
   *
   *  `PersistedScrollback` remains the shape to store and the shape you get back
   *  when storage is intact; see `save`. */
  load(sessionId: string): unknown;
  /** Store an entry, replacing any previous one for the session.
   *
   *  THROW when nothing was persisted (over quota, storage revoked, an entry the
   *  store refuses). Returning normally is taken as "this is on disk" and records
   *  a watermark against it; a failure reported that way made the library skip the
   *  session until its output advanced again, which is how persistence stopped
   *  silently. A throw is caught, warned once, and retried on the next pass. */
  save(sessionId: string, entry: PersistedScrollback): void;
  /** Delete a session's entry. Called when a tab is closed, and when the
   *  library rejects a stored entry (too old, unusable, or unverifiable), so a
   *  bad or expired entry is not re-read on every load. */
  drop(sessionId: string): void;
  /** Newest lines to persist per session (default 200).
   *
   *  A bound rather than the whole store because the cost is a repeated
   *  serialize-and-store on a device that may already be under memory pressure,
   *  and because the screen plus recent history is what a returning user needs.
   *  The default follows the nearest precedent — VS Code's
   *  `terminal.integrated.persistentSessionScrollback` restores 100 lines — with
   *  headroom, and against measurement: 200 lines is ~60 K characters of a
   *  coloured session and serialises in under a millisecond, where 1000 is ~300 K
   *  and ~4 ms, paid on every backgrounding and every timer tick while output
   *  advances. The depth NOT kept is reported honestly after hydration: the store
   *  shows its "earlier output trimmed" marker rather than implying the buffer is
   *  complete. Non-integer or non-positive values are ignored. */
  lines?: number;
  /** Maximum age of a stored entry (default 7 days). An entry outside this is
   *  neither loaded nor kept. Distance in EITHER direction counts, so a phone
   *  whose clock moved cannot leave an entry that never expires. */
  maxAgeMs?: number;
  /** Interval for the background save while content is changing (default 10s).
   *
   *  `visibilitychange` to hidden and `pagehide` are the last reliable callbacks
   *  before a discard and the library writes on both, but Chrome's page-lifecycle
   *  documentation is explicit that `pagehide` is not guaranteed. The timer is
   *  what makes a killed tab have a recent-enough snapshot rather than none. It
   *  skips sessions whose content has not advanced since their last save. */
  saveIntervalMs?: number;
}

/** Options for createTerminal. */
export interface CreateTerminalOptions {
  /** The feature list, as a FUNCTION that produces it; omitted means the bare
   *  kernel (no chrome). Heterogeneous feature APIs are held as unknown here; a
   *  consumer reads a specific feature's api off the feature value it holds.
   *
   *  It is a function, not an array, so that a preset or feature constructor
   *  that throws does so INSIDE createTerminal's failure boundary. Passed as an
   *  array (`features: presetTabbed()`) the call was evaluated as an argument —
   *  before createTerminal was entered — so the throw escaped the library
   *  entirely and every consumer had to wrap the preset call in its own
   *  try/catch and hand-build a recovery surface. Write `features:
   *  presetTabbed` when the preset takes no arguments, or `features: () =>
   *  presetTabbed({...})` when it does. */
  features?: () => readonly TerminalFeature<unknown>[];
  /** How the terminal claims space (default "viewport").
   *  "viewport": the root becomes a fixed full-viewport box — the full-page
   *  product (web-terminal-server, web-terminal-kiro, the scaffold page).
   *  "container": the root fills its parent element, which becomes the
   *  boundary — the embedded case (vibekit's panel). Either way the kernel
   *  stamps the matching class (wt-viewport / wt-container) on the root and
   *  every piece of chrome positions against the root, never the page. */
  layout?: "viewport" | "container";
  /** WebSocket endpoint path (default "/ws"). */
  wsPath?: string;
  /** CSS font shorthand awaited before the first resize. */
  fontReady?: string;
  /** Retained scrollback lines per terminal (and per tab under the tabs
   *  feature) — the client-side line cap; the engine's default is 5000.
   *
   *  This is the page's dominant memory dial: the cap bounds both the styled
   *  run arrays each store retains AND the DOM rows the renderer keeps (one
   *  `div.term-row` per retained line, no offscreen virtualisation), which in
   *  turn bounds the height of the scrolled-contents layer the browser
   *  composites. It is a HISTORY budget floored at the live screen: the
   *  engine never evicts the current window's rows, so a value at or below
   *  the terminal height keeps the full screen and simply retains no
   *  scrollback. Choose a value comfortably above the largest expected
   *  terminal height (a few multiples of it): near or below the height,
   *  batched eviction has no history headroom to work with and degrades
   *  back to per-line eviction — the screen stays correct, but the churn
   *  the batching exists to remove returns. A memory-constrained consumer (iOS Safari, where the content
   *  process is a jetsam victim under system pressure) passes a smaller
   *  budget; scrolling back then reaches fewer lines, so this is a consumer
   *  policy choice, not a tuning knob the library second-guesses. Applies to
   *  the kernel's implicit store (via the engine renderer) and to every store
   *  created through `ctx.newLineStore()` (the tabs switching cache).
   *  Non-integer or non-positive values are ignored. */
  scrollbackLines?: number;
  /** Persist each session's scrollback across a page discard, through storage
   *  the CONSUMER supplies. Omitted means off, which is the default on purpose.
   *
   *  What it fixes: a page that is discarded and reloaded otherwise resumes
   *  holding nothing, so it asks the server for everything and refills its whole
   *  buffer over the wire. On iOS that is the normal case rather than an edge
   *  case — Safari evicts backgrounded tabs under memory pressure and returning
   *  to one re-runs the page — and the refill is both slow and visible. With a
   *  snapshot restored, the resume asks only for what was printed while the tab
   *  was gone.
   *
   *  Scope it honestly: this helps the FRESH-LOAD case only. A warm reconnect and
   *  an in-page tab switch already replay nothing, because their stores never
   *  went away.
   *
   *  Off by default, and the default is the LIBRARY's rather than a
   *  recommendation. `localStorage` is a shared, origin-wide, quota-limited
   *  resource, and this package is embedded in host applications that keep their
   *  own state there; consuming it uninvited would risk the embedder's writes
   *  failing, whose degradation is theirs to design and not ours to assume. Our
   *  own failure under quota pressure is graceful (nothing restored, terminal
   *  unaffected). An application decides durability for its own users; a library
   *  does not decide it for an embedder who never asked. All three reference apps
   *  DO enable it — see `localScrollbackStorage`, which is the ready-made answer.
   *
   *  Note for a consumer weighing it: enabling this writes terminal output where
   *  it is readable from that browser without reaching the server and outlives the
   *  tab (bounded by a per-session delete on close and a seven-day expiry). No
   *  permission prompt is involved — `localStorage` needs none — and a browser
   *  that blocks site data simply restores nothing.
   *
   *  It applies to the whole terminal, not one composition: the kernel's implicit
   *  store (a single unmanaged terminal) and every store a session-owning feature
   *  creates through `ctx.newLineStore(sessionId)` (the tabs cache) are both
   *  hydrated and both saved. */
  persistScrollback?: ScrollbackPersistence;
  /** Optional pre-JS loading overlay the kernel fades out on first paint. Give
   *  it the `wt-loading` class and a `wt-loading-bar` child and css/page.css
   *  styles it; the kernel also writes a progressive status line into it while
   *  startup drags on (see kernel/loading-status.ts). */
  loading?: HTMLElement;
  /** Reword the loading overlay's progressive status text. Partial: anything
   *  omitted keeps the library default. The wording only ever appears on a SLOW
   *  start (nothing is written for the first few seconds), so this is about what
   *  a waiting user reads, not about branding the normal case. A live reason
   *  pushed by a feature via `ctx.loadingReason` supersedes all of it. */
  loadingMessages?: Partial<LoadingMessages>;
  /** Observe or replace the kernel's fatal feature-setup surface. Called only
   *  after the live terminal has been completely torn down and its root
   *  cleared. Return true after rendering a replacement recovery surface into
   *  that root; false or undefined keeps the built-in Reload page surface. If
   *  this callback throws, the kernel logs that error and shows the built-in
   *  surface, so a reporting failure cannot leave the page blank. */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- an observing handler returns nothing; only a literal `true` claims the recovery surface, so forcing `return undefined` on every observer is worse than the union
  onFatalError?: (failure: TerminalStartupFailure) => boolean | void;
  /** Called when the active session's process has ended and nothing is retrying:
   *  the engine's definitive process-exited close, the same fact the connection
   *  banner renders as "Session ended".
   *
   *  Wired by a host that can do something about it, which means a host that
   *  knows its endpoint yields a new session on the next connect (see
   *  `TerminalHandle.reattach`). Everything the kernel does about the end — lower
   *  the loading overlay, surface the state, discard an unconfirmed restore —
   *  happens first and happens regardless, so a host that wires nothing loses
   *  nothing, and a callback that throws cannot take the banner down with it (the
   *  throw is logged and swallowed).
   *
   *  Observation only: the recovery POLICY stays with the host, deliberately.
   *  Whether to reattach at all, how many times and how fast depends on what sits
   *  behind the endpoint, which this library does not know. */
  onSessionEnded?: () => void;
  /** Theme overrides: CSS custom properties set on the terminal root so a
   *  consumer recolors the UI (accent, tab hover/active, the activity-dot
   *  palette) without shipping CSS. Keys must be CSS custom-property names
   *  (start with "--"); values are any CSS value. The library ships the defaults
   *  (css/00-tokens.css) — the "template"; these are the consumer's "settings"
   *  and override them for this instance.
   *
   *  The supported keys are published as DATA, not prose: `PUBLIC_THEME_TOKENS`
   *  (exported at the package root and at "@cplieger/web-terminal-ui/style-contract").
   *  This type stays an open Record so a consumer may build its theme
   *  dynamically, which means nothing here rejects a key the library renamed or
   *  retired — the override would simply apply to nothing. Assert your keys
   *  against that list rather than trusting a comment; the library's own suite
   *  guarantees every token on it is both declared and read by a rule. */
  theme?: Readonly<Record<string, string>>;
}

/** The handle createTerminal returns. Feature APIs are not materialized here
 *  (that could not be typed soundly); a consumer holds the feature value and
 *  reads its `api`. */
export interface TerminalHandle {
  /** Focus the terminal input (opens the soft keyboard on touch). */
  focus(): void;
  /** Send bytes to the active session through the kernel's sanitizing,
   *  session-routed input funnel — the same path features use: input
   *  transforms apply, and the view snaps to the bottom exactly like typed
   *  input. The supported host path for "type this command" affordances
   *  (a run-in-shell button). No-op after destroy(). */
  send(bytes: Uint8Array): void;
  /** Reset the LOCAL display: drop the client-side scrollback and screen (the
   *  same reset the engine performs on a server restart). Deliberately injects
   *  no keystroke — a host that wants a freshly drawn prompt sends one itself
   *  (e.g. Ctrl+L via send()). No-op after destroy(). */
  reset(): void;
  /** Attach again to whatever the server serves now, discarding this terminal's
   *  view of the session that is gone.
   *
   *  For the one state the kernel cannot leave on its own: `ended`. The engine
   *  refuses to reconnect a definitively closed session, and it is right to on a
   *  per-session server, where reconnecting could only collect the same close
   *  again. A host whose endpoint hands out a NEW session on the next connect —
   *  one shared PTY that the server replaces once it is spent — is the only party
   *  that knows a reconnect is worth making, so it is the party that asks.
   *
   *  Three steps, in this order, and none of them is a host's to perform: drop
   *  the local scrollback and screen (the old session's content, and a stale
   *  absolute-index base whose `haveThrough` would otherwise claim lines the new
   *  session has never reached), move the connection state off `ended` so the
   *  banner stops contradicting a blank screen, then reconnect.
   *
   *  Reconnecting is ALL it does: it starts no process and asks the server for
   *  nothing. Whatever makes a new session exist is the host's own call to its
   *  own API, made before this one. Do not call it on a live session — that is a
   *  needless full replay, and it drops history the server may have evicted since.
   *  No-op after destroy(). */
  reattach(): void;
  /** Tear down every feature in reverse order, dispose all subscriptions, and
   *  release the kernel's DOM and engine wiring. */
  destroy(): void;
}
