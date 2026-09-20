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
