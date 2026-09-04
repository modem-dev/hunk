import {
  HUNK_EXTENSION_API_VERSION,
  type ChangesetTransform,
  type ExtensionCliCommand,
  type ExtensionCliCommandHandler,
  type ExtensionEventHandler,
  type ExtensionEventName,
  type ExtensionFactory,
  type ExtensionFileLanguageMatcher,
  type ExtensionLoadIssue,
  type ExtensionCommand,
  type ExtensionCommandHandler,
  type ExtensionCustomEventHandler,
  type ExtensionEventBus,
  type ExtensionMetadata,
  type ExtensionRegistry,
  type ExtensionPane,
  type ExtensionSidebarView,
  type ExtensionSessionOptions,
  type ExtensionFileView,
  type ExtensionKeyboardMode,
  type ExtensionLineHighlighter,
  type ExtensionThemeConfig,
  type ExtensionVcsAdapter,
  type HunkExtensionAPI,
} from "./types";
import { parseKeyChord, toKeyChordList } from "../lib/commandKeys";
import { toUserFacingError } from "../core/run/errors";
import { toInternalVcsPatchResult } from "./vcsPatchResult";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsHistorySource,
  ExtensionVcsOperation,
} from "../extension-api/types";
import type { VcsAdapter, VcsHistorySource, VcsOperation, VcsReviewInput } from "../core/vcs/types";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../lib/terminalText";
import { defaultExtensionPaneSize, extensionPaneSize, isVerticalPanePlacement } from "./panes";
import {
  isReservedExtensionCliCommandName,
  isValidExtensionCliCommandName,
} from "../core/run/cliCommandNames";
import { copyExtensionCliCommand } from "./cliCommands";

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

/** Normalize a registered file extension to a dotless, lowercased selector. */
function normalizeFileExtension(extension: unknown): string {
  const value = assertNonEmptyString(
    extension,
    "registerFileLanguage requires a non-empty file extension.",
  );
  const normalized = value.trim().replace(/^\.+/, "").toLowerCase();
  if (normalized.length === 0) {
    throw new Error("registerFileLanguage requires a non-empty file extension.");
  }

  return normalized;
}

/** Validate and copy one public file-language matcher into its canonical shape. */
function normalizeFileLanguageMatcher(matcher: unknown): ExtensionFileLanguageMatcher {
  if (typeof matcher === "string") {
    return { kind: "extension", value: normalizeFileExtension(matcher) };
  }
  if (!isPlainObject(matcher)) {
    throw new Error("registerFileLanguage requires an extension string or matcher object.");
  }

  if (typeof matcher.value !== "string" || matcher.value.length === 0) {
    throw new Error("registerFileLanguage matcher value must be a non-empty string.");
  }
  const value = matcher.value;

  if (matcher.kind === "extension") {
    return { kind: "extension", value: normalizeFileExtension(value) };
  }
  if (matcher.kind === "filename") {
    if (value.includes("/")) {
      throw new Error("registerFileLanguage filename matchers cannot contain `/`.");
    }
    return { kind: "filename", value };
  }
  if (matcher.kind === "glob") {
    if (matcher.target !== "basename" && matcher.target !== "path") {
      throw new Error('registerFileLanguage glob target must be "basename" or "path".');
    }
    if (value.includes("\0")) {
      throw new Error("registerFileLanguage glob matchers cannot contain NUL.");
    }
    // Construct once during loading so any runtime rejection still rolls the factory back cleanly.
    new Bun.Glob(value);
    return { kind: "glob", value, target: matcher.target };
  }

  throw new Error('registerFileLanguage matcher kind must be "extension", "filename", or "glob".');
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

/** Snapshot named properties once so accessors cannot change values after validation. */
function snapshotProperties(value: Record<string, unknown>, keys: readonly string[]) {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) snapshot[key] = value[key];
  return snapshot;
}

/** Snapshot an array's length and each accepted element once, including for proxied arrays. */
function snapshotArray(value: unknown[], maximum = Number.MAX_SAFE_INTEGER) {
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new Error("VCS history returned more values than allowed.");
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) snapshot.push(value[index]);
  return snapshot;
}

/** Copy and validate one extension-provided history commit before it reaches core or UI. */
function normalizeHistoryCommit(value: unknown): ExtensionVcsHistoryCommit {
  if (!isPlainObject(value)) {
    throw new Error("VCS history returned a commit that is not an object.");
  }
  const snapshot = snapshotProperties(value, [
    "revisionId",
    "displayId",
    "parentRevisionIds",
    "graphParentRevisionIds",
    "subject",
    "body",
    "authorName",
    "authorEmail",
    "authoredAt",
    "decorations",
    "logicalId",
  ]);
  const required = (key: string) =>
    assertNonEmptyString(snapshot[key], `VCS history commit ${key} must be a non-empty string.`);
  const safeDisplay = (key: "displayId" | "subject" | "authorName") => {
    const text = sanitizeTerminalLine(required(key)).replaceAll("\t", " ");
    if (text.trim().length === 0) {
      throw new Error(`VCS history commit ${key} must remain non-empty after sanitization.`);
    }
    return text;
  };
  const safeRevision = (revision: unknown, label: string) => {
    const text = assertNonEmptyString(revision, `${label} must be a non-empty string.`);
    if (text.includes("\t") || sanitizeTerminalLine(text) !== text) {
      throw new Error(`${label} must be a terminal-safe immutable revision id.`);
    }
    return text;
  };
  const revisionId = safeRevision(snapshot.revisionId, "VCS history commit revisionId");
  const displayId = safeDisplay("displayId");
  const authoredAt = required("authoredAt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(authoredAt) ||
    Number.isNaN(Date.parse(authoredAt))
  ) {
    throw new Error("VCS history commit authoredAt must be an ISO timestamp.");
  }
  if (!Array.isArray(snapshot.parentRevisionIds)) {
    throw new Error("VCS history commit parentRevisionIds must be an array.");
  }
  if (
    snapshot.graphParentRevisionIds !== undefined &&
    !Array.isArray(snapshot.graphParentRevisionIds)
  ) {
    throw new Error("VCS history commit graphParentRevisionIds must be an array when present.");
  }
  if (!Array.isArray(snapshot.decorations)) {
    throw new Error("VCS history commit decorations must be an array.");
  }

  const parentValues = snapshotArray(snapshot.parentRevisionIds, 256);
  const graphParentValues = Array.isArray(snapshot.graphParentRevisionIds)
    ? snapshotArray(snapshot.graphParentRevisionIds, 256)
    : undefined;
  const decorationValues = snapshotArray(snapshot.decorations, 256);
  const parentRevisionIds = parentValues.map((parent) =>
    safeRevision(parent, "VCS history parent revision id"),
  );
  const graphParentRevisionIds = graphParentValues?.map((parent) =>
    safeRevision(parent, "VCS history graph parent revision id"),
  );
  const decorationKinds = new Set(["head", "local-branch", "remote-branch", "tag", "ref"]);
  const decorations = decorationValues.map((decoration) => {
    if (!isPlainObject(decoration)) {
      throw new Error("VCS history returned an invalid decoration.");
    }
    const fields = snapshotProperties(decoration, ["kind", "label", "attachedLocalBranch"]);
    if (typeof fields.kind !== "string" || !decorationKinds.has(fields.kind)) {
      throw new Error("VCS history returned an invalid decoration.");
    }
    const kind = fields.kind as ExtensionVcsHistoryCommit["decorations"][number]["kind"];
    const label = sanitizeTerminalLine(
      assertNonEmptyString(fields.label, "VCS history decoration labels must be non-empty."),
    ).replaceAll("\t", " ");
    if (kind === "head") {
      const attachedLocalBranch =
        fields.attachedLocalBranch === undefined
          ? undefined
          : sanitizeTerminalLine(
              assertNonEmptyString(
                fields.attachedLocalBranch,
                "VCS history attached local branch must be non-empty.",
              ),
            ).replaceAll("\t", " ");
      return { kind, label, ...(attachedLocalBranch ? { attachedLocalBranch } : {}) };
    }
    if (fields.attachedLocalBranch !== undefined) {
      throw new Error("Only a VCS history HEAD decoration may name an attached local branch.");
    }
    return { kind, label };
  });

  return {
    revisionId,
    displayId,
    parentRevisionIds,
    ...(graphParentRevisionIds ? { graphParentRevisionIds } : {}),
    subject: safeDisplay("subject"),
    ...(typeof snapshot.body === "string"
      ? {
          body: sanitizeTerminalText(snapshot.body, {
            preserveNewlines: true,
            preserveTabs: false,
          }),
        }
      : {}),
    authorName: safeDisplay("authorName"),
    ...(typeof snapshot.authorEmail === "string"
      ? { authorEmail: sanitizeTerminalLine(snapshot.authorEmail).replaceAll("\t", " ") }
      : {}),
    authoredAt,
    decorations,
    ...(typeof snapshot.logicalId === "string"
      ? { logicalId: sanitizeTerminalLine(snapshot.logicalId).replaceAll("\t", " ") }
      : {}),
  };
}

/** Copy and validate a provider-owned plan for opening one opaque history item. */
function normalizeHistoryReviewAction(value: unknown): ExtensionVcsHistoryReviewAction {
  if (!isPlainObject(value)) {
    throw new Error("VCS history planReview() must return an action object.");
  }
  const fields = snapshotProperties(value, [
    "kind",
    "revisionId",
    "fromRevisionId",
    "toRevisionId",
  ]);
  const revision = (candidate: unknown, label: string) => {
    const text = assertNonEmptyString(candidate, `${label} must be a non-empty string.`);
    if (text.includes("\t") || sanitizeTerminalLine(text) !== text) {
      throw new Error(`${label} must be a terminal-safe immutable revision id.`);
    }
    return text;
  };
  if (fields.kind === "revision-show") {
    return { kind: "revision-show", revisionId: revision(fields.revisionId, "revisionId") };
  }
  if (fields.kind === "revision-range") {
    return {
      kind: "revision-range",
      fromRevisionId: revision(fields.fromRevisionId, "fromRevisionId"),
      toRevisionId: revision(fields.toRevisionId, "toRevisionId"),
    };
  }
  throw new Error("VCS history planReview() returned an unsupported action kind.");
}

/** Wrap an extension history source with bounded reads, copying, cleanup, and error translation. */
async function toInternalHistorySource(
  source: ExtensionVcsHistorySource,
): Promise<VcsHistorySource> {
  if (!isPlainObject(source)) {
    throw new Error("VCS history open() must return a source object.");
  }
  const sourceFields = snapshotProperties(source, ["read", "close"]);
  const sourceRead = sourceFields.read;
  const sourceClose = sourceFields.close;
  if (typeof sourceRead !== "function" || typeof sourceClose !== "function") {
    if (typeof sourceClose === "function") {
      try {
        await sourceClose.call(source);
      } catch {
        // The malformed shape remains the primary failure.
      }
    }
    throw new Error("VCS history open() must return a source with read() and close().");
  }
  let closed = false;
  let done = false;
  const acceptedIds = new Set<string>();
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await sourceClose.call(source);
    } catch (error) {
      throw toUserFacingError(error);
    }
  };

  return {
    async read({ limit, signal }) {
      if (closed || done) return { commits: [], done: true };
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("VCS history reads require a positive integer limit.");
      }
      try {
        if (signal?.aborted) throw signal.reason ?? new Error("History read aborted.");
        const page = await sourceRead.call(source, { limit, signal });
        if (!isPlainObject(page)) {
          throw new Error("VCS history returned an invalid page.");
        }
        const pageFields = snapshotProperties(page, ["commits", "done"]);
        if (!Array.isArray(pageFields.commits) || typeof pageFields.done !== "boolean") {
          throw new Error("VCS history returned an invalid page.");
        }
        let commitValues: unknown[];
        try {
          commitValues = snapshotArray(pageFields.commits, limit);
        } catch {
          throw new Error("VCS history returned more commits than the requested page limit.");
        }
        const commits = commitValues.map(normalizeHistoryCommit);
        for (const commit of commits) {
          if (acceptedIds.has(commit.revisionId)) {
            throw new Error(`VCS history returned duplicate revision ${commit.revisionId}.`);
          }
          const emittedParent = commit.parentRevisionIds.find((parent) => acceptedIds.has(parent));
          if (emittedParent) {
            throw new Error(
              `VCS history returned parent ${emittedParent} before child ${commit.revisionId}.`,
            );
          }
          acceptedIds.add(commit.revisionId);
        }
        done = pageFields.done;
        if (done) await close();
        return { commits, done };
      } catch (error) {
        try {
          await close();
        } catch {
          // Preserve the read/validation failure as the primary error.
        }
        throw toUserFacingError(error);
      }
    },
    close,
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
 * Detection results are normalized to the registered id. Nothing else forces
 * `detect()` to return the id the adapter registered under, and a mismatch does
 * not fail locally: the foreign id flows out of detection, into the session's
 * `vcs` option, and finally into `getVcsAdapter`, which finds no adapter and
 * throws `Unsupported VCS: <id>` from startup — aborting the session over a typo
 * in third-party code. The registered id is the one every lookup keys off, so it
 * wins here, and the mismatch is recorded as a diagnostic for the author.
 *
 * `detectionPriority` needs no conversion: the published watch-plan shape is
 * the same declaration core planning consumes, so it flows inward whole.
 */
export function toInternalVcsAdapter(
  adapter: ExtensionVcsAdapter,
  /** Diagnostic sink for a `detect()` result whose id was rewritten. */
  reportDetectionIdMismatch?: (returnedId: string) => void,
): VcsAdapter {
  const adapterFields = snapshotProperties(adapter as unknown as Record<string, unknown>, [
    "id",
    "name",
    "operations",
    "history",
    "detect",
    "detectionPriority",
  ]);
  const adapterId = assertNonEmptyString(adapterFields.id, "registerVcsAdapter requires an id.");
  if (sanitizeTerminalLine(adapterId) !== adapterId) {
    throw new Error("registerVcsAdapter requires a terminal-safe id.");
  }
  const adapterName = sanitizeTerminalLine(
    assertNonEmptyString(adapterFields.name, "registerVcsAdapter requires a name."),
  ).replaceAll("\t", " ");
  const operations = adapterFields.operations;
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

  const history = adapterFields.history;
  const historyFields = isPlainObject(history)
    ? snapshotProperties(history, ["open", "planReview"])
    : undefined;
  const historyOpen = historyFields?.open;
  const historyPlanReview = historyFields?.planReview;
  if (
    history !== undefined &&
    (!isPlainObject(history) ||
      typeof historyOpen !== "function" ||
      typeof historyPlanReview !== "function")
  ) {
    throw new Error("registerVcsAdapter history must provide open() and planReview() functions.");
  }

  const openHistory = historyOpen as NonNullable<ExtensionVcsAdapter["history"]>["open"];
  const planHistoryReview = historyPlanReview as NonNullable<
    ExtensionVcsAdapter["history"]
  >["planReview"];
  const detect = adapterFields.detect;
  if (typeof detect !== "function") {
    throw new Error("registerVcsAdapter requires a detect() function.");
  }
  // Report once per adapter: detection runs on every session and reload, and a
  // repeated diagnostic for one authoring mistake is noise, not information.
  let reportedMismatch = false;

  return {
    id: adapterId,
    name: adapterName,
    detectionPriority:
      typeof adapterFields.detectionPriority === "number"
        ? adapterFields.detectionPriority
        : undefined,
    detect(cwd: string) {
      const detected = detect(cwd);
      if (!detected || !isPlainObject(detected)) {
        return null;
      }

      // Snapshot detection metadata before validation so accessors cannot change it later.
      const detectionFields = snapshotProperties(detected, ["id", "repoRoot"]);
      if (typeof detectionFields.repoRoot !== "string" || detectionFields.repoRoot.length === 0) {
        return null;
      }

      if (detectionFields.id !== adapterId && !reportedMismatch) {
        reportedMismatch = true;
        reportDetectionIdMismatch?.(sanitizeTerminalLine(String(detectionFields.id)));
      }

      return { id: adapterId, repoRoot: detectionFields.repoRoot };
    },
    operations: internalOperations,
    ...(history && {
      history: {
        async open(input, context) {
          try {
            const source = await openHistory.call(
              history,
              {
                ...input,
                ...(input.pathspecs ? { pathspecs: [...input.pathspecs] } : {}),
              },
              context,
            );
            return await toInternalHistorySource(source);
          } catch (error) {
            throw toUserFacingError(error);
          }
        },
        async planReview(commit, context) {
          try {
            return normalizeHistoryReviewAction(
              await planHistoryReview.call(history, normalizeHistoryCommit(commit), context),
            );
          } catch (error) {
            throw toUserFacingError(error);
          }
        },
      },
    }),
  };
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
  sessionOptions: number;
  themes: number;
  fileLanguages: number;
  vcsAdapters: number;
  changesetTransforms: number;
  panes: number;
  fileViews: number;
  lineHighlighters: number;
  keyboardModes: number;
  cliCommands: number;
  commands: number;
  eventHandlers: Record<string, number>;
  customEventHandlers: number;
  pendingCustomEvents: number;
}

/** Capture how much each registration list already holds. */
function snapshotRegistry(registry: ExtensionRegistry): RegistrySnapshot {
  const eventHandlers: Record<string, number> = {};
  for (const [event, handlers] of Object.entries(registry.eventHandlers)) {
    eventHandlers[event] = handlers.length;
  }

  return {
    sessionOptions: registry.sessionOptions.length,
    themes: registry.themes.length,
    fileLanguages: registry.fileLanguages.length,
    vcsAdapters: registry.vcsAdapters.length,
    changesetTransforms: registry.changesetTransforms.length,
    panes: registry.panes.length,
    fileViews: registry.fileViews.length,
    lineHighlighters: registry.lineHighlighters.length,
    keyboardModes: registry.keyboardModes.length,
    cliCommands: registry.cliCommands.length,
    commands: registry.commands.length,
    eventHandlers,
    customEventHandlers: registry.customEventHandlers.length,
    pendingCustomEvents: registry.pendingCustomEvents.length,
  };
}

/**
 * Drop registrations made before an extension threw.
 *
 * A factory that fails halfway is not loaded, so its partial contributions must
 * not stay in the registry. Collected logs are kept as failure diagnostics.
 */
function rollbackRegistry(registry: ExtensionRegistry, snapshot: RegistrySnapshot) {
  registry.sessionOptions.length = snapshot.sessionOptions;
  registry.themes.length = snapshot.themes;
  registry.fileLanguages.length = snapshot.fileLanguages;
  registry.vcsAdapters.length = snapshot.vcsAdapters;
  registry.changesetTransforms.length = snapshot.changesetTransforms;
  registry.panes.length = snapshot.panes;
  registry.fileViews.length = snapshot.fileViews;
  registry.lineHighlighters.length = snapshot.lineHighlighters;
  registry.keyboardModes.length = snapshot.keyboardModes;
  registry.cliCommands.length = snapshot.cliCommands;
  registry.commands.length = snapshot.commands;
  registry.customEventHandlers.length = snapshot.customEventHandlers;
  registry.pendingCustomEvents.length = snapshot.pendingCustomEvents;
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

  /** Guard one registration call against use after the load pass finished or retired. */
  const assertOpen = (method: string) => {
    if (sealed || registry.eventBusPhase === "closed") {
      throw new Error(
        `${metadata.id}: hunk.${method}() can only be called while the extension is loading.`,
      );
    }
  };

  const events: ExtensionEventBus = {
    on<Payload = unknown>(event: string, handler: ExtensionCustomEventHandler<Payload>) {
      assertOpen("events.on");
      assertNonEmptyString(event, "events.on requires a non-empty event name.");
      if (typeof handler !== "function") {
        throw new Error(`events.on("${event}") requires a handler function.`);
      }

      registry.customEventHandlers.push({
        extensionId: metadata.id,
        event,
        handler: handler as ExtensionCustomEventHandler,
      });
    },
    emit(event: string, payload: unknown) {
      assertNonEmptyString(event, "events.emit requires a non-empty event name.");
      if (registry.emitCustomEvent) {
        registry.emitCustomEvent(event, payload);
      } else if (registry.eventBusPhase === "loading") {
        // Factories load sequentially, before the runtime dispatcher has its
        // notification context. Preserve their events until it is available.
        registry.pendingCustomEvents.push({ extensionId: metadata.id, event, payload });
      }
    },
  };

  const api: HunkExtensionAPI = {
    apiVersion: HUNK_EXTENSION_API_VERSION,
    config,
    events,
    configureSession(options: ExtensionSessionOptions) {
      assertOpen("configureSession");
      if (!isPlainObject(options)) {
        throw new Error("configureSession requires an options object.");
      }
      if (
        options.viewPreferences !== undefined &&
        options.viewPreferences !== "default" &&
        options.viewPreferences !== "transient"
      ) {
        throw new Error('configureSession viewPreferences must be "default" or "transient".');
      }

      registry.sessionOptions.push({ extensionId: metadata.id, options: { ...options } });
    },
    registerTheme(theme: ExtensionThemeConfig) {
      assertOpen("registerTheme");
      assertNonEmptyString(theme?.id, "registerTheme requires a theme with a non-empty id.");
      registry.themes.push({ extensionId: metadata.id, theme });
    },
    registerFileLanguage(matcher: string | ExtensionFileLanguageMatcher, language: string) {
      assertOpen("registerFileLanguage");
      assertNonEmptyString(language, "registerFileLanguage requires a non-empty language.");
      registry.fileLanguages.push({
        extensionId: metadata.id,
        matcher: normalizeFileLanguageMatcher(matcher),
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
        adapter: toInternalVcsAdapter(adapter, (returnedId) => {
          registry.logs.push({
            extensionId: metadata.id,
            message:
              `VCS adapter "${adapter.id}" returned detection id "${returnedId}" • ` +
              "using the registered id instead",
          });
        }),
      });
    },
    registerPane(pane: ExtensionPane) {
      assertOpen("registerPane");
      assertNonEmptyString(pane?.id, "registerPane requires a pane with a non-empty id.");
      if (typeof pane.component !== "function") {
        throw new Error("registerPane requires a pane with a component function.");
      }
      const placement = pane.placement ?? "left";
      if (!(["left", "right", "top", "bottom"] as const).includes(placement)) {
        throw new Error(
          `registerPane placement must be "left", "right", "top", or "bottom", got "${String(placement)}".`,
        );
      }
      const dimension = isVerticalPanePlacement(placement) ? "width" : "height";
      const wrongDimension = dimension === "width" ? "height" : "width";
      if (pane[wrongDimension] !== undefined) {
        throw new Error(`registerPane ${placement} panes use ${dimension}, not ${wrongDimension}.`);
      }
      const size = extensionPaneSize(pane, placement);
      const min = size.min ?? 1;
      const max = size.max ?? Number.MAX_SAFE_INTEGER;
      for (const [name, value] of Object.entries({ preferred: size.preferred, min, max })) {
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error(`registerPane ${dimension}.${name} must be a positive safe integer.`);
        }
      }
      if (
        size.fraction !== undefined &&
        (typeof size.fraction !== "number" ||
          !Number.isFinite(size.fraction) ||
          size.fraction <= 0 ||
          size.fraction > 1)
      ) {
        throw new Error(`registerPane ${dimension}.fraction must be greater than 0 and at most 1.`);
      }
      if (min > size.preferred || size.preferred > max) {
        throw new Error(`registerPane ${dimension} must satisfy min <= preferred <= max.`);
      }
      if (pane.available !== undefined && typeof pane.available !== "function") {
        throw new Error("registerPane available must be a function.");
      }
      if (pane.onActivate !== undefined && typeof pane.onActivate !== "function") {
        throw new Error("registerPane onActivate must be a function.");
      }
      if (pane.currentLine !== undefined && typeof pane.currentLine !== "boolean") {
        throw new Error("registerPane currentLine must be a boolean.");
      }
      if (pane.replaces !== undefined) {
        assertNonEmptyString(pane.replaces, "registerPane replaces must be a non-empty pane key.");
        if (pane.replaces === `${metadata.id}:${pane.id}`) {
          throw new Error("registerPane cannot replace itself.");
        }
      }

      const normalizedSize = {
        preferred: size.preferred,
        min,
        max,
        ...(size.fraction === undefined ? {} : { fraction: size.fraction }),
      };
      registry.panes.push({
        extensionId: metadata.id,
        pane: {
          ...pane,
          placement,
          ...(dimension === "width"
            ? { width: normalizedSize, height: undefined }
            : { height: normalizedSize, width: undefined }),
        } as ExtensionPane,
      });
    },
    registerSidebarView(view: ExtensionSidebarView) {
      assertOpen("registerSidebarView");
      assertNonEmptyString(view?.id, "registerSidebarView requires a view with a non-empty id.");
      if (view.placement !== undefined && view.placement !== "left" && view.placement !== "right") {
        throw new Error(
          `registerSidebarView placement must be "left" or "right", got "${String(view.placement)}".`,
        );
      }
      api.registerPane({
        id: view.id,
        ...(view.title ? { title: view.title } : {}),
        placement: view.placement ?? "left",
        width: defaultExtensionPaneSize("left"),
        defaultOpen: view.defaultOpen,
        replaces: view.replacesDefault ? "hunk:files" : undefined,
        component: view.component as unknown as ExtensionPane["component"],
      });
    },
    registerFileView(view: ExtensionFileView) {
      assertOpen("registerFileView");
      assertNonEmptyString(view?.id, "registerFileView requires a view with a non-empty id.");
      assertNonEmptyString(view?.title, "registerFileView requires a view with a non-empty title.");
      if (typeof view.matches !== "function") {
        throw new Error("registerFileView requires a matches() function.");
      }
      if (typeof view.layout !== "function") {
        throw new Error("registerFileView requires a layout() function.");
      }
      // A mode is optional, but one declared without a key handler could never
      // be entered — fail the registration rather than the first `enterMode`.
      if (view.mode !== undefined && typeof view.mode?.onKey !== "function") {
        throw new Error("registerFileView mode requires an onKey() function.");
      }

      registry.fileViews.push({ extensionId: metadata.id, view });
    },
    registerLineHighlighter(highlighter: ExtensionLineHighlighter) {
      assertOpen("registerLineHighlighter");
      assertNonEmptyString(
        highlighter?.id,
        "registerLineHighlighter requires a highlighter with a non-empty id.",
      );
      if (typeof highlighter.highlight !== "function") {
        throw new Error("registerLineHighlighter requires a highlight() function.");
      }

      registry.lineHighlighters.push({ extensionId: metadata.id, highlighter });
    },
    registerKeyboardMode(mode: ExtensionKeyboardMode) {
      assertOpen("registerKeyboardMode");
      assertNonEmptyString(mode?.id, "registerKeyboardMode requires a mode with a non-empty id.");
      assertNonEmptyString(
        mode?.title,
        "registerKeyboardMode requires a mode with a non-empty title.",
      );
      if (typeof mode.onKey !== "function") {
        throw new Error("registerKeyboardMode requires an onKey() function.");
      }
      if (mode.onEnter !== undefined && typeof mode.onEnter !== "function") {
        throw new Error("registerKeyboardMode onEnter must be a function when provided.");
      }
      if (mode.onExit !== undefined && typeof mode.onExit !== "function") {
        throw new Error("registerKeyboardMode onExit must be a function when provided.");
      }

      registry.keyboardModes.push({ extensionId: metadata.id, mode });
    },
    registerCliCommand(command: ExtensionCliCommand, handler: ExtensionCliCommandHandler) {
      assertOpen("registerCliCommand");
      if (!isPlainObject(command)) {
        throw new Error("registerCliCommand requires a command metadata object.");
      }
      assertNonEmptyString(
        command.name,
        "registerCliCommand requires a command with a non-empty name.",
      );
      if (!isValidExtensionCliCommandName(command.name)) {
        throw new Error(
          "registerCliCommand name must use lowercase kebab case and start with a letter.",
        );
      }
      if (isReservedExtensionCliCommandName(command.name)) {
        throw new Error(`registerCliCommand cannot replace built-in command "${command.name}".`);
      }
      assertNonEmptyString(
        command.summary,
        "registerCliCommand requires a command with a non-empty summary.",
      );
      if (command.usage !== undefined) {
        assertNonEmptyString(
          command.usage,
          "registerCliCommand usage must be a non-empty string when provided.",
        );
      }
      if (typeof handler !== "function") {
        throw new Error("registerCliCommand requires a handler function.");
      }

      registry.cliCommands.push({
        extensionId: metadata.id,
        command: copyExtensionCliCommand(command),
        handler,
      });
    },
    registerCommand(command: ExtensionCommand, handler: ExtensionCommandHandler) {
      assertOpen("registerCommand");
      assertNonEmptyString(command?.id, "registerCommand requires a command with a non-empty id.");
      assertNonEmptyString(
        command?.title,
        "registerCommand requires a command with a non-empty title.",
      );
      if (typeof handler !== "function") {
        throw new Error("registerCommand requires a handler function.");
      }

      // Parse every chord at registration so a typo fails the author loudly
      // here, instead of registering a binding that silently never fires. An
      // array binds the command to each chord it lists, so one bad entry is
      // still a bad registration rather than a partially applied one.
      if (command.key !== undefined) {
        const chords =
          typeof command.key === "string" || Array.isArray(command.key)
            ? toKeyChordList(command.key)
            : undefined;
        if (chords === undefined || chords.length === 0) {
          throw new Error(
            "registerCommand key must be a non-empty chord string or array of chords.",
          );
        }

        for (const chord of chords) {
          assertNonEmptyString(
            chord,
            "registerCommand key must be a non-empty chord string or array of chords.",
          );
          const parsed = parseKeyChord(chord);
          if ("error" in parsed) {
            throw new Error(`registerCommand: ${parsed.error}`);
          }
        }
      }

      registry.commands.push({ extensionId: metadata.id, command, handler });
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

  let thenable: boolean;
  try {
    thenable = isThenable(pending);
  } catch (error) {
    seal();
    fail(error);
    return;
  }

  if (!thenable) {
    seal();
    if (registry.eventBusPhase !== "closed") registry.extensions.push(metadata);
    return;
  }

  // Promise assimilation turns a throwing or otherwise hostile `then` access
  // into the ordinary rejection path instead of leaking out of the load pass.
  return Promise.resolve(pending).then(
    () => {
      seal();
      if (registry.eventBusPhase === "closed") {
        rollbackRegistry(registry, snapshot);
        return;
      }
      registry.extensions.push(metadata);
    },
    (error: unknown) => {
      seal();
      if (registry.eventBusPhase === "closed") {
        rollbackRegistry(registry, snapshot);
        return;
      }
      fail(error);
    },
  );
}
