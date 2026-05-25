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
  firstCommentTargetForHunk,
  resolveCommentTarget,
} from "../../core/liveComments";
import { SourceTextTooLargeError } from "../../core/fileSource";
import type { AgentAnnotation, DiffFile, UserNoteLineTarget } from "../../core/types";
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
  SessionReviewNoteSummary,
} from "../../hunk-session/types";
import type { FileSourceStatus } from "../diff/expandCollapsedRows";
import { selectGapForKeyboardToggle } from "../diff/expandCollapsedRows";
import { trailingCollapsedLines } from "../diff/pierre";
import { findNextHunkCursor } from "../lib/hunks";
import { reviewNoteSource } from "../lib/agentAnnotations";
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

/** Merge file-id keyed annotation maps without losing their concrete item types. */
function mergeAnnotationMaps<T extends AgentAnnotation, U extends AgentAnnotation>(
  first: Record<string, T[]>,
  second: Record<string, U[]>,
): Record<string, Array<T | U>> {
  const next: Record<string, Array<T | U>> = {};
  for (const [fileId, annotations] of Object.entries(first)) {
    next[fileId] = [...annotations];
  }
  for (const [fileId, annotations] of Object.entries(second)) {
    next[fileId] = [...(next[fileId] ?? []), ...annotations];
  }
  return next;
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

export interface UserReviewNote extends AgentAnnotation {
  id: string;
  source: "user";
  filePath: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  summary: string;
  author: string;
  createdAt: string;
  editable: true;
}

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
  draftNote: DraftReviewNote | null;
  liveCommentCount: number;
  liveCommentSummaries: SessionLiveCommentSummary[];
  liveCommentsByFileId: Record<string, LiveComment[]>;
  reviewNoteCount: number;
  reviewNoteSummaries: SessionReviewNoteSummary[];
  userNotesByFileId: Record<string, UserReviewNote[]>;
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
  cancelDraftNote: () => void;
  removeUserNote: (noteId: string) => void;
  saveDraftNote: () => UserReviewNote | null;
  selectFile: (fileId: string, nextHunkIndex?: number, options?: ReviewSelectionOptions) => void;
  selectHunk: (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => void;
  startUserNote: (
    fileId?: string,
    hunkIndex?: number,
    target?: UserNoteLineTarget,
  ) => DraftReviewNote | null;
  setFilter: (value: string) => void;
  updateDraftNote: (body: string) => void;
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
  const [userNotesByFileId, setUserNotesByFileId] = useState<Record<string, UserReviewNote[]>>({});
  const [draftNote, setDraftNote] = useState<DraftReviewNote | null>(null);
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
        liveCommentsByFileId: mergeAnnotationMaps(liveCommentsByFileId, userNotesByFileId),
        filterQuery: deferredFilter,
        selectedFileId,
        selectedHunkIndex,
      }),
    [
      deferredFilter,
      files,
      liveCommentsByFileId,
      selectedFileId,
      selectedHunkIndex,
      userNotesByFileId,
    ],
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

      const nextIndex = clamp(currentIndex + delta, 0, visibleFiles.length - 1);
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
        if (!isCurrentRequest()) {
          return;
        }

        sourceLoadRequestsRef.current.delete(fileId);
        sourceStatusRef.current = { ...sourceStatusRef.current, [fileId]: nextStatus };
        setSourceStatusByFileId((prev) => ({
          ...prev,
          [fileId]: nextStatus,
        }));
      };

      void file.sourceFetcher
        .getFullText(side)
        .then((text) => {
          setSettledStatus(text === null ? { kind: "error" } : { kind: "loaded", text });
        })
        .catch((error: unknown) => {
          if (!isCurrentRequest()) {
            console.error(
              `hunk: ignored stale ${side} source load failure for ${file.path} (${file.id}).`,
              error,
            );
            return;
          }

          const reason = error instanceof SourceTextTooLargeError ? "too-large" : undefined;
          if (reason !== "too-large") {
            console.error(
              `hunk: failed to load ${side} source for ${file.path} (${file.id}).`,
              error,
            );
          }
          setSettledStatus({
            kind: "error",
            reason,
          });
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
  const saveDraftNote = useCallback((): UserReviewNote | null => {
    if (!draftNote) {
      return null;
    }

    const body = draftNote.body.trim();
    if (!body) {
      setDraftNote(null);
      return null;
    }

    const savedNote: UserReviewNote = {
      id: `user:${Date.now()}`,
      source: "user",
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

    setUserNotesByFileId((notesByFile) => ({
      ...notesByFile,
      [draftNote.fileId]: [...(notesByFile[draftNote.fileId] ?? []), savedNote],
    }));
    setDraftNote(null);
    return savedNote;
  }, [draftNote]);

  /** Remove one in-memory user note by id. */
  const removeUserNote = useCallback(
    (noteId: string) => {
      let removed = false;
      const next: Record<string, UserReviewNote[]> = {};

      for (const [fileId, notes] of Object.entries(userNotesByFileId)) {
        const filtered = notes.filter((note) => note.id !== noteId);
        if (filtered.length !== notes.length) {
          removed = true;
        }
        if (filtered.length > 0) {
          next[fileId] = filtered;
        }
      }

      if (!removed) {
        throw new Error(`No user note matches id ${noteId}.`);
      }

      setUserNotesByFileId(next);
    },
    [userNotesByFileId],
  );

  /** Count all currently tracked live comments, including ones hidden by the active filter. */
  const liveCommentCount = useMemo(
    () => Object.values(liveCommentsByFileId).reduce((sum, comments) => sum + comments.length, 0),
    [liveCommentsByFileId],
  );

  /** Format current inline notes for daemon snapshots without exposing UI-only objects. */
  const reviewNoteSummaries = useMemo<SessionReviewNoteSummary[]>(() => {
    const noteSummaries: SessionReviewNoteSummary[] = [];

    files.forEach((file) => {
      (file.agent?.annotations ?? []).forEach((annotation, index) => {
        const source = reviewNoteSource(annotation);
        noteSummaries.push({
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

      (liveCommentsByFileId[file.id] ?? []).forEach((comment) => {
        noteSummaries.push({
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

      (userNotesByFileId[file.id] ?? []).forEach((note) => {
        noteSummaries.push({
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

    return noteSummaries;
  }, [files, liveCommentsByFileId, userNotesByFileId]);

  /** Count all currently tracked review notes, including AI, agent, and user notes. */
  const reviewNoteCount = reviewNoteSummaries.length;

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
    draftNote,
    expandedGapsByFileId,
    filter,
    liveCommentCount,
    liveCommentSummaries,
    liveCommentsByFileId,
    reviewNoteCount,
    reviewNoteSummaries,
    userNotesByFileId,
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
    setFilter,
    updateDraftNote,
  };
}
