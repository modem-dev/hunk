import type { HighlightedDiffCode } from "./diffRows";

/**
 * Cache budget, counted in highlighted diff lines.
 *
 * Highlighted HAST nodes and their flattened render spans cost roughly 1.4KB per line, so a budget
 * in lines bounds memory directly where a file count could not: 40 files of a 2400-line diff is
 * ~130MB, while 40 single-line fixes is a rounding error. Lines are also the unit the prefetch
 * window is measured in, so the files it warms always fit — a window spans about seven viewport
 * heights of rows, leaving this budget an order of magnitude of headroom for scrolling back.
 */
const MAX_HIGHLIGHTED_DIFF_CACHE_LINES = 12_000;

export interface HighlightedDiffCache {
  /** Read one result and mark it most recently used. */
  get: (key: string) => HighlightedDiffCode | undefined;
  /** Read one result without changing recency, for render paths that must stay side-effect free. */
  peek: (key: string) => HighlightedDiffCode | undefined;
  /** Store one result as most recently used, evicting the least recently used entries over budget. */
  set: (key: string, value: HighlightedDiffCode) => void;
}

interface HighlightedDiffCacheEntry {
  lines: number;
  value: HighlightedDiffCode;
}

/** Count the highlighted lines one result retains, across both diff sides. */
function highlightedLineCount(value: HighlightedDiffCode) {
  return value.deletionLines.length + value.additionLines.length;
}

/**
 * Holds highlight results under a bounded least-recently-used line budget.
 *
 * Reads refresh recency, so eviction drops the files the review has stopped touching rather than
 * the ones highlighted longest ago. Viewport prefetch re-reads its whole window on every scroll,
 * which keeps the files on screen resident while files ahead of them are warmed.
 *
 * A result larger than the whole budget is still cached, alone: the file being read must stay
 * highlighted, so a single generated file can push its neighbors out. That trade is the point of
 * budgeting memory rather than file count.
 */
export function createHighlightedDiffCache(
  maxLines = MAX_HIGHLIGHTED_DIFF_CACHE_LINES,
): HighlightedDiffCache {
  const entries = new Map<string, HighlightedDiffCacheEntry>();
  const budget = Math.max(1, Math.floor(maxLines));
  let cachedLines = 0;

  /** Move one key to the most-recently-used end of Map iteration order. */
  const touch = (key: string, entry: HighlightedDiffCacheEntry) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }

      touch(key, entry);
      return entry.value;
    },

    peek(key) {
      return entries.get(key)?.value;
    },

    set(key, value) {
      cachedLines -= entries.get(key)?.lines ?? 0;

      const lines = highlightedLineCount(value);
      touch(key, { lines, value });
      cachedLines += lines;

      // Map iteration order is insertion order and every read re-inserts, so the first keys are the
      // least recently used. Stop at one entry so the result just stored survives its own eviction
      // pass even when it alone exceeds the budget.
      while (cachedLines > budget && entries.size > 1) {
        const leastRecentlyUsed = entries.entries().next().value;
        if (leastRecentlyUsed === undefined) {
          return;
        }

        const [evictedKey, evictedEntry] = leastRecentlyUsed;
        entries.delete(evictedKey);
        cachedLines -= evictedEntry.lines;
      }
    },
  };
}
