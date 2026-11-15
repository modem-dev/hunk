/**
 * The lightweight per-file facts the sidebar and the stream's reserved heights need.
 *
 * Kept apart from the full canonical file so it can arrive from a cheaper source: the
 * shared-state route carries it for the whole review up front, in document order, so the
 * sidebar, the toolbar totals, and every reserved height are complete before any canonical
 * file loads, and file order no longer rests on catalog order. When the route cannot answer,
 * entries are projected from each canonical file as it loads. The mirror accepts entries from
 * either source through `ReviewFileIndexSource`.
 */
import type {
  ReviewFileChangeKind,
  ReviewFileFlagsV1,
  ReviewFileStatsV1,
  ReviewFileV1,
} from "../../core/review/types";
import type { HunkReviewResourceCatalogV1 } from "../../session/reviewProtocol";
import type { ReviewSharedFileV1 } from "../../session/reviewSharedState";

/** What the page knows about one file before, or without, its full content. */
export interface ReviewFileIndexEntry {
  key: string;
  path: string;
  previousPath?: string;
  changeKind: ReviewFileChangeKind;
  stats: ReviewFileStatsV1;
  flags: ReviewFileFlagsV1;
  splitLineCount: number;
  unifiedLineCount: number;
  /** Known once the canonical file has loaded; the shared file index does not carry it. */
  hunkCount?: number;
  /** The file's agent summary, from the shared file index. */
  agentSummary?: string;
}

/** Project one full file down to its index entry. */
export function reviewFileIndexEntry(file: ReviewFileV1): ReviewFileIndexEntry {
  return {
    key: file.key,
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    changeKind: file.changeKind,
    stats: file.stats,
    flags: file.flags,
    splitLineCount: file.splitLineCount,
    unifiedLineCount: file.unifiedLineCount,
    hunkCount: file.hunks.length,
    // The filter matches summaries too, so entries built without the shared index keep it.
    ...(file.agentSummary !== undefined ? { agentSummary: file.agentSummary } : {}),
  };
}

/** Project one shared file-index entry onto the page's index entry. */
export function reviewSharedFileIndexEntry(file: ReviewSharedFileV1): ReviewFileIndexEntry {
  return {
    key: file.key,
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    changeKind: file.changeKind,
    stats: file.stats,
    flags: file.flags,
    splitLineCount: file.splitLineCount,
    unifiedLineCount: file.unifiedLineCount,
    ...(file.agentSummary !== undefined ? { agentSummary: file.agentSummary } : {}),
  };
}

/**
 * Supplies index entries for a whole generation ahead of its canonical files.
 *
 * Returns the entries in document order (an array), or keyed by file key in catalog order (a
 * map), or nothing when this source cannot describe the generation, in which case the mirror
 * projects entries from canonical files as they load.
 */
export type ReviewFileIndexSource = (
  catalog: HunkReviewResourceCatalogV1,
  signal: AbortSignal,
) => Promise<
  ReadonlyMap<string, ReviewFileIndexEntry> | readonly ReviewFileIndexEntry[] | undefined
>;
