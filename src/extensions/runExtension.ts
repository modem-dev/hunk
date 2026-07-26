import {
  HUNK_EXTENSION_API_VERSION,
  type ChangesetTransform,
  type ExtensionEventHandler,
  type ExtensionEventName,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type ExtensionMetadata,
  type ExtensionRegistry,
  type ExtensionThemeConfig,
  type ExtensionVcsAdapter,
  type HunkExtensionAPI,
} from "./types";
import { toUserFacingError } from "../core/errors";
import { toInternalVcsPatchResult } from "./vcsPatchResult";
import type { ExtensionVcsOperation } from "../extension-api/types";
import type { VcsAdapter, VcsOperation, VcsReviewInput } from "../core/vcs/types";

/**
 * Running one extension factory into the shared registry.
 *
 * This module deliberately imports nothing from `src/core/vcs` beyond its
 * types: it is what the bundled tier (`./bundled`) uses, and that tier is
 * loaded *from* VCS adapter resolution. Keeping the dependency one-way means
 * bundled loading cannot deadlock on a half-initialized module.
 */

/** Read an error's message without assuming extensions throw `Error` instances. */
export function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
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

/** Report whether one value is a plain object rather than an array or null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Report whether one value is promise-like, so async factories can be awaited. */
function isThenable(value: unknown): value is Promise<void> {
  return typeof (value as Promise<void> | undefined)?.then === "function";
}

/**
 * Wrap one published operation so everything it produces arrives internal.
 *
 * Two translations happen here and nowhere else. The published patch result is
 * converted into the diff model Hunk reviews, so an adapter describes files
 * instead of assembling them. And whatever the operation threw is normalized,
 * so an adapter that raises the published user-facing error reaches the user as
 * a clean message with suggestions rather than a stack trace.
 */
function toInternalVcsOperation(
  operation: ExtensionVcsOperation<VcsReviewInput>,
): VcsOperation<VcsReviewInput> {
  const { watchSignature, watchPlan } = operation;

  return {
    async load(input, context) {
      try {
        return toInternalVcsPatchResult(await operation.load(input, context));
      } catch (error) {
        throw toUserFacingError(error);
      }
    },
    // Watch support stays optional inward as well as outward: an absent hook is
    // what tells planning to fall back to signature polling.
    ...(watchSignature && {
      watchSignature(input, context) {
        try {
          return watchSignature(input, context);
        } catch (error) {
          throw toUserFacingError(error);
        }
      },
    }),
    ...(watchPlan && {
      watchPlan(input, context) {
        try {
          return watchPlan(input, context);
        } catch (error) {
          throw toUserFacingError(error);
        }
      },
    }),
  };
}

/**
 * Accept the public adapter shape as the internal one.
 *
 * The published surface leaves `operations` optional, and Hunk's internal
 * adapter type requires it, so an adapter registered without operations gets an
 * empty map here. That is the conversion boundary: everything downstream —
 * detection, operation lookup, the unsupported-operation error — can then rely
 * on the map existing instead of guarding a value only a JS extension can omit.
 *
 * An entry whose `load` is not callable is dropped rather than wrapped: only an
 * untyped extension can produce one, and leaving it out makes the command
 * report "not supported" instead of failing with a TypeError mid-review.
 *
 * `detectionPriority` needs no conversion: the published watch-plan shape is
 * the same declaration core planning consumes, so it flows inward whole.
 */
export function toInternalVcsAdapter(adapter: ExtensionVcsAdapter): VcsAdapter {
  const operations = adapter.operations;
  if (operations !== undefined && !isPlainObject(operations)) {
    throw new Error("registerVcsAdapter requires operations to be an object of review operations.");
  }

  const internalOperations: Record<string, VcsOperation<VcsReviewInput>> = {};
  for (const [kind, operation] of Object.entries(operations ?? {})) {
    if (isPlainObject(operation) && typeof operation.load === "function") {
      internalOperations[kind] = toInternalVcsOperation(
        operation as unknown as ExtensionVcsOperation<VcsReviewInput>,
      );
    }
  }

  return { ...adapter, operations: internalOperations };
}

/** Pull the default export factory out of an imported extension module. */
export function readExtensionFactory(module: unknown): ExtensionFactory {
  const candidate = (module as { default?: unknown } | null)?.default;
  if (typeof candidate !== "function") {
    throw new Error("Extension must default-export a function that receives the Hunk API.");
  }

  return candidate as ExtensionFactory;
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
export function createExtensionApi(
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
    registerVcsAdapter(adapter: ExtensionVcsAdapter) {
      assertOpen("registerVcsAdapter");
      assertNonEmptyString(adapter?.id, "registerVcsAdapter requires an adapter with an id.");
      assertNonEmptyString(adapter?.name, "registerVcsAdapter requires an adapter with a name.");
      if (typeof adapter.detect !== "function") {
        throw new Error("registerVcsAdapter requires an adapter with a detect() function.");
      }

      registry.vcsAdapters.push({
        extensionId: metadata.id,
        adapter: toInternalVcsAdapter(adapter),
      });
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

export interface RunExtensionFactoryOptions {
  metadata: ExtensionMetadata;
  registry: ExtensionRegistry;
  /** Failure sink; a factory that throws appends here instead of propagating. */
  issues: ExtensionLoadIssue[];
  factory: ExtensionFactory;
  /** The extension's own `[extension.<id>]` table, empty when it has none. */
  config?: Record<string, unknown>;
}

/**
 * Run one extension factory into the registry, isolated from every other one.
 *
 * A factory that throws is rolled back to its pre-run registration counts and
 * reported as a load issue, so a broken extension costs a notice rather than
 * the session.
 *
 * The return type is the seam between the two tiers: a *synchronous* factory is
 * fully applied — success recorded, or failure rolled back and reported —
 * before this returns, and nothing is handed back to await. Only a factory that
 * returns a promise produces one. That is what lets the bundled tier load its
 * synchronous factories from a synchronous call site while sharing this exact
 * policy with user extensions, instead of reimplementing it.
 */
export function runExtensionFactory({
  metadata,
  registry,
  issues,
  factory,
  config = {},
}: RunExtensionFactoryOptions): void | Promise<void> {
  const snapshot = snapshotRegistry(registry);
  const { api, seal } = createExtensionApi(metadata, registry, config);

  /** Record one failure and drop whatever the factory registered before it. */
  const fail = (error: unknown) => {
    rollbackRegistry(registry, snapshot);
    issues.push({
      extensionId: metadata.id,
      path: metadata.sourcePath,
      origin: metadata.origin,
      message: describeError(error),
    });
  };

  let pending: void | Promise<void>;
  try {
    pending = factory(api);
  } catch (error) {
    seal();
    fail(error);
    return;
  }

  if (!isThenable(pending)) {
    seal();
    registry.extensions.push(metadata);
    return;
  }

  return pending.then(
    () => {
      seal();
      registry.extensions.push(metadata);
    },
    (error: unknown) => {
      seal();
      fail(error);
    },
  );
}
