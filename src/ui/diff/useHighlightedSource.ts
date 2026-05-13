import { useLayoutEffect, useMemo, useState } from "react";
import type { DiffFile } from "../../core/types";
import { loadHighlightedSourceLines, type HighlightedSourceCode } from "./pierre";

interface HighlightedSourceState {
  cacheKey: string;
  highlighted: HighlightedSourceCode;
}

/** Summarize loaded source text for expansion highlighting invalidation. */
function sourceTextFingerprint(text: string) {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** Cache key for full-source highlights used by expanded unchanged rows. */
function buildSourceCacheKey(appearance: string, file: DiffFile, text: string) {
  return `${appearance}:${file.id}:${file.path}:${file.language ?? ""}:${sourceTextFingerprint(text)}`;
}

/** Resolve highlighted full-source content for expanded unchanged rows. */
export function useHighlightedSource({
  file,
  text,
  appearance,
  shouldLoadHighlight,
}: {
  file: DiffFile | undefined;
  text: string | undefined;
  appearance: "light" | "dark";
  shouldLoadHighlight?: boolean;
}) {
  const [state, setState] = useState<HighlightedSourceState | null>(null);
  const cacheKey = useMemo(
    () => (file && text !== undefined ? buildSourceCacheKey(appearance, file, text) : null),
    [appearance, file, text],
  );

  useLayoutEffect(() => {
    if (!file || text === undefined || !cacheKey) {
      setState(null);
      return;
    }

    if (state?.cacheKey === cacheKey || !shouldLoadHighlight) {
      return;
    }

    let cancelled = false;
    setState(null);

    loadHighlightedSourceLines({ file, text, appearance })
      .then((highlighted) => {
        if (!cancelled) {
          setState({ cacheKey, highlighted });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ cacheKey, highlighted: { lines: [] } });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appearance, cacheKey, file, shouldLoadHighlight, state?.cacheKey, text]);

  return state?.cacheKey === cacheKey ? state.highlighted : null;
}
