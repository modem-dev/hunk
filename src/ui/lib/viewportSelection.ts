import type { DiffFile } from "../../core/types";
import type { DiffSectionGeometry } from "./diffSectionGeometry";
import { findFileSectionAtOffset, type FileSectionLayout } from "./fileSectionLayout";

export interface ViewportCenteredHunkTarget {
  fileId: string;
  hunkIndex: number;
}

/** Pick the hunk nearest one vertical offset within a file body. */
function findNearestHunkIndexAtBodyOffset(
  sectionGeometry: DiffSectionGeometry | undefined,
  bodyOffset: number,
  hunkCount: number,
) {
  if (!sectionGeometry || hunkCount <= 1 || sectionGeometry.hunkBounds.size === 0) {
    return 0;
  }

  let nearestHunkIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let hunkIndex = 0; hunkIndex < hunkCount; hunkIndex += 1) {
    const hunkBounds = sectionGeometry.hunkBounds.get(hunkIndex);
    if (!hunkBounds) {
      continue;
    }

    const hunkBottom = hunkBounds.top + hunkBounds.height - 1;
    if (bodyOffset >= hunkBounds.top && bodyOffset <= hunkBottom) {
      return hunkIndex;
    }

    const distance =
      bodyOffset < hunkBounds.top ? hunkBounds.top - bodyOffset : bodyOffset - hunkBottom;

    // Favor the later hunk on exact ties so ownership hands off when the midpoint reaches center.
    if (
      distance < nearestDistance ||
      (distance === nearestDistance && hunkIndex > nearestHunkIndex)
    ) {
      nearestDistance = distance;
      nearestHunkIndex = hunkIndex;
    }
  }

  return nearestHunkIndex;
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
    hunkIndex: findNearestHunkIndexAtBodyOffset(
      sectionGeometry[centeredSection.sectionIndex],
      centerOffset - centeredSection.bodyTop,
      centeredFile.metadata.hunks.length,
    ),
  };
}
