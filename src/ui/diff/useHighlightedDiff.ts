import { useLayoutEffect, useState } from "react";
import type { DiffFile } from "../../core/types";
import type { AppTheme } from "../themes";
import { loadHighlightedDiff, type HighlightedDiffCode } from "./diffRows";
import { createHighlightedDiffCache } from "./highlightedDiffCache";
import { syntaxHighlightThemeName } from "./syntaxHighlightTheme";

const SHARED_HIGHLIGHTED_DIFF_CACHE = createHighlightedDiffCache();
const SHARED_HIGHLIGHT_PROMISES = new Map<string, Promise<HighlightedDiffCode>>();
const sourceFetcherIds = new WeakMap<NonNullable<DiffFile["sourceFetcher"]>, number>();
let nextSourceFetcherId = 1;

/** Summarize rendered diff lines without serializing whole arrays into the cache key. */
function lineSetFingerprint(lines: string[] | undefined) {
  let totalChars = 0;
  let hash = 2166136261;

  for (const line of lines ?? []) {
    totalChars += line.length;

    for (let index = 0; index < line.length; index += 1) {
      hash ^= line.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    hash ^= 10;
    hash = Math.imul(hash, 16777619);
  }

  return `${lines?.length ?? 0}:${totalChars}:${(hash >>> 0).toString(36)}`;
}

/** Build a fallback fingerprint from parsed metadata when raw patch text is unavailable. */
function metadataFingerprint(file: DiffFile) {
  const hunkSummary = file.metadata.hunks
    .map(
      (hunk) =>
        `${hunk.hunkSpecs ?? ""}:${hunk.deletionStart}:${hunk.deletionCount}:${hunk.additionStart}:${hunk.additionCount}:${hunk.hunkContent.length}`,
    )
    .join("|");

  return [
    file.metadata.name,
    file.metadata.prevName ?? "",
    file.metadata.type,
    lineSetFingerprint(file.metadata.deletionLines),
    lineSetFingerprint(file.metadata.additionLines),
    hunkSummary,
  ].join(":");
}

/** Content fingerprint from the diff patch. Changes whenever the underlying diff
 *  changes, allowing per-file cache invalidation without a global flush. */
function patchFingerprint(file: DiffFile) {
  const { patch } = file;
  if (patch.length === 0) {
    return metadataFingerprint(file);
  }

  const mid = Math.floor(patch.length / 2);
  return `${patch.length}:${patch.slice(0, 64)}:${patch.slice(mid, mid + 64)}:${patch.slice(-64)}`;
}

/** Identify the source snapshot provider used to recover grammar state for a partial diff. */
function sourceFetcherFingerprint(file: DiffFile) {
  if (!file.metadata.isPartial || !file.sourceFetcher) {
    return "patch-only";
  }

  if (file.sourceFetcher.cacheKey !== undefined) {
    return `source-cache:${file.sourceFetcher.cacheKey.length}:${file.sourceFetcher.cacheKey}`;
  }

  let id = sourceFetcherIds.get(file.sourceFetcher);
  if (id === undefined) {
    id = nextSourceFetcherId;
    nextSourceFetcherId += 1;
    sourceFetcherIds.set(file.sourceFetcher, id);
  }

  return `source:${id}`;
}

/** Cache key that includes patch and source-provider identity so reloads cannot reuse stale grammar state. */
export function highlightedDiffCacheKey(theme: AppTheme, file: DiffFile) {
  return `${theme.id}:${syntaxHighlightThemeName(theme)}:${file.id}:${patchFingerprint(file)}:${sourceFetcherFingerprint(file)}`;
}

/**
 * Worker failures re-attempted before a file settles on plain rows.
 *
 * A retryable result is deliberately kept out of the cache so a recreated worker can still colorize
 * the file, but viewport prefetch re-requests every file in its halo on each scroll. Without a
 * bound, a failure that repeats — an unresolvable worker entry, a payload the validator always
 * rejects — would restart the multi-second highlight on every scroll step. One retry covers a
 * worker lost mid-session; past that the plain result is cached and the work stops.
 */
const MAX_HIGHLIGHT_RETRY_ATTEMPTS = 1;

/** Retryable worker failures seen per cache key, cleared once the key settles. */
const HIGHLIGHT_RETRY_ATTEMPTS = new Map<string, number>();

/**
 * Commit one cacheable highlight result if its promise is still active for that key.
 *
 * A retryable worker failure updates the current view without occupying the cache, so a later
 * visit can try a recreated worker. Once the retry budget is spent the plain result is cached like
 * any other, which is what stops prefetch from re-running a failure that will not resolve.
 */
function commitHighlightResult(
  cacheKey: string,
  promise: Promise<HighlightedDiffCode>,
  result: HighlightedDiffCode,
) {
  if (SHARED_HIGHLIGHT_PROMISES.get(cacheKey) !== promise) {
    return false;
  }

  SHARED_HIGHLIGHT_PROMISES.delete(cacheKey);

  if (result.retryable) {
    const attempts = (HIGHLIGHT_RETRY_ATTEMPTS.get(cacheKey) ?? 0) + 1;
    if (attempts <= MAX_HIGHLIGHT_RETRY_ATTEMPTS) {
      HIGHLIGHT_RETRY_ATTEMPTS.set(cacheKey, attempts);
      return true;
    }

    // Budget spent: cache plain rows without the retryable marker so readers stop re-requesting.
    HIGHLIGHT_RETRY_ATTEMPTS.delete(cacheKey);
    SHARED_HIGHLIGHTED_DIFF_CACHE.set(cacheKey, { deletionLines: [], additionLines: [] });
    return true;
  }

  HIGHLIGHT_RETRY_ATTEMPTS.delete(cacheKey);
  SHARED_HIGHLIGHTED_DIFF_CACHE.set(cacheKey, result);
  return true;
}

/** Start one shared highlight request unless the cache or an in-flight promise already has it. */
function ensureHighlightedDiffLoaded(
  file: DiffFile,
  theme: AppTheme,
  offloadLargeDiff: boolean,
  cacheKey = highlightedDiffCacheKey(theme, file),
) {
  // Viewport prefetch calls this for every file in its halo on each scroll, so this read is also
  // what keeps the files around the viewport at the recent end of the cache while files entering
  // the halo evict older ones.
  const cached = SHARED_HIGHLIGHTED_DIFF_CACHE.get(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

  const existing = SHARED_HIGHLIGHT_PROMISES.get(cacheKey);
  if (existing) {
    return existing;
  }

  let pending: Promise<HighlightedDiffCode>;
  pending = loadHighlightedDiff(file, theme, { offloadLargeDiff })
    .then((nextHighlighted) => {
      commitHighlightResult(cacheKey, pending, nextHighlighted);
      return nextHighlighted;
    })
    .catch(() => {
      const fallback = {
        deletionLines: [],
        additionLines: [],
      } satisfies HighlightedDiffCode;
      commitHighlightResult(cacheKey, pending, fallback);
      return fallback;
    });

  SHARED_HIGHLIGHT_PROMISES.set(cacheKey, pending);
  return pending;
}

/** Queue syntax highlighting for one file without mounting its diff rows first. */
export function prefetchHighlightedDiff({
  file,
  offloadLargeDiff = false,
  theme,
}: {
  file: DiffFile;
  offloadLargeDiff?: boolean;
  theme: AppTheme;
}) {
  return ensureHighlightedDiffLoaded(file, theme, offloadLargeDiff);
}

/** Read the best already-available highlight result without starting async work during render. */
function resolveHighlightedSnapshot({
  appearanceCacheKey,
  highlighted,
  highlightedCacheKey,
}: {
  appearanceCacheKey: string | null;
  highlighted: HighlightedDiffCode | null;
  highlightedCacheKey: string | null;
}) {
  if (!appearanceCacheKey) {
    return null;
  }

  if (highlightedCacheKey === appearanceCacheKey) {
    // Plain rows from a retryable worker failure are provisional. The layout effect below will not
    // re-run for a key it already committed, so prefer a result a later prefetch retry has since
    // cached rather than holding this file plain until it remounts.
    if (highlighted?.retryable) {
      return SHARED_HIGHLIGHTED_DIFF_CACHE.peek(appearanceCacheKey) ?? highlighted;
    }

    return highlighted;
  }

  // Peek rather than read: render stays side-effect free, and the layout effect below refreshes
  // recency for this same key during commit.
  return SHARED_HIGHLIGHTED_DIFF_CACHE.peek(appearanceCacheKey) ?? null;
}

/** Resolve highlighted diff content with shared caching and background prefetch support. */
export function useHighlightedDiff({
  file,
  offloadLargeDiff = false,
  theme,
  shouldLoadHighlight,
}: {
  file: DiffFile | undefined;
  offloadLargeDiff?: boolean;
  theme: AppTheme;
  shouldLoadHighlight?: boolean;
}) {
  const [highlighted, setHighlighted] = useState<HighlightedDiffCode | null>(null);
  const [highlightedCacheKey, setHighlightedCacheKey] = useState<string | null>(null);
  const appearanceCacheKey = file ? highlightedDiffCacheKey(theme, file) : null;

  // Use a layout effect so a newly available cached result can replace the plain-text fallback
  // before the next diff paint whenever possible. That reduces flash/stutter as files enter view.
  useLayoutEffect(() => {
    if (!file || !appearanceCacheKey) {
      setHighlighted(null);
      setHighlightedCacheKey(null);
      return;
    }

    if (highlightedCacheKey === appearanceCacheKey) {
      return;
    }

    const cached = SHARED_HIGHLIGHTED_DIFF_CACHE.get(appearanceCacheKey);
    if (cached) {
      setHighlighted(cached);
      setHighlightedCacheKey(appearanceCacheKey);
      return;
    }

    if (!shouldLoadHighlight) {
      return;
    }

    let cancelled = false;
    setHighlighted(null);

    ensureHighlightedDiffLoaded(file, theme, offloadLargeDiff, appearanceCacheKey).then(
      (nextHighlighted) => {
        if (cancelled) {
          return;
        }

        setHighlighted(nextHighlighted);
        setHighlightedCacheKey(appearanceCacheKey);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [appearanceCacheKey, file, highlightedCacheKey, offloadLargeDiff, shouldLoadHighlight]);

  // Prefer cached highlights during render so revisiting a file can paint immediately.
  return resolveHighlightedSnapshot({
    appearanceCacheKey,
    highlighted,
    highlightedCacheKey,
  });
}
