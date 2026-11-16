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
import type { ReviewFileV1 } from "../../core/review/types";
import type { HunkReviewResourceCatalogV1 } from "../../session/reviewProtocol";
import type { ReviewSharedFileV1 } from "../../session/reviewSharedState";

/**
 * What the page knows about one file before, or without, its full content.
 *
 * Takes its fields from the shared file index, so a shared file is already an entry and the
 * shared-state source hands its files over as they are. It picks only what the sidebar, the
 * toolbar totals, reserved heights, and the filter read, so an entry projected from a canonical
 * file has the same shape: `language` and `contentIdentity` are read from the loaded canonical
 * file where needed, and `agentContext`, which no canonical file carries, from the shared state.
 */
export type ReviewFileIndexEntry = Pick<
  ReviewSharedFileV1,
  | "key"
  | "path"
  | "previousPath"
  | "changeKind"
  | "stats"
  | "flags"
  | "splitLineCount"
  | "unifiedLineCount"
  | "agentSummary"
> & {
  /** Known once the canonical file has loaded; the shared file index does not carry it. */
  hunkCount?: number;
};

/** Projects one full canonical file down to its index entry, for reviews without a shared index. */
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
