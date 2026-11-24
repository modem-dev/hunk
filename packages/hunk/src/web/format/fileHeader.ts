/**
 * Words and path pieces the stream's file headers print.
 *
 * The header path is the shared label from `core/review/fileLabels.ts` (`old -> new` for a
 * rename), split so the page can dim the directory and the old name while the text stays one
 * copyable string. The state chip names what kind of change a file is from facts the review
 * document already carries — its change kind, untracked flag, and the shared reason a file
 * renders no rows — so the page never re-derives a file's kind on its own. A second chip warns
 * when the file's name or lines hold bidi controls or invisible characters.
 */
import type { ReviewEmptyDiffReason } from "../../core/review/document";
import type { ReviewHiddenTextFacts } from "../../core/review/hiddenText";
import { reviewFileLabelParts } from "../../core/review/fileLabels";
import type { ReviewFileChangeKind } from "../../core/review/types";

/** The header path for one file, in the pieces the header styles differently. */
export interface WebFileHeaderPath {
  /** The whole label, as the header's text content and tooltip read it. */
  text: string;
  /** The old path of a rename, drawn dimmed before the arrow. */
  previous?: string;
  /** The shown path's directory with its trailing slash, or empty. */
  directory: string;
  basename: string;
}

/** Split one file's header label into its old name, directory, and basename. */
export function webFileHeaderPath(file: {
  path: string;
  previousPath?: string;
  changeKind: ReviewFileChangeKind;
  untracked: boolean;
}): WebFileHeaderPath {
  const { filename } = reviewFileLabelParts(file);
  const renamed = file.previousPath !== undefined && file.previousPath !== file.path;
  const previous = renamed ? file.previousPath : undefined;
  const shown = previous !== undefined ? filename.slice(previous.length + " -> ".length) : filename;
  const slash = shown.lastIndexOf("/");
  return {
    text: filename,
    ...(previous !== undefined ? { previous } : {}),
    directory: shown.slice(0, slash + 1),
    basename: shown.slice(slash + 1),
  };
}

/** What a file's state chip says about a file with nothing to render, per shared reason. */
const EMPTY_REASON_WORDS: Record<ReviewEmptyDiffReason, string | null> = {
  "rename-only": null,
  binary: "binary",
  "too-large": "too large",
  "new-file": "empty",
  "deleted-file": "empty",
  "no-hunks": "no textual changes",
};

/**
 * The quiet chip after a file's path: "new", "deleted", "untracked", "renamed, no content
 * changes", and for a file that renders no rows the shared reason ("binary", "too large"),
 * joined with ` · `. Returns null for an ordinary modified file.
 *
 * `sizes` is extra detail a binary file may carry when the page already holds it.
 */
export function webFileStateChip(file: {
  changeKind: ReviewFileChangeKind;
  untracked: boolean;
  emptyReason?: ReviewEmptyDiffReason;
  sizes?: string;
}): string | null {
  const words: string[] = [];
  if (file.untracked) words.push("untracked");
  else if (file.changeKind === "new") words.push("new");
  else if (file.changeKind === "deleted") words.push("deleted");
  if (file.changeKind === "rename-pure" || file.emptyReason === "rename-only") {
    words.push("renamed, no content changes");
  }
  const reason = file.emptyReason ? EMPTY_REASON_WORDS[file.emptyReason] : null;
  if (reason) words.push(reason);
  if (file.emptyReason === "binary" && file.sizes) words.push(file.sizes);
  return words.length > 0 ? words.join(" · ") : null;
}

/** What a file header's hidden-text warning says: a short label and the sentence behind it. */
export interface WebHiddenTextChip {
  label: string;
  description: string;
}

/**
 * The warning chip for a file whose name or lines hold bidi controls or invisible characters
 * (`reviewFileHiddenText`), or null for a file with none.
 */
export function webHiddenTextChip(
  facts: ReviewHiddenTextFacts | undefined,
): WebHiddenTextChip | null {
  if (!facts) return null;
  const marked = (example: string) => `Each one is shown as its code point, such as ${example}.`;
  if (facts.bidi) {
    return {
      label: "bidirectional Unicode",
      description:
        `This file contains ${facts.invisible ? "bidirectional and invisible" : "bidirectional"} ` +
        `Unicode characters that can make text read differently from how it is interpreted. ` +
        marked("U+202E"),
    };
  }
  return {
    label: "hidden Unicode",
    description: `This file contains invisible Unicode characters. ${marked("U+200B")}`,
  };
}
