/**
 * Builds one sidebar row from one indexed file, through the shared labels.
 *
 * Both sidebar modes draw from this so their rows cannot disagree.
 */
import { revealReviewHiddenText } from "../../core/review/hiddenText";
import {
  formatReviewNoteBadge,
  reviewSidebarFileName,
  type ReviewSidebarFileEntry,
} from "../../core/review/fileLabels";
import { formatAddedBadge, formatRemovedBadge } from "../format/lineCounts";
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
    additionsText: formatAddedBadge(entry.stats.additions, entry.stats.truncated),
    deletionsText: formatRemovedBadge(entry.stats.deletions),
    changeType: entry.changeKind,
    isUntracked: entry.flags.untracked,
  };
}

/**
 * Return one distinct tree path per entry, in entry order, as the tree draws it.
 *
 * The tree draws a row's name from its path as plain text, so hidden characters are spelled
 * out first (`file<U+202E>txt.exe`): a bidi override in a name would otherwise fake its
 * extension. The review may list two files at one shown path (a delete and an add of it have
 * different keys, or two paths differ only by a hidden character), but the tree keys rows by
 * path and would merge them, leaving one unreachable. Each repeat gets a visible ` (2)`,
 * ` (3)`, … suffix on its name, so every file has its own row.
 */
export function treePathsOf(entries: readonly { path: string }[]) {
  const shown = entries.map((entry) => revealReviewHiddenText(entry.path));
  const taken = new Set(shown);
  const seen = new Set<string>();
  return shown.map((path) => {
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
