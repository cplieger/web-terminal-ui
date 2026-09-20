// @cplieger/web-terminal-ui: the reference touch-first browser UI built on
// @cplieger/web-terminal-engine. createTerminal(root, { features }) builds a
// small kernel (display output, hidden textarea, IME, one engine instance, the
// input funnel, connection state, layout regions) plus opt-in feature modules;
// bundles live at "@cplieger/web-terminal-ui/presets".

export { createTerminal } from "./kernel/kernel.js";
export { localScrollbackStorage } from "./kernel/scrollback-storage.js";
export type { LocalScrollbackStorageOptions } from "./kernel/scrollback-storage.js";
export { STARTUP_FAILURE_COPY } from "./kernel/startup-copy.js";
export { LOADING_OVERLAY_CLASSES, PUBLIC_THEME_TOKENS } from "./kernel/style-contract.js";
export type { PublicThemeToken } from "./kernel/style-contract.js";
export type {
  CreateTerminalOptions,
  TerminalStartupFailure,
  TerminalHandle,
  TerminalFeature,
  FeatureInstance,
  PersistedScrollback,
  ScrollbackPersistence,
  SessionOwnerRegistration,
  PaneLayoutOwnerRegistration,
  PaneSide,
  PaneHandle,
  ShellContext,
  AttentionOptions,
  AttentionState,
  AttentionReporter,
  NotificationEvent,
  NotificationView,
  Notifier,
  SplitState,
  SplitController,
  ModeReaders,
  TerminalContext,
  TerminalEvents,
  RegionName,
  RegionSlot,
  RenderHandle,
  ScrollHandle,
  SessionRef,
  SessionView,
  ConnState,
  TablistController,
  TabHandle,
  Unsubscribe,
} from "./kernel/types.js";
