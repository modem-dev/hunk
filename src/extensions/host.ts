import { pathToFileURL } from "node:url";
import { findVcsRepoRootCandidate } from "../core/vcs";
import { resolveRepoTrust, type ExtensionTrustOptions, type ExtensionTrustState } from "./trust";
import {
  createEmptyExtensionRegistry,
  createExtensionContext,
  HUNK_EXTENSION_API_VERSION,
  type ChangesetTransform,
  type ExtensionCandidate,
  type ExtensionEventHandler,
  type ExtensionEventName,
  type ExtensionLoadIssue,
  type ExtensionLoadResult,
  type ExtensionMetadata,
  type ExtensionNotifySink,
  type ExtensionRegistry,
  type ExtensionThemeConfig,
  type HunkExtensionAPI,
} from "./types";
import type { VcsAdapter } from "../core/vcs/types";

export interface LoadExtensionsOptions {
  candidates: readonly ExtensionCandidate[];
  cwd: string;
  /** Per-extension `[extension.<id>]` config tables, keyed by extension id. */
  extensionConfigs?: Record<string, Record<string, unknown>>;
  /** Where `ctx.notify` messages go; no-ops until the UI owns a toast surface. */
  notify?: ExtensionNotifySink;
  /** Repo root repo-local candidates belong to; discovered from `cwd` when omitted. */
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Trust lookup seam so tests can drive gating without touching the state file. */
  resolveRepoTrustImpl?: (repoRoot: string, options: ExtensionTrustOptions) => ExtensionTrustState;
  /** Module loader seam; defaults to a plain dynamic import of the absolute path. */
  importExtensionModuleImpl?: (path: string) => Promise<unknown>;
}

/** Import one extension entry file by absolute path, cross-platform. */
async function importExtensionModule(path: string): Promise<unknown> {
  // File URLs are required on Windows, where a drive-letter path is not a valid specifier.
  return await import(pathToFileURL(path).href);
}

/** Read an error's message without assuming extensions throw `Error` instances. */
function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

/** Pull the default export factory out of an imported extension module. */
function readExtensionFactory(module: unknown) {
  const candidate = (module as { default?: unknown } | null)?.default;
  if (typeof candidate !== "function") {
    throw new Error("Extension must default-export a function that receives the Hunk API.");
  }

  return candidate as (hunk: HunkExtensionAPI) => void | Promise<void>;
}

/** Normalize a registered file extension to Pierre's dotless, lowercased form. */
function normalizeFileExtension(extension: string) {
  const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
  if (normalized.length === 0) {
    throw new Error("registerFileLanguage requires a non-empty file extension.");
  }

  return normalized;
}

/** Reject registrations that would leave the registry holding unusable entries. */
function assertNonEmptyString(value: unknown, message: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }

  return value;
}

interface ExtensionApiHandle {
  api: HunkExtensionAPI;
  /** Invalidate the API so deferred callbacks cannot mutate the registry later. */
  seal: () => void;
}

/** Registration counts captured before one extension runs, for failure rollback. */
interface RegistrySnapshot {
  themes: number;
  fileLanguages: number;
  vcsAdapters: number;
  changesetTransforms: number;
  eventHandlers: Record<string, number>;
}

/** Capture how much each registration list already holds. */
function snapshotRegistry(registry: ExtensionRegistry): RegistrySnapshot {
  const eventHandlers: Record<string, number> = {};
  for (const [event, handlers] of Object.entries(registry.eventHandlers)) {
    eventHandlers[event] = handlers.length;
  }

  return {
    themes: registry.themes.length,
    fileLanguages: registry.fileLanguages.length,
    vcsAdapters: registry.vcsAdapters.length,
    changesetTransforms: registry.changesetTransforms.length,
    eventHandlers,
  };
}

/**
 * Drop registrations made before an extension threw.
 *
 * A factory that fails halfway is not loaded, so its partial contributions must
 * not stay in the registry. Collected logs are kept as failure diagnostics.
 */
function rollbackRegistry(registry: ExtensionRegistry, snapshot: RegistrySnapshot) {
  registry.themes.length = snapshot.themes;
  registry.fileLanguages.length = snapshot.fileLanguages;
  registry.vcsAdapters.length = snapshot.vcsAdapters;
  registry.changesetTransforms.length = snapshot.changesetTransforms;
  for (const [event, handlers] of Object.entries(registry.eventHandlers)) {
    handlers.length = snapshot.eventHandlers[event] ?? 0;
  }
}

/**
 * Build the capability object for one extension.
 *
 * Every registration writes straight into the shared registry, tagged with the
 * owning extension id, and stops working once the factory has returned.
 */
function createExtensionApi(
  metadata: ExtensionMetadata,
  registry: ExtensionRegistry,
  config: Record<string, unknown>,
): ExtensionApiHandle {
  let sealed = false;

  /** Guard one registration call against use after the load pass finished. */
  const assertOpen = (method: string) => {
    if (sealed) {
      throw new Error(
        `${metadata.id}: hunk.${method}() can only be called while the extension is loading.`,
      );
    }
  };

  const api: HunkExtensionAPI = {
    apiVersion: HUNK_EXTENSION_API_VERSION,
    config,
    registerTheme(theme: ExtensionThemeConfig) {
      assertOpen("registerTheme");
      assertNonEmptyString(theme?.id, "registerTheme requires a theme with a non-empty id.");
      registry.themes.push({ extensionId: metadata.id, theme });
    },
    registerFileLanguage(extension: string, language: string) {
      assertOpen("registerFileLanguage");
      assertNonEmptyString(language, "registerFileLanguage requires a non-empty language.");
      registry.fileLanguages.push({
        extensionId: metadata.id,
        extension: normalizeFileExtension(extension),
        language,
      });
    },
    registerVcsAdapter(adapter: VcsAdapter) {
      assertOpen("registerVcsAdapter");
      assertNonEmptyString(adapter?.id, "registerVcsAdapter requires an adapter with an id.");
      assertNonEmptyString(adapter?.name, "registerVcsAdapter requires an adapter with a name.");
      if (typeof adapter.detect !== "function") {
        throw new Error("registerVcsAdapter requires an adapter with a detect() function.");
      }

      registry.vcsAdapters.push({ extensionId: metadata.id, adapter });
    },
    transformChangeset(fn: ChangesetTransform) {
      assertOpen("transformChangeset");
      if (typeof fn !== "function") {
        throw new Error("transformChangeset requires a function.");
      }

      registry.changesetTransforms.push({ extensionId: metadata.id, transform: fn });
    },
    on<Event extends ExtensionEventName>(event: Event, handler: ExtensionEventHandler<Event>) {
      assertOpen("on");
      const handlers = registry.eventHandlers[event];
      if (!handlers) {
        throw new Error(`Unknown Hunk extension event: ${String(event)}`);
      }
      if (typeof handler !== "function") {
        throw new Error(`on("${String(event)}") requires a handler function.`);
      }

      handlers.push({ extensionId: metadata.id, handler });
    },
    log(message: string) {
      // Logs are collected rather than printed: the TUI owns the terminal.
      registry.logs.push({ extensionId: metadata.id, message: String(message) });
    },
  };

  return {
    api,
    seal: () => {
      sealed = true;
    },
  };
}

/**
 * Load every discovered extension into one registry.
 *
 * Isolation is the contract here: a candidate that fails to import, has no
 * default export, or throws from its factory becomes an `ExtensionLoadIssue`
 * and is skipped. Repo-local candidates additionally require a recorded trust
 * decision; unknown ones are skipped and reported through
 * `pendingTrustRepoRoot` so the UI can ask and reload.
 */
export async function loadExtensions(options: LoadExtensionsOptions): Promise<ExtensionLoadResult> {
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  const loaded: ExtensionMetadata[] = [];
  const importModule = options.importExtensionModuleImpl ?? importExtensionModule;
  const resolveTrust = options.resolveRepoTrustImpl ?? resolveRepoTrust;
  const trustOptions: ExtensionTrustOptions = { env: options.env };

  let repoTrustState: ExtensionTrustState | undefined;
  let repoRoot = options.repoRoot;
  let pendingTrustRepoRoot: string | undefined;

  /** Resolve the repo trust state once per load pass, lazily. */
  const resolveRepoTrustState = () => {
    repoRoot ??= findVcsRepoRootCandidate(options.cwd);
    if (!repoRoot) {
      return "unknown" as const;
    }

    repoTrustState ??= resolveTrust(repoRoot, trustOptions);
    return repoTrustState;
  };

  for (const candidate of options.candidates) {
    if (candidate.origin === "repo") {
      const trust = resolveRepoTrustState();
      if (trust !== "trusted") {
        // Unknown trust is a question for the user; denied trust is already answered.
        if (trust === "unknown" && repoRoot) {
          pendingTrustRepoRoot = repoRoot;
        }
        continue;
      }
    }

    const metadata: ExtensionMetadata = {
      id: candidate.id,
      sourcePath: candidate.path,
      origin: candidate.origin,
    };
    const { api, seal } = createExtensionApi(
      metadata,
      registry,
      options.extensionConfigs?.[candidate.id] ?? {},
    );

    const snapshot = snapshotRegistry(registry);

    try {
      const factory = readExtensionFactory(await importModule(candidate.path));
      await factory(api);
      registry.extensions.push(metadata);
      loaded.push(metadata);
    } catch (error) {
      rollbackRegistry(registry, snapshot);
      issues.push({
        extensionId: candidate.id,
        path: candidate.path,
        origin: candidate.origin,
        message: describeError(error),
      });
    } finally {
      seal();
    }
  }

  const context = createExtensionContext(options.cwd, options.notify);
  return pendingTrustRepoRoot
    ? { registry, issues, loaded, context, pendingTrustRepoRoot }
    : { registry, issues, loaded, context };
}
