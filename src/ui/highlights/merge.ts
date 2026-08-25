import type { ValidatedLineHighlight } from "./validate";

/**
 * Merge two per-file mark maps into the one map the diff pane paints from.
 *
 * Overlay marks append after base marks, so where ranges overlap the overlay
 * paints last and wins — agent attention marks land on top of extension marks.
 * Either side empty returns the other unchanged, preserving map identity so
 * row memoization downstream keeps holding.
 */
export function mergeLineHighlightMaps(
  base: ReadonlyMap<string, readonly ValidatedLineHighlight[]>,
  overlay: ReadonlyMap<string, readonly ValidatedLineHighlight[]>,
): ReadonlyMap<string, readonly ValidatedLineHighlight[]> {
  if (overlay.size === 0) {
    return base;
  }
  if (base.size === 0) {
    return overlay;
  }

  const merged = new Map(base);
  for (const [fileId, marks] of overlay) {
    const existing = merged.get(fileId);
    merged.set(fileId, existing ? [...existing, ...marks] : marks);
  }
  return merged;
}
