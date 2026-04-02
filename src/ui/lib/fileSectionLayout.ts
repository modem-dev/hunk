import type { DiffFile } from "../../core/types";

/** Stream geometry for one file section in the main review pane. */
export interface FileSectionLayout {
  fileId: string;
  sectionIndex: number;
  sectionTop: number;
  headerTop: number;
  bodyTop: number;
  bodyHeight: number;
  sectionBottom: number;
}

/** Build absolute section offsets from file order, header heights, and measured body heights. */
export function buildFileSectionLayouts(
  files: DiffFile[],
  bodyHeights: number[],
  headerHeights?: number[],
) {
  const layouts: FileSectionLayout[] = [];
  let cursor = 0;

  files.forEach((file, index) => {
    const separatorHeight = index > 0 ? 1 : 0;
    const headerHeight = Math.max(0, headerHeights?.[index] ?? 1);
    const bodyHeight = Math.max(0, bodyHeights[index] ?? 0);
    const sectionTop = cursor;
    const headerTop = sectionTop + separatorHeight;
    const bodyTop = headerTop + headerHeight;
    const sectionBottom = bodyTop + bodyHeight;

    layouts.push({
      fileId: file.id,
      sectionIndex: index,
      sectionTop,
      headerTop,
      bodyTop,
      bodyHeight,
      sectionBottom,
    });

    cursor = sectionBottom;
  });

  return layouts;
}

/** Return the file section that owns the viewport top, switching at each next header row. */
export function findHeaderOwningFileSection(
  fileSectionLayouts: FileSectionLayout[],
  scrollTop: number,
) {
  if (fileSectionLayouts.length === 0) {
    return null;
  }

  // Choose the last header whose top has reached the viewport, so separator rows still belong
  // to the previous section until the next header itself takes over.
  let low = 0;
  let high = fileSectionLayouts.length - 1;
  let winner = 0;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const layout = fileSectionLayouts[mid]!;

    if (layout.headerTop <= scrollTop) {
      winner = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return fileSectionLayouts[winner]!;
}
