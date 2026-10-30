import { createHash } from "node:crypto";
import { useEffect, useLayoutEffect, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";
import type { AppTheme } from "../themes";
import { loadHighlightedDiff, type HighlightedDiffCode } from "./diffRows";
import { createHighlightedDiffCache } from "./highlightedDiffCache";
import { createHighlightRetryBudget } from "./highlightRetryBudget";
import { syntaxHighlightThemeName } from "./syntaxHighlightTheme";

const SHARED_HIGHLIGHTED_DIFF_CACHE = createHighlightedDiffCache();
const SHARED_HIGHLIGHT_PROMISES = new Map<string, Promise<HighlightedDiffCode>>();
const highlightedContentFingerprints = new WeakMap<
  DiffFile,
  { fingerprint: string; metadata: DiffFile["metadata"]; patch: string }
>();
const sourceFetcherIds = new WeakMap<NonNullable<DiffFile["sourceFetcher"]>, number>();
let nextSourceFetcherId = 1;

/** Hash every diff-content input that can change the rendered highlight result. */
function highlightedContentFingerprint(file: DiffFile) {
  const cached = highlightedContentFingerprints.get(file);
  if (cached?.metadata === file.metadata && cached.patch === file.patch) {
    return cached.fingerprint;
  }

  const metadata = JSON.stringify(file.metadata);
  const fingerprint = createHash("sha256")
    .update(`${file.patch.length}:`)
    .update(file.patch)
    .update(`${metadata.length}:`)
    .update(metadata)
    .digest("hex");
  // Review reloads replace DiffFile snapshots rather than mutating them, so object identity safely
  // avoids rehashing large patches during every render and viewport-prefetch pass.
  highlightedContentFingerprints.set(file, {
    fingerprint,
    metadata: file.metadata,
    patch: file.patch,
  });
  return fingerprint;
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

/** Cache key that includes every content and source-provider input to highlighted rendering. */
export function highlightedDiffCacheKey(theme: AppTheme, file: DiffFile) {
  return `${theme.id}:${syntaxHighlightThemeName(theme)}:${file.id}:${file.language ?? "text"}:${highlightedContentFingerprint(file)}:${sourceFetcherFingerprint(file)}`;
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

/** Bound abandoned retry history as well as the results retained by the shared cache. */
const HIGHLIGHT_RETRY_BUDGET = createHighlightRetryBudget(MAX_HIGHLIGHT_RETRY_ATTEMPTS);

/** Readers waiting for one cache key to receive a cacheable result. */
const HIGHLIGHT_RESULT_LISTENERS = new Map<string, Set<() => void>>();

/**
 * Watch one cache key until it holds a cacheable result, and return an unsubscribe.
 *
 * Viewport prefetch fills the shared cache without rendering anything, so a reader showing the
 * provisional plain rows of a retryable failure has no other signal that a later attempt succeeded.
 */
export function subscribeToHighlightedDiff(cacheKey: string, listener: () => void) {
  const listeners = HIGHLIGHT_RESULT_LISTENERS.get(cacheKey) ?? new Set<() => void>();
  listeners.add(listener);
  HIGHLIGHT_RESULT_LISTENERS.set(cacheKey, listeners);

  // A retry may finish between the provisional render and this subscription's effect. Recheck
  // after registering so the reader observes that commit even without another render.
  if (SHARED_HIGHLIGHTED_DIFF_CACHE.peek(cacheKey)) {
    listener();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      HIGHLIGHT_RESULT_LISTENERS.delete(cacheKey);
    }
  };
}

/** Wake readers holding provisional rows once a key caches a result. */
function notifyHighlightedDiffCached(cacheKey: string) {
  const listeners = HIGHLIGHT_RESULT_LISTENERS.get(cacheKey);
  if (!listeners) {
    return;
  }

  // Copy before dispatching: a listener that repaints unsubscribes while this loop is running.
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

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
    if (HIGHLIGHT_RETRY_BUDGET.recordFailure(cacheKey)) {
      return true;
    }

    // Budget spent: cache plain rows without the retryable marker so readers stop re-requesting.
    SHARED_HIGHLIGHTED_DIFF_CACHE.set(cacheKey, { deletionLines: [], additionLines: [] });
    notifyHighlightedDiffCached(cacheKey);
    return true;
  }

  HIGHLIGHT_RETRY_BUDGET.clear(cacheKey);
  SHARED_HIGHLIGHTED_DIFF_CACHE.set(cacheKey, result);
  notifyHighlightedDiffCached(cacheKey);
  return true;
}

/** Start one shared highlight request unless the cache or an in-flight promise already has it. */
function ensureHighlightedDiffLoaded(
  file: DiffFile,
  theme: AppTheme,
  cacheKey = highlightedDiffCacheKey(theme, file),
) {
  // Viewport prefetch calls this for every file in its halo on each scroll, so this read is also
  // what keeps the files around the viewport at the recent end of the cache while files entering
  // the halo evict older ones.
  HIGHLIGHT_RETRY_BUDGET.touch(cacheKey);
  const cached = SHARED_HIGHLIGHTED_DIFF_CACHE.get(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

  const existing = SHARED_HIGHLIGHT_PROMISES.get(cacheKey);
  if (existing) {
    return existing;
  }

  let pending: Promise<HighlightedDiffCode>;
  pending = loadHighlightedDiff(file, theme, { offload: true })
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

/** Wait until every highlight request started so far has finished. */
export async function waitForHighlightedDiffIdle() {
  while (SHARED_HIGHLIGHT_PROMISES.size > 0) {
    await Promise.allSettled(SHARED_HIGHLIGHT_PROMISES.values());
  }
}

/** Return whether syntax highlighting still has work in flight. */
export function hasPendingHighlightedDiffs() {
  return SHARED_HIGHLIGHT_PROMISES.size > 0;
}

/** Queue syntax highlighting for one file without mounting its diff rows first. */
export function prefetchHighlightedDiff({ file, theme }: { file: DiffFile; theme: AppTheme }) {
  return ensureHighlightedDiffLoaded(file, theme);
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
  theme,
  shouldLoadHighlight,
}: {
  file: DiffFile | undefined;
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

    ensureHighlightedDiffLoaded(file, theme, appearanceCacheKey).then((nextHighlighted) => {
      if (cancelled) {
        return;
      }

      setHighlighted(nextHighlighted);
      setHighlightedCacheKey(appearanceCacheKey);
    });

    return () => {
      cancelled = true;
    };
  }, [appearanceCacheKey, file, highlightedCacheKey, shouldLoadHighlight]);

  // Plain rows from a retryable worker failure are provisional, and the layout effect above will
  // not run again for a key it already committed. Viewport prefetch fills the shared cache without
  // rendering, so watch this key until a later attempt caches a result worth repainting.
  useEffect(() => {
    if (
      !appearanceCacheKey ||
      highlightedCacheKey !== appearanceCacheKey ||
      !highlighted?.retryable
    ) {
      return;
    }

    return subscribeToHighlightedDiff(appearanceCacheKey, () => {
      const cached = SHARED_HIGHLIGHTED_DIFF_CACHE.peek(appearanceCacheKey);
      if (cached) {
        setHighlighted(cached);
      }
    });
  }, [appearanceCacheKey, highlighted, highlightedCacheKey]);

  // Prefer cached highlights during render so revisiting a file can paint immediately.
  return resolveHighlightedSnapshot({
    appearanceCacheKey,
    highlighted,
    highlightedCacheKey,
  });
}
