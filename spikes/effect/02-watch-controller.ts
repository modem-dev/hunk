/**
 * Sample 2 — The watch controller. This is the strongest case in the codebase.
 *
 * Real code: `src/core/watchController.ts`, 345 lines.
 *
 * That file is a hand-rolled concurrency runtime. It has:
 *   - an injected `WatchControllerClock` seam that exists only so tests can
 *     control time (`now` / `setTimeout` / `clearTimeout`),
 *   - four deadlines (`startupDeadline`, `quietDeadline`, `maximumDeadline`,
 *     `safetyDeadline`) collapsed by hand into one chained timeout,
 *   - an `isClosed()` guard after *every* `await`, because a close can land
 *     mid-flight and the continuation must be dropped,
 *   - a `dirty` flag, because events that arrive during a check must be
 *     replayed as one trailing check,
 *   - manual `closeEventSource()` bookkeeping with a four-state
 *     `sourceStatus` machine so a source is never closed twice or leaked.
 *
 * Every one of those five is a named, solved problem in Effect. This sample
 * shows the same behavior with those five concerns deleted rather than
 * reimplemented.
 */

import { Data, Duration, Effect, Fiber, Queue, Ref, Scope } from "effect";

// ===========================================================================
// BEFORE — the shapes that exist only to hand-roll concurrency
// ===========================================================================

/**
 * Test seam #1: time. Every timer in the controller goes through this so the
 * unit tests can advance a fake clock. It is pure overhead — it exists because
 * `setTimeout` is not controllable, not because the domain has a clock in it.
 */
export interface WatchControllerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Excerpt from `beginCheck` (watchController.ts:181-218), unedited in spirit.
 *
 * Note the shape: four `isClosed()` calls in 30 lines. Each one is a manual
 * cancellation check. Miss one and a closed controller refreshes the UI after
 * teardown.
 */
export function beginCheckBefore(deps: {
  state: { phase: string; appliedSignature: string; dirty: boolean };
  getSignature: () => string | Promise<string>;
  refresh: () => void | Promise<void>;
  reportError: (error: unknown) => void;
  finishCheck: () => void;
  clearTimer: () => void;
}) {
  const { state } = deps;
  const isClosed = () => state.phase === "closed";

  return async () => {
    if (state.phase === "closed" || state.phase === "checking" || state.phase === "refreshing") {
      return;
    }
    deps.clearTimer();
    state.phase = "checking";

    let signature: string;
    try {
      signature = await deps.getSignature();
    } catch (error) {
      if (isClosed()) return; // guard 1
      deps.reportError(error);
      deps.finishCheck();
      return;
    }
    if (isClosed()) return; // guard 2
    if (signature === state.appliedSignature) {
      deps.finishCheck();
      return;
    }

    state.phase = "refreshing";
    try {
      await deps.refresh();
    } catch (error) {
      if (isClosed()) return; // guard 3
      deps.reportError(error);
      deps.finishCheck();
      return;
    }
    if (isClosed()) return; // guard 4
    state.appliedSignature = signature;
    deps.finishCheck();
  };
}

// ===========================================================================
// AFTER
// ===========================================================================

export interface WatchControllerConfig {
  readonly initialSignature: string;
  readonly quietDelay: Duration.Duration;
  readonly maximumDelay: Duration.Duration;
  readonly healthyCheck: Duration.Duration;
  readonly degradedCheck: Duration.Duration;
}

export const defaultConfig: WatchControllerConfig = {
  initialSignature: "",
  quietDelay: Duration.millis(200),
  maximumDelay: Duration.millis(1_000),
  healthyCheck: Duration.seconds(10),
  degradedCheck: Duration.seconds(2),
};

export class WatchSourceExhausted extends Data.TaggedError("WatchSourceExhausted")<{
  readonly code: string;
}> {}

export interface WatchEventSource {
  close(): void;
}

export interface WatchEventSourceCallbacks {
  onEvent(): void;
  onError(error: unknown): void;
  onReady?(): void;
}

export interface WatchControllerDeps {
  /** Compute the current changeset signature. May fail; failure is non-fatal. */
  readonly getSignature: Effect.Effect<string, unknown>;
  /** Apply a refresh. May fail; failure is non-fatal. */
  readonly refresh: Effect.Effect<void, unknown>;
  readonly reportError: (error: unknown) => Effect.Effect<void>;
  readonly onReloadPending: Effect.Effect<void>;
  readonly createEventSource: (callbacks: WatchEventSourceCallbacks) => WatchEventSource;
}

/**
 * Concern #5, gone: source lifetime.
 *
 * `acquireRelease` ties `close()` to the enclosing scope. The controller can no
 * longer leak a watcher or close one twice, so the four-state `sourceStatus`
 * machine and the `isSourceClosed()` post-construction check both disappear.
 * If `createEventSource` throws, acquisition fails and nothing was acquired.
 */
const openEventSource = (
  create: (callbacks: WatchEventSourceCallbacks) => WatchEventSource,
  events: Queue.Queue<void>,
  onSourceError: (error: unknown) => Effect.Effect<void>,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      create({
        onEvent: () => Effect.runSync(Queue.offer(events, undefined).pipe(Effect.asVoid)),
        onError: (error) => Effect.runFork(onSourceError(error)),
        onReady: () => Effect.runSync(Queue.offer(events, undefined).pipe(Effect.asVoid)),
      }),
    ),
    (source) => Effect.sync(() => source.close()),
  );

/**
 * Concern #2, gone: coalescing four deadlines by hand.
 *
 * Wait for the first event, then swallow events until either the quiet window
 * passes with none, or the hard cap elapses — whichever comes first. That is
 * the whole of `quietDeadline` + `maximumDeadline` + `schedule()` +
 * `clearTimer()` + `onTimer()`, expressed as a race.
 */
const awaitCoalescedEvent = (events: Queue.Queue<void>, config: WatchControllerConfig) => {
  const quietWindow: Effect.Effect<void> = Queue.take(events).pipe(
    Effect.timeoutTo({
      duration: config.quietDelay,
      onTimeout: () => "settled" as const,
      onSuccess: () => "more" as const,
    }),
    Effect.flatMap((outcome) =>
      outcome === "settled" ? Effect.void : Effect.suspend(() => quietWindow),
    ),
  );

  return Queue.take(events).pipe(
    Effect.zipRight(Effect.raceFirst(quietWindow, Effect.sleep(config.maximumDelay))),
    Effect.as("event" as const),
  );
};

/**
 * Concern #1, gone: cancellation guards.
 *
 * There is no `isClosed()` anywhere below. When the controller's scope closes,
 * the fiber running this loop is interrupted at whatever `yield*` it is parked
 * on — mid-sleep, mid-`getSignature`, mid-`refresh` — and the continuation
 * simply never runs. That is the same guarantee the four manual guards were
 * approximating, except it cannot be forgotten at a new await site.
 */
const runCheck = (
  deps: WatchControllerDeps,
  applied: Ref.Ref<string>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const signature = yield* deps.getSignature;
    const current = yield* Ref.get(applied);

    if (signature === current) {
      return;
    }

    yield* deps.refresh;
    yield* Ref.set(applied, signature);
  }).pipe(
    // Expected failures are reported and swallowed; the loop survives them,
    // exactly as `finishCheck()` does today. Interruption is *not* caught here
    // — it propagates, which is what makes close instant.
    Effect.catchAll((error) => deps.reportError(error)),
  );

export interface WatchControllerState {
  readonly degraded: boolean;
  readonly appliedSignature: string;
}

/**
 * The controller.
 *
 * Returns a `Ref` for diagnostics. Lifetime is the caller's `Scope`: close the
 * scope and the watcher closes, the loop is interrupted, and any in-flight
 * signature check is abandoned. There is no `close()` method to call in the
 * right order, and no way to call it twice.
 */
export const makeWatchController = (
  deps: WatchControllerDeps,
  config: WatchControllerConfig = defaultConfig,
): Effect.Effect<Ref.Ref<WatchControllerState>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<void>();
    const applied = yield* Ref.make(config.initialSignature);
    const state = yield* Ref.make<WatchControllerState>({
      degraded: false,
      appliedSignature: config.initialSignature,
    });

    /** Degrade to polling only for watcher resource exhaustion, as today. */
    const onSourceError = (error: unknown) =>
      Effect.gen(function* () {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;

        if (code === "ENOSPC" || code === "EMFILE") {
          yield* Ref.update(state, (prior) => ({ ...prior, degraded: true }));
        }

        yield* deps.reportError(error);
      });

    yield* openEventSource(deps.createEventSource, events, onSourceError);

    /**
     * Concern #4, gone: the `dirty` flag.
     *
     * Events that arrive while a check is running stay in the queue. The next
     * turn of the loop takes them immediately, which *is* the trailing check
     * that `state.dirty` was tracking — no flag, no way to drop one.
     */
    const loop = Effect.gen(function* () {
      const { degraded } = yield* Ref.get(state);
      const safetyInterval = degraded ? config.degradedCheck : config.healthyCheck;

      yield* Effect.raceFirst(
        awaitCoalescedEvent(events, config).pipe(Effect.zipLeft(deps.onReloadPending)),
        Effect.sleep(safetyInterval).pipe(Effect.as("poll" as const)),
      );

      yield* runCheck(deps, applied);
      yield* Ref.get(applied).pipe(
        Effect.flatMap((signature) =>
          Ref.update(state, (prior) => ({ ...prior, appliedSignature: signature })),
        ),
      );
    }).pipe(Effect.forever);

    // `forkScoped` ties the fiber to the same scope as the watcher: one
    // lifetime, released in the right order automatically.
    yield* Effect.forkScoped(loop);

    return state;
  });

/**
 * Concern #3, gone: the clock seam.
 *
 * `WatchControllerClock` had exactly one production implementation and existed
 * for tests. Effect's `TestClock` controls `Effect.sleep` and every timeout in
 * the whole tree — including ones inside `getSignature` — without the domain
 * type knowing time is fake. `WatchControllerClock`, `defaultClock`, and every
 * `clock.now()` call site are deleted.
 *
 * See `02-watch-controller.test.ts` for the tests this enables.
 */
export type ClockSeamIsDeleted = never;

/** Convenience for callers outside Effect; see sample 4 for the real boundary. */
export const runWatchControllerForever = (deps: WatchControllerDeps) =>
  Effect.scoped(makeWatchController(deps).pipe(Effect.flatMap(() => Effect.never)));

export { Fiber };
