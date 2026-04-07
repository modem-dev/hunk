import { useLayoutEffect, useState } from "react";
import type { DiffFile } from "../../core/types";
import { loadHighlightedDiff, type HighlightedDiffCode } from "./pierre";

/** Maximum cached highlight results. Prevents unbounded growth during long watch sessions. */
const MAX_CACHE_ENTRIES = 150;

const SHARED_HIGHLIGHTED_DIFF_CACHE = new Map<string, HighlightedDiffCode>();
const SHARED_HIGHLIGHT_PROMISES = new Map<string, Promise<HighlightedDiffCode>>();

/** Evict the oldest entries when the cache exceeds MAX_CACHE_ENTRIES.
 *  Map iteration order is insertion order, so the first keys are the oldest. */
function enforceCacheLimit() {
  while (SHARED_HIGHLIGHTED_DIFF_CACHE.size > MAX_CACHE_ENTRIES) {
    const oldest = SHARED_HIGHLIGHTED_DIFF_CACHE.keys().next().value;
    if (oldest !== undefined) {
      SHARED_HIGHLIGHTED_DIFF_CACHE.delete(oldest);
    }
  }
}

/** Content fingerprint from the diff patch. Changes whenever the underlying diff
 *  changes, allowing per-file cache invalidation without a global flush. */
function patchFingerprint(file: DiffFile) {
  const { patch } = file;
  const mid = Math.floor(patch.length / 2);
  return `${patch.length}:${patch.slice(0, 64)}:${patch.slice(mid, mid + 64)}:${patch.slice(-64)}`;
}

/** Cache key that includes a content fingerprint so stale entries are never served
 *  after reload. Unchanged files keep their cache hit across reloads. */
function buildCacheKey(appearance: string, file: DiffFile) {
  return `${appearance}:${file.id}:${patchFingerprint(file)}`;
}

/** Only commit a highlight result if the promise is still the active one for that key.
 *  Prevents a superseded or late-resolving promise from overwriting a newer entry. */
function commitHighlightResult(
  cacheKey: string,
  promise: Promise<HighlightedDiffCode>,
  result: HighlightedDiffCode,
) {
  if (SHARED_HIGHLIGHT_PROMISES.get(cacheKey) !== promise) {
    return false;
  }

  SHARED_HIGHLIGHT_PROMISES.delete(cacheKey);
  SHARED_HIGHLIGHTED_DIFF_CACHE.set(cacheKey, result);
  enforceCacheLimit();
  return true;
}

/** Start one shared highlight request unless the cache or an in-flight promise already has it. */
function ensureHighlightedDiffLoaded(
  file: DiffFile,
  appearance: "light" | "dark",
  cacheKey = buildCacheKey(appearance, file),
) {
  const cached = SHARED_HIGHLIGHTED_DIFF_CACHE.get(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

  const existing = SHARED_HIGHLIGHT_PROMISES.get(cacheKey);
  if (existing) {
    return existing;
  }

  let pending: Promise<HighlightedDiffCode>;
  pending = loadHighlightedDiff(file, appearance)
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
  appearance,
}: {
  file: DiffFile;
  appearance: "light" | "dark";
}) {
  return ensureHighlightedDiffLoaded(file, appearance);
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

  return SHARED_HIGHLIGHTED_DIFF_CACHE.get(appearanceCacheKey) ?? null;
}

/** Resolve highlighted diff content with shared caching and background prefetch support. */
export function useHighlightedDiff({
  file,
  appearance,
  shouldLoadHighlight,
}: {
  file: DiffFile | undefined;
  appearance: "light" | "dark";
  shouldLoadHighlight?: boolean;
}) {
  const [highlighted, setHighlighted] = useState<HighlightedDiffCode | null>(null);
  const [highlightedCacheKey, setHighlightedCacheKey] = useState<string | null>(null);
  const appearanceCacheKey = file ? buildCacheKey(appearance, file) : null;

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

    ensureHighlightedDiffLoaded(file, appearance, appearanceCacheKey).then((nextHighlighted) => {
      if (cancelled) {
        return;
      }

      setHighlighted(nextHighlighted);
      setHighlightedCacheKey(appearanceCacheKey);
    });

    return () => {
      cancelled = true;
    };
  }, [appearance, appearanceCacheKey, file, highlightedCacheKey, shouldLoadHighlight]);

  // Prefer cached highlights during render so revisiting a file can paint immediately.
  return resolveHighlightedSnapshot({
    appearanceCacheKey,
    highlighted,
    highlightedCacheKey,
  });
}
