/**
 * The lightweight per-file facts the sidebar and the stream's reserved heights need.
 *
 * Kept apart from the full canonical file so it can arrive from a cheaper source: today it is
 * projected from each canonical file as that file loads, and the shared-state route is meant
 * to carry it for the whole review up front, so navigation does not wait on every file. The
 * mirror accepts entries from either source through `ReviewFileIndexSource`.
 */
import type {
  ReviewFileChangeKind,
  ReviewFileFlagsV1,
  ReviewFileStatsV1,
  ReviewFileV1,
} from "../../core/review/types";
import type { HunkReviewResourceCatalogV1 } from "../../session/reviewProtocol";

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
  hunkCount: number;
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
  };
}

/**
 * Supplies index entries for a whole generation ahead of its canonical files.
 *
 * Returns entries keyed by file key, or nothing when this source cannot describe the
 * generation, in which case the mirror projects entries from canonical files as they load.
 */
export type ReviewFileIndexSource = (
  catalog: HunkReviewResourceCatalogV1,
  signal: AbortSignal,
) => Promise<ReadonlyMap<string, ReviewFileIndexEntry> | undefined>;
