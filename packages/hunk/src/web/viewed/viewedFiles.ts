/**
 * Decides what the page shows for each file's viewed mark: viewed, changed since viewed, or not
 * viewed, and how many of the shown files are viewed.
 *
 * The session's viewed marks are shared review state (`files/set-viewed`, G1): the shared-state
 * snapshot lists only the marks whose recorded `contentIdentity` still matches the file, so a
 * reload that changes a file drops its mark everywhere. What the snapshot cannot say is that a
 * file *was* viewed before its content changed, so the page remembers, per session and per
 * browser, the content identity each file was last seen marked at (`ViewedMemory`). A file
 * whose remembered identity differs from its current one, and that is not marked now, is
 * "changed since viewed" until the reader marks it again or clears the mark.
 *
 * Nothing here decides whether a mark is valid; the shared state already did. The memory only
 * annotates what the shared state dropped.
 */

/** What the page shows for one file's viewed mark. */
export type ReviewViewedStatus = "viewed" | "changed" | "unviewed";

/** One file as the page needs it to judge its mark. */
export interface ReviewViewedFile {
  key: string;
  contentIdentity: string;
}

/** The content identity each file was last seen marked viewed at, by file key. */
export type ViewedMemory = Readonly<Record<string, string>>;

/** The status of one file given the shared marks and what this browser remembers. */
export function reviewViewedStatus(
  file: ReviewViewedFile,
  viewedFiles: Readonly<Record<string, { contentIdentity: string }>>,
  memory: ViewedMemory,
): ReviewViewedStatus {
  const mark = viewedFiles[file.key];
  if (mark && mark.contentIdentity === file.contentIdentity) return "viewed";
  const remembered = memory[file.key];
  return remembered !== undefined && remembered !== file.contentIdentity ? "changed" : "unviewed";
}

/**
 * Fold the shared marks into the memory: every listed mark is remembered at its identity.
 *
 * Returns the same object when nothing changed, so a React state update can bail out.
 */
export function rememberViewedMarks(
  memory: ViewedMemory,
  viewedFiles: Readonly<Record<string, { contentIdentity: string }>>,
): ViewedMemory {
  let next: Record<string, string> | undefined;
  for (const [key, mark] of Object.entries(viewedFiles)) {
    if (memory[key] === mark.contentIdentity) continue;
    next ??= { ...memory };
    next[key] = mark.contentIdentity;
  }
  return next ?? memory;
}

/** Forget one file's remembered mark (the reader cleared it). */
export function forgetViewedMark(memory: ViewedMemory, key: string): ViewedMemory {
  if (!(key in memory)) return memory;
  const { [key]: _forgotten, ...rest } = memory;
  return rest;
}

/** The progress label the toolbar shows. */
export function formatReviewViewedProgress(progress: { viewed: number; total: number }) {
  return `${progress.viewed} of ${progress.total} viewed`;
}
