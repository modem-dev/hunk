import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/** Resolve highlighted diff content with shared caching and background prefetch support. */
export function useHighlightedDiff({
  file,
  appearance,
  onHighlightReady,
  shouldLoadHighlight,
}: {
  file: DiffFile | undefined;
  appearance: "light" | "dark";
  onHighlightReady?: () => void;
  shouldLoadHighlight?: boolean;
}) {
  const [highlighted, setHighlighted] = useState<HighlightedDiffCode | null>(null);
  const [highlightedCacheKey, setHighlightedCacheKey] = useState<string | null>(null);
  const appearanceCacheKey = file ? buildCacheKey(appearance, file) : null;

  // Selected files load immediately; background prefetch can opt neighboring files in later.
  const pendingHighlight = useMemo(() => {
    if (
      !shouldLoadHighlight ||
      !file ||
      !appearanceCacheKey ||
      SHARED_HIGHLIGHTED_DIFF_CACHE.has(appearanceCacheKey)
    ) {
      return null;
    }

    const existing = SHARED_HIGHLIGHT_PROMISES.get(appearanceCacheKey);
    if (existing) {
      return existing;
    }

    const pending = loadHighlightedDiff(file, appearance);
    SHARED_HIGHLIGHT_PROMISES.set(appearanceCacheKey, pending);
    return pending;
  }, [appearance, appearanceCacheKey, file, shouldLoadHighlight]);

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

    // Capture the key and promise reference this effect was started for so the
    // resolution callback only writes if it is still the active request.
    const effectCacheKey = appearanceCacheKey;
    const effectPromise = pendingHighlight;

    effectPromise
      ?.then((nextHighlighted) => {
        if (cancelled) {
          return;
        }

        if (commitHighlightResult(effectCacheKey, effectPromise, nextHighlighted)) {
          setHighlighted(nextHighlighted);
          setHighlightedCacheKey(effectCacheKey);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        const fallback = {
          deletionLines: [],
          additionLines: [],
        } satisfies HighlightedDiffCode;
        if (commitHighlightResult(effectCacheKey, effectPromise, fallback)) {
          setHighlighted(fallback);
          setHighlightedCacheKey(effectCacheKey);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appearanceCacheKey, file, highlightedCacheKey, pendingHighlight, shouldLoadHighlight]);

  // Prefer cached highlights during render so revisiting a file can paint immediately.
  const resolvedHighlighted =
    appearanceCacheKey && highlightedCacheKey === appearanceCacheKey
      ? highlighted
      : appearanceCacheKey
        ? (SHARED_HIGHLIGHTED_DIFF_CACHE.get(appearanceCacheKey) ?? null)
        : null;
  const notifiedHighlightKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onHighlightReady || !appearanceCacheKey || !resolvedHighlighted) {
      return;
    }

    if (notifiedHighlightKeyRef.current === appearanceCacheKey) {
      return;
    }

    notifiedHighlightKeyRef.current = appearanceCacheKey;
    onHighlightReady();
  }, [appearanceCacheKey, onHighlightReady, resolvedHighlighted]);

  return resolvedHighlighted;
}
