/**
 * Public authoring surface for Hunk extensions, published as `hunkdiff/extension`.
 *
 * Extensions import types from here and default-export a factory:
 *
 * ```ts
 * import type { HunkExtensionAPI } from "hunkdiff/extension";
 *
 * export default function (hunk: HunkExtensionAPI) {
 *   hunk.registerFileLanguage(".prisma", "graphql");
 * }
 * ```
 *
 * Only façade types belong here. Everything exported is something Hunk intends
 * to keep stable for the declared `apiVersion`, and everything is declared in
 * `./types` so the published declarations stay free of Hunk internals.
 */
export {
  HUNK_CORE_VCS_DETECTION_PRIORITY,
  HUNK_DEFAULT_VCS_DETECTION_PRIORITY,
  HUNK_EXTENSION_API_VERSION,
  HUNK_EXTENSION_USER_ERROR_NAME,
  HunkExtensionUserError,
} from "./types";
export type {
  AgentAnnotation,
  AgentFileContext,
  ChangesetTransform,
  CustomSyntaxColorsConfig,
  CustomSyntaxScopesConfig,
  CustomThemeConfig,
  ExtensionChangeset,
  ExtensionContext,
  ExtensionDiffFile,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionEventPayloads,
  ExtensionFactory,
  ExtensionNotifyType,
  ExtensionThemeConfig,
  ExtensionVcsAdapter,
  ExtensionVcsDetection,
  ExtensionVcsDiffInput,
  ExtensionVcsDirectoryEntriesWatchTarget,
  ExtensionVcsDirectoryTreeWatchTarget,
  ExtensionVcsExtraFile,
  ExtensionVcsExtraPatchFile,
  ExtensionVcsFileChangeType,
  ExtensionVcsFileSide,
  ExtensionVcsFileSourceReader,
  ExtensionVcsFileSourceRequest,
  ExtensionVcsFileStats,
  ExtensionVcsLoadContext,
  ExtensionVcsOperation,
  ExtensionVcsOperations,
  ExtensionVcsPatchResult,
  ExtensionVcsReviewOptions,
  ExtensionVcsShowInput,
  ExtensionVcsSkippedFile,
  ExtensionVcsSkippedFileReason,
  ExtensionVcsStashShowInput,
  ExtensionVcsWatchPlan,
  ExtensionVcsWatchTarget,
  ExtensionVcsWatchTargetSource,
  HunkExtensionAPI,
  HunkExtensionApiVersion,
  HunkExtensionUserErrorOptions,
  NamedCustomThemeConfig,
  SessionReloadReason,
} from "./types";
