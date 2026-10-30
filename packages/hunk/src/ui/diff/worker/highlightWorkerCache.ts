import {
  cloneCompactHighlightedDiff,
  cloneCompactHighlightedDocument,
  compactHighlightedDiffByteLength,
  compactHighlightedDocumentByteLength,
  type CompactHighlightedDiff,
  type CompactHighlightedDocument,
} from "./highlightCompact";

/** Bounds compact worker response bytes retained after the terminal-owned cache evicts them. */
export const MAX_WORKER_HIGHLIGHT_CACHE_BYTES = 8 * 1024 * 1024;
/** Bounds tiny and empty artifacts that consume little typed-array space. */
export const MAX_WORKER_HIGHLIGHT_CACHE_ENTRIES = 512;

export type HighlightWorkerCachePayload = CompactHighlightedDiff | CompactHighlightedDocument;

interface HighlightWorkerCacheEntry {
  bytes: number;
  payload: HighlightWorkerCachePayload;
}

/** Return whether one compact payload represents a complete document rather than a diff. */
function isDocumentPayload(
  payload: HighlightWorkerCachePayload,
): payload is CompactHighlightedDocument {
  return "document" in payload;
}

/** Clone a compact payload without surrendering the worker-owned typed arrays. */
function clonePayload(payload: HighlightWorkerCachePayload) {
  return isDocumentPayload(payload)
    ? cloneCompactHighlightedDocument(payload)
    : cloneCompactHighlightedDiff(payload);
}

/** Measure the retained wire representation for either compact payload kind. */
function payloadByteLength(payload: HighlightWorkerCachePayload) {
  return isDocumentPayload(payload)
    ? compactHighlightedDocumentByteLength(payload)
    : compactHighlightedDiffByteLength(payload);
}

/** Holds a byte-bounded LRU of compact worker results without surrendering response buffers. */
export class HighlightWorkerCache {
  private readonly entries = new Map<string, HighlightWorkerCacheEntry>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private cachedBytes = 0;

  constructor(
    maxBytes = MAX_WORKER_HIGHLIGHT_CACHE_BYTES,
    maxEntries = MAX_WORKER_HIGHLIGHT_CACHE_ENTRIES,
  ) {
    this.maxBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes)) : 1;
    this.maxEntries = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 1;
  }

  /** Returns a transferable copy while preserving the worker-owned cached payload. */
  get(cacheKey: string) {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return undefined;
    }

    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return clonePayload(entry.payload);
  }

  /** Retains one worker-owned payload and evicts least-recently-used entries over budget. */
  set(cacheKey: string, payload: HighlightWorkerCachePayload) {
    const entry = { bytes: payloadByteLength(payload), payload };
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

    while (this.cachedBytes > this.maxBytes || this.entries.size > this.maxEntries) {
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

  /** Reports retained entry count for empty-payload adversarial tests. */
  getEntryCount() {
    return this.entries.size;
  }
}
