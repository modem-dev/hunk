/**
 * Default-collapse policy for review "noise" files (lockfiles, minified bundles,
 * generated code) and the presentation variant used to render them.
 *
 * A collapsed file is shown as a single placeholder row. Rather than threading a
 * `collapsed` flag through the entire render/geometry/windowing pipeline, we swap
 * the file's hunks for an empty placeholder — a state the diff stream already
 * renders (see `PierreDiffView` and `measureDiffSectionGeometry`). That keeps the
 * deep rendering path as the single source of truth for "file with no hunks".
 */
import { createCollapsedMetadata } from "../../core/diffFile";
import type { DiffFile } from "../../core/types";

// Cache one collapsed variant per source file so its object identity stays stable
// across renders, keeping the geometry WeakMap cache warm. Replaced files (e.g. on
// reload) become new keys and naturally drop their stale variants.
const COLLAPSED_VARIANTS = new WeakMap<DiffFile, DiffFile>();

/** Build (or reuse) the placeholder variant shown when a file is collapsed. */
export function collapsedFileVariant(file: DiffFile): DiffFile {
  const cached = COLLAPSED_VARIANTS.get(file);
  if (cached) {
    return cached;
  }

  const variant: DiffFile = {
    ...file,
    // Empty hunks route the file through the existing placeholder render path while
    // preserving id, path, stats, agent context, and noiseKind for the label/sidebar.
    metadata: createCollapsedMetadata(file.path, file.metadata.type),
    isCollapsedPlaceholder: true,
  };
  COLLAPSED_VARIANTS.set(file, variant);
  return variant;
}

export interface ResolveCollapsedFileIdsOptions {
  files: DiffFile[];
  collapseGenerated: boolean;
  manuallyCollapsedFileIds: ReadonlySet<string>;
  manuallyExpandedFileIds: ReadonlySet<string>;
}

/**
 * Resolve which files should render collapsed, combining the noise-default policy
 * with explicit per-file overrides. A noise file collapses unless the user expanded
 * it; any file the user manually collapses also collapses.
 */
export function resolveCollapsedFileIds({
  files,
  collapseGenerated,
  manuallyCollapsedFileIds,
  manuallyExpandedFileIds,
}: ResolveCollapsedFileIdsOptions): Set<string> {
  const collapsed = new Set<string>();

  for (const file of files) {
    const collapsedByDefault = collapseGenerated && Boolean(file.noiseKind);
    const isCollapsed = manuallyCollapsedFileIds.has(file.id)
      ? true
      : collapsedByDefault && !manuallyExpandedFileIds.has(file.id);

    if (isCollapsed) {
      collapsed.add(file.id);
    }
  }

  return collapsed;
}
