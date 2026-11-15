import { describe, expect, test } from "bun:test";
import {
  createReconnectScheduler,
  createSupersedeQueue,
  type LifecycleTimerClock,
} from "./lifecycle";

/** A clock that only advances when the test says so. */
function createTestClock() {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; active: boolean }> = [];
  const clock: LifecycleTimerClock = {
    schedule(callback, delayMs) {
      const timer = { at: now + delayMs, callback, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((entry) => entry.active && entry.at <= now)) {
        timer.active = false;
        timer.callback();
      }
    },
    pending: () => timers.filter((timer) => timer.active).map((timer) => timer.at - now),
  };
}

describe("createReconnectScheduler", () => {
  test("backs off by its factor up to the ceiling and restarts after a success", () => {
    const time = createTestClock();
    const scheduler = createReconnectScheduler({
      backoff: { initialDelayMs: 500, factor: 2, maxDelayMs: 1_500 },
      clock: time.clock,
    });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      delays.push(scheduler.nextDelayMs());
      scheduler.schedule(() => undefined);
      time.advance(10_000);
    }
    scheduler.succeeded();

    expect(delays).toEqual([500, 1_000, 1_500, 1_500]);
    expect(scheduler.nextDelayMs()).toBe(500);
  });

  test("runs the attempt only when its delay elapses", () => {
    const time = createTestClock();
    const scheduler = createReconnectScheduler({
      backoff: { initialDelayMs: 300 },
      clock: time.clock,
    });
    let runs = 0;
    scheduler.schedule(() => {
      runs += 1;
    });

    time.advance(299);
    expect(runs).toBe(0);
    expect(scheduler.pending).toBe(true);
    time.advance(1);
    expect(runs).toBe(1);
    expect(scheduler.pending).toBe(false);
  });

  // Intent: a link that reports its loss twice must not push its own retry further away.
  test("keeps an attempt already pending for the same key", () => {
    const time = createTestClock();
    const scheduler = createReconnectScheduler<string>({
      backoff: { initialDelayMs: 100 },
      clock: time.clock,
    });

    expect(scheduler.schedule(() => undefined, { key: "a" })).toBe(true);
    time.advance(50);
    expect(scheduler.schedule(() => undefined, { key: "a" })).toBe(false);
    expect(time.pending()).toEqual([50]);
    expect(scheduler.schedule(() => undefined, { key: "b" })).toBe(true);
    expect(time.pending()).toEqual([100]);
    expect(scheduler.pendingKey).toBe("b");
  });

  test("cancels without running and honors a one-off delay", () => {
    const time = createTestClock();
    const scheduler = createReconnectScheduler({
      backoff: { initialDelayMs: 100 },
      clock: time.clock,
    });
    let runs = 0;
    scheduler.schedule(() => {
      runs += 1;
    });
    scheduler.cancel();
    time.advance(1_000);
    scheduler.schedule(() => undefined, { delayMs: 7 });

    expect(runs).toBe(0);
    expect(time.pending()).toEqual([7]);
  });

  test("stays idle when a disposer throws during cancel", () => {
    const scheduler = createReconnectScheduler({
      backoff: { initialDelayMs: 100 },
      clock: {
        schedule: () => () => {
          throw new Error("dispose failed");
        },
      },
    });
    scheduler.schedule(() => undefined);

    expect(() => scheduler.cancel()).toThrow("dispose failed");
    expect(scheduler.pending).toBe(false);
  });
});

describe("createSupersedeQueue", () => {
  test("reports a newer load's value and an older load as superseded", async () => {
    const queue = createSupersedeQueue();
    let releaseOld!: (value: string) => void;
    const older = queue.run(() => new Promise<string>((resolve) => (releaseOld = resolve)));
    const newer = queue.run(async () => "new");
    releaseOld("old");

    expect(await newer).toEqual({ status: "settled", value: "new" });
    expect(await older).toEqual({ status: "superseded" });
  });

  test("aborts the superseded load's signal at once", async () => {
    const queue = createSupersedeQueue();
    let observed: AbortSignal | undefined;
    const older = queue.run(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          observed = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await queue.run(async () => undefined);

    expect(observed?.aborted).toBe(true);
    expect(await older).toEqual({ status: "superseded" });
  });

  test("rethrows a failure of the current load and tracks epochs", async () => {
    const queue = createSupersedeQueue();
    const failing = queue.run(async () => {
      throw new Error("boom");
    });

    await expect(failing).rejects.toThrow("boom");
    expect(queue.epoch).toBe(1);
    expect(queue.isCurrent(1)).toBe(true);
    queue.cancel();
    expect(queue.isCurrent(1)).toBe(false);
  });
});
