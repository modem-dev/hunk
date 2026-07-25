export { discoverExtensions, type DiscoverExtensionsOptions } from "./discovery";
export { loadExtensions, type LoadExtensionsOptions } from "./host";
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
  ExtensionLoadIssue,
  ExtensionLoadResult,
  ExtensionLogEntry,
  ExtensionMetadata,
  ExtensionNotifySink,
  ExtensionNotifyType,
  ExtensionOrigin,
  ExtensionRegistry,
  ExtensionThemeConfig,
  HunkExtensionAPI,
  HunkExtensionApiVersion,
  RegisteredChangesetTransform,
  RegisteredEventHandler,
  RegisteredFileLanguage,
  RegisteredTheme,
  RegisteredVcsAdapter,
} from "./types";
