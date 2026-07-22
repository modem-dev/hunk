import type {
  HunkSessionRegistration,
  HunkSessionSnapshot,
  ListedSession,
  SelectedSessionContext,
  SessionFileSummary,
  SessionLiveCommentSummary,
  SessionReview,
  SessionReviewNoteSummary,
  SessionReviewFile,
} from "./types";

export interface HunkSessionEntryLike {
  registration: HunkSessionRegistration;
  snapshot: HunkSessionSnapshot;
}

function findSelectedFile(session: ListedSession) {
  return (
    session.files.find(
      (file) =>
        file.id === session.snapshot.state.selectedFileId ||
        file.path === session.snapshot.state.selectedFilePath ||
        file.previousPath === session.snapshot.state.selectedFilePath,
    ) ?? null
  );
}

/** Match one review-export file against the live snapshot's current file selection. */
function findSelectedReviewFile(entry: HunkSessionEntryLike) {
  return (
    entry.registration.info.files.find(
      (file) =>
        file.id === entry.snapshot.state.selectedFileId ||
        file.path === entry.snapshot.state.selectedFilePath ||
        file.previousPath === entry.snapshot.state.selectedFilePath,
    ) ?? null
  );
}

/** Reduce one review-export file back to the summary fields used by session listings. */
export function summarizeReviewFile(reviewFile: SessionReviewFile): SessionFileSummary {
  return {
    id: reviewFile.id,
    path: reviewFile.path,
    previousPath: reviewFile.previousPath,
    additions: reviewFile.additions,
    deletions: reviewFile.deletions,
    hunkCount: reviewFile.hunkCount,
  };
}

/** Serialize one review-export file while keeping raw patch text opt-in for callers. */
export function serializeReviewFile(
  reviewFile: SessionReviewFile,
  includePatch: boolean,
): SessionReviewFile {
  return includePatch
    ? reviewFile
    : {
        ...summarizeReviewFile(reviewFile),
        hunks: reviewFile.hunks,
      };
}

/** Project one raw broker entry into the Hunk session list shape used by the CLI. */
export function buildListedHunkSession(entry: HunkSessionEntryLike): ListedSession {
  return {
    sessionId: entry.registration.sessionId,
    pid: entry.registration.pid,
    cwd: entry.registration.cwd,
    repoRoot: entry.registration.repoRoot,
    launchedAt: entry.registration.launchedAt,
    terminal: entry.registration.terminal,
    inputKind: entry.registration.info.inputKind,
    title: entry.registration.info.title,
    sourceLabel: entry.registration.info.sourceLabel,
    fileCount: entry.registration.info.files.length,
    files: entry.registration.info.files.map(summarizeReviewFile),
    snapshot: entry.snapshot,
  };
}

/** Project the focused file and hunk for one Hunk session. */
export function buildSelectedHunkSessionContext(session: ListedSession): SelectedSessionContext {
  const selectedFile = findSelectedFile(session);

  return {
    sessionId: session.sessionId,
    title: session.title,
    sourceLabel: session.sourceLabel,
    cwd: session.cwd,
    repoRoot: session.repoRoot,
    inputKind: session.inputKind,
    selectedFile,
    selectedHunk: selectedFile
      ? {
          index: session.snapshot.state.selectedHunkIndex,
          oldRange: session.snapshot.state.selectedHunkOldRange,
          newRange: session.snapshot.state.selectedHunkNewRange,
        }
      : null,
    showAgentNotes: session.snapshot.state.showAgentNotes,
    noteMarkupWidth: session.snapshot.state.noteMarkupWidth,
    liveCommentCount: session.snapshot.state.liveCommentCount,
  };
}

/** Project one raw broker entry into the Hunk review export used by `hunk session review`. */
export function buildHunkSessionReview(
  entry: HunkSessionEntryLike,
  options: { includePatch?: boolean; includeNotes?: boolean } = {},
): SessionReview {
  const selectedFile = findSelectedReviewFile(entry);
  const includePatch = options.includePatch ?? false;

  return {
    sessionId: entry.registration.sessionId,
    title: entry.registration.info.title,
    sourceLabel: entry.registration.info.sourceLabel,
    cwd: entry.registration.cwd,
    repoRoot: entry.registration.repoRoot,
    inputKind: entry.registration.info.inputKind,
    selectedFile: selectedFile ? serializeReviewFile(selectedFile, includePatch) : null,
    selectedHunk: selectedFile
      ? (selectedFile.hunks[entry.snapshot.state.selectedHunkIndex] ?? null)
      : null,
    showAgentNotes: entry.snapshot.state.showAgentNotes,
    liveCommentCount: entry.snapshot.state.liveCommentCount,
    reviewNoteCount:
      entry.snapshot.state.reviewNoteCount ?? entry.snapshot.state.reviewNotes?.length ?? 0,
    reviewNotes: options.includeNotes ? (entry.snapshot.state.reviewNotes ?? []) : undefined,
    files: entry.registration.info.files.map((file) => serializeReviewFile(file, includePatch)),
  };
}

/** Return the visible live comments for one Hunk session, optionally filtered to one file. */
export function listHunkSessionComments(
  session: ListedSession,
  filter: { filePath?: string } = {},
): SessionLiveCommentSummary[] {
  if (!filter.filePath) {
    return session.snapshot.state.liveComments;
  }

  return session.snapshot.state.liveComments.filter(
    (comment) => comment.filePath === filter.filePath,
  );
}

/** Return review notes for one Hunk session, optionally filtered to a file and source. */
export function listHunkSessionNotes(
  session: ListedSession,
  filter: { filePath?: string; source?: SessionReviewNoteSummary["source"] } = {},
): SessionReviewNoteSummary[] {
  return (session.snapshot.state.reviewNotes ?? []).filter((note) => {
    if (filter.filePath && note.filePath !== filter.filePath) {
      return false;
    }

    if (filter.source && note.source !== filter.source) {
      return false;
    }

    return true;
  });
}
