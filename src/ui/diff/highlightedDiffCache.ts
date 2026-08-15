import type { HighlightedDiffCode } from "./diffRows";

/**
 * Maximum cached highlight results.
 *
 * Highlighted HAST nodes and their flattened render spans are expensive enough that a whole-review
 * cache can dominate memory while navigating large changesets. Keep a viewport-local working set
 * instead of retaining every file the user has visited in the current review.
 */
const MAX_HIGHLIGHTED_DIFF_CACHE_ENTRIES = 40;

export interface HighlightedDiffCache {
  /** Read one result and mark it most recently used. */
  get: (key: string) => HighlightedDiffCode | undefined;
  /** Read one result without changing recency, for render paths that must stay side-effect free. */
  peek: (key: string) => HighlightedDiffCode | undefined;
  /** Store one result as most recently used, evicting the least recently used entries over budget. */
  set: (key: string, value: HighlightedDiffCode) => void;
}

/**
 * Holds highlight results under a bounded least-recently-used budget.
 *
 * Reads refresh recency, so eviction drops the files the review has stopped touching rather than
 * the ones highlighted longest ago. Viewport prefetch re-reads its whole halo on every scroll, so
 * the files on screen stay resident while files ahead of them are warmed. A halo wider than the
 * budget still thrashes; that is a prefetch sizing question, not an eviction-order one.
 */
export function createHighlightedDiffCache(
  maxEntries = MAX_HIGHLIGHTED_DIFF_CACHE_ENTRIES,
): HighlightedDiffCache {
  const entries = new Map<string, HighlightedDiffCode>();
  const budget = Math.max(1, Math.floor(maxEntries));

  /** Move one key to the most-recently-used end of Map iteration order. */
  const touch = (key: string, value: HighlightedDiffCode) => {
    entries.delete(key);
    entries.set(key, value);
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }

      touch(key, entry);
      return entry;
    },

    peek(key) {
      return entries.get(key);
    },

    set(key, value) {
      touch(key, value);

      // Map iteration order is insertion order and every read re-inserts, so the first keys are
      // the least recently used.
      while (entries.size > budget) {
        const leastRecentlyUsed = entries.keys().next().value;
        if (leastRecentlyUsed === undefined) {
          return;
        }

        entries.delete(leastRecentlyUsed);
      }
    },
  };
}
