import { type Accessor, createMemo, createRenderEffect, createSignal, onCleanup } from "solid-js";
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

/**
 * Resolve highlighted full-source content for expanded unchanged rows.
 *
 * Args are accessors so the highlight re-resolves when the loaded source text (e.g. after a gap
 * expansion) or theme appearance changes while the same component stays mounted. Returns an
 * `Accessor<HighlightedSourceCode | null>`: call it to read the current snapshot reactively.
 */
export function useHighlightedSource(args: {
  file: Accessor<DiffFile | undefined>;
  text: Accessor<string | undefined>;
  appearance: Accessor<"light" | "dark">;
  shouldLoadHighlight?: Accessor<boolean | undefined>;
}): Accessor<HighlightedSourceCode | null> {
  const [state, setState] = createSignal<HighlightedSourceState | null>(null);
  const cacheKey = createMemo(() => {
    const file = args.file();
    const text = args.text();
    return file && text !== undefined ? buildSourceCacheKey(args.appearance(), file, text) : null;
  });

  createRenderEffect(() => {
    const key = cacheKey();
    const file = args.file();
    const text = args.text();
    if (!file || text === undefined || !key) {
      setState(null);
      return;
    }

    if (state()?.cacheKey === key || !args.shouldLoadHighlight?.()) {
      return;
    }

    let cancelled = false;
    setState(null);

    loadHighlightedSourceLines({ file, text, appearance: args.appearance() })
      .then((highlighted) => {
        if (!cancelled) {
          setState({ cacheKey: key, highlighted });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ cacheKey: key, highlighted: { lines: [] } });
        }
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  return () => {
    const current = state();
    return current?.cacheKey === cacheKey() ? current.highlighted : null;
  };
}
