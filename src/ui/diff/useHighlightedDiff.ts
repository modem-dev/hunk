import { createHash } from "node:crypto";
import { useLayoutEffect, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";
import type { AppTheme } from "../themes";
import { loadHighlightedDiff, type HighlightedDiffCode } from "./diffRows";
import { createHighlightedDiffCache } from "./highlightedDiffCache";
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
 * Commit one cacheable highlight result if its promise is still active for that key.
 *
 * A transient worker failure resolves to plain rows with `retryable`, which updates the current
 * view but must not occupy the shared cache and prevent a later worker retry.
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
  if (!result.retryable) {
    SHARED_HIGHLIGHTED_DIFF_CACHE.set(cacheKey, result);
  }
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
