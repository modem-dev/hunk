import {
  cloneCompactHighlightedDiff,
  compactHighlightedDiffByteLength,
  type CompactHighlightedDiff,
} from "./highlightCompact";

/** Bounds compact worker response bytes retained after the terminal-owned cache evicts them. */
export const MAX_WORKER_HIGHLIGHT_CACHE_BYTES = 8 * 1024 * 1024;

interface HighlightWorkerCacheEntry {
  bytes: number;
  payload: CompactHighlightedDiff;
}

/** Holds a byte-bounded LRU of compact worker results without surrendering response buffers. */
export class HighlightWorkerCache {
  private readonly entries = new Map<string, HighlightWorkerCacheEntry>();
  private readonly maxBytes: number;
  private cachedBytes = 0;

  constructor(maxBytes = MAX_WORKER_HIGHLIGHT_CACHE_BYTES) {
    this.maxBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes)) : 1;
  }

  /** Returns a transferable copy while preserving the worker-owned cached payload. */
  get(cacheKey: string) {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return undefined;
    }

    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return cloneCompactHighlightedDiff(entry.payload);
  }

  /** Retains one worker-owned payload and evicts least-recently-used entries over budget. */
  set(cacheKey: string, payload: CompactHighlightedDiff) {
    const entry = { bytes: compactHighlightedDiffByteLength(payload), payload };
    if (entry.bytes > this.maxBytes) {
      return false;
    }

    const previous = this.entries.get(cacheKey);
    if (previous) {
      this.cachedBytes -= previous.bytes;
      this.entries.delete(cacheKey);
    }

    this.entries.set(cacheKey, entry);
    this.cachedBytes += entry.bytes;

    while (this.cachedBytes > this.maxBytes) {
      const leastRecentlyUsed = this.entries.entries().next().value;
      if (!leastRecentlyUsed) {
        return false;
      }

      const [key, evicted] = leastRecentlyUsed;
      this.entries.delete(key);
      this.cachedBytes -= evicted.bytes;
    }

    return true;
  }

  /** Reports retained payload bytes for focused cache tests. */
  getCachedBytes() {
    return this.cachedBytes;
  }
}
