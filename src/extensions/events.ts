import type { ExtensionEventName, ExtensionEventPayloads, ExtensionLoadResult } from "./types";

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
 * Invoke every handler for one event, isolating each from the others.
 *
 * A handler that throws synchronously or rejects is reported through
 * `ctx.notify` naming its extension and never reaches the caller, so one bad
 * extension cannot take down navigation, reload, or exit.
 */
function runExtensionEventHandlers<Event extends ExtensionEventName>(
  result: ExtensionLoadResult,
  event: Event,
  payload: ExtensionEventPayloads[Event],
): Promise<void>[] {
  const handlers = result.registry.eventHandlers[event];
  const settled: Promise<void>[] = [];

  for (const { extensionId, handler } of handlers) {
    /** Turn one handler failure into a warning instead of an app-level error. */
    const report = (error: unknown) => {
      result.context.notify(
        `Extension ${extensionId} failed handling ${event} • ${describeError(error)}`,
        "warning",
      );
    };

    try {
      const returned = handler(payload, result.context);
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
