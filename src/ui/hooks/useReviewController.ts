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
  findDiffFileByPath,
  resolveCommentTarget,
} from "../../core/liveComments";
import type { DiffFile } from "../../core/types";
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
import type { FileSourceStatus } from "../diff/expandCollapsedRows";
import { selectGapForKeyboardToggle } from "../diff/expandCollapsedRows";
import { trailingCollapsedLines } from "../diff/pierre";
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

/** Return a new record with the given keys omitted, or the original when nothing changed. */
function removeKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      changed = true;
    } else {
      next[key] = value;
    }
  }
  return changed ? next : record;
}

interface SourceLoadRequest {
  fetcher: NonNullable<DiffFile["sourceFetcher"]>;
  requestId: number;
  side: "old" | "new";
}

export interface ReviewSelectionOptions {
  alignFileHeaderTop?: boolean;
  preserveViewport?: boolean;
  scrollToNote?: boolean;
}

export interface ReviewController {
  allFiles: DiffFile[];
  expandedGapsByFileId: Record<string, ReadonlySet<string>>;
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
  sourceStatusByFileId: Record<string, FileSourceStatus>;
  toggleGap: (fileId: string, gapKey: string) => void;
  toggleSelectedHunkGap: () => void;
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
  selectFile: (fileId: string, nextHunkIndex?: number, options?: ReviewSelectionOptions) => void;
  selectHunk: (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => void;
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
  const [expandedGapsByFileId, setExpandedGapsByFileId] = useState<
    Record<string, ReadonlySet<string>>
  >({});
  const [sourceStatusByFileId, setSourceStatusByFileId] = useState<
    Record<string, FileSourceStatus>
  >({});
  // Mirror sourceStatusByFileId so toggleGap can dedup synchronously without
  // waiting for React's state updater to commit.
  const sourceStatusRef = useRef(sourceStatusByFileId);
  sourceStatusRef.current = sourceStatusByFileId;
  const sourceLoadRequestsRef = useRef(new Map<string, SourceLoadRequest>());
  const nextSourceLoadRequestIdRef = useRef(1);

  // Track the files array we last reconciled against so we can invalidate
  // expansion state when a soft reload replaces a file's sourceFetcher.
  // Without this, the same file id could outlive a reload while its
  // cached `loaded` source text refers to the previous patch, and toggleGap
  // would short-circuit on stale state instead of re-fetching.
  const [filesSnapshot, setFilesSnapshot] = useState(files);
  if (filesSnapshot !== files) {
    setFilesSnapshot(files);
    const currentFetcherByFileId = new Map<string, DiffFile["sourceFetcher"]>();
    for (const file of files) {
      currentFetcherByFileId.set(file.id, file.sourceFetcher);
    }
    const staleFileIds = new Set<string>();
    for (const previousFile of filesSnapshot) {
      const currentFetcher = currentFetcherByFileId.get(previousFile.id);
      // Either the file was removed, or its fetcher (and thus its patch)
      // was replaced. Both invalidate any state keyed by file id.
      if (currentFetcher !== previousFile.sourceFetcher) {
        staleFileIds.add(previousFile.id);
      }
    }
    if (staleFileIds.size > 0) {
      for (const fileId of staleFileIds) {
        sourceLoadRequestsRef.current.delete(fileId);
      }
      setSourceStatusByFileId((prev) => removeKeys(prev, staleFileIds));
      setExpandedGapsByFileId((prev) => removeKeys(prev, staleFileIds));
    }
  }

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

  /** Toggle expansion of one collapsed gap and lazily load source when needed. */
  const toggleGap = useCallback(
    (fileId: string, gapKey: string) => {
      const file = allFiles.find((entry) => entry.id === fileId);
      if (!file?.sourceFetcher) {
        return;
      }

      setExpandedGapsByFileId((prev) => {
        const current = prev[fileId];
        const next = new Set(current ?? []);
        if (next.has(gapKey)) {
          next.delete(gapKey);
        } else {
          next.add(gapKey);
        }
        return { ...prev, [fileId]: next };
      });

      // The fetcher caches its own resolved text; we mirror it into React state
      // as a tagged status so the UI can distinguish loading, loaded, and error
      // states. Skip the fetch when one is already in flight or has resolved
      // to avoid redundant work and stale "loading" flicker.
      const currentStatus = sourceStatusRef.current[fileId]?.kind;
      if (currentStatus === "loaded" || currentStatus === "loading") {
        return;
      }

      const side = file.metadata.type === "deleted" ? "old" : "new";
      const request = {
        fetcher: file.sourceFetcher,
        requestId: nextSourceLoadRequestIdRef.current,
        side,
      } satisfies SourceLoadRequest;
      nextSourceLoadRequestIdRef.current += 1;
      sourceLoadRequestsRef.current.set(fileId, request);

      const loadingStatus = { kind: "loading" } satisfies FileSourceStatus;
      sourceStatusRef.current = { ...sourceStatusRef.current, [fileId]: loadingStatus };
      setSourceStatusByFileId((prev) => ({ ...prev, [fileId]: loadingStatus }));

      const isCurrentRequest = () => {
        const current = sourceLoadRequestsRef.current.get(fileId);
        return (
          current?.requestId === request.requestId &&
          current.fetcher === request.fetcher &&
          current.side === request.side
        );
      };

      const setSettledStatus = (nextStatus: FileSourceStatus) => {
        setSourceStatusByFileId((prev) => {
          if (!isCurrentRequest()) {
            return prev;
          }
          sourceLoadRequestsRef.current.delete(fileId);
          sourceStatusRef.current = { ...sourceStatusRef.current, [fileId]: nextStatus };
          return {
            ...prev,
            [fileId]: nextStatus,
          };
        });
      };

      void file.sourceFetcher
        .getFullText(side)
        .then((text) => {
          setSettledStatus(text === null ? { kind: "error" } : { kind: "loaded", text });
        })
        .catch((error: unknown) => {
          if (!isCurrentRequest()) {
            return;
          }

          console.error(
            `hunk: failed to load ${side} source for ${file.path} (${file.id}).`,
            error,
          );
          setSettledStatus({ kind: "error" });
        });
    },
    [allFiles],
  );

  /** Toggle the collapsed gap nearest to the current hunk selection. */
  const toggleSelectedHunkGap = useCallback(() => {
    const file = selectedFile;
    if (!file?.sourceFetcher) {
      return;
    }

    const target = selectGapForKeyboardToggle(
      file.metadata.hunks,
      selectedHunkIndex,
      trailingCollapsedLines(file.metadata) > 0,
    );
    if (target) {
      toggleGap(file.id, target);
    }
  }, [selectedFile, selectedHunkIndex, toggleGap]);

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
    expandedGapsByFileId,
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
    sourceStatusByFileId,
    toggleGap,
    toggleSelectedHunkGap,
    visibleFiles,
    addLiveComment,
    addLiveCommentBatch,
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
