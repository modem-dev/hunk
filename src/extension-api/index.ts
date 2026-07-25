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
 * to keep stable for the declared `apiVersion`.
 */
export { HUNK_EXTENSION_API_VERSION } from "../extensions/types";
export type {
  ChangesetTransform,
  ExtensionContext,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionEventPayloads,
  ExtensionFactory,
  ExtensionNotifyType,
  ExtensionThemeConfig,
  HunkExtensionAPI,
  HunkExtensionApiVersion,
  SessionReloadReason,
} from "../extensions/types";
export type { AgentAnnotation, AgentFileContext, Changeset, DiffFile } from "../core/types";
export type {
  VcsAdapter,
  VcsDetection,
  VcsLoadContext,
  VcsOperation,
  VcsOperations,
  VcsPatchResult,
  VcsReviewInput,
  VcsReviewOperation,
  VcsReviewOperationKind,
} from "../core/vcs/types";
