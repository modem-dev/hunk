/**
 * Shared review-stream state for both the app shell and the session bridge.
 *
 * This hook owns the live review state that both callers need to agree on:
 * filtering, merged live comments, selected file and hunk, and relative review
 * navigation. `App` uses it for rendering and keyboard or menu actions, while
 * the session bridge uses the same state and actions for daemon-driven navigation.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { firstCommentTargetForHunk } from "../../core/liveComments";
import type { DiffFile, UserNoteLineTarget } from "../../core/types";
import {
  addReviewLiveComment,
  addReviewLiveCommentBatch,
  addSavedUserReviewNote,
  buildReviewSessionSnapshot,
  clearReviewLiveComments,
  createReviewCommandState,
  navigateReviewCommandState,
  reconcileReviewCommandSelection,
  removeReviewLiveComment,
  removeSavedUserReviewNote,
  reviewCommandFiles,
  selectReviewHunk,
  setReviewAgentNotesVisible,
  type ReviewCommandState,
  type SavedUserReviewNote,
} from "../../hunk-session/reviewCommandState";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  CommentBatchItemInput,
  CommentToolInput,
  HunkSessionSnapshot,
  HunkSessionState,
  LiveComment,
  NavigateToHunkToolInput,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../../hunk-session/types";
import { findNextHunkCursor } from "../lib/hunks";
import { buildReviewState, findNextAnnotatedFile, type ReviewState } from "../lib/reviewState";

export interface DraftReviewNote {
  id: string;
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  oldRange?: [number, number];
  newRange?: [number, number];
  body: string;
}

export interface ReviewSelectionOptions {
  alignFileHeaderTop?: boolean;
  preserveViewport?: boolean;
  scrollToNote?: boolean;
}

export interface ReviewController {
  allFiles: DiffFile[];
  filter: string;
  draftNote: DraftReviewNote | null;
  liveCommentCount: number;
  liveCommentSummaries: SessionLiveCommentSummary[];
  liveCommentsByFileId: Record<string, LiveComment[]>;
  reviewNoteCount: number;
  reviewNoteSummaries: SessionReviewNoteSummary[];
  sessionSnapshot: HunkSessionSnapshot;
  showAgentNotes: boolean;
  userNotesByFileId: Record<string, SavedUserReviewNote[]>;
  moveToAnnotatedFile: (delta: number) => void;
  moveToAnnotatedHunk: (delta: number) => void;
  moveToFile: (delta: number) => void;
  moveToHunk: (delta: number) => void;
  scrollToNote: boolean;
  selectedFile: DiffFile | undefined;
  selectedFileId: string;
  selectedFileTopAlignRequestId: number;
  selectedHunkRevealRequestId: number;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  selectedHunkIndex: number;
  sidebarEntries: ReviewState["sidebarEntries"];
  visibleFiles: DiffFile[];
  addLiveComment: (
    input: CommentToolInput,
    commentId: string,
    options?: { reveal?: boolean },
  ) => AppliedCommentResult;
  addLiveCommentBatch: (
    inputs: CommentBatchItemInput[],
    requestId: string,
    options?: { revealMode?: "none" | "first" },
  ) => AppliedCommentBatchResult;
  clearFilter: () => void;
  clearLiveComments: (filePath?: string) => ClearedCommentsResult;
  navigateToLocation: (input: NavigateToHunkToolInput) => NavigatedSelectionResult;
  removeLiveComment: (commentId: string) => RemovedCommentResult;
  cancelDraftNote: () => void;
  removeUserNote: (noteId: string) => void;
  saveDraftNote: () => SavedUserReviewNote | null;
  selectFile: (fileId: string, nextHunkIndex?: number, options?: ReviewSelectionOptions) => void;
  selectHunk: (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => void;
  startUserNote: (
    fileId?: string,
    hunkIndex?: number,
    target?: UserNoteLineTarget,
  ) => DraftReviewNote | null;
  setAgentNotesVisible: (visible: boolean) => void;
  setFilter: (value: string) => void;
  toggleAgentNotes: () => void;
  updateDraftNote: (body: string) => void;
}

/** Own the shared review stream state used by both the UI and session bridge. */
export function useReviewController({
  files,
  initialSessionState,
  initialShowAgentNotes,
}: {
  files: DiffFile[];
  initialSessionState?: HunkSessionState;
  initialShowAgentNotes?: boolean;
}): ReviewController {
  const [filter, setFilter] = useState("");
  const [commandState, setCommandState] = useState(() =>
    createReviewCommandState({ files, initialSessionState, initialShowAgentNotes }),
  );
  const commandStateRef = useRef(commandState);
  const [selectedFileTopAlignRequestId, setSelectedFileTopAlignRequestId] = useState(0);
  const [selectedHunkRevealRequestId, setSelectedHunkRevealRequestId] = useState(0);
  const [scrollToNote, setScrollToNote] = useState(false);
  const [draftNote, setDraftNote] = useState<DraftReviewNote | null>(null);
  const deferredFilter = useDeferredValue(filter);

  /** Update command state and its imperative mirror together. */
  const updateCommandState = useCallback(
    (updater: (state: ReviewCommandState) => ReviewCommandState) => {
      setCommandState((current) => {
        const next = updater(current);
        commandStateRef.current = next;
        return next;
      });
    },
    [],
  );

  /** Apply a command-state transition synchronously so session command replies match state. */
  const applyCommandStateTransition = useCallback(
    <T>(transition: (state: ReviewCommandState) => { state: ReviewCommandState; result: T }) => {
      const next = transition(commandStateRef.current);
      commandStateRef.current = next.state;
      setCommandState(next.state);
      return next.result;
    },
    [],
  );

  const {
    allFiles,
    visibleFiles,
    sidebarEntries,
    selectedFile,
    selectedHunk,
    hunkCursors,
    annotatedHunkCursors,
  } = useMemo(
    () =>
      buildReviewState({
        files: reviewCommandFiles(files, commandState),
        filterQuery: deferredFilter,
        selectedFileId: commandState.selectedFileId,
        selectedHunkIndex: commandState.selectedHunkIndex,
      }),
    [deferredFilter, files, commandState],
  );
  const selectedFileId = commandState.selectedFileId;
  const selectedHunkIndex = commandState.selectedHunkIndex;
  const showAgentNotes = commandState.showAgentNotes;
  const liveCommentsByFileId = commandState.liveCommentsByFileId;
  const userNotesByFileId = commandState.userNotesByFileId;

  /** Update the selection and reveal intent together so diff scrolling stays explicit. */
  const selectHunk = useCallback(
    (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => {
      updateCommandState((current) => selectReviewHunk(current, { fileId, hunkIndex }));
      setScrollToNote(Boolean(options?.scrollToNote));

      if (options?.alignFileHeaderTop) {
        setSelectedFileTopAlignRequestId((current) => current + 1);
        return;
      }

      if (!options?.preserveViewport) {
        setSelectedHunkRevealRequestId((current) => current + 1);
      }
    },
    [updateCommandState],
  );

  /** Select one file and optionally one specific hunk within it. */
  const selectFile = useCallback(
    (fileId: string, nextHunkIndex = 0, options?: ReviewSelectionOptions) => {
      selectHunk(fileId, nextHunkIndex, options);
    },
    [selectHunk],
  );

  useEffect(() => {
    updateCommandState((current) =>
      reconcileReviewCommandSelection({ allFiles, visibleFiles, state: current }),
    );
  }, [allFiles, updateCommandState, visibleFiles]);

  /** Move through the full visible review stream one hunk at a time. */
  const moveToHunk = useCallback(
    (delta: number) => {
      const nextCursor = findNextHunkCursor(
        hunkCursors,
        selectedFile?.id,
        selectedHunkIndex,
        delta,
      );
      if (!nextCursor) {
        return;
      }

      const crossingFileBoundary = nextCursor.fileId !== selectedFile?.id;
      selectHunk(nextCursor.fileId, nextCursor.hunkIndex, {
        // Align the file header to top only for forward cross-file jumps so the new file
        // starts at its header. Backward jumps should reveal the target hunk directly,
        // since the target is often near the bottom of the previous file and the file-top
        // align would require an extra navigation press to reach it.
        alignFileHeaderTop: crossingFileBoundary && delta > 0,
      });
    },
    [hunkCursors, selectHunk, selectedFile?.id, selectedHunkIndex],
  );

  /** Move through only hunks that currently have agent notes or live comments. */
  const moveToAnnotatedHunk = useCallback(
    (delta: number) => {
      const nextCursor = findNextHunkCursor(
        annotatedHunkCursors,
        selectedFile?.id,
        selectedHunkIndex,
        delta,
        hunkCursors,
      );
      if (!nextCursor) {
        return;
      }

      selectHunk(nextCursor.fileId, nextCursor.hunkIndex, { scrollToNote: true });
    },
    [annotatedHunkCursors, hunkCursors, selectHunk, selectedFile?.id, selectedHunkIndex],
  );

  /** Cycle through only the currently visible files that carry annotations. */
  const moveToAnnotatedFile = useCallback(
    (delta: number) => {
      const nextFile = findNextAnnotatedFile(visibleFiles, selectedFile?.id, delta);
      if (!nextFile) {
        return;
      }

      selectFile(nextFile.id);
    },
    [selectFile, selectedFile?.id, visibleFiles],
  );

  /** Move through all currently visible files without wrapping past either end. */
  const moveToFile = useCallback(
    (delta: number) => {
      const currentIndex = visibleFiles.findIndex((file) => file.id === selectedFile?.id);
      if (currentIndex < 0) {
        return;
      }

      const nextIndex = Math.min(Math.max(currentIndex + delta, 0), visibleFiles.length - 1);
      if (nextIndex === currentIndex) {
        return;
      }

      const nextFile = visibleFiles[nextIndex];
      if (!nextFile) {
        return;
      }

      selectFile(nextFile.id, 0, { alignFileHeaderTop: true });
    },
    [selectFile, selectedFile?.id, visibleFiles],
  );

  /** Clear the active file filter without touching the current selection. */
  const clearFilter = useCallback(() => {
    setFilter("");
  }, []);

  /** Resolve one session-daemon navigation request against the current review state and select it. */
  const navigateToLocation = useCallback(
    (input: NavigateToHunkToolInput): NavigatedSelectionResult => {
      let scrollToNoteAfterNavigation = false;
      const result = applyCommandStateTransition((state) => {
        const transition = navigateReviewCommandState({
          allFiles,
          visibleFiles,
          state,
          input,
        });
        scrollToNoteAfterNavigation = transition.scrollToNote;
        return transition;
      });
      setScrollToNote(scrollToNoteAfterNavigation);
      setSelectedHunkRevealRequestId((current) => current + 1);
      return result;
    },
    [allFiles, applyCommandStateTransition, visibleFiles],
  );

  /** Add one live comment, optionally revealing its hunk in the active review. */
  const addLiveComment = useCallback(
    (
      input: CommentToolInput,
      commentId: string,
      options?: { reveal?: boolean },
    ): AppliedCommentResult => {
      const now = new Date().toISOString();
      const result = applyCommandStateTransition((state) =>
        addReviewLiveComment({
          files: allFiles,
          state,
          input,
          commentId,
          now,
          options,
        }),
      );

      if (options?.reveal ?? false) {
        setScrollToNote(true);
        setSelectedHunkRevealRequestId((current) => current + 1);
      }

      return result;
    },
    [allFiles, applyCommandStateTransition],
  );

  /** Apply several live comments together after validating every target first. */
  const addLiveCommentBatch = useCallback(
    (
      inputs: CommentBatchItemInput[],
      requestId: string,
      options?: { revealMode?: "none" | "first" },
    ): AppliedCommentBatchResult => {
      const now = new Date().toISOString();
      const result = applyCommandStateTransition((state) =>
        addReviewLiveCommentBatch({
          files: allFiles,
          state,
          inputs,
          requestId,
          now,
          options,
        }),
      );

      if (options?.revealMode === "first" && result.applied.length > 0) {
        setScrollToNote(true);
        setSelectedHunkRevealRequestId((current) => current + 1);
      }

      return result;
    },
    [allFiles, applyCommandStateTransition],
  );

  /** Remove one live comment by id and report how many remain. */
  const removeLiveComment = useCallback(
    (commentId: string): RemovedCommentResult => {
      return applyCommandStateTransition((state) => removeReviewLiveComment(state, commentId));
    },
    [applyCommandStateTransition],
  );

  /** Clear all live comments, or only the comments attached to one specific file. */
  const clearLiveComments = useCallback(
    (filePath?: string): ClearedCommentsResult => {
      return applyCommandStateTransition((state) =>
        clearReviewLiveComments({
          files: allFiles,
          state,
          filePath,
        }),
      );
    },
    [allFiles, applyCommandStateTransition],
  );

  /** Start a human-authored draft note at the selected or requested hunk. */
  const startUserNote = useCallback(
    (
      fileId = selectedFile?.id,
      hunkIndex = selectedHunkIndex,
      requestedTarget?: UserNoteLineTarget,
    ): DraftReviewNote | null => {
      const file = allFiles.find((candidate) => candidate.id === fileId);
      const hunk = file?.metadata.hunks[hunkIndex];
      if (!file || !hunk) {
        return null;
      }

      const target = requestedTarget ?? firstCommentTargetForHunk(hunk);
      const draft: DraftReviewNote = {
        id: `draft:${file.id}:${hunkIndex}:${Date.now()}`,
        fileId: file.id,
        filePath: file.path,
        hunkIndex,
        side: target.side,
        line: target.line,
        oldRange: target.side === "old" ? [target.line, target.line] : undefined,
        newRange: target.side === "new" ? [target.line, target.line] : undefined,
        body: "",
      };
      setDraftNote(draft);
      selectHunk(
        file.id,
        hunkIndex,
        requestedTarget ? { preserveViewport: true } : { scrollToNote: true },
      );
      return draft;
    },
    [allFiles, selectHunk, selectedFile?.id, selectedHunkIndex],
  );

  /** Update the body of the active draft note. */
  const updateDraftNote = useCallback((body: string) => {
    setDraftNote((current) => (current ? { ...current, body } : current));
  }, []);

  /** Discard the active human note draft. */
  const cancelDraftNote = useCallback(() => {
    setDraftNote(null);
  }, []);

  /** Persist the active draft into the in-memory user note collection. */
  const saveDraftNote = useCallback((): SavedUserReviewNote | null => {
    if (!draftNote) {
      return null;
    }

    const body = draftNote.body.trim();
    if (!body) {
      setDraftNote(null);
      return null;
    }

    const savedNote: SavedUserReviewNote = {
      id: `user:${Date.now()}`,
      source: "user",
      fileId: draftNote.fileId,
      filePath: draftNote.filePath,
      hunkIndex: draftNote.hunkIndex,
      side: draftNote.side,
      line: draftNote.line,
      oldRange: draftNote.oldRange,
      newRange: draftNote.newRange,
      summary: body,
      author: "user",
      createdAt: new Date().toISOString(),
      editable: true,
    };

    updateCommandState((current) => addSavedUserReviewNote(current, savedNote));
    setDraftNote(null);
    return savedNote;
  }, [draftNote, updateCommandState]);

  /** Remove one in-memory user note by id. */
  const removeUserNote = useCallback(
    (noteId: string) => {
      updateCommandState((current) => removeSavedUserReviewNote(current, noteId));
    },
    [updateCommandState],
  );

  const setAgentNotesVisible = useCallback(
    (visible: boolean) => {
      updateCommandState((current) => setReviewAgentNotesVisible(current, visible));
    },
    [updateCommandState],
  );

  const toggleAgentNotes = useCallback(() => {
    updateCommandState((current) => setReviewAgentNotesVisible(current, !current.showAgentNotes));
  }, [updateCommandState]);

  const sessionSnapshot = useMemo(
    () =>
      buildReviewSessionSnapshot({
        files,
        state: commandState,
        now: new Date().toISOString(),
      }),
    [files, commandState],
  );
  const {
    liveCommentCount,
    liveComments: liveCommentSummaries,
    reviewNoteCount = 0,
    reviewNotes: reviewNoteSummaries = [],
  } = sessionSnapshot.state;

  return {
    allFiles,
    draftNote,
    filter,
    liveCommentCount,
    liveCommentSummaries,
    liveCommentsByFileId,
    reviewNoteCount,
    reviewNoteSummaries,
    sessionSnapshot,
    showAgentNotes,
    userNotesByFileId,
    scrollToNote,
    selectedFile,
    selectedFileId,
    selectedFileTopAlignRequestId,
    selectedHunkRevealRequestId,
    selectedHunk,
    selectedHunkIndex,
    sidebarEntries,
    visibleFiles,
    addLiveComment,
    addLiveCommentBatch,
    clearFilter,
    cancelDraftNote,
    clearLiveComments,
    moveToAnnotatedFile,
    moveToAnnotatedHunk,
    moveToFile,
    moveToHunk,
    navigateToLocation,
    removeLiveComment,
    removeUserNote,
    saveDraftNote,
    selectFile,
    selectHunk,
    startUserNote,
    setAgentNotesVisible,
    setFilter,
    toggleAgentNotes,
    updateDraftNote,
  };
}
