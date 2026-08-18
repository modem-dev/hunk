import {
  HUNK_EXTENSION_API_VERSION,
  type ChangesetTransform,
  type ExtensionEventHandler,
  type ExtensionEventName,
  type ExtensionFactory,
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
import type { ExtensionVcsOperation } from "../extension-api/types";
import type { VcsAdapter, VcsOperation, VcsReviewInput } from "../core/vcs/types";
import { defaultExtensionPaneSize, extensionPaneSize, isVerticalPanePlacement } from "./panes";

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

  const detect = adapter.detect;
  // Report once per adapter: detection runs on every session and reload, and a
  // repeated diagnostic for one authoring mistake is noise, not information.
  let reportedMismatch = false;

  return {
    ...adapter,
    detect(cwd: string) {
      const detected = detect(cwd);
      if (!detected || !isPlainObject(detected)) {
        return null;
      }

      // `repoRoot` is a path every caller measures distance against, and the
      // measurement happens outside detection's own error handling — so a
      // detection missing it throws past `detectVcs` and aborts startup rather
      // than being skipped. Treat it as "did not recognize this directory".
      if (typeof detected.repoRoot !== "string" || detected.repoRoot.length === 0) {
        return null;
      }

      if (detected.id === adapter.id) {
        return detected;
      }

      if (!reportedMismatch) {
        reportedMismatch = true;
        reportDetectionIdMismatch?.(String(detected.id));
      }

      return { ...detected, id: adapter.id };
    },
    operations: internalOperations,
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
      if (min > size.preferred || size.preferred > max) {
        throw new Error(`registerPane ${dimension} must satisfy min <= preferred <= max.`);
      }
      if (pane.available !== undefined && typeof pane.available !== "function") {
        throw new Error("registerPane available must be a function.");
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

      const normalizedSize = { preferred: size.preferred, min, max };
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
