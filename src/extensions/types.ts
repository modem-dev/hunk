import { basename, dirname, extname } from "node:path";
import type { VcsAdapter } from "../core/vcs/types";
import type {
  ChangesetTransform,
  ExtensionContext,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionNotifyType,
  ExtensionThemeConfig,
} from "../extension-api/types";
import { createExtensionNotificationHub, type ExtensionNotificationHub } from "./notifications";

/**
 * The authoring contract lives in `src/extension-api/types.ts` and is re-exported
 * here so host code keeps one import site for both halves of the system. That
 * module is self-contained because its declarations are published; this one is
 * free to reference Hunk internals.
 */
export { HUNK_EXTENSION_API_VERSION } from "../extension-api/types";
export type {
  ChangesetTransform,
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
  HunkExtensionAPI,
  HunkExtensionApiVersion,
  SessionReloadReason,
} from "../extension-api/types";

/** Where one extension entry file came from, which decides its trust posture. */
export type ExtensionOrigin = "global" | "repo" | "config" | "flag";

/** Sink the host routes `ctx.notify` through; the UI supplies a real toast later. */
export type ExtensionNotifySink = (message: string, type: ExtensionNotifyType) => void;

/** Identity of one loaded extension, carried on everything it registered. */
export interface ExtensionMetadata {
  id: string;
  sourcePath: string;
  origin: ExtensionOrigin;
}

/** One extension entry file discovery found, before it is imported. */
export interface ExtensionCandidate {
  id: string;
  /** Absolute, resolved path to the entry file. */
  path: string;
  origin: ExtensionOrigin;
}

export interface RegisteredTheme {
  extensionId: string;
  theme: ExtensionThemeConfig;
}

export interface RegisteredFileLanguage {
  extensionId: string;
  /** Normalized extension without a leading dot, lowercased. */
  extension: string;
  language: string;
}

export interface RegisteredVcsAdapter {
  extensionId: string;
  adapter: VcsAdapter;
}

export interface RegisteredChangesetTransform {
  extensionId: string;
  transform: ChangesetTransform;
}

export interface RegisteredEventHandler<Event extends ExtensionEventName = ExtensionEventName> {
  extensionId: string;
  handler: ExtensionEventHandler<Event>;
}

export interface ExtensionLogEntry {
  extensionId: string;
  message: string;
}

export type ExtensionEventHandlerMap = {
  [Event in ExtensionEventName]: Array<RegisteredEventHandler<Event>>;
};

/** Everything extensions registered, in load order, for the rest of the app to consume. */
export interface ExtensionRegistry {
  extensions: ExtensionMetadata[];
  themes: RegisteredTheme[];
  fileLanguages: RegisteredFileLanguage[];
  vcsAdapters: RegisteredVcsAdapter[];
  changesetTransforms: RegisteredChangesetTransform[];
  eventHandlers: ExtensionEventHandlerMap;
  logs: ExtensionLogEntry[];
}

/** One extension that could not be loaded, surfaced as a startup notice. */
export interface ExtensionLoadIssue {
  extensionId: string;
  path: string;
  origin: ExtensionOrigin;
  message: string;
}

/** Result of one extension load pass. */
export interface ExtensionLoadResult {
  registry: ExtensionRegistry;
  issues: ExtensionLoadIssue[];
  loaded: ExtensionMetadata[];
  /**
   * The one context every handler and transform from this pass is invoked with,
   * so notifications from any extension land in the same sink.
   */
  context: ExtensionContext;
  /**
   * The sink behind `context.notify`, kept on the result so the UI can attach
   * its toast surface and so a later load pass (after a trust grant) can reuse
   * the same hub instead of orphaning the UI's subscription.
   */
  notifications: ExtensionNotificationHub;
  /**
   * Repo root holding repo-local extensions that have no trust decision yet.
   * Set only when such extensions exist and were therefore skipped, so the UI
   * can prompt and reload.
   */
  pendingTrustRepoRoot?: string;
}

/**
 * Derive the stable id one extension is known by.
 *
 * `foo.ts` and `foo/index.ts` both resolve to `foo`, so moving a single-file
 * extension into a folder keeps its `[extension.<id>]` config table working.
 */
export function deriveExtensionId(entryPath: string) {
  const stem = basename(entryPath, extname(entryPath));
  if (stem !== "index") {
    return stem;
  }

  const parent = basename(dirname(entryPath));
  return parent.length > 0 ? parent : stem;
}

/** Build the empty registry used before loading and whenever extensions are disabled. */
export function createEmptyExtensionRegistry(): ExtensionRegistry {
  return {
    extensions: [],
    themes: [],
    fileLanguages: [],
    vcsAdapters: [],
    changesetTransforms: [],
    eventHandlers: {
      startup: [],
      changeset_loaded: [],
      selection_changed: [],
      session_reload: [],
      shutdown: [],
    },
    logs: [],
  };
}

/** Build the context handed to extension handlers and transforms. */
export function createExtensionContext(
  cwd: string,
  notify?: ExtensionNotifySink,
): ExtensionContext {
  return {
    cwd,
    notify(message: string, type: ExtensionNotifyType = "info") {
      notify?.(message, type);
    },
  };
}

/** Build the result used when extensions are disabled or nothing was discovered. */
export function createEmptyExtensionLoadResult(
  cwd: string = process.cwd(),
  notifications: ExtensionNotificationHub = createExtensionNotificationHub(),
): ExtensionLoadResult {
  return {
    registry: createEmptyExtensionRegistry(),
    issues: [],
    loaded: [],
    context: createExtensionContext(cwd, notifications.notify),
    notifications,
  };
}
