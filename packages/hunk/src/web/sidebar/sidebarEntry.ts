/**
 * Builds one sidebar row from one indexed file, through the shared labels.
 *
 * Both sidebar modes draw from this so their rows cannot disagree.
 */
import {
  formatReviewNoteBadge,
  formatReviewSidebarStat,
  reviewSidebarFileName,
  type ReviewSidebarFileEntry,
} from "../../core/review/fileLabels";
import type { ReviewFileIndexEntry } from "../mirror/fileIndex";

/** One sidebar row for one indexed file. Notes arrive with the state route; none yet. */
export function sidebarEntry(entry: ReviewFileIndexEntry, depth: number): ReviewSidebarFileEntry {
  return {
    kind: "file",
    id: entry.key,
    name: reviewSidebarFileName(entry.path, entry.previousPath),
    depth,
    agentCommentsText: formatReviewNoteBadge(0),
    additionsText: formatReviewSidebarStat("+", entry.stats.additions, entry.stats.truncated),
    deletionsText: formatReviewSidebarStat("-", entry.stats.deletions),
    changeType: entry.changeKind,
    isUntracked: entry.flags.untracked,
  };
}

/** What either sidebar mode is given. */
export interface FileSidebarProps {
  entries: readonly ReviewFileIndexEntry[];
  selectedKey: string | null;
  mode: "tree" | "flat";
  onSelectFile: (fileKey: string) => void;
}
