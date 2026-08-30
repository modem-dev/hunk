import { describe, expect, test } from "bun:test";
import { createReconnectScheduler, type ReconnectSchedulerOptions } from "./reconnect";

/** A timer table a test drives by hand, so no scheduler assertion waits on real time. */
function createFakeTimers() {
  const due = new Map<number, () => void>();
  let nextHandle = 1;
  const delays: number[] = [];
  return {
    delays,
    timers: {
      setTimeout(handler: () => void, delayMs: number) {
        delays.push(delayMs);
        const handle = nextHandle;
        nextHandle += 1;
        due.set(handle, handler);
        return handle;
      },
      clearTimeout(handle: unknown) {
        due.delete(handle as number);
      },
    } satisfies NonNullable<ReconnectSchedulerOptions["timers"]>,
    /** Fire every armed timer, as the runtime would when each delay elapses. */
    fire() {
      const pending = [...due.values()];
      due.clear();
      for (const handler of pending) {
        handler();
      }
    },
  };
}

describe("createReconnectScheduler", () => {
  test("arms one attempt at a time and reports which call armed it", () => {
    const { timers, delays, fire } = createFakeTimers();
    let attempts = 0;
    const scheduler = createReconnectScheduler({
      delayMs: 3_000,
      onDue: () => {
        attempts += 1;
      },
      timers,
    });

    expect(scheduler.schedule()).toBe(true);
    expect(scheduler.schedule()).toBe(false);
    expect(scheduler.pending).toBe(true);
    expect(delays).toEqual([3_000]);

    fire();
    expect(attempts).toBe(1);
    expect(scheduler.pending).toBe(false);
    // The timer is free again once it has run, which is what lets a failed attempt ask for
    // the next one from inside its own callback.
    expect(scheduler.schedule()).toBe(true);
  });

  test("keeps a fixed delay unless a factor asks otherwise", () => {
    const { timers, delays, fire } = createFakeTimers();
    const scheduler = createReconnectScheduler({ delayMs: 3_000, onDue: () => undefined, timers });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      scheduler.schedule();
      fire();
    }

    expect(delays).toEqual([3_000, 3_000, 3_000]);
  });

  test("grows by the factor, stops at the ceiling, and forgets on reset", () => {
    const { timers, delays, fire } = createFakeTimers();
    const scheduler = createReconnectScheduler({
      delayMs: 1_000,
      factor: 2,
      maxDelayMs: 4_000,
      onDue: () => undefined,
      timers,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      scheduler.schedule();
      fire();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);

    scheduler.reset();
    scheduler.schedule();
    expect(delays.at(-1)).toBe(1_000);
  });

  test("spreads the delay by the jitter fraction", () => {
    const { timers, delays } = createFakeTimers();
    const scheduler = createReconnectScheduler({
      delayMs: 1_000,
      jitter: 0.5,
      random: () => 0,
      onDue: () => undefined,
      timers,
    });

    scheduler.schedule();
    // Jitter subtracts rather than adds, so a jittered delay is never longer than the
    // delay a caller asked for.
    expect(delays).toEqual([500]);
  });

  test("takes an explicit delay over the computed one", () => {
    const { timers, delays } = createFakeTimers();
    const scheduler = createReconnectScheduler({ delayMs: 3_000, onDue: () => undefined, timers });

    scheduler.schedule(50);
    expect(delays).toEqual([50]);
  });

  test("cancel keeps the scheduler usable and stop does not", () => {
    const { timers, fire } = createFakeTimers();
    let attempts = 0;
    const scheduler = createReconnectScheduler({
      delayMs: 3_000,
      onDue: () => {
        attempts += 1;
      },
      timers,
    });

    scheduler.schedule();
    scheduler.cancel();
    fire();
    expect(attempts).toBe(0);
    expect(scheduler.schedule()).toBe(true);

    scheduler.stop();
    fire();
    expect(attempts).toBe(0);
    expect(scheduler.schedule()).toBe(false);
  });
});
