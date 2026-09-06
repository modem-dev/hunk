import type {
  ExtensionChangeset,
  ExtensionDiffFile,
  ExtensionEventName,
  ExtensionEventPayloads,
  ExtensionLoadResult,
} from "./types";
import type { Hunk } from "@pierre/diffs";
import type {
  ExtensionDiffHunk,
  ExtensionDialogs,
  ExtensionEventContext,
  ExtensionPaneControls,
  ExtensionReviewReloadControls,
  ExtensionReviewNavigation,
  ExtensionVcsFileChangeType,
} from "../extension-api/types";
import { summarizeHunk } from "../core/changeset/hunkSummary";

/**
 * How long `shutdown` handlers may run before Hunk exits anyway.
 *
 * Quitting must feel instant, so shutdown is best-effort: handlers get a short
 * window to flush whatever they were doing and are then abandoned.
 */
export const EXTENSION_SHUTDOWN_TIMEOUT_MS = 250;

/** Read an error's message without assuming handlers throw `Error` instances. */
function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

/**
 * Build the read-only changeset view lifecycle handlers receive.
 *
 * Handlers are observers, not transforms — `transformChangeset` is the
 * supported way to change what gets reviewed, and it works by returning a new
 * changeset. Passing the live object to a handler instead means one
 * `payload.changeset.files.push(...)` corrupts the array the review UI renders
 * from, and the app dies on the next render, far from the extension that did it.
 *
 * So handlers get frozen shallow copies: the changeset, its `files` array, and
 * each file. A mutating handler now throws *inside itself*, where the isolation
 * contract already turns it into a warning naming the extension. Copies are
 * frozen rather than the originals, so nothing internal — which legitimately
 * rebuilds and reassigns these objects — is affected. The shared nested state
 * (`metadata`, `stats`, `agent`) is guarded by `toReadOnlyDeepView` instead of
 * a deep freeze, which would cost a walk of the whole diff model per emit.
 */
export function toReadOnlyChangesetView(changeset: ExtensionChangeset): ExtensionChangeset {
  const files = Array.isArray(changeset.files) ? changeset.files : [];
  return Object.freeze({ ...changeset, files: toReadOnlyFileViews(files) });
}

/**
 * Read the change type Hunk's diff engine recorded for one file, if any.
 *
 * `metadata` is opaque in the public contract, but the change type inside it is
 * exactly the vocabulary adapters already speak (`ExtensionVcsFileChangeType`),
 * so the read-only views surface it as a first-class field instead of asking
 * extensions to poke into an object Hunk promised not to describe.
 */
export function readMetadataChangeType(metadata: unknown): ExtensionVcsFileChangeType | undefined {
  const type = (metadata as { type?: unknown } | null | undefined)?.type;
  return type === "change" ||
    type === "rename-pure" ||
    type === "rename-changed" ||
    type === "new" ||
    type === "deleted"
    ? type
    : undefined;
}

/**
 * Read how many hunks Hunk's diff engine parsed for one file, if any.
 *
 * Same boundary as `readMetadataChangeType`: `metadata` is opaque to
 * extensions, so the one place that knows its real shape stays here rather
 * than spreading casts across the surfaces that hand extensions file views.
 * A file the engine could not parse into hunks — binary, skipped — reads as
 * zero rather than throwing.
 */
export function readMetadataHunkCount(metadata: unknown): number {
  const hunks = (metadata as { hunks?: unknown } | null | undefined)?.hunks;
  return Array.isArray(hunks) ? hunks.length : 0;
}

/** The one frozen empty summary list, shared by every file with nothing to summarize. */
const NO_HUNK_SUMMARIES: readonly ExtensionDiffHunk[] = Object.freeze([]);

/** Summary lists already derived, keyed by the metadata that produced them. */
const metadataHunkSummaries = new WeakMap<object, readonly ExtensionDiffHunk[]>();

/**
 * Summarize the hunks Hunk's diff engine parsed for one file.
 *
 * Same boundary as `readMetadataChangeType`: the parsed hunks live inside the
 * opaque `metadata`, so the public views surface them as first-class
 * `ExtensionDiffHunk` records instead of asking extensions to cast into an
 * object Hunk promised not to describe. Derivation runs once per parsed diff —
 * file views are rebuilt on every emit while the metadata behind them is
 * stable, so summaries are cached by metadata object, and repeated views hand
 * back the identical frozen list. A file whose metadata has no hunk array
 * (binary, skipped) reads as the shared empty list rather than throwing.
 */
export function readMetadataHunkSummaries(metadata: unknown): readonly ExtensionDiffHunk[] {
  if (metadata === null || typeof metadata !== "object") {
    return NO_HUNK_SUMMARIES;
  }

  const cached = metadataHunkSummaries.get(metadata);
  if (cached) {
    return cached;
  }

  const hunks = (metadata as { hunks?: unknown }).hunks;
  const summaries = Array.isArray(hunks)
    ? Object.freeze(
        (hunks as Hunk[]).map((hunk, index) => Object.freeze(summarizeHunk(hunk, index))),
      )
    : NO_HUNK_SUMMARIES;
  metadataHunkSummaries.set(metadata, summaries);
  return summaries;
}

/** Proxies already built for shared objects, so repeated views stay identical. */
const readOnlyDeepViews = new WeakMap<object, unknown>();

/** Report whether a value is JSON-shaped data a read-only proxy can stand in for. */
function isProxyableData(value: unknown): value is object {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return true;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Lazily wrap one shared object so extensions can read it but never write it.
 *
 * The file views deliberately share `metadata`, `stats`, and `agent` with the
 * live review model instead of copying them — `metadata` alone is the whole
 * parsed diff, and eagerly deep-freezing it would walk the model on every
 * conversion. The proxy defers the cost to the moment an extension actually
 * reaches in: reads pass through and hand back wrapped objects (so the guard
 * is deep), while writes, deletes, and redefinitions are refused — a
 * strict-mode assignment throws inside the extension, exactly like writing to
 * the frozen view itself. Proxies are cached per source object, so converting
 * again hands out the identical view.
 *
 * Only plain objects and arrays are wrapped: the diff model is JSON-shaped,
 * and proxying an exotic object (a Map, a class instance) would break its
 * internal-slot methods, so anything else reads through unwrapped. The proxy
 * targets a disposable façade rather than the shared source. That keeps
 * reflective operations — especially property descriptors and preventing
 * extensions — from exposing or mutating the live model behind the view.
 */
export function toReadOnlyDeepView<T>(value: T): T {
  if (!isProxyableData(value)) {
    return value;
  }

  const cached = readOnlyDeepViews.get(value);
  if (cached !== undefined) {
    return cached as T;
  }

  // Keep an array target for Array.isArray and array built-ins, but never put
  // source properties on it: descriptor reflection must not expose raw values.
  const façade = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  if (Array.isArray(value)) {
    // Match the source length without copying its elements onto the façade.
    (façade as unknown[]).length = value.length;
  }

  const proxy = new Proxy(façade, {
    get(_target, property) {
      return toReadOnlyDeepView(Reflect.get(value, property, value));
    },
    has: (_target, property) => Reflect.has(value, property),
    ownKeys: () => Reflect.ownKeys(value),
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
      if (descriptor === undefined) {
        return undefined;
      }

      // Array targets have a non-configurable `length` property, which proxy
      // invariants require us to report as non-configurable as well.
      if (Array.isArray(target) && property === "length") {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }

      if ("value" in descriptor) {
        return {
          ...descriptor,
          configurable: true,
          value: toReadOnlyDeepView(descriptor.value),
        };
      }

      // Accessors are read-only from the extension's perspective too. Calling
      // the source setter through a reflected descriptor would otherwise evade
      // the proxy's `set` trap.
      return {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => toReadOnlyDeepView(Reflect.get(value, property, value)),
        set: undefined,
      };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
  readOnlyDeepViews.set(value, proxy);
  return proxy as T;
}

/**
 * Build the read-only file-list view extension UI code receives.
 *
 * The same isolation story as `toReadOnlyChangesetView` — frozen shallow
 * copies, with the nested state every copy shares (`metadata`, `stats`,
 * `agent`) behind `toReadOnlyDeepView` — factored out so surfaces that hand
 * extensions a file list without a changeset envelope (a custom sidebar's
 * props, a command's selection) guard it identically. `changeType` is filled
 * from the diff metadata when the file does not carry it already, and `hunks`
 * always from the metadata — the parsed diff is authoritative, so a `hunks`
 * value already on the file (say, spread through a transform) is replaced
 * rather than trusted.
 */
export function toReadOnlyFileViews(files: readonly ExtensionDiffFile[]): ExtensionDiffFile[] {
  const frozenFiles = files.map((file) => {
    if (file === null || typeof file !== "object") {
      return file;
    }

    const changeType = file.changeType ?? readMetadataChangeType(file.metadata);
    return Object.freeze({
      ...file,
      ...(changeType ? { changeType } : {}),
      hunks: readMetadataHunkSummaries(file.metadata),
      metadata: toReadOnlyDeepView(file.metadata),
      stats: toReadOnlyDeepView(file.stats),
      agent: toReadOnlyDeepView(file.agent),
    });
  }) as ExtensionDiffFile[];

  return Object.freeze(frozenFiles) as ExtensionDiffFile[];
}

/**
 * Build the payload handlers receive: a frozen copy, with a frozen changeset view.
 *
 * Done here, once per emit, rather than at each call site — every event gets the
 * protection automatically and a future one cannot forget it. The envelope is
 * frozen as well as the changeset, because handlers for one event share a single
 * payload object: without it, a handler that deletes or overwrites a field
 * changes what every later handler sees, which is the same isolation failure as
 * mutating the changeset, one level up.
 *
 * The caller's own object is never frozen — only the copy handed outward.
 */
function toHandlerPayload<Event extends ExtensionEventName>(
  payload: ExtensionEventPayloads[Event],
): ExtensionEventPayloads[Event] {
  const changeset = (payload as { changeset?: unknown }).changeset;
  const file = (payload as { file?: unknown }).file;
  const note = (payload as { note?: unknown }).note;
  return Object.freeze({
    ...payload,
    ...(changeset !== null && typeof changeset === "object"
      ? { changeset: toReadOnlyChangesetView(changeset as ExtensionChangeset) }
      : {}),
    ...(file !== null && typeof file === "object"
      ? { file: toReadOnlyFileViews([file as ExtensionDiffFile])[0] }
      : {}),
    ...(note !== null && typeof note === "object" ? { note: Object.freeze({ ...note }) } : {}),
  }) as ExtensionEventPayloads[Event];
}

/** Pane controls used only before the mounted app has installed live controls. */
function unavailablePaneControls(
  result: ExtensionLoadResult,
  extensionId: string,
): ExtensionPaneControls {
  const unavailable = (method: string, viewId: string) => {
    result.context.notify(
      `Extension ${extensionId} cannot ${method} pane "${viewId}" before the app is ready`,
      "warning",
    );
  };

  return {
    open: (viewId) => unavailable("open", viewId),
    close: (viewId) => unavailable("close", viewId),
    toggle: (viewId) => unavailable("toggle", viewId),
    isOpen: () => false,
  };
}

/** Navigation controls used before the mounted app can safely move a review. */
function unavailableReviewNavigation(
  result: ExtensionLoadResult,
  extensionId: string,
): ExtensionReviewNavigation {
  const unavailable = () =>
    result.context.notify(
      `Extension ${extensionId} cannot navigate the review before the app is ready`,
      "warning",
    );
  return { selectFile: unavailable, selectHunk: unavailable, revealLine: unavailable };
}

/** Dialog controls used before the mounted app has installed its modal queue. */
function unavailableDialogs(result: ExtensionLoadResult, extensionId: string): ExtensionDialogs {
  const unavailable = () =>
    result.context.notify(
      `Extension ${extensionId} cannot open a dialog before the app is ready`,
      "warning",
    );
  return {
    confirm: async () => {
      unavailable();
      return false;
    },
    select: async () => {
      unavailable();
      return null;
    },
    input: async () => {
      unavailable();
      return null;
    },
  };
}

/** Review reload controls used before the mounted app can rebuild its current input. */
function unavailableReviewReloadControls(
  result: ExtensionLoadResult,
  extensionId: string,
): ExtensionReviewReloadControls {
  return {
    requestReload: async () => {
      result.context.notify(
        `Extension ${extensionId} cannot reload the review before the app is ready`,
        "warning",
      );
      return {
        ok: false,
        reason: "unavailable",
        detail: "The review is not ready to reload.",
      };
    },
  };
}

/** Build the runtime event context for one owning extension. */
function createEventContext(
  result: ExtensionLoadResult,
  extensionId: string,
): ExtensionEventContext {
  const provided = result.eventContextProvider?.(extensionId);
  if (provided) {
    return provided;
  }

  // The deprecated name is an alias, not another control path.
  const panes = unavailablePaneControls(result, extensionId);
  return {
    ...result.context,
    panes,
    sidebars: panes,
    navigation: unavailableReviewNavigation(result, extensionId),
    dialogs: unavailableDialogs(result, extensionId),
    review: unavailableReviewReloadControls(result, extensionId),
    events: {
      emit(event, payload) {
        emitExtensionCustomEvent(result, event, payload);
      },
    },
  };
}

/**
 * Invoke every handler for one event, isolating each from the others.
 *
 * A handler that throws synchronously or rejects is reported through
 * `ctx.notify` naming its extension and never reaches the caller, so one bad
 * extension cannot take down navigation, reload, or exit.
 */
function runExtensionEventHandlers<Event extends ExtensionEventName>(
  result: ExtensionLoadResult,
  event: Event,
  rawPayload: ExtensionEventPayloads[Event],
): Promise<void>[] {
  const handlers = result.registry.eventHandlers[event];
  const settled: Promise<void>[] = [];

  // Revocation closes ordinary lifecycle delivery synchronously. Retirement is
  // the sole exception: shutdown runs once after authority has become inert.
  if (result.registry.eventBusPhase === "closed" && event !== "shutdown") {
    return settled;
  }

  if (handlers.length === 0) {
    return settled;
  }

  const payload = toHandlerPayload(rawPayload);

  for (const { extensionId, handler } of handlers) {
    /** Turn one handler failure into a warning instead of an app-level error. */
    const report = (error: unknown) => {
      result.context.notify(
        `Extension ${extensionId} failed handling ${event} • ${describeError(error)}`,
        "warning",
      );
    };

    try {
      const returned = handler(payload, createEventContext(result, extensionId));
      if (returned && typeof (returned as PromiseLike<void>).then === "function") {
        settled.push(Promise.resolve(returned).catch(report));
      }
    } catch (error) {
      report(error);
    }
  }

  return settled;
}

/**
 * Emit a named event on the shared extension bus without blocking its caller.
 *
 * Bus payloads are shallow-frozen copies: listeners share an immutable envelope
 * just as lifecycle listeners do, while opaque nested values remain the sender's
 * responsibility. Event names are intentionally open-ended so extensions can
 * coordinate without Hunk reserving a central registry.
 */
export function emitExtensionCustomEvent(
  result: ExtensionLoadResult | undefined,
  event: string,
  rawPayload: unknown,
) {
  if (!result || result.registry.eventBusPhase === "closed") {
    return;
  }

  const payload =
    rawPayload !== null && typeof rawPayload === "object"
      ? Object.freeze({ ...(rawPayload as Record<string, unknown>) })
      : rawPayload;
  for (const { extensionId, event: registeredEvent, handler } of result.registry
    .customEventHandlers) {
    if (registeredEvent !== event) {
      continue;
    }

    const report = (error: unknown) => {
      result.context.notify(
        `Extension ${extensionId} failed handling event ${event} • ${describeError(error)}`,
        "warning",
      );
    };
    try {
      const returned = handler(payload, createEventContext(result, extensionId));
      if (returned && typeof (returned as PromiseLike<void>).then === "function") {
        void Promise.resolve(returned).catch(report);
      }
    } catch (error) {
      report(error);
    }
  }
}

/** Bind a loaded registry so hunk.events.emit starts delivering runtime events. */
export function bindExtensionEventBus(result: ExtensionLoadResult | undefined) {
  if (!result) {
    return;
  }

  const { registry } = result;
  if (registry.eventBusPhase === "closed") return false;
  registry.emitCustomEvent = (event, payload) => {
    emitExtensionCustomEvent(result, event, payload);
  };
  registry.eventBusPhase = "ready";

  // Factories load before a result has the context needed to invoke handlers.
  // Replay their events now that every extension has had a chance to subscribe.
  for (const { event, payload } of registry.pendingCustomEvents.splice(0)) {
    emitExtensionCustomEvent(result, event, payload);
  }
  return true;
}

/**
 * Emit one lifecycle event without blocking the caller.
 *
 * Async handlers are started and detached: the UI thread never waits on
 * extension code, which is what keeps a slow handler from stalling a reload or
 * a selection change.
 */
export function emitExtensionEvent<Event extends ExtensionEventName>(
  result: ExtensionLoadResult | undefined,
  event: Event,
  payload: ExtensionEventPayloads[Event],
) {
  if (!result) {
    return;
  }

  runExtensionEventHandlers(result, event, payload);
}

/**
 * Emit one lifecycle event and wait for its async handlers, up to a bound.
 *
 * Only `shutdown` needs this: everything else is fire-and-forget. The returned
 * promise always resolves, either when every handler settled or when the
 * timeout elapsed, so exit is delayed by at most `timeoutMs`.
 */
export async function emitExtensionEventBounded<Event extends ExtensionEventName>(
  result: ExtensionLoadResult | undefined,
  event: Event,
  payload: ExtensionEventPayloads[Event],
  timeoutMs = EXTENSION_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (!result) {
    return;
  }

  const pending = runExtensionEventHandlers(result, event, payload);
  if (pending.length === 0) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);

  if (timer) {
    clearTimeout(timer);
  }
}

/** Revoke one runtime's UI/event authority before asynchronous teardown begins. */
export function revokeExtensionLoadResult(result: ExtensionLoadResult | undefined) {
  if (!result || result.registry.eventBusPhase === "closed") {
    return false;
  }

  result.registry.emitCustomEvent = undefined;
  result.registry.eventBusPhase = "closed";
  result.registry.pendingCustomEvents.length = 0;
  return true;
}

/** Shut down one retired extension runtime through the registry's shared completion. */
export function retireExtensionLoadResult(result: ExtensionLoadResult | undefined): Promise<void> {
  if (!result) return Promise.resolve();
  const { registry } = result;
  if (registry.retirementPromise) return registry.retirementPromise;
  if (!revokeExtensionLoadResult(result)) return Promise.resolve();

  registry.retirementPromise = emitExtensionEventBounded(result, "shutdown", {});
  return registry.retirementPromise;
}
