/**
 * Shared review-stream state for both the app shell and the session bridge.
 *
 * This hook owns the live review state that both callers need to agree on:
 * filtering, merged live comments, selected file and hunk, and relative review
 * navigation. `App` uses it for rendering and keyboard or menu actions, while
 * the session bridge uses the same state and actions for daemon-driven navigation.
 */
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildLiveComment,
  buildUserLiveComment,
  findDiffFileByPath,
  resolveCommentTarget,
} from "../../core/liveComments";
import type { DiffFile } from "../../core/types";
import {
  cursorRowStableKey,
  firstCursorTargetForHunk,
  moveCursor,
  type CommentCursorPosition,
} from "../lib/commentCursor";
import type { DiffSide } from "../../hunk-session/types";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  CommentBatchItemInput,
  CommentToolInput,
  LiveComment,
  NavigateToHunkToolInput,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SessionLiveCommentSummary,
} from "../../hunk-session/types";
import { findNextHunkCursor } from "../lib/hunks";
import {
  buildReviewState,
  buildSelectedHunkSummary,
  findNextAnnotatedFile,
  type ReviewState,
  resolveReviewNavigationTarget,
} from "../lib/reviewState";

/** Clamp one numeric index into an inclusive range. */
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export type CommentCursorMode = "off" | "navigating" | "composing";

export interface CommentCursorState extends CommentCursorPosition {
  mode: CommentCursorMode;
}

export interface AddUserLiveCommentTarget {
  fileId: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
  author?: string;
}

export interface ReviewSelectionOptions {
  alignFileHeaderTop?: boolean;
  preserveViewport?: boolean;
  scrollToNote?: boolean;
}

export interface ReviewController {
  allFiles: DiffFile[];
  commentCursor: CommentCursorState;
  commentCursorRowStableKey: string | null;
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
  addUserLiveComment: (target: AddUserLiveCommentTarget, summary: string) => AppliedCommentResult;
  clearFilter: () => void;
  clearLiveComments: (filePath?: string) => ClearedCommentsResult;
  jumpCommentCursorToHunk: (delta: number) => void;
  moveCommentCursor: (delta: number) => void;
  navigateToLocation: (input: NavigateToHunkToolInput) => NavigatedSelectionResult;
  removeLiveComment: (commentId: string) => RemovedCommentResult;
  selectFile: (fileId: string, nextHunkIndex?: number, options?: ReviewSelectionOptions) => void;
  selectHunk: (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => void;
  setCommentCursorMode: (mode: CommentCursorMode) => void;
  setFilter: (value: string) => void;
}

/** Own the shared review stream state used by both the UI and session bridge. */
export function useReviewController({ files }: { files: DiffFile[] }): ReviewController {
  const [filter, setFilter] = useState("");
  const [selectedFileId, setSelectedFileId] = useState(files[0]?.id ?? "");
  const [selectedHunkIndex, setSelectedHunkIndex] = useState(0);
  const [selectedFileTopAlignRequestId, setSelectedFileTopAlignRequestId] = useState(0);
  const [selectedHunkRevealRequestId, setSelectedHunkRevealRequestId] = useState(0);
  const [scrollToNote, setScrollToNote] = useState(false);
  const [liveCommentsByFileId, setLiveCommentsByFileId] = useState<Record<string, LiveComment[]>>(
    {},
  );
  const [commentCursor, setCommentCursor] = useState<CommentCursorState>(() => ({
    mode: "off",
    fileId: files[0]?.id ?? "",
    hunkIndex: 0,
    side: "new",
    line: files[0]?.metadata.hunks[0]
      ? firstCursorTargetForHunk(files[0], 0).line
      : 1,
  }));
  const userCommentCounterRef = useRef(0);
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
      buildReviewState({
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
        return;
      }

      if (!options?.preserveViewport) {
        setSelectedHunkRevealRequestId((current) => current + 1);
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

  /** Reset selection to the first visible file when the current target disappears from the review stream. */
  const reselectFirstVisibleFile = useCallback(() => {
    startTransition(() => {
      setSelectedFileId(visibleFiles[0]!.id);
      setSelectedHunkIndex(0);
    });
  }, [visibleFiles]);

  /** Keep the selected file anchored to the current visible review stream as filters and reloads change it. */
  const reconcileSelectedFile = useCallback(() => {
    if (visibleFiles.length === 0) {
      return;
    }

    if (!selectedFileId || !allFiles.some((file) => file.id === selectedFileId)) {
      reselectFirstVisibleFile();
      return;
    }

    if (selectedFile && !visibleFiles.some((file) => file.id === selectedFile.id)) {
      reselectFirstVisibleFile();
    }
  }, [allFiles, reselectFirstVisibleFile, selectedFile, selectedFileId, visibleFiles]);

  /** Clamp the selected hunk index after reloads or filter changes shrink the selected file's hunk list. */
  const reconcileSelectedHunkIndex = useCallback(() => {
    if (!selectedFile) {
      return;
    }

    const maxIndex = Math.max(0, selectedFile.metadata.hunks.length - 1);
    setSelectedHunkIndex((current) => clamp(current, 0, maxIndex));
  }, [selectedFile]);

  useEffect(() => {
    reconcileSelectedFile();
  }, [reconcileSelectedFile]);

  useEffect(() => {
    reconcileSelectedHunkIndex();
  }, [reconcileSelectedHunkIndex]);

  /** Fall back the cursor to the first visible hunk when its target file or hunk disappears. */
  useEffect(() => {
    setCommentCursor((current) => {
      if (current.mode === "off") {
        return current;
      }

      const file = visibleFiles.find((entry) => entry.id === current.fileId);
      if (file && current.hunkIndex < file.metadata.hunks.length) {
        return current;
      }

      const fallbackFile = visibleFiles[0];
      if (!fallbackFile || fallbackFile.metadata.hunks.length === 0) {
        return { ...current, mode: "off" };
      }

      const anchor = firstCursorTargetForHunk(fallbackFile, 0);
      return {
        mode: current.mode,
        fileId: fallbackFile.id,
        hunkIndex: 0,
        side: anchor.side,
        line: anchor.line,
      };
    });
  }, [visibleFiles]);

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

  /** Resolve one session-daemon navigation request against the current review state and select it. */
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
        throw new Error(`No diff file matches ${input.filePath}.`);
      }

      const target = resolveCommentTarget(file, input);

      const liveComment = buildLiveComment(
        {
          ...input,
          side: target.side,
          line: target.line,
        },
        commentId,
        new Date().toISOString(),
        target.hunkIndex,
      );
      setLiveCommentsByFileId((current) => ({
        ...current,
        [file.id]: [...(current[file.id] ?? []), liveComment],
      }));

      if (options?.reveal ?? false) {
        selectHunk(file.id, target.hunkIndex);
      }

      return {
        commentId,
        fileId: file.id,
        filePath: file.path,
        hunkIndex: target.hunkIndex,
        side: target.side,
        line: target.line,
      };
    },
    [allFiles, selectHunk],
  );

  /** Apply several live comments together after validating every target first. */
  const addLiveCommentBatch = useCallback(
    (
      inputs: CommentBatchItemInput[],
      requestId: string,
      options?: { revealMode?: "none" | "first" },
    ): AppliedCommentBatchResult => {
      const createdAt = new Date().toISOString();
      const prepared = inputs.map((input, index) => {
        const file = findDiffFileByPath(allFiles, input.filePath);
        if (!file) {
          throw new Error(`No diff file matches ${input.filePath}.`);
        }

        const target = resolveCommentTarget(file, input);
        return {
          file,
          target,
          liveComment: buildLiveComment(
            {
              ...input,
              side: target.side,
              line: target.line,
            },
            `mcp:${requestId}:${index}`,
            createdAt,
            target.hunkIndex,
          ),
        };
      });

      if (prepared.length > 0) {
        setLiveCommentsByFileId((current) => {
          const next = { ...current };
          for (const entry of prepared) {
            next[entry.file.id] = [...(next[entry.file.id] ?? []), entry.liveComment];
          }

          return next;
        });
      }

      if (options?.revealMode === "first" && prepared.length > 0) {
        const first = prepared[0]!;
        selectHunk(first.file.id, first.target.hunkIndex);
      }

      return {
        applied: prepared.map(({ file, target, liveComment }) => ({
          commentId: liveComment.id,
          fileId: file.id,
          filePath: file.path,
          hunkIndex: target.hunkIndex,
          side: target.side,
          line: target.line,
        })),
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
          throw new Error(`No diff file matches ${filePath}.`);
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

  /** Enter, switch, or leave the cursor mode. Seeds position from the selected hunk on enter. */
  const setCommentCursorMode = useCallback(
    (mode: CommentCursorMode) => {
      setCommentCursor((current) => {
        if (mode === "off") {
          return { ...current, mode };
        }

        if (current.mode !== "off") {
          return { ...current, mode };
        }

        const file = visibleFiles.find((entry) => entry.id === selectedFileId) ?? visibleFiles[0];
        if (!file || file.metadata.hunks.length === 0) {
          return { ...current, mode };
        }

        const hunkIndex = Math.max(
          0,
          Math.min(selectedHunkIndex, file.metadata.hunks.length - 1),
        );
        const anchor = firstCursorTargetForHunk(file, hunkIndex);
        return {
          mode,
          fileId: file.id,
          hunkIndex,
          side: anchor.side,
          line: anchor.line,
        };
      });
    },
    [selectedFileId, selectedHunkIndex, visibleFiles],
  );

  /** Walk the cursor row-by-row through the review stream. */
  const moveCommentCursor = useCallback(
    (delta: number) => {
      setCommentCursor((current) => {
        if (current.mode === "off") {
          return current;
        }

        const next = moveCursor(visibleFiles, current, delta);
        if (!next) {
          return current;
        }

        return { ...current, ...next };
      });
    },
    [visibleFiles],
  );

  /** Jump the cursor to the first content row of the previous or next hunk. */
  const jumpCommentCursorToHunk = useCallback(
    (delta: number) => {
      setCommentCursor((current) => {
        if (current.mode === "off") {
          return current;
        }

        const fileIndex = visibleFiles.findIndex((file) => file.id === current.fileId);
        if (fileIndex < 0) {
          return current;
        }

        let nextFileIndex = fileIndex;
        let nextHunkIndex = current.hunkIndex + delta;

        while (true) {
          const file = visibleFiles[nextFileIndex];
          if (!file) {
            return current;
          }

          if (nextHunkIndex >= 0 && nextHunkIndex < file.metadata.hunks.length) {
            const anchor = firstCursorTargetForHunk(file, nextHunkIndex);
            return {
              ...current,
              fileId: file.id,
              hunkIndex: nextHunkIndex,
              side: anchor.side,
              line: anchor.line,
            };
          }

          if (delta > 0) {
            nextFileIndex += 1;
            nextHunkIndex = 0;
          } else {
            nextFileIndex -= 1;
            const previous = visibleFiles[nextFileIndex];
            if (!previous) {
              return current;
            }
            nextHunkIndex = previous.metadata.hunks.length - 1;
          }
        }
      });
    },
    [visibleFiles],
  );

  /** Persist one user-authored comment using the same store as MCP comments. */
  const addUserLiveComment = useCallback(
    (target: AddUserLiveCommentTarget, summary: string): AppliedCommentResult => {
      const file = allFiles.find((entry) => entry.id === target.fileId);
      if (!file) {
        throw new Error(`No diff file matches ${target.fileId}.`);
      }

      const trimmed = summary.trim();
      if (!trimmed) {
        throw new Error("User comments must have a non-empty summary.");
      }

      userCommentCounterRef.current += 1;
      const commentId = `user:${Date.now()}-${userCommentCounterRef.current}`;
      const liveComment = buildUserLiveComment(
        {
          filePath: file.path,
          side: target.side,
          line: target.line,
          summary: trimmed,
          author: target.author,
        },
        commentId,
        new Date().toISOString(),
        target.hunkIndex,
      );

      setLiveCommentsByFileId((current) => ({
        ...current,
        [file.id]: [...(current[file.id] ?? []), liveComment],
      }));

      return {
        commentId,
        fileId: file.id,
        filePath: file.path,
        hunkIndex: target.hunkIndex,
        side: target.side,
        line: target.line,
      };
    },
    [allFiles],
  );

  const commentCursorRowStableKey =
    commentCursor.mode === "off" ? null : cursorRowStableKey(commentCursor);

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
    commentCursor,
    commentCursorRowStableKey,
    filter,
    liveCommentCount,
    liveCommentSummaries,
    liveCommentsByFileId,
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
    addUserLiveComment,
    clearFilter,
    clearLiveComments,
    jumpCommentCursorToHunk,
    moveCommentCursor,
    moveToAnnotatedFile,
    moveToAnnotatedHunk,
    moveToHunk,
    navigateToLocation,
    removeLiveComment,
    selectFile,
    selectHunk,
    setCommentCursorMode,
    setFilter,
  };
}
