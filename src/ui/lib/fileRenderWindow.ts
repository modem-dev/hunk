import type { FileSectionLayout } from "./fileSectionLayout";

export interface FileRenderWindowFileItem {
  kind: "file";
  fileId: string;
  sectionIndex: number;
}

export interface FileRenderWindowSpacerItem {
  kind: "spacer";
  key: string;
  height: number;
  startIndex: number;
  endIndex: number;
}

export type FileRenderWindowItem = FileRenderWindowFileItem | FileRenderWindowSpacerItem;

export interface FileRenderWindowPlan {
  items: FileRenderWindowItem[];
  mountedFileIds: Set<string>;
  mountedFileIndices: number[];
  visibleStartIndex: number | null;
  visibleEndIndex: number | null;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
}

/** Build a file-id lookup for repeated render-window planning over the same section layout. */
export function buildFileSectionIndexById(fileSectionLayouts: FileSectionLayout[]) {
  const indexByFileId = new Map<string, number>();
  fileSectionLayouts.forEach((layout, index) => {
    indexByFileId.set(layout.fileId, index);
  });
  return indexByFileId;
}

/** Find the first section whose bottom can intersect a viewport ending after `minY`. */
function findFirstPotentiallyVisibleIndex(layouts: FileSectionLayout[], minY: number) {
  let low = 0;
  let high = layouts.length - 1;
  let result = layouts.length;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const layout = layouts[mid]!;

    if (layout.sectionBottom >= minY) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return result;
}

/** Return the inclusive section-index range that intersects the viewport. */
function findVisibleIndexRange(
  layouts: FileSectionLayout[],
  scrollTop: number,
  viewportHeight: number,
) {
  if (layouts.length === 0) {
    return null;
  }

  const minY = Math.max(0, scrollTop);
  const maxY = minY + Math.max(0, viewportHeight);
  const startIndex = findFirstPotentiallyVisibleIndex(layouts, minY);

  if (startIndex >= layouts.length) {
    return null;
  }

  let endIndex = startIndex - 1;
  for (let index = startIndex; index < layouts.length; index += 1) {
    const layout = layouts[index]!;
    if (layout.sectionTop > maxY) {
      break;
    }
    endIndex = index;
  }

  if (endIndex < startIndex) {
    return null;
  }

  return { startIndex, endIndex };
}

/** Add an inclusive index range to a mounted file set, clamped to available layouts. */
function addIndexRange(indices: Set<number>, startIndex: number, endIndex: number, count: number) {
  const start = Math.max(0, startIndex);
  const end = Math.min(count - 1, endIndex);

  for (let index = start; index <= end; index += 1) {
    indices.add(index);
  }
}

/** Return the exact stream height covered by an inclusive section-index range. */
function sectionRangeHeight(layouts: FileSectionLayout[], startIndex: number, endIndex: number) {
  if (startIndex > endIndex) {
    return 0;
  }

  const start = layouts[startIndex];
  const end = layouts[endIndex];
  if (!start || !end) {
    return 0;
  }

  return Math.max(0, end.sectionBottom - start.sectionTop);
}

/** Build a sparse file-level render plan with spacers preserving exact review-stream height. */
export function buildFileRenderWindow({
  fileSectionLayouts,
  includeFileIds = [],
  indexByFileId = buildFileSectionIndexById(fileSectionLayouts),
  overscanFiles = 2,
  scrollTop,
  selectedFileId,
  viewportHeight,
}: {
  fileSectionLayouts: FileSectionLayout[];
  includeFileIds?: Iterable<string>;
  indexByFileId?: ReadonlyMap<string, number>;
  overscanFiles?: number;
  scrollTop: number;
  selectedFileId?: string;
  viewportHeight: number;
}): FileRenderWindowPlan {
  const mountedIndices = new Set<number>();
  const visibleRange = findVisibleIndexRange(fileSectionLayouts, scrollTop, viewportHeight);
  const clampedOverscanFiles = Math.max(0, Math.floor(overscanFiles));

  if (visibleRange) {
    addIndexRange(
      mountedIndices,
      visibleRange.startIndex - clampedOverscanFiles,
      visibleRange.endIndex + clampedOverscanFiles,
      fileSectionLayouts.length,
    );
  }

  if (selectedFileId) {
    const selectedIndex = indexByFileId.get(selectedFileId);
    if (selectedIndex !== undefined) {
      mountedIndices.add(selectedIndex);
    }
  }

  for (const fileId of includeFileIds) {
    const index = indexByFileId.get(fileId);
    if (index !== undefined) {
      mountedIndices.add(index);
    }
  }

  const mountedFileIndices = Array.from(mountedIndices).sort((left, right) => left - right);
  const mountedFileIds = new Set<string>();
  const items: FileRenderWindowItem[] = [];
  let cursor = 0;
  let topSpacerHeight = 0;
  let bottomSpacerHeight = 0;

  const pushSpacer = (startIndex: number, endIndex: number) => {
    const height = sectionRangeHeight(fileSectionLayouts, startIndex, endIndex);
    if (height <= 0) {
      return;
    }

    const item: FileRenderWindowSpacerItem = {
      kind: "spacer",
      key: `file-spacer:${startIndex}:${endIndex}`,
      height,
      startIndex,
      endIndex,
    };
    if (startIndex === 0) {
      topSpacerHeight += height;
    }
    if (endIndex === fileSectionLayouts.length - 1) {
      bottomSpacerHeight += height;
    }
    items.push(item);
  };

  for (const index of mountedFileIndices) {
    if (index > cursor) {
      pushSpacer(cursor, index - 1);
    }

    const layout = fileSectionLayouts[index]!;
    mountedFileIds.add(layout.fileId);
    items.push({ kind: "file", fileId: layout.fileId, sectionIndex: index });
    cursor = index + 1;
  }

  if (cursor < fileSectionLayouts.length) {
    pushSpacer(cursor, fileSectionLayouts.length - 1);
  }

  // With no mounted files, the single spacer represents both the top and bottom extent.
  if (mountedFileIndices.length === 0 && fileSectionLayouts.length > 0) {
    const fullHeight = sectionRangeHeight(fileSectionLayouts, 0, fileSectionLayouts.length - 1);
    topSpacerHeight = fullHeight;
    bottomSpacerHeight = fullHeight;
  }

  return {
    items,
    mountedFileIds,
    mountedFileIndices,
    visibleStartIndex: visibleRange?.startIndex ?? null,
    visibleEndIndex: visibleRange?.endIndex ?? null,
    topSpacerHeight,
    bottomSpacerHeight,
  };
}
