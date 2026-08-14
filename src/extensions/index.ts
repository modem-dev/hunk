export {
  applyExtensionChangesetTransforms,
  applyExtensionFileLanguages,
  applyExtensionRegistrations,
  applyExtensionSyntaxLanguages,
  createExtensionApplyNotices,
  reportExtensionApplyIssues,
  resolveDetectedVcsIdWithExtensions,
  resolveExtensionCommands,
  resolveExtensionKeyboardModes,
  resolveExtensionPanes,
  resolveExtensionVcsAdapters,
  paneKey,
  type AppliedExtensionRegistrations,
  type ExtensionApplyIssue,
  type ResolvedExtensionCommands,
  type ResolvedExtensionKeyboardModes,
  type ResolvedExtensionPanes,
} from "./apply";
export {
  getBundledVcsAdapters,
  loadBundledExtensions,
  type BundledExtensionLoad,
} from "./default/vcs";
export { discoverExtensions, type DiscoverExtensionsOptions } from "./discovery";
export {
  emitExtensionEvent,
  emitExtensionEventBounded,
  EXTENSION_SHUTDOWN_TIMEOUT_MS,
} from "./events";
export { loadExtensions, type LoadExtensionsOptions } from "./host";
export {
  createExtensionNotificationHub,
  type ExtensionNotification,
  type ExtensionNotificationHub,
  type ExtensionNotificationListener,
} from "./notifications";
export {
  createExtensionApi,
  runExtensionFactory,
  type RunExtensionFactoryOptions,
} from "./runExtension";
export {
  createExtensionLoadNotices,
  loadStartupExtensions,
  mergeStartupNotices,
  type LoadStartupExtensionsOptions,
} from "./startup";
export {
  readExtensionTrust,
  resolveRepoTrust,
  writeExtensionTrust,
  type ExtensionTrustDecision,
  type ExtensionTrustMap,
  type ExtensionTrustOptions,
  type ExtensionTrustState,
} from "./trust";
export {
  createEmptyExtensionLoadResult,
  createEmptyExtensionRegistry,
  createExtensionContext,
  deriveExtensionId,
  HUNK_EXTENSION_API_VERSION,
} from "./types";
export type {
  ChangesetTransform,
  ExtensionCandidate,
  ExtensionContext,
  ExtensionEventHandler,
  ExtensionEventHandlerMap,
  ExtensionEventName,
  ExtensionEventPayloads,
  ExtensionFactory,
  ExtensionKeyboardMode,
  ExtensionKeyboardModeContext,
  ExtensionKeyboardModeControls,
  ExtensionKeyboardModeKeyResult,
  ExtensionLoadIssue,
  ExtensionLoadResult,
  ExtensionLogEntry,
  ExtensionMetadata,
  ExtensionNotifySink,
  ExtensionNotifyType,
  ExtensionOrigin,
  ExtensionRegistry,
  ExtensionSyntaxGrammar,
  ExtensionSyntaxLanguageLoader,
  ExtensionThemeConfig,
  HunkExtensionAPI,
  HunkExtensionApiVersion,
  RegisteredChangesetTransform,
  RegisteredCommand,
  RegisteredEventHandler,
  RegisteredFileLanguage,
  RegisteredKeyboardMode,
  RegisteredPane,
  RegisteredSyntaxLanguage,
  RegisteredTheme,
  RegisteredVcsAdapter,
  SessionReloadReason,
} from "./types";
