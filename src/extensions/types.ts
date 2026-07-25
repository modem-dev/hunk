import { basename, dirname, extname } from "node:path";
import type { Changeset, NamedCustomThemeConfig } from "../core/types";
import type { VcsAdapter } from "../core/vcs/types";
import { createExtensionNotificationHub, type ExtensionNotificationHub } from "./notifications";

/**
 * Version of the extension API surface handed to extension factories.
 *
 * Extensions can branch on `hunk.apiVersion` so a newer Hunk can keep loading
 * older extensions without guessing at their expectations.
 */
export const HUNK_EXTENSION_API_VERSION = 1;
export type HunkExtensionApiVersion = typeof HUNK_EXTENSION_API_VERSION;

/** Where one extension entry file came from, which decides its trust posture. */
export type ExtensionOrigin = "global" | "repo" | "config" | "flag";

/**
 * A theme contributed by an extension.
 *
 * Identical to a `[themes.<id>]` config table, so config-defined and
 * extension-contributed themes share one validation and merge path.
 */
export type ExtensionThemeConfig = NamedCustomThemeConfig;

export type ExtensionNotifyType = "info" | "warning" | "error";

/** Sink the host routes `ctx.notify` through; the UI supplies a real toast later. */
export type ExtensionNotifySink = (message: string, type: ExtensionNotifyType) => void;

/** Capability object handed to every extension event handler and transform. */
export interface ExtensionContext {
  cwd: string;
  notify(message: string, type?: ExtensionNotifyType): void;
}

/** Rewrite a loaded changeset before it reaches the review UI. */
export type ChangesetTransform = (
  changeset: Changeset,
  ctx: ExtensionContext,
) => Changeset | Promise<Changeset>;

/**
 * Why a session reload happened.
 *
 * `watch` is a file/VCS change Hunk noticed itself, `daemon` is an agent
 * command routed through the session broker, and `manual` is a user action
 * (the refresh key, or reloading after granting repo-extension trust).
 */
export type SessionReloadReason = "watch" | "daemon" | "manual";

/** Payload delivered with each lifecycle event, keyed by event name. */
export interface ExtensionEventPayloads {
  startup: { cwd: string };
  changeset_loaded: { changeset: Changeset };
  selection_changed: { fileId: string | null; hunkIndex: number | null };
  session_reload: { changeset: Changeset; reason: SessionReloadReason };
  shutdown: Record<string, never>;
}

export type ExtensionEventName = keyof ExtensionEventPayloads;

export type ExtensionEventHandler<Event extends ExtensionEventName = ExtensionEventName> = (
  payload: ExtensionEventPayloads[Event],
  ctx: ExtensionContext,
) => void | Promise<void>;

/**
 * The whole capability surface an extension is granted.
 *
 * Registration calls are only valid while the extension factory is running;
 * the host invalidates the object afterwards so deferred callbacks cannot
 * mutate the registry mid-session.
 */
export interface HunkExtensionAPI {
  readonly apiVersion: HunkExtensionApiVersion;
  /** Contribute one selectable theme. */
  registerTheme(theme: ExtensionThemeConfig): void;
  /** Map one file extension (with or without a leading dot) to a highlight language. */
  registerFileLanguage(extension: string, language: string): void;
  /** Contribute one additional VCS backend. */
  registerVcsAdapter(adapter: VcsAdapter): void;
  /** Rewrite every loaded changeset before review. */
  transformChangeset(fn: ChangesetTransform): void;
  /** Subscribe to one Hunk lifecycle event. */
  on<Event extends ExtensionEventName>(event: Event, handler: ExtensionEventHandler<Event>): void;
  /** This extension's own `[extension.<id>]` config table. */
  readonly config: Record<string, unknown>;
  /** Record a diagnostic line; collected per extension instead of written to the terminal. */
  log(message: string): void;
}

/** Default export every extension entry file must provide. */
export type ExtensionFactory = (hunk: HunkExtensionAPI) => void | Promise<void>;

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
