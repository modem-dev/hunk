import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  buildLiveComment,
  findDiffFileByPath,
  findHunkIndexForLine,
} from "../../core/liveComments";
import type { DiffFile } from "../../core/types";
import type {
  AppliedCommentResult,
  ClearedCommentsResult,
  CommentToolInput,
  LiveComment,
  NavigateToHunkToolInput,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SessionLiveCommentSummary,
} from "../../mcp/types";
import { findNextHunkCursor } from "../lib/hunks";
import {
  buildReviewModel,
  buildSelectedHunkSummary,
  findNextAnnotatedFile,
  type ReviewModel,
  resolveReviewNavigationTarget,
} from "../lib/reviewModel";

/** Clamp one numeric index into an inclusive range. */
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export interface ReviewSelectionOptions {
  alignFileHeaderTop?: boolean;
  scrollToNote?: boolean;
}

export interface ReviewController {
  allFiles: DiffFile[];
  filter: string;
  liveCommentCount: number;
  liveCommentSummaries: SessionLiveCommentSummary[];
  liveCommentsByFileId: Record<string, LiveComment[]>;
  moveToAnnotatedFile: (delta: number) => void;
  moveToAnnotatedHunk: (delta: number) => void;
  moveToHunk: (delta: number) => void;
  scrollToNote: boolean;
  selectedFile: DiffFile | undefined;
  selectedFileId: string;
  selectedFileTopAlignRequestId: number;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  selectedHunkIndex: number;
  sidebarEntries: ReviewModel["sidebarEntries"];
  visibleFiles: DiffFile[];
  addLiveComment: (
    input: CommentToolInput,
    commentId: string,
    options?: { reveal?: boolean },
  ) => AppliedCommentResult;
  clearFilter: () => void;
  clearLiveComments: (filePath?: string) => ClearedCommentsResult;
  navigateToLocation: (input: NavigateToHunkToolInput) => NavigatedSelectionResult;
  removeLiveComment: (commentId: string) => RemovedCommentResult;
  selectFile: (fileId: string, nextHunkIndex?: number, options?: ReviewSelectionOptions) => void;
  selectHunk: (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => void;
  setFilter: (value: string) => void;
}

/** Own the shared review stream state used by both the UI and MCP bridge. */
export function useReviewController({ files }: { files: DiffFile[] }): ReviewController {
  const [filter, setFilter] = useState("");
  const [selectedFileId, setSelectedFileId] = useState(files[0]?.id ?? "");
  const [selectedHunkIndex, setSelectedHunkIndex] = useState(0);
  const [selectedFileTopAlignRequestId, setSelectedFileTopAlignRequestId] = useState(0);
  const [scrollToNote, setScrollToNote] = useState(false);
  const [liveCommentsByFileId, setLiveCommentsByFileId] = useState<Record<string, LiveComment[]>>(
    {},
  );
  const deferredFilter = useDeferredValue(filter);

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
      buildReviewModel({
        files,
        liveCommentsByFileId,
        filterQuery: deferredFilter,
        selectedFileId,
        selectedHunkIndex,
      }),
    [deferredFilter, files, liveCommentsByFileId, selectedFileId, selectedHunkIndex],
  );

  /** Update the selection and reveal intent together so diff scrolling stays explicit. */
  const selectHunk = useCallback(
    (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => {
      setSelectedFileId(fileId);
      setSelectedHunkIndex(hunkIndex);
      setScrollToNote(Boolean(options?.scrollToNote));

      if (options?.alignFileHeaderTop) {
        setSelectedFileTopAlignRequestId((current) => current + 1);
      }
    },
    [],
  );

  /** Select one file and optionally one specific hunk within it. */
  const selectFile = useCallback(
    (fileId: string, nextHunkIndex = 0, options?: ReviewSelectionOptions) => {
      selectHunk(fileId, nextHunkIndex, options);
    },
    [selectHunk],
  );

  useEffect(() => {
    if (visibleFiles.length === 0) {
      return;
    }

    if (!selectedFileId || !allFiles.some((file) => file.id === selectedFileId)) {
      startTransition(() => {
        setSelectedFileId(visibleFiles[0]!.id);
        setSelectedHunkIndex(0);
      });
      return;
    }

    if (selectedFile && !visibleFiles.some((file) => file.id === selectedFile.id)) {
      startTransition(() => {
        setSelectedFileId(visibleFiles[0]!.id);
        setSelectedHunkIndex(0);
      });
    }
  }, [allFiles, selectedFile, selectedFileId, visibleFiles]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }

    const maxIndex = Math.max(0, selectedFile.metadata.hunks.length - 1);
    setSelectedHunkIndex((current) => clamp(current, 0, maxIndex));
  }, [selectedFile]);

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

      selectHunk(nextCursor.fileId, nextCursor.hunkIndex, {
        alignFileHeaderTop: nextCursor.fileId !== selectedFile?.id,
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
      );
      if (!nextCursor) {
        return;
      }

      selectHunk(nextCursor.fileId, nextCursor.hunkIndex, { scrollToNote: true });
    },
    [annotatedHunkCursors, selectHunk, selectedFile?.id, selectedHunkIndex],
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

  /** Clear the active file filter without touching the current selection. */
  const clearFilter = useCallback(() => {
    setFilter("");
  }, []);

  /** Resolve one MCP navigation request against the current review state and select it. */
  const navigateToLocation = useCallback(
    (input: NavigateToHunkToolInput): NavigatedSelectionResult => {
      const target = resolveReviewNavigationTarget({
        allFiles,
        currentFileId: selectedFile?.id,
        currentHunkIndex: selectedHunkIndex,
        input,
        visibleFiles,
      });

      selectHunk(target.file.id, target.hunkIndex, { scrollToNote: target.scrollToNote });
      return {
        fileId: target.file.id,
        filePath: target.file.path,
        hunkIndex: target.hunkIndex,
        selectedHunk: buildSelectedHunkSummary(target.file, target.hunkIndex),
      };
    },
    [allFiles, selectHunk, selectedFile?.id, selectedHunkIndex, visibleFiles],
  );

  /** Add one live comment, optionally revealing its hunk in the active review. */
  const addLiveComment = useCallback(
    (
      input: CommentToolInput,
      commentId: string,
      options?: { reveal?: boolean },
    ): AppliedCommentResult => {
      const file = findDiffFileByPath(allFiles, input.filePath);
      if (!file) {
        throw new Error(`No visible diff file matches ${input.filePath}.`);
      }

      const hunkIndex = findHunkIndexForLine(file, input.side, input.line);
      if (hunkIndex < 0) {
        throw new Error(
          `No ${input.side} diff hunk in ${input.filePath} covers line ${input.line}.`,
        );
      }

      const liveComment = buildLiveComment(input, commentId, new Date().toISOString(), hunkIndex);
      setLiveCommentsByFileId((current) => ({
        ...current,
        [file.id]: [...(current[file.id] ?? []), liveComment],
      }));

      if (options?.reveal ?? false) {
        selectHunk(file.id, hunkIndex);
      }

      return {
        commentId,
        fileId: file.id,
        filePath: file.path,
        hunkIndex,
        side: input.side,
        line: input.line,
      };
    },
    [allFiles, selectHunk],
  );

  /** Remove one live comment by id and report how many remain. */
  const removeLiveComment = useCallback(
    (commentId: string): RemovedCommentResult => {
      let removed = false;
      let remainingCommentCount = 0;
      const next: Record<string, LiveComment[]> = {};

      for (const [fileId, comments] of Object.entries(liveCommentsByFileId)) {
        const filtered = comments.filter((comment) => comment.id !== commentId);
        if (filtered.length !== comments.length) {
          removed = true;
        }

        if (filtered.length > 0) {
          next[fileId] = filtered;
          remainingCommentCount += filtered.length;
        }
      }

      if (!removed) {
        throw new Error(`No live comment matches id ${commentId}.`);
      }

      setLiveCommentsByFileId(next);
      return {
        commentId,
        removed: true,
        remainingCommentCount,
      };
    },
    [liveCommentsByFileId],
  );

  /** Clear all live comments, or only the comments attached to one specific file. */
  const clearLiveComments = useCallback(
    (filePath?: string): ClearedCommentsResult => {
      let removedCount = 0;
      let remainingCommentCount = 0;

      if (filePath) {
        const file = findDiffFileByPath(allFiles, filePath);
        if (!file) {
          throw new Error(`No visible diff file matches ${filePath}.`);
        }

        const next: Record<string, LiveComment[]> = {};
        for (const [fileId, comments] of Object.entries(liveCommentsByFileId)) {
          if (fileId === file.id) {
            removedCount = comments.length;
            continue;
          }

          next[fileId] = comments;
          remainingCommentCount += comments.length;
        }

        if (removedCount > 0) {
          setLiveCommentsByFileId(next);
        }
      } else {
        removedCount = Object.values(liveCommentsByFileId).reduce(
          (sum, comments) => sum + comments.length,
          0,
        );
        if (removedCount > 0) {
          setLiveCommentsByFileId({});
        }
      }

      return {
        removedCount,
        remainingCommentCount,
        filePath,
      };
    },
    [allFiles, liveCommentsByFileId],
  );

  /** Count all currently tracked live comments, including ones hidden by the active filter. */
  const liveCommentCount = useMemo(
    () => Object.values(liveCommentsByFileId).reduce((sum, comments) => sum + comments.length, 0),
    [liveCommentsByFileId],
  );

  /** Format current live comments for daemon snapshots without exposing merged UI-only objects. */
  const liveCommentSummaries = useMemo<SessionLiveCommentSummary[]>(
    () =>
      allFiles.flatMap((file) =>
        (liveCommentsByFileId[file.id] ?? []).map((comment) => ({
          commentId: comment.id,
          filePath: file.path,
          hunkIndex: comment.hunkIndex,
          side: comment.side,
          line: comment.line,
          summary: comment.summary,
          rationale: comment.rationale,
          author: comment.author,
          createdAt: comment.createdAt,
        })),
      ),
    [allFiles, liveCommentsByFileId],
  );

  return {
    allFiles,
    filter,
    liveCommentCount,
    liveCommentSummaries,
    liveCommentsByFileId,
    scrollToNote,
    selectedFile,
    selectedFileId,
    selectedFileTopAlignRequestId,
    selectedHunk,
    selectedHunkIndex,
    sidebarEntries,
    visibleFiles,
    addLiveComment,
    clearFilter,
    clearLiveComments,
    moveToAnnotatedFile,
    moveToAnnotatedHunk,
    moveToHunk,
    navigateToLocation,
    removeLiveComment,
    selectFile,
    selectHunk,
    setFilter,
  };
}
