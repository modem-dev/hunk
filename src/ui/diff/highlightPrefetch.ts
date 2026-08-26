import type { DiffFile } from "../../core/changeset/model";
import type { AppTheme } from "../themes";
import {
  collectIntersectingFileSectionIds,
  type FileSectionLayout,
} from "../lib/fileSectionLayout";

export const HIGHLIGHT_PREFETCH_IDLE_MS = 300;

export interface HighlightPrefetchOptions {
  file: DiffFile;
  offloadLargeDiff: boolean;
  theme: AppTheme;
}

export type HighlightPrefetch = (options: HighlightPrefetchOptions) => unknown;

export interface HighlightPrefetchPlan {
  immediateFileIds: ReadonlySet<string>;
  speculativeFileIds: ReadonlySet<string>;
}

/** Plan disjoint immediate and speculative highlight work for the review stream. */
export function buildHighlightPrefetchPlan({
  files,
  fileSectionLayouts,
  rapidScrollOverscanRows,
  scrollTop,
  viewportHeight,
  selectedFileId,
}: {
  files: DiffFile[];
  fileSectionLayouts: FileSectionLayout[];
  rapidScrollOverscanRows: number;
  scrollTop: number;
  viewportHeight: number;
  selectedFileId?: string;
}): HighlightPrefetchPlan {
  const immediateFileIds = new Set<string>();
  if (selectedFileId) {
    immediateFileIds.add(selectedFileId);
  }

  for (const fileId of collectIntersectingFileSectionIds(
    fileSectionLayouts,
    Math.max(0, scrollTop),
    scrollTop + Math.max(1, viewportHeight),
  )) {
    immediateFileIds.add(fileId);
  }

  const speculativeFileIds = new Set<string>();
  if (selectedFileId) {
    const selectedIndex = files.findIndex((file) => file.id === selectedFileId);
    if (selectedIndex >= 0) {
      const previousFile = files[selectedIndex - 1];
      const nextFile = files[selectedIndex + 1];

      if (previousFile) {
        speculativeFileIds.add(previousFile.id);
      }

      if (nextFile) {
        speculativeFileIds.add(nextFile.id);
      }
    }
  }

  const clampedViewportHeight = Math.max(1, viewportHeight);
  const prefetchRows = Math.max(24, clampedViewportHeight * 3, rapidScrollOverscanRows);
  const minPrefetchY = Math.max(0, scrollTop - prefetchRows);
  const maxPrefetchY = scrollTop + viewportHeight + prefetchRows;

  for (const fileId of collectIntersectingFileSectionIds(
    fileSectionLayouts,
    minPrefetchY,
    maxPrefetchY,
  )) {
    speculativeFileIds.add(fileId);
  }

  for (const fileId of immediateFileIds) {
    speculativeFileIds.delete(fileId);
  }

  return { immediateFileIds, speculativeFileIds };
}

/** Dispatch selected and visible highlight work synchronously from the owning effect. */
export function prefetchImmediateHighlightedFiles({
  files,
  immediateFileIds,
  offloadLargeDiff,
  prefetch,
  theme,
}: {
  files: DiffFile[];
  immediateFileIds: ReadonlySet<string>;
  offloadLargeDiff: boolean;
  prefetch: HighlightPrefetch;
  theme: AppTheme;
}) {
  for (const file of files) {
    if (!immediateFileIds.has(file.id)) {
      continue;
    }

    void prefetch({ file, offloadLargeDiff, theme });
  }
}

/** Schedule cancellable speculative highlighting after the review stream has been idle. */
export function scheduleSpeculativeHighlightedFiles({
  files,
  offloadLargeDiff,
  prefetch,
  speculativeFileIds,
  theme,
}: {
  files: DiffFile[];
  offloadLargeDiff: boolean;
  prefetch: HighlightPrefetch;
  speculativeFileIds: ReadonlySet<string>;
  theme: AppTheme;
}) {
  if (speculativeFileIds.size === 0) {
    return () => {};
  }

  const timer = setTimeout(() => {
    for (const file of files) {
      if (!speculativeFileIds.has(file.id)) {
        continue;
      }

      void prefetch({ file, offloadLargeDiff, theme });
    }
  }, HIGHLIGHT_PREFETCH_IDLE_MS);

  return () => clearTimeout(timer);
}
