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
import type { ReviewViewedStatus } from "../viewed/viewedFiles";

/** One sidebar row for one indexed file, with its visible note count for the `*N` badge. */
export function sidebarEntry(
  entry: ReviewFileIndexEntry,
  depth: number,
  noteCount = 0,
): ReviewSidebarFileEntry {
  return {
    kind: "file",
    id: entry.key,
    name: reviewSidebarFileName(entry.path, entry.previousPath),
    depth,
    agentCommentsText: formatReviewNoteBadge(noteCount),
    additionsText: formatReviewSidebarStat("+", entry.stats.additions, entry.stats.truncated),
    deletionsText: formatReviewSidebarStat("-", entry.stats.deletions),
    changeType: entry.changeKind,
    isUntracked: entry.flags.untracked,
  };
}

/**
 * Return one distinct tree path per entry, in entry order.
 *
 * The review may list two files at one path (a delete and an add of it have different keys),
 * but the tree keys rows by path and would merge them, leaving one unreachable. Each repeat
 * gets a visible ` (2)`, ` (3)`, … suffix on its name, so every file has its own row.
 */
export function treePathsOf(entries: readonly { path: string }[]) {
  const taken = new Set(entries.map((entry) => entry.path));
  const seen = new Set<string>();
  return entries.map(({ path }) => {
    if (!seen.has(path)) {
      seen.add(path);
      return path;
    }
    let copy = 2;
    while (taken.has(`${path} (${copy})`)) copy += 1;
    const distinct = `${path} (${copy})`;
    taken.add(distinct);
    return distinct;
  });
}

/** What either sidebar mode is given. */
export interface FileSidebarProps {
  entries: readonly ReviewFileIndexEntry[];
  /** Visible notes per file key. */
  noteCounts: ReadonlyMap<string, number>;
  selectedKey: string | null;
  mode: "tree" | "flat";
  onSelectFile: (fileKey: string) => void;
  /** Each file's viewed mark as the page shows it. */
  viewedStatuses?: ReadonlyMap<string, ReviewViewedStatus>;
  /** Flip one file's viewed mark. */
  onToggleViewed?: (fileKey: string) => void;
}
