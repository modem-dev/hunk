/**
 * Schedules reconnect attempts and supersedes in-flight loads, for every client that keeps a
 * link to a broker alive.
 *
 * Two lifecycle questions recur in every long-lived client: "the link dropped — when do I try
 * again?" and "a newer load started — what happens to the older one still running?". The
 * prototype answered the first four times (one copy verbatim) and the second twice, each with
 * its own timing constants (`docs/browser-review-seam-audit.md`, C5 and C3). Both answers live
 * here, runtime-neutral and timer-injected, so a Bun daemon client, a Node adapter, and a
 * browser page schedule and supersede the same way and tests drive them with a fake clock.
 *
 * Browser-safe on purpose: this module imports nothing, and the package exposes it as its own
 * `@hunk/session-broker-core/lifecycle` entry so a browser bundle can take it without the
 * Node-only modules the package barrel also re-exports.
 */

/** The one timer capability both primitives need; returns an idempotent disposer. */
export interface LifecycleTimerClock {
  schedule(callback: () => void, delayMs: number): () => void;
}

/** A timer clock over the platform's own `setTimeout`. */
export const NATIVE_LIFECYCLE_TIMER_CLOCK: LifecycleTimerClock = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/**
 * How long to wait before each attempt.
 *
 * The first retry waits `initialDelayMs`; each consecutive failure multiplies the wait by
 * `factor` up to `maxDelayMs`. A factor of 1 is a fixed delay.
 */
export interface ReconnectBackoff {
  initialDelayMs: number;
  maxDelayMs?: number;
  factor?: number;
}

export interface ReconnectSchedulerOptions {
  backoff: ReconnectBackoff;
  clock?: LifecycleTimerClock;
}

/** One pending-or-idle reconnect timer with backoff. */
export interface ReconnectScheduler<Key = unknown> {
  /**
   * Schedule one attempt, replacing any attempt already pending.
   *
   * An attempt already pending for the same `key` is kept rather than restarted, so a link
   * that reports its loss twice does not push its retry further away. `delayMs` overrides
   * the backoff for this one attempt; otherwise the attempt waits the current backoff and
   * the next one waits longer. Returns whether a new attempt was scheduled.
   */
  schedule(attempt: () => void, options?: { key?: Key; delayMs?: number }): boolean;
  /** Drop the pending attempt, if any, without touching the backoff. */
  cancel(): void;
  /** Record a successful connection: the next failure starts from the initial delay again. */
  succeeded(): void;
  /** The delay the next scheduled attempt will wait, absent an override. */
  nextDelayMs(): number;
  readonly pending: boolean;
  /** The key the pending attempt was scheduled under. */
  readonly pendingKey: Key | undefined;
  /** Consecutive attempts scheduled since the last success. */
  readonly attempts: number;
}

/** Create one reconnect scheduler. */
export function createReconnectScheduler<Key = unknown>({
  backoff,
  clock = NATIVE_LIFECYCLE_TIMER_CLOCK,
}: ReconnectSchedulerOptions): ReconnectScheduler<Key> {
  const factor = backoff.factor ?? 1;
  const maxDelayMs = backoff.maxDelayMs ?? backoff.initialDelayMs;
  let attempts = 0;
  let pending: { key: Key | undefined; dispose: () => void } | undefined;

  const nextDelayMs = () =>
    Math.min(maxDelayMs, backoff.initialDelayMs * factor ** Math.min(attempts, 64));

  return {
    schedule(attempt, options = {}) {
      if (pending && options.key !== undefined && pending.key === options.key) {
        return false;
      }
      const replaced = pending;
      pending = undefined;
      replaced?.dispose();
      const delayMs = options.delayMs ?? nextDelayMs();
      attempts += 1;
      let scheduled!: { key: Key | undefined; dispose: () => void };
      const dispose = clock.schedule(() => {
        // A replaced or cancelled timer whose disposer raced its own firing does nothing.
        if (pending !== scheduled) return;
        pending = undefined;
        attempt();
      }, delayMs);
      scheduled = { key: options.key, dispose };
      pending = scheduled;
      return true;
    },
    cancel() {
      // Ownership is released before the disposer runs, so a disposer that throws still
      // leaves the scheduler idle.
      const cancelled = pending;
      pending = undefined;
      cancelled?.dispose();
    },
    succeeded() {
      attempts = 0;
    },
    nextDelayMs,
    get pending() {
      return pending !== undefined;
    },
    get pendingKey() {
      return pending?.key;
    },
    get attempts() {
      return attempts;
    },
  };
}

/** What a superseding run reports: its value, or that a newer run replaced it. */
export type SupersedeOutcome<T> = { status: "settled"; value: T } | { status: "superseded" };

/** One latest-wins queue of asynchronous loads. */
export interface SupersedeQueue {
  /**
   * Start one load, superseding every load still in flight.
   *
   * The superseded load's signal aborts at once, and its outcome reports `superseded`
   * whatever it resolves with, so a slow older load can never overwrite a newer one. A load
   * that throws after being superseded is reported as superseded too.
   */
  run<T>(load: (signal: AbortSignal, epoch: number) => Promise<T>): Promise<SupersedeOutcome<T>>;
  /** Supersede the in-flight load, if any, without starting another. */
  cancel(): void;
  /** The epoch of the most recently started load; 0 before the first. */
  readonly epoch: number;
  /** Whether `epoch` is still the latest load. */
  isCurrent(epoch: number): boolean;
}

/** Create one supersede queue. */
export function createSupersedeQueue(): SupersedeQueue {
  let epoch = 0;
  let controller: AbortController | undefined;

  return {
    async run(load) {
      controller?.abort();
      const own = new AbortController();
      controller = own;
      epoch += 1;
      const started = epoch;
      try {
        const value = await load(own.signal, started);
        return started === epoch ? { status: "settled", value } : { status: "superseded" };
      } catch (error) {
        if (started !== epoch) {
          return { status: "superseded" };
        }
        throw error;
      } finally {
        if (controller === own) {
          controller = undefined;
        }
      }
    },
    cancel() {
      controller?.abort();
      controller = undefined;
      epoch += 1;
    },
    get epoch() {
      return epoch;
    },
    isCurrent(candidate) {
      return candidate === epoch;
    },
  };
}
