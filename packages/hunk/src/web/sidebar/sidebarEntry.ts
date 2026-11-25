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
 * The tree draws each name from its path as plain text, so hidden characters are spelled out
 * segment by segment (`file<U+202E>txt.exe`): a bidi override in a name would otherwise fake its
 * extension. The tree keys rows and folders by path, so two different files or folders must
 * never share a shown path. Spelling can collide — `a\u200B/` and a folder literally named
 * `a<U+200B>/` — and so can the review itself (a delete and an add of one path have different
 * keys). Each raw folder or file keeps its natural spelling when it is free, first come first
 * served in review order, and otherwise gets a visible ` (2)`, ` (3)`, … suffix, so every file
 * has its own row and folders with different names never merge their counts.
 */
export function treePathsOf(entries: readonly { path: string }[]) {
  const shownByRaw = new Map<string, string>();
  const taken = new Set<string>();
  const claim = (natural: string) => {
    let shown = natural;
    for (let copy = 2; taken.has(shown); copy += 1) shown = `${natural} (${copy})`;
    taken.add(shown);
    return shown;
  };

  // First occurrences claim every folder and file spelling, segment by segment.
  for (const { path } of entries) {
    let raw = "";
    let shown = "";
    for (const [depth, segment] of path.split("/").entries()) {
      raw = depth === 0 ? segment : `${raw}/${segment}`;
      const known = shownByRaw.get(raw);
      if (known !== undefined) {
        shown = known;
        continue;
      }
      const natural = revealReviewHiddenText(segment);
      shown = claim(depth === 0 ? natural : `${shown}/${natural}`);
      shownByRaw.set(raw, shown);
    }
  }

  // A repeated path is a different file at the same place; it gets a row of its own.
  const seen = new Set<string>();
  return entries.map(({ path }) => {
    const shown = shownByRaw.get(path)!;
    if (!seen.has(path)) {
      seen.add(path);
      return shown;
    }
    return claim(shown);
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
