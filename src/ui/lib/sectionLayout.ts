import type { DiffFile } from "../../core/types";

/** Stream geometry for one file section in the main review pane. */
export interface SectionLayoutMetric {
  fileId: string;
  sectionIndex: number;
  sectionTop: number;
  headerTop: number;
  bodyTop: number;
  bodyHeight: number;
  sectionBottom: number;
}

/** Build absolute section offsets from file order and measured body heights. */
export function buildSectionLayoutMetrics(files: DiffFile[], bodyHeights: number[]) {
  const metrics: SectionLayoutMetric[] = [];
  let cursor = 0;

  files.forEach((file, index) => {
    const separatorHeight = index > 0 ? 1 : 0;
    const bodyHeight = Math.max(0, bodyHeights[index] ?? 0);
    const sectionTop = cursor;
    const headerTop = sectionTop + separatorHeight;
    const bodyTop = headerTop + 1;
    const sectionBottom = bodyTop + bodyHeight;

    metrics.push({
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

  return metrics;
}

/** Return the file section that owns the viewport top, switching at each next header row. */
export function findHeaderOwningSection(sectionMetrics: SectionLayoutMetric[], scrollTop: number) {
  if (sectionMetrics.length === 0) {
    return null;
  }

  // Choose the last header whose top has reached the viewport, so separator rows still belong
  // to the previous section until the next header itself takes over.
  let low = 0;
  let high = sectionMetrics.length - 1;
  let winner = 0;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const metric = sectionMetrics[mid]!;

    if (metric.headerTop <= scrollTop) {
      winner = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return sectionMetrics[winner]!;
}

/** Resolve the scroll target needed to make one file header own the viewport top. */
export function resolveFileHeaderTop(sectionMetrics: SectionLayoutMetric[], fileId: string) {
  const targetSection = sectionMetrics.find((metric) => metric.fileId === fileId);
  if (!targetSection) {
    return null;
  }

  return targetSection.headerTop;
}
