// The v3 kernel/feature contract (design section 22.4).
//
// A terminal is a small always-present kernel plus opt-in feature modules. This
// module is the typed spine both sides hang off: the feature interface, the
// context the kernel hands each feature, the typed event bus payloads, and the
// layout-region vocabulary. It is fully typed (no `any`, no stringly-typed
// capability lookup) so a feature's public API is held by reference and a peer
// reads it through a typed token.

import type { ScreenMessage, ModesMessage, LineStore } from "@cplieger/web-terminal-engine";

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
  | "ended";

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
  /** Point the renderer at a store and rebuild from it (tabs, on switch). */
  bind(store: LineStore): void;
  /** The store the renderer is currently bound to. */
  boundStore(): LineStore;
  /** Highest absolute line index the active store holds (-1 if empty). */
  getHighestIndex(): number;
}

/** The scroll methods features may drive. */
export interface ScrollHandle {
  scrollToBottom(): void;
  isUserScrolledUp(): boolean;
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
  /** The kernel's tablist/tabpanel ARIA controller (used by tabs). */
  tablist(): TablistController;

  /** The current layout facts a feature keys touch-vs-desktop behavior on.
   *  `narrow` is ROOT width at or below the kernel's single breakpoint (the
   *  same fact the .wt-narrow root class exposes to CSS — root width, not
   *  viewport width, so an embedded terminal in a narrow panel counts as
   *  narrow). `coarse` is the primary pointer's coarseness (a live media-query
   *  read). Read lazily at interaction time. */
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

/** Options for createTerminal. */
export interface CreateTerminalOptions {
  /** The feature list; omitted or empty means the bare kernel (no chrome).
   *  Heterogeneous feature APIs are held as unknown here; a consumer reads a
   *  specific feature's api off the feature value it holds. */
  features?: readonly TerminalFeature<unknown>[];
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
  /** Optional pre-JS loading overlay the kernel fades out on first paint. */
  loading?: HTMLElement;
  /** Theme overrides: CSS custom properties set on the terminal root so a
   *  consumer recolors the UI (accent, tab hover/active) without shipping CSS.
   *  Keys must be CSS custom-property names (start with "--"); values are any
   *  CSS value. The library ships the defaults (css/00-tokens.css) — the
   *  "template"; these are the consumer's "settings" and override them for this
   *  instance. Known tokens: --accent, --tab-bg, --tab-hover-bg,
   *  --tab-active-bg, --tab-active-fg, --tab-active-border. */
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
  /** Tear down every feature in reverse order, dispose all subscriptions, and
   *  release the kernel's DOM and engine wiring. */
  destroy(): void;
}
