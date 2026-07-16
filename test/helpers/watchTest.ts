import type {
  WatchControllerClock,
  WatchEventSourceCallbacks,
} from "../../src/core/watchController";
import type { WatchedInputRuntime } from "../../src/ui/hooks/useWatchedInput";

interface ScheduledWatchTestTimer {
  callback: () => void;
  deadline: number;
  id: number;
}

/** Create a deterministic clock that advances chained watch-controller timers in deadline order. */
export function createWatchTestClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, ScheduledWatchTestTimer>();

  const clock: WatchControllerClock = {
    now: () => now,
    setTimeout(callback, delayMs) {
      const timer = { callback, deadline: now + delayMs, id: nextId++ };
      timers.set(timer.id, timer);
      return timer.id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };

  return {
    clock,
    /** Advance through every timer due by the requested instant. */
    advanceBy(delayMs: number) {
      const target = now + delayMs;
      while (true) {
        const due = [...timers.values()]
          .filter((timer) => timer.deadline <= target)
          .sort((left, right) => left.deadline - right.deadline || left.id - right.id)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.deadline;
        due.callback();
      }
      now = target;
    },
  };
}

/** Build an injected watch runtime whose events and signatures are controlled by a test. */
export function createWatchTestRuntime(initialSignature = "signature:0") {
  const testClock = createWatchTestClock();
  let signature = initialSignature;
  const sources: Array<{
    callbacks: WatchEventSourceCallbacks;
    closeCount: number;
  }> = [];

  const runtime: WatchedInputRuntime = {
    clock: testClock.clock,
    getSignature: () => signature,
    resolvePlan: () => ({
      coverage: "hybrid",
      targets: [],
    }),
    createEventSource: (_plan, callbacks) => {
      const source = { callbacks, closeCount: 0 };
      sources.push(source);
      return {
        close() {
          source.closeCount++;
        },
      };
    },
  };

  return {
    runtime,
    sources,
    advanceBy: testClock.advanceBy,
    setSignature(nextSignature: string) {
      signature = nextSignature;
    },
    emit(index = sources.length - 1) {
      sources[index]?.callbacks.onEvent();
    },
  };
}
