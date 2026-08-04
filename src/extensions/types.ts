import { basename, dirname, extname } from "node:path";
import type { VcsAdapter } from "../core/vcs/types";
import type {
  ChangesetTransform,
  ExtensionCommand,
  ExtensionCommandHandler,
  ExtensionContext,
  ExtensionCustomEventHandler,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionFileView,
  ExtensionNotifyType,
  ExtensionSidebarView,
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
  ExtensionCommand,
  ExtensionCommandContext,
  ExtensionCommandHandler,
  ExtensionConfirmOptions,
  ExtensionContext,
  ExtensionCustomEventHandler,
  ExtensionDialogs,
  ExtensionDiffFile,
  ExtensionEventBus,
  ExtensionEventContext,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionEventPayloads,
  ExtensionFileChangeRange,
  ExtensionFileSide,
  ExtensionFileView,
  ExtensionFileViewControls,
  ExtensionFileViewInput,
  ExtensionFileViewLayout,
  ExtensionFileViewRow,
  ExtensionFileViewRowComponentProps,
  ExtensionFileViewSourceRange,
  ExtensionFileViewSpan,
  ExtensionFactory,
  ExtensionInputOptions,
  ExtensionReviewNote,
  ExtensionNotifyType,
  ExtensionPaintTheme,
  ExtensionSelectOptions,
  ExtensionSidebarActions,
  ExtensionSidebarComponent,
  ExtensionSidebarControls,
  ExtensionSidebarPlacement,
  ExtensionSidebarTheme,
  ExtensionSidebarView,
  ExtensionSidebarViewProps,
  ExtensionThemeConfig,
  ExtensionVcsAdapter,
  ExtensionWorkspace,
  ExtensionWorkspaceWriteRequest,
  ExtensionWorkspaceWriteResult,
  HunkExtensionAPI,
  HunkExtensionApiVersion,
  SessionReloadReason,
} from "../extension-api/types";

/**
 * Where one extension came from, which decides its trust posture.
 *
 * `bundled` is Hunk's own compiled-in tier (`src/extensions/default/`): no
 * discovery, no trust prompt, and never disabled by `--no-extensions`. Every
 * other origin is a user extension loaded from disk.
 */
export type ExtensionOrigin = "bundled" | "global" | "repo" | "config" | "flag";

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

export interface RegisteredSidebarView {
  extensionId: string;
  view: ExtensionSidebarView;
}

/** A host-rendered alternative file presentation registered by one extension. */
export interface RegisteredFileView {
  extensionId: string;
  view: ExtensionFileView;
}

export interface RegisteredCommand {
  extensionId: string;
  command: ExtensionCommand;
  handler: ExtensionCommandHandler;
}

export interface RegisteredEventHandler<Event extends ExtensionEventName = ExtensionEventName> {
  extensionId: string;
  handler: ExtensionEventHandler<Event>;
}

/** One extension listener on a named inter-extension bus channel. */
export interface RegisteredCustomEventHandler {
  extensionId: string;
  event: string;
  handler: ExtensionCustomEventHandler;
}

/** One bus event emitted while extension factories are still loading. */
export interface PendingCustomEvent {
  extensionId: string;
  event: string;
  payload: unknown;
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
  sidebarViews: RegisteredSidebarView[];
  fileViews: RegisteredFileView[];
  commands: RegisteredCommand[];
  eventHandlers: ExtensionEventHandlerMap;
  customEventHandlers: RegisteredCustomEventHandler[];
  /** Events raised by a factory, delivered after every factory has loaded. */
  pendingCustomEvents: PendingCustomEvent[];
  /** The bus accepts queued factory events only while this registry is loading. */
  eventBusPhase: "loading" | "ready" | "closed";
  /** Bound after loading so hunk.events.emit can dispatch at runtime. */
  emitCustomEvent?: (event: string, payload: unknown) => void;
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
  /** UI installs this per-extension context factory once sidebar controls exist. */
  eventContextProvider?: (
    extensionId: string,
  ) => import("../extension-api/types").ExtensionEventContext;
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
    sidebarViews: [],
    fileViews: [],
    commands: [],
    eventHandlers: {
      startup: [],
      changeset_loaded: [],
      selection_changed: [],
      file_viewed: [],
      filter_changed: [],
      theme_changed: [],
      layout_changed: [],
      watch_reload_pending: [],
      note_created: [],
      note_edited: [],
      session_reload: [],
      shutdown: [],
    },
    customEventHandlers: [],
    pendingCustomEvents: [],
    eventBusPhase: "loading",
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
