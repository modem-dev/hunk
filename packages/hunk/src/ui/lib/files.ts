import type { FileDiffMetadata } from "@pierre/diffs";
import { normalizeDiffPath } from "../../core/changeset/diffPaths";
import type { DiffFile } from "../../core/changeset/model";
import {
  buildReviewFlatSidebarEntries,
  buildReviewTreeSidebarEntries,
  collapseReviewTreeSidebarEntries,
  expandCollapsedReviewDirectoryPaths,
  formatReviewNoteBadge,
  formatReviewSidebarStat,
  reviewFileLabelParts,
  reviewSidebarBadges,
  reviewSidebarDirectoryPaths,
  reviewSidebarFileName,
  toggleCollapsedReviewDirectoryPath,
  type ReviewSidebarBadgeTexts,
  type ReviewSidebarDirectoryEntry,
  type ReviewSidebarEntry,
  type ReviewSidebarFileEntry,
  type ReviewSidebarGroupEntry,
} from "../../core/review/fileLabels";
import type { AgentAnnotation } from "../../extension-api/types";
import { readMetadataChangeType } from "../../extensions/events";
import { formatTerminalPath } from "../../lib/terminalText";

/*
 * The terminal's adapter over the shared file labels and sidebar projections in
 * `core/review/fileLabels.ts` (`docs/browser-review-seam-audit.md`, E1). What stays here is
 * terminal-only: sanitizing paths for a terminal cell, reading the renderer model's change
 * type, and merging live annotations into the file list.
 */

export type FileListEntry = ReviewSidebarFileEntry;
export type FileGroupEntry = ReviewSidebarGroupEntry;
export type FileDirectoryEntry = ReviewSidebarDirectoryEntry;
export type SidebarEntry = ReviewSidebarEntry;

/**
 * The slice of one reviewed file the sidebar needs to build its entries.
 *
 * Structural on purpose: Hunk's internal `DiffFile` satisfies it through
 * `metadata.type`, and the public `ExtensionDiffFile` view satisfies it through
 * its first-class `changeType`, so the built-in sidebar — which is itself a
 * bundled extension consuming the public props — and internal callers share
 * this one entry builder.
 */
export interface SidebarFileSource {
  id: string;
  path: string;
  previousPath?: string;
  stats: { additions: number; deletions: number };
  statsTruncated?: boolean;
  isUntracked?: boolean;
  agent?: { annotations: readonly unknown[] } | null;
  changeType?: FileDiffMetadata["type"];
  metadata?: unknown;
}

export type FileSidebarMode = "flat" | "tree";

export const TREE_FILE_SIDEBAR_MIN_CONTENT_WIDTH = 32;

/** Choose the compact or hierarchical sidebar projection for an available content width. */
export function resolveFileSidebarMode(contentWidth: number): FileSidebarMode {
  return contentWidth >= TREE_FILE_SIDEBAR_MIN_CONTENT_WIDTH ? "tree" : "flat";
}

/** Normalize one review path for display in a terminal cell. */
function terminalPath(path: string) {
  return formatTerminalPath(normalizeDiffPath(path) ?? path);
}

/** Build the visible stats badges for one sidebar row, note badge first. */
export function sidebarEntryStats(entry: ReviewSidebarBadgeTexts) {
  return reviewSidebarBadges(entry);
}

/** Measure the rendered sidebar stats width, including the space between badges. */
export function sidebarEntryStatsWidth(entry: ReviewSidebarBadgeTexts) {
  return sidebarEntryStats(entry).reduce(
    (width, stat, index) => width + stat.text.length + (index > 0 ? 1 : 0),
    0,
  );
}

/** Merge one file-id keyed annotation map into the review stream file list. */
export function mergeFileAnnotationsByFileId<T extends AgentAnnotation>(
  files: DiffFile[],
  annotationsByFileId: Record<string, T[]>,
): DiffFile[] {
  return files.map((file) => {
    const annotations = annotationsByFileId[file.id];
    if (!annotations || annotations.length === 0) {
      return file;
    }

    return {
      ...file,
      agent: {
        path: file.path,
        summary: file.agent?.summary,
        annotations: [...(file.agent?.annotations ?? []), ...annotations],
      },
    };
  });
}

/** Build the shared file-row metadata used by both sidebar projections. */
function buildSidebarFileEntry(file: SidebarFileSource, depth: number): FileListEntry {
  return {
    kind: "file",
    id: file.id,
    name: reviewSidebarFileName(
      terminalPath(file.path),
      file.previousPath ? terminalPath(file.previousPath) : undefined,
    ),
    depth,
    agentCommentsText: formatReviewNoteBadge(file.agent?.annotations.length ?? 0),
    additionsText: formatReviewSidebarStat("+", file.stats.additions, file.statsTruncated),
    deletionsText: formatReviewSidebarStat("-", file.stats.deletions),
    changeType: file.changeType ?? readMetadataChangeType(file.metadata) ?? "change",
    isUntracked: file.isUntracked ?? false,
  };
}

/** Build compact grouped sidebar entries while preserving the review stream order. */
export function buildFlatSidebarEntries(files: readonly SidebarFileSource[]): SidebarEntry[] {
  return buildReviewFlatSidebarEntries({
    files,
    pathOf: (file) => terminalPath(file.path),
    entryOf: buildSidebarFileEntry,
  });
}

/** Return the stable logical paths for every directory containing one review path. */
export function sidebarDirectoryPaths(path: string): string[] {
  return reviewSidebarDirectoryPaths(terminalPath(path));
}

/** Build an expanded hierarchy without regrouping files away from review order. */
export function buildTreeSidebarEntries(files: readonly SidebarFileSource[]): SidebarEntry[] {
  return buildReviewTreeSidebarEntries({
    files,
    pathOf: (file) => terminalPath(file.path),
    entryOf: buildSidebarFileEntry,
  });
}

/** Expand the named ancestors while preserving unrelated collapsed directory paths. */
export const expandCollapsedDirectoryPaths = expandCollapsedReviewDirectoryPaths;

/** Toggle one directory path without mutating the current collapsed-path set. */
export const toggleCollapsedDirectoryPath = toggleCollapsedReviewDirectoryPath;

/** Hide descendants of collapsed directory rows without changing the remaining review order. */
export const collapseTreeSidebarEntries = collapseReviewTreeSidebarEntries;

/** Build the canonical file label used across headers and note cards. */
export function fileLabel(file: DiffFile | undefined) {
  const { filename, stateLabel } = fileLabelParts(file);
  return stateLabel ? `${filename}${stateLabel}` : filename;
}

/** Split file label into filename and state label for styled rendering. */
export function fileLabelParts(file: DiffFile | undefined): {
  filename: string;
  stateLabel: string | null;
} {
  if (!file) {
    return { filename: "No file selected", stateLabel: null };
  }

  return reviewFileLabelParts({
    path: terminalPath(file.path),
    ...(file.previousPath ? { previousPath: terminalPath(file.previousPath) } : {}),
    changeKind: file.metadata.type,
    untracked: Boolean(file.isUntracked),
  });
}
