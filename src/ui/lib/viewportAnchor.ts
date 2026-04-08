import type { DiffFile } from "../../core/types";
import type { DiffSectionGeometry, DiffSectionRowBounds } from "./diffSectionGeometry";
import { buildFileSectionLayouts } from "./fileSectionLayout";

/** Identify the rendered review row that currently owns the viewport top. */
export interface ViewportRowAnchor {
  fileId: string;
  rowKey: string;
  stableKey: string;
  rowOffsetWithin: number;
}

/** Find the measured row bounds that cover one file-relative vertical offset. */
function binarySearchRowBounds(sectionRowBounds: DiffSectionRowBounds[], relativeTop: number) {
  let low = 0;
  let high = sectionRowBounds.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const rowBounds = sectionRowBounds[mid]!;

    if (relativeTop < rowBounds.top) {
      high = mid - 1;
    } else if (relativeTop >= rowBounds.top + rowBounds.height) {
      low = mid + 1;
    } else {
      return rowBounds;
    }
  }

  return undefined;
}

/**
 * Capture a stable top-row anchor from the current review stream.
 *
 * `preferredStableKey` lets callers preserve the exact logical side they were already following
 * when a split row can map to multiple stacked rows and vice versa.
 */
export function findViewportRowAnchor(
  files: DiffFile[],
  sectionGeometry: DiffSectionGeometry[],
  scrollTop: number,
  headerHeights: number[],
  preferredStableKey?: string | null,
) {
  const fileSectionLayouts = buildFileSectionLayouts(
    files,
    sectionGeometry.map((metrics) => metrics?.bodyHeight ?? 0),
    headerHeights,
  );

  for (let index = 0; index < files.length; index += 1) {
    const sectionLayout = fileSectionLayouts[index];
    const bodyTop = sectionLayout?.bodyTop ?? 0;
    const geometry = sectionGeometry[index];
    const bodyHeight = geometry?.bodyHeight ?? 0;
    const relativeTop = scrollTop - bodyTop;

    if (relativeTop >= 0 && relativeTop < bodyHeight && geometry) {
      const rowBounds = binarySearchRowBounds(geometry.rowBounds, relativeTop);
      if (!rowBounds) {
        continue;
      }

      const stableKey =
        preferredStableKey && rowBounds.stableKeys.includes(preferredStableKey)
          ? preferredStableKey
          : rowBounds.stableKey;

      return {
        fileId: files[index]!.id,
        rowKey: rowBounds.key,
        stableKey,
        rowOffsetWithin: relativeTop - rowBounds.top,
      } satisfies ViewportRowAnchor;
    }
  }

  return null;
}

/** Resolve one captured row anchor into its next absolute scrollTop after a relayout. */
export function resolveViewportRowAnchorTop(
  files: DiffFile[],
  sectionGeometry: DiffSectionGeometry[],
  anchor: ViewportRowAnchor,
  headerHeights: number[],
) {
  const fileSectionLayouts = buildFileSectionLayouts(
    files,
    sectionGeometry.map((metrics) => metrics?.bodyHeight ?? 0),
    headerHeights,
  );

  for (let index = 0; index < files.length; index += 1) {
    const sectionLayout = fileSectionLayouts[index];
    const bodyTop = sectionLayout?.bodyTop ?? 0;
    const file = files[index];
    const geometry = sectionGeometry[index];
    if (file?.id !== anchor.fileId || !geometry) {
      continue;
    }

    const rowBounds =
      geometry.rowBoundsByStableKey.get(anchor.stableKey) ??
      geometry.rowBoundsByKey.get(anchor.rowKey);
    if (rowBounds) {
      return (
        bodyTop +
        rowBounds.top +
        Math.min(anchor.rowOffsetWithin, Math.max(0, rowBounds.height - 1))
      );
    }

    return bodyTop;
  }

  return 0;
}
