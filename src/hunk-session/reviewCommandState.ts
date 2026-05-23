import {
  buildLiveComment,
  findDiffFileByPath,
  hunkLineRange,
  resolveCommentTarget,
  type LiveComment,
} from "../core/liveComments";
import type { AgentAnnotation, DiffFile } from "../core/types";
import { reviewNoteSource } from "../ui/lib/agentAnnotations";
import { mergeFileAnnotationsByFileId } from "../ui/lib/files";
import { buildSelectedHunkSummary, resolveReviewNavigationTarget } from "../ui/lib/reviewState";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  CommentBatchItemInput,
  CommentToolInput,
  HunkSessionSnapshot,
  HunkSessionState,
  NavigateToHunkToolInput,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "./types";

export interface SavedUserReviewNote extends AgentAnnotation {
  id: string;
  source: "user";
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  author: string;
  createdAt: string;
  editable: true;
}

export interface ReviewCommandState {
  selectedFileId: string;
  selectedHunkIndex: number;
  showAgentNotes: boolean;
  liveCommentsByFileId: Record<string, LiveComment[]>;
  userNotesByFileId: Record<string, SavedUserReviewNote[]>;
}

function countFileMapItems<T>(byFileId: Record<string, T[]>) {
  return Object.values(byFileId).reduce((sum, items) => sum + items.length, 0);
}

function appendMapItem<T>(byFileId: Record<string, T[]>, fileId: string, item: T) {
  return { ...byFileId, [fileId]: [...(byFileId[fileId] ?? []), item] };
}

function removeMapItem<T extends { id: string }>(byFileId: Record<string, T[]>, id: string) {
  let removed = false;
  const next: Record<string, T[]> = {};

  for (const [fileId, items] of Object.entries(byFileId)) {
    const filtered = items.filter((item) => item.id !== id);
    removed ||= filtered.length !== items.length;
    if (filtered.length > 0) next[fileId] = filtered;
  }

  return { next, removed, remainingCount: countFileMapItems(next) };
}

function liveCommentsByFileFromSummaries(
  files: DiffFile[],
  summaries: SessionLiveCommentSummary[] = [],
) {
  const byFileId: Record<string, LiveComment[]> = {};
  summaries.forEach((summary) => {
    const file = findDiffFileByPath(files, summary.filePath);
    if (!file) return;
    const comments = (byFileId[file.id] ??= []);
    comments.push(
      buildLiveComment(summary, summary.commentId, summary.createdAt, summary.hunkIndex),
    );
  });
  return byFileId;
}

function summarizeLiveComment(filePath: string, comment: LiveComment): SessionLiveCommentSummary {
  return {
    commentId: comment.id,
    filePath,
    hunkIndex: comment.hunkIndex,
    side: comment.side,
    line: comment.line,
    summary: comment.summary,
    rationale: comment.rationale,
    author: comment.author,
    createdAt: comment.createdAt,
  };
}

/** Create command state from a fresh review, optionally rehydrating a broker snapshot. */
export function createReviewCommandState({
  files,
  initialSessionState,
  initialShowAgentNotes = false,
}: {
  files: DiffFile[];
  initialSessionState?: HunkSessionState;
  initialShowAgentNotes?: boolean;
}): ReviewCommandState {
  const selectedFile =
    files.find((file) => file.id === initialSessionState?.selectedFileId) ??
    (initialSessionState?.selectedFilePath
      ? findDiffFileByPath(files, initialSessionState.selectedFilePath)
      : undefined) ??
    files[0];

  return reconcileReviewCommandSelection({
    allFiles: files,
    visibleFiles: files,
    state: {
      selectedFileId: selectedFile?.id ?? "",
      selectedHunkIndex: initialSessionState?.selectedHunkIndex ?? 0,
      showAgentNotes: initialSessionState?.showAgentNotes ?? initialShowAgentNotes,
      liveCommentsByFileId: liveCommentsByFileFromSummaries(
        files,
        initialSessionState?.liveComments,
      ),
      userNotesByFileId: {},
    },
  });
}

function reviewCommandAnnotationsByFileId(state: ReviewCommandState) {
  const next: Record<string, AgentAnnotation[]> = { ...state.liveCommentsByFileId };
  for (const [fileId, annotations] of Object.entries(state.userNotesByFileId)) {
    next[fileId] = [...(next[fileId] ?? []), ...annotations];
  }
  return next;
}

/** Merge command-owned annotations into review files for command navigation. */
export function reviewCommandFiles(files: DiffFile[], state: ReviewCommandState): DiffFile[] {
  return mergeFileAnnotationsByFileId(files, reviewCommandAnnotationsByFileId(state));
}

/** Keep command selection anchored to the currently available review stream. */
export function reconcileReviewCommandSelection({
  allFiles,
  state,
  visibleFiles,
}: {
  allFiles: DiffFile[];
  state: ReviewCommandState;
  visibleFiles: DiffFile[];
}): ReviewCommandState {
  if (visibleFiles.length === 0) {
    return state;
  }

  const selectedFile = allFiles.find((file) => file.id === state.selectedFileId);
  const selectedVisible = selectedFile
    ? visibleFiles.some((file) => file.id === selectedFile.id)
    : false;

  if (!state.selectedFileId || !selectedFile || !selectedVisible) {
    const firstVisibleFile = visibleFiles[0]!;
    return selectReviewHunk(state, { fileId: firstVisibleFile.id, hunkIndex: 0 });
  }

  const maxIndex = Math.max(0, selectedFile.metadata.hunks.length - 1);
  const selectedHunkIndex = Math.min(Math.max(state.selectedHunkIndex, 0), maxIndex);
  return selectedHunkIndex === state.selectedHunkIndex ? state : { ...state, selectedHunkIndex };
}

/** Select one file and hunk in command state. */
export function selectReviewHunk(
  state: ReviewCommandState,
  { fileId, hunkIndex }: { fileId: string; hunkIndex: number },
): ReviewCommandState {
  return state.selectedFileId === fileId && state.selectedHunkIndex === hunkIndex
    ? state
    : { ...state, selectedFileId: fileId, selectedHunkIndex: hunkIndex };
}

/** Toggle the persistent review-note visibility bit in command state. */
export function setReviewAgentNotesVisible(
  state: ReviewCommandState,
  visible: boolean,
): ReviewCommandState {
  return state.showAgentNotes === visible ? state : { ...state, showAgentNotes: visible };
}

function addLiveComments({
  files,
  inputs,
  now,
  revealFirst,
  state,
}: {
  files: DiffFile[];
  state: ReviewCommandState;
  inputs: Array<{ commentId: string; input: CommentBatchItemInput }>;
  now: string;
  revealFirst: boolean;
}): { applied: AppliedCommentResult[]; state: ReviewCommandState } {
  const prepared = inputs.map(({ commentId, input }) => {
    const file = findDiffFileByPath(files, input.filePath);
    if (!file) throw new Error(`No diff file matches ${input.filePath}.`);

    const target = resolveCommentTarget(file, input);
    const liveComment = buildLiveComment(
      { ...input, side: target.side, line: target.line },
      commentId,
      now,
      target.hunkIndex,
    );
    return { file, liveComment, target };
  });

  let liveCommentsByFileId = state.liveCommentsByFileId;
  prepared.forEach(({ file, liveComment }) => {
    liveCommentsByFileId = appendMapItem(liveCommentsByFileId, file.id, liveComment);
  });

  let nextState: ReviewCommandState = { ...state, liveCommentsByFileId };
  if (revealFirst && prepared[0]) {
    nextState = setReviewAgentNotesVisible(
      selectReviewHunk(nextState, {
        fileId: prepared[0].file.id,
        hunkIndex: prepared[0].target.hunkIndex,
      }),
      true,
    );
  }

  return {
    state: nextState,
    applied: prepared.map(({ file, liveComment, target }) => ({
      commentId: liveComment.id,
      fileId: file.id,
      filePath: file.path,
      hunkIndex: target.hunkIndex,
      side: target.side,
      line: target.line,
    })),
  };
}

/** Add one live agent comment to command state. */
export function addReviewLiveComment({
  commentId,
  files,
  input,
  now,
  options = {},
  state,
}: {
  files: DiffFile[];
  state: ReviewCommandState;
  input: CommentToolInput;
  commentId: string;
  now: string;
  options?: { reveal?: boolean };
}): { state: ReviewCommandState; result: AppliedCommentResult } {
  const next = addLiveComments({
    files,
    state,
    inputs: [{ commentId, input }],
    now,
    revealFirst: options.reveal ?? false,
  });
  return { state: next.state, result: next.applied[0]! };
}

/** Apply several live comments after validating every target against the same input state. */
export function addReviewLiveCommentBatch({
  files,
  inputs,
  now,
  options = {},
  requestId,
  state,
}: {
  files: DiffFile[];
  state: ReviewCommandState;
  inputs: CommentBatchItemInput[];
  requestId: string;
  now: string;
  options?: { revealMode?: "none" | "first" };
}): { state: ReviewCommandState; result: AppliedCommentBatchResult } {
  const next = addLiveComments({
    files,
    state,
    inputs: inputs.map((input, index) => ({ commentId: `mcp:${requestId}:${index}`, input })),
    now,
    revealFirst: options.revealMode === "first",
  });
  return { state: next.state, result: { applied: next.applied } };
}

/** Remove one live comment by id. */
export function removeReviewLiveComment(
  state: ReviewCommandState,
  commentId: string,
): { state: ReviewCommandState; result: RemovedCommentResult } {
  const removed = removeMapItem(state.liveCommentsByFileId, commentId);
  if (!removed.removed) throw new Error(`No live comment matches id ${commentId}.`);

  return {
    state: { ...state, liveCommentsByFileId: removed.next },
    result: { commentId, removed: true, remainingCommentCount: removed.remainingCount },
  };
}

/** Clear all live comments, or only the comments attached to one file. */
export function clearReviewLiveComments({
  filePath,
  files,
  state,
}: {
  files: DiffFile[];
  state: ReviewCommandState;
  filePath?: string;
}): { state: ReviewCommandState; result: ClearedCommentsResult } {
  let liveCommentsByFileId: Record<string, LiveComment[]> = {};
  let removedCount = countFileMapItems(state.liveCommentsByFileId);

  if (filePath) {
    const file = findDiffFileByPath(files, filePath);
    if (!file) throw new Error(`No diff file matches ${filePath}.`);

    liveCommentsByFileId = { ...state.liveCommentsByFileId };
    removedCount = liveCommentsByFileId[file.id]?.length ?? 0;
    delete liveCommentsByFileId[file.id];
  }

  const remainingCommentCount = countFileMapItems(liveCommentsByFileId);
  return {
    state: removedCount === 0 ? state : { ...state, liveCommentsByFileId },
    result: { removedCount, remainingCommentCount, filePath },
  };
}

/** Add one saved user review note to command state. */
export function addSavedUserReviewNote(
  state: ReviewCommandState,
  note: SavedUserReviewNote,
): ReviewCommandState {
  return {
    ...state,
    userNotesByFileId: appendMapItem(state.userNotesByFileId, note.fileId, note),
  };
}

/** Remove one saved user review note by id. */
export function removeSavedUserReviewNote(
  state: ReviewCommandState,
  noteId: string,
): ReviewCommandState {
  const removed = removeMapItem(state.userNotesByFileId, noteId);
  if (!removed.removed) throw new Error(`No user note matches id ${noteId}.`);
  return { ...state, userNotesByFileId: removed.next };
}

/** Navigate persistent command selection using a session-daemon navigation request. */
export function navigateReviewCommandState({
  allFiles,
  input,
  state,
  visibleFiles,
}: {
  allFiles: DiffFile[];
  visibleFiles: DiffFile[];
  state: ReviewCommandState;
  input: NavigateToHunkToolInput;
}): { state: ReviewCommandState; result: NavigatedSelectionResult; scrollToNote: boolean } {
  const target = resolveReviewNavigationTarget({
    allFiles,
    currentFileId: state.selectedFileId,
    currentHunkIndex: state.selectedHunkIndex,
    input,
    visibleFiles,
  });

  return {
    state: selectReviewHunk(state, { fileId: target.file.id, hunkIndex: target.hunkIndex }),
    scrollToNote: target.scrollToNote,
    result: {
      fileId: target.file.id,
      filePath: target.file.path,
      hunkIndex: target.hunkIndex,
      selectedHunk: buildSelectedHunkSummary(target.file, target.hunkIndex),
    },
  };
}

/** Return all session-owned live comments in file order. */
function reviewLiveCommentSummaries(
  files: DiffFile[],
  state: ReviewCommandState,
): SessionLiveCommentSummary[] {
  return files.flatMap((file) =>
    (state.liveCommentsByFileId[file.id] ?? []).map((comment) =>
      summarizeLiveComment(file.path, comment),
    ),
  );
}

/** Return all review notes visible to session commands and review exports. */
function reviewNoteSummaries(
  files: DiffFile[],
  state: ReviewCommandState,
): SessionReviewNoteSummary[] {
  const summaries: SessionReviewNoteSummary[] = [];

  files.forEach((file) => {
    (file.agent?.annotations ?? []).forEach((annotation, index) => {
      const source = reviewNoteSource(annotation);
      summaries.push({
        noteId: annotation.id ?? `${source}:${file.id}:${index}`,
        source,
        filePath: file.path,
        oldRange: annotation.oldRange,
        newRange: annotation.newRange,
        body: [annotation.summary, annotation.rationale].filter(Boolean).join("\n\n"),
        title: annotation.title,
        author: annotation.author,
        createdAt: annotation.createdAt ?? "1970-01-01T00:00:00.000Z",
        updatedAt: annotation.updatedAt,
        editable: false,
      });
    });

    (state.liveCommentsByFileId[file.id] ?? []).forEach((comment) => {
      summaries.push({
        noteId: comment.id,
        source: "agent",
        filePath: file.path,
        hunkIndex: comment.hunkIndex,
        oldRange: comment.oldRange,
        newRange: comment.newRange,
        body: [comment.summary, comment.rationale].filter(Boolean).join("\n\n"),
        author: comment.author,
        createdAt: comment.createdAt,
        editable: false,
      });
    });

    (state.userNotesByFileId[file.id] ?? []).forEach((note) => {
      summaries.push({
        noteId: note.id,
        source: "user",
        filePath: file.path,
        hunkIndex: note.hunkIndex,
        oldRange: note.oldRange,
        newRange: note.newRange,
        body: note.summary,
        author: note.author,
        createdAt: note.createdAt,
        editable: true,
      });
    });
  });

  return summaries;
}

/** Build the broker-facing snapshot for the current command state. */
export function buildReviewSessionSnapshot({
  files,
  now,
  state,
}: {
  files: DiffFile[];
  state: ReviewCommandState;
  now: string;
}): HunkSessionSnapshot {
  const selectedFile = files.find((file) => file.id === state.selectedFileId);
  const selectedHunk = selectedFile?.metadata.hunks[state.selectedHunkIndex];
  const selectedRange = selectedHunk ? hunkLineRange(selectedHunk) : undefined;
  const liveComments = reviewLiveCommentSummaries(files, state);
  const reviewNotes = reviewNoteSummaries(files, state);

  return {
    updatedAt: now,
    state: {
      selectedFileId: selectedFile?.id,
      selectedFilePath: selectedFile?.path,
      selectedHunkIndex: state.selectedHunkIndex,
      selectedHunkOldRange: selectedRange?.oldRange,
      selectedHunkNewRange: selectedRange?.newRange,
      showAgentNotes: state.showAgentNotes,
      liveCommentCount: liveComments.length,
      liveComments,
      reviewNoteCount: reviewNotes.length,
      reviewNotes,
    },
  };
}
