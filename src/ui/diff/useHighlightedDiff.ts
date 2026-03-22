import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/types";
import { loadHighlightedDiff, type HighlightedDiffCode } from "./pierre";

const SHARED_HIGHLIGHTED_DIFF_CACHE = new Map<string, HighlightedDiffCode>();
const SHARED_HIGHLIGHT_PROMISES = new Map<string, Promise<HighlightedDiffCode>>();

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
  const appearanceCacheKey = file ? `${appearance}:${file.id}` : null;

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

    pendingHighlight
      ?.then((nextHighlighted) => {
        if (cancelled) {
          return;
        }

        SHARED_HIGHLIGHT_PROMISES.delete(appearanceCacheKey);
        SHARED_HIGHLIGHTED_DIFF_CACHE.set(appearanceCacheKey, nextHighlighted);
        setHighlighted(nextHighlighted);
        setHighlightedCacheKey(appearanceCacheKey);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        SHARED_HIGHLIGHT_PROMISES.delete(appearanceCacheKey);
        const fallback = {
          deletionLines: [],
          additionLines: [],
        } satisfies HighlightedDiffCode;
        SHARED_HIGHLIGHTED_DIFF_CACHE.set(appearanceCacheKey, fallback);
        setHighlighted(fallback);
        setHighlightedCacheKey(appearanceCacheKey);
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
