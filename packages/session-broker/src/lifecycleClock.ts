/** Supplies runtime-neutral lifecycle time and scheduling to broker producers. */
export interface SessionBrokerLifecycleClock {
  /** Return the current wall-clock time in milliseconds. */
  now(): number;
  /** Schedule one callback and return an idempotent disposer for the pending timer. */
  schedule(callback: () => void, delayMs: number): () => void;
  /** Schedule delayed-first fixed-rate callbacks and return an idempotent disposer. */
  scheduleInterval(callback: () => void, intervalMs: number): () => void;
  /** Await a delay without claiming that unrelated asynchronous work is cancellable. */
  delay(delayMs: number): Promise<void>;
}

/** Create one native lifecycle clock whose scheduled work does not retain the process. */
export function createNativeSessionBrokerLifecycleClock(): SessionBrokerLifecycleClock {
  /** Schedule a native one-shot timer while hiding its runtime-specific handle. */
  const schedule = (callback: () => void, delayMs: number) => {
    let active = true;
    const handle = setTimeout(() => {
      if (!active) return;
      active = false;
      callback();
    }, delayMs);
    handle.unref?.();

    return () => {
      if (!active) return;
      active = false;
      clearTimeout(handle);
    };
  };

  return {
    now: () => Date.now(),
    schedule,
    scheduleInterval(callback, intervalMs) {
      let active = true;
      const handle = setInterval(() => {
        if (active) callback();
      }, intervalMs);
      handle.unref?.();

      return () => {
        if (!active) return;
        active = false;
        clearInterval(handle);
      };
    },
    delay: (delayMs) => new Promise<void>((resolve) => void schedule(resolve, delayMs)),
  };
}
