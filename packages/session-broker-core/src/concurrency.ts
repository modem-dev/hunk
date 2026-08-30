/**
 * Running bounded work, for every caller that must not start everything at once.
 *
 * Reading many resources, hashing many files, fetching many sources: the shape is always
 * the same — a limit, work that must not exceed it, and results that must come back in the
 * order they were asked for. The repo had three copies of it, with the clamps already
 * disagreeing: one guarded `Math.max(1, limit)` and one did not, so a limit of zero meant
 * "no workers, hang forever" on one side and "one worker" on the other
 * (`docs/browser-review-seam-audit.md`, C2). The clamp here is the guarded one, and a
 * limit below one runs the work serially rather than never.
 *
 * Two entry points because callers arrive two ways. `inBoundedParallel` runs a list that is
 * known up front; `ConcurrencyGate` bounds work that arrives over time and has no list at
 * all. Both count the same slots the same way, and neither knows what the work is — this
 * module has no I/O, no timers, and no platform, which is what lets a browser client
 * import it alongside the daemon.
 */

/** Hold one limit to at least a single worker, so a zero never means "never run". */
function boundedLimit(limit: number) {
  return Math.max(1, Math.floor(limit) || 1);
}

/**
 * Run one bounded-parallel pass over a work list, preserving the order of the results.
 *
 * At most `limit` calls to `run` are in flight; results are returned by input position
 * regardless of the order they finished in. Never starts more workers than there is work.
 */
export async function inBoundedParallel<Item, Result>(
  items: readonly Item[],
  limit: number,
  run: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = Array.from({ length: items.length }) as Result[];
  let next = 0;
  const workers = Array.from({ length: Math.min(boundedLimit(limit), items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * A fixed number of slots, taken and given back as work arrives.
 *
 * For the callers `inBoundedParallel` cannot serve: work that is requested one call at a
 * time, where the limit has to hold across calls rather than within one pass. Waiters are
 * released in the order they queued, so a burst of requests is served first-come rather
 * than by whichever promise the runtime happens to resume.
 */
export class ConcurrencyGate {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = boundedLimit(limit);
  }

  /** How many slots are in use right now. */
  get inFlight() {
    return this.active;
  }

  /** Take one slot, waiting when they are all in use. */
  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  /** Give one slot back to the next waiter. */
  release() {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}
