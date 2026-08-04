/**
 * Tests for sample 2 — and the point of sample 2.
 *
 * `src/core/watchController.test.ts` is 642 lines, and a large fraction of it is
 * scaffolding: a fake clock object, a manual timer queue, and helpers that
 * advance it. All of that exists because the controller had to be handed a
 * clock.
 *
 * These tests use `TestClock`. Time is virtual for the entire effect tree, so
 * `TestClock.adjust` advances the debounce window, the maximum-delay cap, and
 * the safety poll at once, with no seam in the production type. Every assertion
 * below is about behavior the real controller has today.
 */

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Ref, TestClock, TestContext } from "effect";
import {
  defaultConfig,
  makeWatchController,
  type WatchEventSourceCallbacks,
} from "./02-watch-controller";

/** Build a controller whose signature and refresh calls are observable. */
const harness = (signatures: string[]) =>
  Effect.gen(function* () {
    const refreshes = yield* Ref.make(0);
    const checks = yield* Ref.make(0);
    const errors = yield* Ref.make<unknown[]>([]);
    let emit: (() => void) | undefined;
    let closed = 0;

    const controller = yield* makeWatchController(
      {
        getSignature: Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(checks, (n) => n + 1);
          return signatures[Math.min(index, signatures.length - 1)] ?? "";
        }),
        refresh: Ref.update(refreshes, (n) => n + 1),
        reportError: (error) => Ref.update(errors, (prior) => [...prior, error]),
        onReloadPending: Effect.void,
        createEventSource: (callbacks: WatchEventSourceCallbacks) => {
          emit = callbacks.onEvent;
          return {
            close: () => {
              closed += 1;
            },
          };
        },
      },
      { ...defaultConfig, initialSignature: "sig-0" },
    );

    return {
      controller,
      refreshes,
      checks,
      errors,
      fire: () => emit?.(),
      closedCount: () => closed,
    };
  });

describe("watch controller (Effect)", () => {
  test("coalesces a noisy burst into one check", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(["sig-0"]);

          // Three events spread across 300ms — shorter than the 1000ms cap,
          // each one resetting the 200ms quiet window.
          h.fire();
          yield* TestClock.adjust(Duration.millis(150));
          h.fire();
          yield* TestClock.adjust(Duration.millis(150));
          h.fire();

          // Still inside the quiet window: nothing has run yet.
          expect(yield* Ref.get(h.checks)).toBe(0);

          yield* TestClock.adjust(Duration.millis(250));
          expect(yield* Ref.get(h.checks)).toBe(1);
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    ));

  test("a relentless event stream still checks at the maximum-delay cap", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(["sig-0"]);

          // An event every 50ms never lets the 200ms quiet window close, so
          // only the 1000ms cap can fire the check. This is the invariant the
          // real controller's `maximumDeadline` protects.
          for (let i = 0; i < 24; i += 1) {
            h.fire();
            yield* TestClock.adjust(Duration.millis(50));
          }

          expect(yield* Ref.get(h.checks)).toBe(1);
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    ));

  test("refreshes only when the signature actually changed", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // First check sees the unchanged signature, second sees a new one.
          const h = yield* harness(["sig-0", "sig-1"]);

          h.fire();
          yield* TestClock.adjust(Duration.millis(250));
          expect(yield* Ref.get(h.checks)).toBe(1);
          expect(yield* Ref.get(h.refreshes)).toBe(0);

          h.fire();
          yield* TestClock.adjust(Duration.millis(250));
          expect(yield* Ref.get(h.checks)).toBe(2);
          expect(yield* Ref.get(h.refreshes)).toBe(1);
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    ));

  test("polls on the safety interval when no events arrive", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(["sig-0"]);

          yield* TestClock.adjust(Duration.seconds(9));
          expect(yield* Ref.get(h.checks)).toBe(0);

          yield* TestClock.adjust(Duration.seconds(2));
          expect(yield* Ref.get(h.checks)).toBe(1);
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    ));

  test("a failing signature check is reported and the loop survives", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const failures = yield* Ref.make(0);
          const errors = yield* Ref.make<unknown[]>([]);
          let emit: (() => void) | undefined;

          yield* makeWatchController(
            {
              getSignature: Effect.gen(function* () {
                const n = yield* Ref.getAndUpdate(failures, (prior) => prior + 1);
                return n === 0 ? yield* Effect.fail(new Error("git exploded")) : "sig-1";
              }),
              refresh: Effect.void,
              reportError: (error) => Ref.update(errors, (prior) => [...prior, error]),
              onReloadPending: Effect.void,
              createEventSource: (callbacks) => {
                emit = callbacks.onEvent;
                return { close: () => {} };
              },
            },
            { ...defaultConfig, initialSignature: "sig-0" },
          );

          emit?.();
          yield* TestClock.adjust(Duration.millis(250));
          expect((yield* Ref.get(errors)).length).toBe(1);

          // The controller is still alive: the next event is still serviced.
          emit?.();
          yield* TestClock.adjust(Duration.millis(250));
          expect(yield* Ref.get(failures)).toBe(2);
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    ));

  test("closing the scope closes the event source and stops the loop", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let closed = 0;
        const checks = yield* Ref.make(0);
        let emit: (() => void) | undefined;

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* makeWatchController(
              {
                getSignature: Ref.updateAndGet(checks, (n) => n + 1).pipe(Effect.as("sig-0")),
                refresh: Effect.void,
                reportError: () => Effect.void,
                onReloadPending: Effect.void,
                createEventSource: (callbacks) => {
                  emit = callbacks.onEvent;
                  return {
                    close: () => {
                      closed += 1;
                    },
                  };
                },
              },
              { ...defaultConfig, initialSignature: "sig-0" },
            );

            yield* TestClock.adjust(Duration.seconds(11));
            expect(yield* Ref.get(checks)).toBe(1);
          }),
        );

        // Scope exit released the watcher exactly once, with no close() call.
        expect(closed).toBe(1);

        // And the loop is gone: further time and further events do nothing.
        emit?.();
        yield* TestClock.adjust(Duration.seconds(60));
        expect(yield* Ref.get(checks)).toBe(1);
      }).pipe(Effect.provide(TestContext.TestContext)),
    ));
});
