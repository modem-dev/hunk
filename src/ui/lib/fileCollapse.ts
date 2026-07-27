/**
 * Manual file collapse for the review stream.
 *
 * Collapsing a file swaps it for a zero-hunk placeholder variant so the existing
 * empty-file render and geometry paths handle it as a single header-plus-message
 * section. This keeps collapse out of the deep renderer: hunk cursors, windowing,
 * and sticky headers all read the same `hunks: []` shape they already understand.
 */
import type { DiffFile } from "../../core/types";

// Cache the collapsed variant per original file object so its identity stays
// stable across renders. The geometry layer keys its measurement cache on the
// DiffFile object, so a fresh variant per render would thrash that cache.
const collapsedVariants = new WeakMap<DiffFile, DiffFile>();

/** Build (or reuse) the zero-hunk placeholder variant for a collapsed file. */
export function collapsedFileVariant(file: DiffFile): DiffFile {
  const cached = collapsedVariants.get(file);
  if (cached) {
    return cached;
  }

  const variant: DiffFile = {
    ...file,
    isCollapsed: true,
    metadata: {
      ...file.metadata,
      hunks: [],
      // Distinguish the collapsed geometry from the real file in any string-keyed cache.
      cacheKey: `${file.metadata.cacheKey}:collapsed`,
    },
  };
  collapsedVariants.set(file, variant);
  return variant;
}

/**
 * Replace collapsed files in a review list with their header-only placeholder variant.
 *
 * Collapse state is a `fileId -> true` map, the same shape as the controller's
 * other per-file session state, so it reconciles through the shared `removeKeys`
 * stale-id pruning on reload rather than needing its own pruning helper.
 */
export function applyFileCollapse(
  files: DiffFile[],
  collapsedFileIds: Readonly<Record<string, true>>,
): DiffFile[] {
  const anyCollapsed = files.some((file) => collapsedFileIds[file.id]);
  if (!anyCollapsed) {
    return files;
  }
  return files.map((file) => (collapsedFileIds[file.id] ? collapsedFileVariant(file) : file));
}
