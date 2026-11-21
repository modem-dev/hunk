import type { DiffFile } from "../../core/changeset/model";
import { reviewHunkIndexAtOffset } from "../../core/review/viewportAnchor";
import type { DiffSectionGeometry } from "../diff/diffSectionGeometry";
import { findFileSectionAtOffset, type FileSectionLayout } from "./fileSectionLayout";

export interface ViewportCenteredHunkTarget {
  fileId: string;
  hunkIndex: number;
}

/** Pick the hunk owning one body offset from this section's measured hunk bounds. */
function centeredHunkIndex(
  sectionGeometry: DiffSectionGeometry | undefined,
  bodyOffset: number,
  hunkCount: number,
) {
  if (!sectionGeometry || hunkCount <= 1 || sectionGeometry.hunkBounds.size === 0) {
    return 0;
  }

  return reviewHunkIndexAtOffset(
    hunkCount,
    (hunkIndex) => sectionGeometry.hunkBounds.get(hunkIndex),
    bodyOffset,
  );
}

/** Resolve the file and hunk nearest the current review viewport center. */
export function findViewportCenteredHunkTarget({
  files,
  fileSectionLayouts,
  sectionGeometry,
  scrollTop,
  viewportHeight,
}: {
  files: DiffFile[];
  fileSectionLayouts: FileSectionLayout[];
  sectionGeometry: DiffSectionGeometry[];
  scrollTop: number;
  viewportHeight: number;
}): ViewportCenteredHunkTarget | null {
  if (files.length === 0 || fileSectionLayouts.length === 0) {
    return null;
  }

  const centerOffset = Math.max(0, scrollTop + Math.max(0, Math.floor((viewportHeight - 1) / 2)));
  const centeredSection = findFileSectionAtOffset(fileSectionLayouts, centerOffset);
  if (!centeredSection) {
    return null;
  }

  const centeredFile = files[centeredSection.sectionIndex];
  if (!centeredFile) {
    return null;
  }

  return {
    fileId: centeredFile.id,
    // Which hunk owns the center is the shared viewport-anchor rule (audit B11).
    hunkIndex: centeredHunkIndex(
      sectionGeometry[centeredSection.sectionIndex],
      centerOffset - centeredSection.bodyTop,
      centeredFile.metadata.hunks.length,
    ),
  };
}
