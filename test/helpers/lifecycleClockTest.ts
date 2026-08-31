import type { SessionBrokerLifecycleClock } from "@hunk/session-broker";

interface ScheduledLifecycleTimerTest {
  id: number;
  due: number;
  intervalMs: number | null;
  callback: () => void;
}

/** Drive lifecycle scheduling deterministically without replacing process-global timers. */
export class DeterministicLifecycleClockTest implements SessionBrokerLifecycleClock {
  private currentTimeMs: number;
  private nextId = 1;
  private readonly scheduled = new Map<number, ScheduledLifecycleTimerTest>();

  constructor(startTimeMs = 0) {
    this.currentTimeMs = startTimeMs;
  }

  now() {
    return this.currentTimeMs;
  }

  schedule(callback: () => void, delayMs: number) {
    return this.addTimerTest(callback, delayMs, null);
  }

  scheduleInterval(callback: () => void, intervalMs: number) {
    if (intervalMs <= 0) throw new Error("Test clock intervals must be positive.");
    return this.addTimerTest(callback, intervalMs, intervalMs);
  }

  delay(delayMs: number) {
    return new Promise<void>((resolve) => void this.schedule(resolve, delayMs));
  }

  /** Advance through every callback due in the requested interval. */
  advanceByTest(durationMs: number) {
    if (durationMs < 0) throw new Error("Test clock cannot move backwards.");
    const target = this.currentTimeMs + durationMs;

    for (;;) {
      const next = this.nextDueTimerTest(target);
      if (!next) break;
      this.fireTimerTest(next);
    }

    this.currentTimeMs = target;
  }

  /** Advance time while letting promise continuations schedule against each exact deadline. */
  async advanceByTestAsync(durationMs: number) {
    if (durationMs < 0) throw new Error("Test clock cannot move backwards.");
    const target = this.currentTimeMs + durationMs;

    for (;;) {
      const next = this.nextDueTimerTest(target);
      if (!next) break;
      this.fireTimerTest(next);
      await this.flushMicrotasksTest();
    }

    this.currentTimeMs = target;
    await this.flushMicrotasksTest();
  }

  /** Let bounded async lifecycle continuations reach their next scheduled delay. */
  async flushMicrotasksTest(rounds = 8) {
    for (let round = 0; round < rounds; round += 1) await Promise.resolve();
  }

  pendingCountTest() {
    return this.scheduled.size;
  }

  private nextDueTimerTest(target: number) {
    return [...this.scheduled.values()]
      .filter((timer) => timer.due <= target)
      .sort((left, right) => left.due - right.due || left.id - right.id)[0];
  }

  private fireTimerTest(timer: ScheduledLifecycleTimerTest) {
    this.currentTimeMs = timer.due;
    if (timer.intervalMs === null) {
      this.scheduled.delete(timer.id);
    } else {
      timer.due += timer.intervalMs;
    }
    timer.callback();
  }

  private addTimerTest(callback: () => void, delayMs: number, intervalMs: number | null) {
    const id = this.nextId++;
    let active = true;
    this.scheduled.set(id, {
      id,
      due: this.currentTimeMs + Math.max(0, delayMs),
      intervalMs,
      callback,
    });

    return () => {
      if (!active) return;
      active = false;
      this.scheduled.delete(id);
    };
  }
}
