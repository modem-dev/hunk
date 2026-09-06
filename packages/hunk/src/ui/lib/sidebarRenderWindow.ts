import type { SidebarEntry } from "./files";

export const SIDEBAR_ROW_HEIGHT = 1;

export interface SidebarRenderWindowEntryItem {
  kind: "entry";
  entry: SidebarEntry;
  entryIndex: number;
}

export interface SidebarRenderWindowSpacerItem {
  kind: "spacer";
  key: string;
  height: number;
  startIndex: number;
  endIndex: number;
}

export type SidebarRenderWindowItem = SidebarRenderWindowEntryItem | SidebarRenderWindowSpacerItem;

export interface SidebarRenderWindowPlan {
  items: SidebarRenderWindowItem[];
  mountedEntryIndices: number[];
  visibleStartIndex: number | null;
  visibleEndIndex: number | null;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
}

/** Return the inclusive fixed-row range that intersects the current sidebar viewport. */
function findVisibleEntryRange(entryCount: number, scrollTop: number, viewportHeight: number) {
  if (entryCount === 0 || viewportHeight <= 0) {
    return null;
  }

  const minY = Math.max(0, scrollTop);
  const maxY = minY + Math.max(0, viewportHeight);
  const totalHeight = entryCount * SIDEBAR_ROW_HEIGHT;

  if (minY >= totalHeight || maxY <= 0) {
    return null;
  }

  const startIndex = Math.min(entryCount - 1, Math.max(0, Math.floor(minY / SIDEBAR_ROW_HEIGHT)));
  const endIndex = Math.min(
    entryCount - 1,
    Math.max(startIndex, Math.ceil(maxY / SIDEBAR_ROW_HEIGHT) - 1),
  );

  return { startIndex, endIndex };
}

/** Add an inclusive fixed-row index range to the mounted sidebar set. */
function addEntryIndexRange(
  indices: Set<number>,
  startIndex: number,
  endIndex: number,
  count: number,
) {
  const start = Math.max(0, startIndex);
  const end = Math.min(count - 1, endIndex);

  for (let index = start; index <= end; index += 1) {
    indices.add(index);
  }
}

/** Return exact spacer height for an inclusive fixed-row index range. */
function entryRangeHeight(startIndex: number, endIndex: number) {
  return startIndex > endIndex ? 0 : (endIndex - startIndex + 1) * SIDEBAR_ROW_HEIGHT;
}

/** Build a sparse sidebar render plan that preserves exact scroll height with spacers. */
export function buildSidebarRenderWindow({
  entries,
  estimatedViewportRows = 32,
  overscanRows = 4,
  scrollTop,
  selectedFileId,
  viewportHeight,
}: {
  entries: SidebarEntry[];
  estimatedViewportRows?: number;
  overscanRows?: number;
  scrollTop: number;
  selectedFileId?: string;
  viewportHeight: number;
}): SidebarRenderWindowPlan {
  const mountedIndices = new Set<number>();
  const effectiveViewportHeight =
    viewportHeight > 0 ? viewportHeight : Math.max(0, Math.floor(estimatedViewportRows));
  const visibleRange = findVisibleEntryRange(entries.length, scrollTop, effectiveViewportHeight);
  const clampedOverscanRows = Math.max(0, Math.floor(overscanRows));

  if (visibleRange) {
    addEntryIndexRange(
      mountedIndices,
      visibleRange.startIndex - clampedOverscanRows,
      visibleRange.endIndex + clampedOverscanRows,
      entries.length,
    );
  }

  if (selectedFileId) {
    const selectedIndex = entries.findIndex(
      (entry) => entry.kind === "file" && entry.id === selectedFileId,
    );
    if (selectedIndex >= 0) {
      mountedIndices.add(selectedIndex);
    }
  }

  const mountedEntryIndices = Array.from(mountedIndices).sort((left, right) => left - right);
  const items: SidebarRenderWindowItem[] = [];
  let cursor = 0;
  let topSpacerHeight = 0;
  let bottomSpacerHeight = 0;

  const pushSpacer = (startIndex: number, endIndex: number) => {
    const height = entryRangeHeight(startIndex, endIndex);
    if (height <= 0) {
      return;
    }

    const item: SidebarRenderWindowSpacerItem = {
      kind: "spacer",
      key: `sidebar-spacer:${startIndex}:${endIndex}`,
      height,
      startIndex,
      endIndex,
    };
    if (startIndex === 0) {
      topSpacerHeight += height;
    }
    if (endIndex === entries.length - 1) {
      bottomSpacerHeight += height;
    }
    items.push(item);
  };

  for (const index of mountedEntryIndices) {
    if (index > cursor) {
      pushSpacer(cursor, index - 1);
    }

    const entry = entries[index];
    if (entry) {
      items.push({ kind: "entry", entry, entryIndex: index });
    }
    cursor = index + 1;
  }

  if (cursor < entries.length) {
    pushSpacer(cursor, entries.length - 1);
  }

  // With no mounted rows, one spacer represents the full sidebar extent.
  if (mountedEntryIndices.length === 0 && entries.length > 0) {
    const fullHeight = entryRangeHeight(0, entries.length - 1);
    topSpacerHeight = fullHeight;
    bottomSpacerHeight = fullHeight;
  }

  return {
    items,
    mountedEntryIndices,
    visibleStartIndex: visibleRange?.startIndex ?? null,
    visibleEndIndex: visibleRange?.endIndex ?? null,
    topSpacerHeight,
    bottomSpacerHeight,
  };
}
