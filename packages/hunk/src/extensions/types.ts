import { basename, dirname, extname } from "node:path";
import type { VcsAdapter } from "../core/vcs/types";
import type {
  ChangesetTransform,
  ExtensionCliCommand,
  ExtensionCliCommandHandler,
  ExtensionCommand,
  ExtensionCommandHandler,
  ExtensionContext,
  ExtensionCustomEventHandler,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionFileLanguageMatcher,
  ExtensionFileView,
  ExtensionKeyboardMode,
  ExtensionLineHighlighter,
  ExtensionNotifyType,
  ExtensionPane,
  ExtensionSessionOptions,
  ExtensionThemeConfig,
} from "../extension-api/types";
import { createExtensionNotificationHub, type ExtensionNotificationHub } from "./notifications";

/**
 * The authoring contract lives in `packages/hunk/src/extension-api/types.ts` and is re-exported
 * here so host code keeps one import site for both halves of the system. That
 * module is self-contained because its declarations are published; this one is
 * free to reference Hunk internals.
 */
export { HUNK_EXTENSION_API_VERSION } from "../extension-api/types";
export type {
  ChangesetTransform,
  ExtensionChangeset,
  ExtensionCliCommand,
  ExtensionCliCommandContext,
  ExtensionCliCommandHandler,
  ExtensionCliCommandResult,
  ExtensionCliDelegateResult,
  ExtensionCliExitResult,
  ExtensionCliWriter,
  ExtensionCommand,
  ExtensionCommandContext,
  ExtensionCommandHandler,
  ExtensionContext,
  ExtensionCustomEventHandler,
  ExtensionDiffFile,
  ExtensionEventBus,
  ExtensionEventContext,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionEventPayloads,
  ExtensionFileLanguageMatcher,
  ExtensionFileSide,
  ExtensionFileView,
  ExtensionFileViewControls,
  ExtensionFileViewModeKeyResult,
  ExtensionFactory,
  ExtensionKeyEvent,
  ExtensionKeyboardMode,
  ExtensionKeyboardModeKeyResult,
  ExtensionLineHighlighter,
  ExtensionReviewDescriptor,
  ExtensionReviewControls,
  ExtensionReviewReloadControls,
  ExtensionReviewReloadResult,
  ExtensionReviewNote,
  ExtensionReviewSnapshot,
  ExtensionReviewSnapshotFile,
  ExtensionReviewSnapshotLineAddress,
  ExtensionReviewSnapshotNote,
  ExtensionReviewSnapshotNoteAnchor,
  ExtensionNotifyType,
  ExtensionPane,
  ExtensionPaneControls,
  ExtensionSidebarView,
  ExtensionSessionOptions,
  ExtensionThemeConfig,
  ExtensionVcsAdapter,
  ExtensionVcsHistoryCapability,
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryDecoration,
  ExtensionVcsHistoryInput,
  ExtensionVcsHistoryPage,
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsHistoryReviewOptions,
  ExtensionVcsHistorySource,
  ExtensionWorkspace,
  ExtensionWorkspaceWriteRequest,
  ExtensionWorkspaceWriteResult,
  HunkExtensionAPI,
} from "../extension-api/types";

/**
 * Where one extension came from, which decides its trust posture.
 *
 * `bundled` is Hunk's own compiled-in tier (`packages/hunk/src/extensions/default/`): no
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
  /**
   * Minimum extension API version the folder's manifest requires
   * (`"hunk": { "apiVersion": N }`). The host refuses the candidate before
   * importing it when this Hunk's API is older.
   */
  requiresApiVersion?: number;
}

export interface RegisteredTheme {
  extensionId: string;
  theme: ExtensionThemeConfig;
}

export interface RegisteredFileLanguage {
  extensionId: string;
  matcher: ExtensionFileLanguageMatcher;
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

export interface RegisteredPane {
  extensionId: string;
  pane: ExtensionPane;
}

/** A host-rendered alternative file presentation registered by one extension. */
export interface RegisteredFileView {
  extensionId: string;
  view: ExtensionFileView;
}

/** A contributor of paint-time diff line marks registered by one extension. */
export interface RegisteredLineHighlighter {
  extensionId: string;
  highlighter: ExtensionLineHighlighter;
}

/** One session-scoped keyboard mode registered by an extension. */
export interface RegisteredKeyboardMode {
  extensionId: string;
  mode: ExtensionKeyboardMode;
}

export interface RegisteredCliCommand {
  extensionId: string;
  command: ExtensionCliCommand;
  handler: ExtensionCliCommandHandler;
}

export interface RegisteredCommand {
  extensionId: string;
  command: ExtensionCommand;
  handler: ExtensionCommandHandler;
}

/** One extension's host-level behavior request for the current session. */
export interface RegisteredSessionOptions {
  extensionId: string;
  options: ExtensionSessionOptions;
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
  sessionOptions: RegisteredSessionOptions[];
  themes: RegisteredTheme[];
  fileLanguages: RegisteredFileLanguage[];
  vcsAdapters: RegisteredVcsAdapter[];
  changesetTransforms: RegisteredChangesetTransform[];
  panes: RegisteredPane[];
  fileViews: RegisteredFileView[];
  lineHighlighters: RegisteredLineHighlighter[];
  keyboardModes: RegisteredKeyboardMode[];
  cliCommands: RegisteredCliCommand[];
  commands: RegisteredCommand[];
  eventHandlers: ExtensionEventHandlerMap;
  customEventHandlers: RegisteredCustomEventHandler[];
  /** Events raised by a factory, delivered after every factory has loaded. */
  pendingCustomEvents: PendingCustomEvent[];
  /** The bus accepts queued factory events only while this registry is loading. */
  eventBusPhase: "loading" | "ready" | "closed";
  /** Bound after loading so hunk.events.emit can dispatch at runtime. */
  emitCustomEvent?: (event: string, payload: unknown) => void;
  /** Shared completion for the one terminal retirement of this registry. */
  retirementPromise?: Promise<void>;
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
export interface ExtensionLoadState {
  /** Full discovery order used to build this registry, including refused candidates. */
  candidates: readonly ExtensionCandidate[];
  /** Config snapshot factories in this registry were created against. */
  extensionConfigs: Record<string, Record<string, unknown>>;
}

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
  /** Internal inputs retained so a staged pass can append newly discovered candidates safely. */
  loadState: ExtensionLoadState;
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
    sessionOptions: [],
    themes: [],
    fileLanguages: [],
    vcsAdapters: [],
    changesetTransforms: [],
    panes: [],
    fileViews: [],
    lineHighlighters: [],
    keyboardModes: [],
    cliCommands: [],
    commands: [],
    eventHandlers: {
      startup: [],
      changeset_loaded: [],
      command_executed: [],
      selection_changed: [],
      file_viewed: [],
      hunk_viewed: [],
      filter_changed: [],
      theme_changed: [],
      layout_changed: [],
      watch_reload_pending: [],
      note_created: [],
      note_edited: [],
      note_changed: [],
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
    loadState: { candidates: [], extensionConfigs: {} },
  };
}
