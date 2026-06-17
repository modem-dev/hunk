import { useLayoutEffect, useState } from "react";
import type { DiffFile } from "../../core/types";
import type { AppTheme } from "../themes";
import { loadHighlightedDiff, type HighlightedDiffCode } from "./pierre";

/**
 * Maximum cached highlight results.
 *
 * Highlighted HAST nodes and their flattened render spans are expensive enough that a whole-review
 * cache can dominate memory while navigating large changesets. Keep a viewport-local working set
 * instead of retaining every file the user has visited in the current review.
 */
const MAX_CACHE_ENTRIES = 40;

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

/** Cache key that includes a content fingerprint so stale entries are never served
 *  after reload. Unchanged files keep their cache hit across reloads. */
function buildCacheKey(theme: AppTheme, file: DiffFile) {
  return `${theme.id}:${theme.syntaxTheme ?? theme.appearance}:${file.id}:${patchFingerprint(file)}`;
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
  theme: AppTheme,
  cacheKey = buildCacheKey(theme, file),
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
  pending = loadHighlightedDiff(file, theme)
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
    return highlighted;
  }

  return SHARED_HIGHLIGHTED_DIFF_CACHE.get(appearanceCacheKey) ?? null;
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
  const appearanceCacheKey = file ? buildCacheKey(theme, file) : null;

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
  }, [appearanceCacheKey, file, highlightedCacheKey, shouldLoadHighlight, theme]);

  // Prefer cached highlights during render so revisiting a file can paint immediately.
  return resolveHighlightedSnapshot({
    appearanceCacheKey,
    highlighted,
    highlightedCacheKey,
  });
}
