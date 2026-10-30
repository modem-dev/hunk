/** Limit retained retry history independently of the highlighted-result cache. */
const MAX_RETAINED_HIGHLIGHT_RETRY_KEYS = 1_024;

/**
 * Track failures for recently requested highlight keys under a bounded retention budget.
 *
 * Watch reloads can abandon a key after its first failure, so settlement alone cannot reclaim
 * history. Requests refresh recency; new failures evict the least recently requested key. An
 * evicted key becomes eligible for a fresh retry budget, just as an evicted plain fallback does.
 */
export function createHighlightRetryBudget(
  maxRetryAttempts: number,
  maxKeys = MAX_RETAINED_HIGHLIGHT_RETRY_KEYS,
) {
  const failures = new Map<string, number>();
  const capacity = Math.max(1, Math.floor(maxKeys));

  return {
    /** Keep a requested provisional key ahead of abandoned revision keys. */
    touch(cacheKey: string) {
      const attempts = failures.get(cacheKey);
      if (attempts !== undefined) {
        failures.delete(cacheKey);
        failures.set(cacheKey, attempts);
      }
    },

    /** Record a failure and return whether this key may retry again. */
    recordFailure(cacheKey: string) {
      const attempts = (failures.get(cacheKey) ?? 0) + 1;
      failures.delete(cacheKey);
      if (attempts > maxRetryAttempts) {
        return false;
      }

      failures.set(cacheKey, attempts);
      if (failures.size > capacity) {
        const oldestKey = failures.keys().next().value;
        if (oldestKey !== undefined) {
          failures.delete(oldestKey);
        }
      }
      return true;
    },

    /** Release retry history when a key successfully settles. */
    clear(cacheKey: string) {
      failures.delete(cacheKey);
    },
  };
}
