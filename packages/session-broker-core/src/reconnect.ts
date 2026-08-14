/**
 * One reconnect timer, for every client that has to come back after a dropped link.
 *
 * The pieces are always the same — at most one pending attempt, a delay that may grow with
 * consecutive failures, a stop that cannot be restarted, and a timer that must not hold the
 * process open — and the prototype wrote them four times with three different policies,
 * including one client re-implementing the scheduler of the connection it already
 * configured (`docs/browser-review-seam-audit.md`, C5). It is written once here, in the
 * package both the session-side connections and a browser client can import.
 *
 * What stays with each caller is what should: which failures are worth retrying, and what
 * to do when the timer comes due. This module owns the timing and nothing else — it never
 * touches a socket, so it is as usable over `fetch` as over a websocket.
 */

export interface ReconnectSchedulerOptions {
  /** Delay before a first retry, and the whole delay while `factor` is 1. */
  delayMs: number;
  /** What the timer does when it comes due. */
  onDue: () => void;
  /**
   * Growth per consecutive attempt. The default of 1 keeps a fixed delay, so a caller that
   * wants "try again in three seconds, forever" gets exactly that rather than a backoff it
   * did not ask for.
   */
  factor?: number;
  /** Ceiling the delay never exceeds, however many attempts have failed. */
  maxDelayMs?: number;
  /**
   * Fraction of each delay spread randomly, as a number in `[0, 1]`.
   *
   * Several clients dropped by one restarting daemon otherwise retry in lockstep and
   * arrive as one burst; jitter turns that into a spread.
   */
  jitter?: number;
  /** Randomness source, injected so a test can pin the jitter. */
  random?: () => number;
  /** Timer functions, injected so a test can drive time. */
  timers?: {
    setTimeout: (handler: () => void, delayMs: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export interface ReconnectScheduler {
  /**
   * Arrange one attempt, unless one is already pending or the scheduler is stopped.
   *
   * Returns whether this call is the one that armed the timer, which is what a caller
   * needs to avoid logging a reconnect per failed message.
   */
  schedule: (delayMs?: number) => boolean;
  /** Cancel any pending attempt without ending the scheduler. */
  cancel: () => void;
  /** Forget the failure count, so the next delay is the first one again. */
  reset: () => void;
  /** Cancel and refuse every later `schedule`. */
  stop: () => void;
  /** How many attempts have been scheduled since the last `reset`. */
  readonly attempts: number;
  /** Whether an attempt is currently armed. */
  readonly pending: boolean;
}

/** Build one reconnect scheduler. */
export function createReconnectScheduler(options: ReconnectSchedulerOptions): ReconnectScheduler {
  const factor = options.factor ?? 1;
  const jitter = Math.min(Math.max(options.jitter ?? 0, 0), 1);
  const random = options.random ?? Math.random;
  const setTimer = options.timers?.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = options.timers?.clearTimeout ?? ((handle) => clearTimeout(handle as never));

  let handle: unknown = null;
  let attempts = 0;
  let stopped = false;

  /** The delay this attempt waits: growth, then ceiling, then jitter. */
  function delayFor(attempt: number) {
    const grown = options.delayMs * factor ** Math.max(attempt, 0);
    const bounded = Math.min(grown, options.maxDelayMs ?? grown);
    return jitter === 0 ? bounded : bounded * (1 - jitter + jitter * random());
  }

  return {
    schedule(delayMs?: number) {
      if (handle !== null || stopped) {
        return false;
      }
      const wait = delayMs ?? delayFor(attempts);
      attempts += 1;
      handle = setTimer(() => {
        handle = null;
        options.onDue();
      }, wait);
      // Node's timers can hold a process open; a pending reconnect never should.
      (handle as { unref?: () => void })?.unref?.();
      return true;
    },
    cancel() {
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
    },
    reset() {
      attempts = 0;
    },
    stop() {
      stopped = true;
      this.cancel();
    },
    get attempts() {
      return attempts;
    },
    get pending() {
      return handle !== null;
    },
  };
}
