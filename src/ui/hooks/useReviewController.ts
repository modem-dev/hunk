/**
 * Shared review-stream state for both the app shell and the session bridge.
 *
 * This hook owns the live review state that both callers need to agree on:
 * filtering, merged live comments, selected file and hunk, and relative review
 * navigation. `App` uses it for rendering and keyboard or menu actions, while
 * the session bridge uses the same state and actions for daemon-driven navigation.
 */
import { type Accessor, createEffect, createMemo, createSignal } from "solid-js";
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

/** Count array-backed entries in a file-id keyed note map. */
function countFileMapItems<T>(record: Record<string, T[]>) {
  return Object.values(record).reduce((sum, items) => sum + items.length, 0);
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
  allFiles: Accessor<DiffFile[]>;
  expandedGapsByFileId: Accessor<Record<string, ReadonlySet<string>>>;
  filter: Accessor<string>;
  draftNote: Accessor<DraftReviewNote | null>;
  liveCommentCount: Accessor<number>;
  liveCommentSummaries: Accessor<SessionLiveCommentSummary[]>;
  liveCommentsByFileId: Accessor<Record<string, LiveComment[]>>;
  reviewNoteCount: Accessor<number>;
  reviewNoteSummaries: Accessor<SessionReviewNoteSummary[]>;
  userNotesByFileId: Accessor<Record<string, UserReviewNote[]>>;
  moveToAnnotatedFile: (delta: number) => void;
  moveToAnnotatedHunk: (delta: number) => void;
  moveToFile: (delta: number) => void;
  moveToHunk: (delta: number) => void;
  scrollToNote: Accessor<boolean>;
  selectedFile: Accessor<DiffFile | undefined>;
  selectedFileId: Accessor<string>;
  selectedFileTopAlignRequestId: Accessor<number>;
  selectedHunkRevealRequestId: Accessor<number>;
  selectedHunk: Accessor<DiffFile["metadata"]["hunks"][number] | undefined>;
  selectedHunkIndex: Accessor<number>;
  sidebarEntries: Accessor<ReviewState["sidebarEntries"]>;
  sourceStatusByFileId: Accessor<Record<string, FileSourceStatus>>;
  toggleGap: (fileId: string, gapKey: string) => void;
  toggleSelectedHunkGap: () => void;
  visibleFiles: Accessor<DiffFile[]>;
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
  clearLiveComments: (
    filePath?: string,
    options?: { includeUser?: boolean },
  ) => ClearedCommentsResult;
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
export function useReviewController({ files }: { files: Accessor<DiffFile[]> }): ReviewController {
  const [filter, setFilter] = createSignal("");
  const [selectedFileId, setSelectedFileId] = createSignal(files()[0]?.id ?? "");
  const [selectedHunkIndex, setSelectedHunkIndex] = createSignal(0);
  const [selectedFileTopAlignRequestId, setSelectedFileTopAlignRequestId] = createSignal(0);
  const [selectedHunkRevealRequestId, setSelectedHunkRevealRequestId] = createSignal(0);
  const [scrollToNote, setScrollToNote] = createSignal(false);
  const [liveCommentsByFileId, setLiveCommentsByFileId] = createSignal<
    Record<string, LiveComment[]>
  >({});
  const [userNotesByFileId, setUserNotesByFileId] = createSignal<Record<string, UserReviewNote[]>>(
    {},
  );
  const [draftNote, setDraftNote] = createSignal<DraftReviewNote | null>(null);
  const [expandedGapsByFileId, setExpandedGapsByFileId] = createSignal<
    Record<string, ReadonlySet<string>>
  >({});
  const [sourceStatusByFileId, setSourceStatusByFileId] = createSignal<
    Record<string, FileSourceStatus>
  >({});
  // Mirror sourceStatusByFileId so toggleGap can dedup synchronously without
  // waiting for the signal updater to commit.
  const sourceStatusRef: { current: Record<string, FileSourceStatus> } = {
    current: sourceStatusByFileId(),
  };
  // Keep the synchronous mirror aligned with the committed signal value.
  createEffect(() => {
    sourceStatusRef.current = sourceStatusByFileId();
  });
  const sourceLoadRequestsRef: { current: Map<string, SourceLoadRequest> } = {
    current: new Map<string, SourceLoadRequest>(),
  };
  const nextSourceLoadRequestIdRef: { current: number } = { current: 1 };

  // Track the files array we last reconciled against so we can invalidate
  // expansion state when a soft reload replaces a file's sourceFetcher.
  // Without this, the same file id could outlive a reload while its
  // cached `loaded` source text refers to the previous patch, and toggleGap
  // would short-circuit on stale state instead of re-fetching.
  //
  // React derived this during render; Solid components run once, so the
  // comparison runs in an effect that tracks `files()` and remembers the
  // previously reconciled snapshot in a plain closure variable.
  let filesSnapshot = files();
  createEffect(() => {
    const nextFiles = files();
    if (filesSnapshot === nextFiles) {
      return;
    }
    const previousFiles = filesSnapshot;
    filesSnapshot = nextFiles;
    const currentFetcherByFileId = new Map<string, DiffFile["sourceFetcher"]>();
    for (const file of nextFiles) {
      currentFetcherByFileId.set(file.id, file.sourceFetcher);
    }
    const staleFileIds = new Set<string>();
    for (const previousFile of previousFiles) {
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
  });

  // The filter feeds an expensive review-state recompute. React deferred it via
  // `useDeferredValue` to keep typing responsive; Solid's fine-grained updates
  // recompute only the dependent memo, so we read the filter signal directly
  // here instead of deferring. Behavior change: filter results now update
  // synchronously with each keystroke rather than after a deferred pass.
  const reviewState = createMemo(() =>
    buildReviewState({
      files: files(),
      liveCommentsByFileId: mergeAnnotationMaps(liveCommentsByFileId(), userNotesByFileId()),
      filterQuery: filter(),
      selectedFileId: selectedFileId(),
      selectedHunkIndex: selectedHunkIndex(),
    }),
  );

  // `reviewState` recomputes on every selection change (it reads the selected file/hunk), which
  // hands back fresh array references for these selection-independent lists. Without an equality
  // guard that propagates downstream into expensive consumers (e.g. DiffPane re-measures every
  // file's geometry on each hunk navigation). Compare by element identity so these only notify
  // when the underlying list actually changes (filter edit, reload) — not on navigation.
  const sameFileList = (a: DiffFile[], b: DiffFile[]) =>
    a === b || (a.length === b.length && a.every((file, index) => file === b[index]));
  const allFiles = createMemo(() => reviewState().allFiles, undefined, { equals: sameFileList });
  const visibleFiles = createMemo(() => reviewState().visibleFiles, undefined, {
    equals: sameFileList,
  });
  const sidebarEntries = createMemo(() => reviewState().sidebarEntries);
  const selectedFile = createMemo(() => reviewState().selectedFile);
  const selectedHunk = createMemo(() => reviewState().selectedHunk);
  const hunkCursors = createMemo(() => reviewState().hunkCursors);
  const annotatedHunkCursors = createMemo(() => reviewState().annotatedHunkCursors);

  /** Update the selection and reveal intent together so diff scrolling stays explicit. */
  const selectHunk = (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => {
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
  };

  /** Select one file and optionally one specific hunk within it. */
  const selectFile = (fileId: string, nextHunkIndex = 0, options?: ReviewSelectionOptions) => {
    selectHunk(fileId, nextHunkIndex, options);
  };

  /** Reset selection to the first visible file when the current target disappears from the review stream. */
  const reselectFirstVisibleFile = () => {
    setSelectedFileId(visibleFiles()[0]!.id);
    setSelectedHunkIndex(0);
  };

  /** Keep the selected file anchored to the current visible review stream as filters and reloads change it. */
  const reconcileSelectedFile = () => {
    if (visibleFiles().length === 0) {
      return;
    }

    if (!selectedFileId() || !allFiles().some((file) => file.id === selectedFileId())) {
      reselectFirstVisibleFile();
      return;
    }

    const file = selectedFile();
    if (file && !visibleFiles().some((candidate) => candidate.id === file.id)) {
      reselectFirstVisibleFile();
    }
  };

  /** Clamp the selected hunk index after reloads or filter changes shrink the selected file's hunk list. */
  const reconcileSelectedHunkIndex = () => {
    const file = selectedFile();
    if (!file) {
      return;
    }

    const maxIndex = Math.max(0, file.metadata.hunks.length - 1);
    setSelectedHunkIndex((current) => clamp(current, 0, maxIndex));
  };

  createEffect(() => {
    reconcileSelectedFile();
  });

  createEffect(() => {
    reconcileSelectedHunkIndex();
  });

  /** Move through the full visible review stream one hunk at a time. */
  const moveToHunk = (delta: number) => {
    const nextCursor = findNextHunkCursor(
      hunkCursors(),
      selectedFile()?.id,
      selectedHunkIndex(),
      delta,
    );
    if (!nextCursor) {
      return;
    }

    const crossingFileBoundary = nextCursor.fileId !== selectedFile()?.id;
    selectHunk(nextCursor.fileId, nextCursor.hunkIndex, {
      // Align the file header to top only for forward cross-file jumps so the new file
      // starts at its header. Backward jumps should reveal the target hunk directly,
      // since the target is often near the bottom of the previous file and the file-top
      // align would require an extra navigation press to reach it.
      alignFileHeaderTop: crossingFileBoundary && delta > 0,
    });
  };

  /** Move through only hunks that currently have agent notes or live comments. */
  const moveToAnnotatedHunk = (delta: number) => {
    const nextCursor = findNextHunkCursor(
      annotatedHunkCursors(),
      selectedFile()?.id,
      selectedHunkIndex(),
      delta,
      hunkCursors(),
    );
    if (!nextCursor) {
      return;
    }

    selectHunk(nextCursor.fileId, nextCursor.hunkIndex, { scrollToNote: true });
  };

  /** Cycle through only the currently visible files that carry annotations. */
  const moveToAnnotatedFile = (delta: number) => {
    const nextFile = findNextAnnotatedFile(visibleFiles(), selectedFile()?.id, delta);
    if (!nextFile) {
      return;
    }

    selectFile(nextFile.id);
  };

  /** Move through all currently visible files without wrapping past either end. */
  const moveToFile = (delta: number) => {
    const files = visibleFiles();
    const currentIndex = files.findIndex((file) => file.id === selectedFile()?.id);
    if (currentIndex < 0) {
      return;
    }

    const nextIndex = clamp(currentIndex + delta, 0, files.length - 1);
    if (nextIndex === currentIndex) {
      return;
    }

    const nextFile = files[nextIndex];
    if (!nextFile) {
      return;
    }

    selectFile(nextFile.id, 0, { alignFileHeaderTop: true });
  };

  /** Clear the active file filter without touching the current selection. */
  const clearFilter = () => {
    setFilter("");
  };

  /** Toggle expansion of one collapsed gap and lazily load source when needed. */
  const toggleGap = (fileId: string, gapKey: string) => {
    const file = allFiles().find((entry) => entry.id === fileId);
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

    // The fetcher caches its own resolved text; we mirror it into signal state
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
  };

  /** Toggle the collapsed gap nearest to the current hunk selection. */
  const toggleSelectedHunkGap = () => {
    const file = selectedFile();
    if (!file?.sourceFetcher) {
      return;
    }

    const target = selectGapForKeyboardToggle(
      file.metadata.hunks,
      selectedHunkIndex(),
      trailingCollapsedLines(file.metadata) > 0,
    );
    if (target) {
      toggleGap(file.id, target);
    }
  };

  /** Resolve one session-daemon navigation request against the current review state and select it. */
  const navigateToLocation = (input: NavigateToHunkToolInput): NavigatedSelectionResult => {
    const target = resolveReviewNavigationTarget({
      allFiles: allFiles(),
      currentFileId: selectedFile()?.id,
      currentHunkIndex: selectedHunkIndex(),
      input,
      visibleFiles: visibleFiles(),
    });

    selectHunk(target.file.id, target.hunkIndex, { scrollToNote: target.scrollToNote });
    return {
      fileId: target.file.id,
      filePath: target.file.path,
      hunkIndex: target.hunkIndex,
      selectedHunk: buildSelectedHunkSummary(target.file, target.hunkIndex),
    };
  };

  /** Add one live comment, optionally revealing its hunk in the active review. */
  const addLiveComment = (
    input: CommentToolInput,
    commentId: string,
    options?: { reveal?: boolean },
  ): AppliedCommentResult => {
    const file = findDiffFileByPath(allFiles(), input.filePath);
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
  };

  /** Apply several live comments together after validating every target first. */
  const addLiveCommentBatch = (
    inputs: CommentBatchItemInput[],
    requestId: string,
    options?: { revealMode?: "none" | "first" },
  ): AppliedCommentBatchResult => {
    const createdAt = new Date().toISOString();
    const prepared = inputs.map((input, index) => {
      const file = findDiffFileByPath(allFiles(), input.filePath);
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
  };

  /** Remove one daemon-addressable comment, including human notes by stable `user:*` id. */
  const removeLiveComment = (commentId: string): RemovedCommentResult => {
    if (commentId.startsWith("user:")) {
      let removed = false;
      const next: Record<string, UserReviewNote[]> = {};

      for (const [fileId, notes] of Object.entries(userNotesByFileId())) {
        const filtered = notes.filter((note) => note.id !== commentId);
        if (filtered.length !== notes.length) {
          removed = true;
        }
        if (filtered.length > 0) {
          next[fileId] = filtered;
        }
      }

      if (!removed) {
        throw new Error(`No user note matches id ${commentId}.`);
      }

      setUserNotesByFileId(next);
      return {
        commentId,
        removed: true,
        remainingCommentCount: countFileMapItems(liveCommentsByFileId()) + countFileMapItems(next),
        source: "user",
      };
    }

    let removed = false;
    let remainingLiveCommentCount = 0;
    const next: Record<string, LiveComment[]> = {};

    for (const [fileId, comments] of Object.entries(liveCommentsByFileId())) {
      const filtered = comments.filter((comment) => comment.id !== commentId);
      if (filtered.length !== comments.length) {
        removed = true;
      }

      if (filtered.length > 0) {
        next[fileId] = filtered;
        remainingLiveCommentCount += filtered.length;
      }
    }

    if (!removed) {
      throw new Error(`No live comment matches id ${commentId}.`);
    }

    setLiveCommentsByFileId(next);
    return {
      commentId,
      removed: true,
      remainingCommentCount: remainingLiveCommentCount + countFileMapItems(userNotesByFileId()),
      source: "agent",
    };
  };

  /** Clear live comments, optionally including human notes, globally or for one file. */
  const clearLiveComments = (
    filePath?: string,
    options: { includeUser?: boolean } = {},
  ): ClearedCommentsResult => {
    const file = filePath ? findDiffFileByPath(allFiles(), filePath) : undefined;
    if (filePath && !file) {
      throw new Error(`No diff file matches ${filePath}.`);
    }

    let removedLiveCommentCount = 0;
    let remainingLiveCommentCount = 0;
    const currentLiveCommentsByFileId = liveCommentsByFileId();
    let nextLiveCommentsByFileId: Record<string, LiveComment[]> = currentLiveCommentsByFileId;

    if (file) {
      nextLiveCommentsByFileId = {};
      for (const [fileId, comments] of Object.entries(currentLiveCommentsByFileId)) {
        if (fileId === file.id) {
          removedLiveCommentCount = comments.length;
          continue;
        }

        nextLiveCommentsByFileId[fileId] = comments;
        remainingLiveCommentCount += comments.length;
      }
    } else {
      removedLiveCommentCount = countFileMapItems(currentLiveCommentsByFileId);
      remainingLiveCommentCount = 0;
      nextLiveCommentsByFileId = {};
    }

    if (removedLiveCommentCount > 0) {
      setLiveCommentsByFileId(nextLiveCommentsByFileId);
    }

    const currentUserNotesByFileId = userNotesByFileId();
    let removedUserNoteCount = 0;
    let remainingUserNoteCount = countFileMapItems(currentUserNotesByFileId);
    let nextUserNotesByFileId = currentUserNotesByFileId;

    if (options.includeUser) {
      if (file) {
        nextUserNotesByFileId = {};
        remainingUserNoteCount = 0;
        for (const [fileId, notes] of Object.entries(currentUserNotesByFileId)) {
          if (fileId === file.id) {
            removedUserNoteCount = notes.length;
            continue;
          }

          nextUserNotesByFileId[fileId] = notes;
          remainingUserNoteCount += notes.length;
        }
      } else {
        removedUserNoteCount = countFileMapItems(currentUserNotesByFileId);
        remainingUserNoteCount = 0;
        nextUserNotesByFileId = {};
      }

      if (removedUserNoteCount > 0) {
        setUserNotesByFileId(nextUserNotesByFileId);
      }
    }

    return {
      removedCount: removedLiveCommentCount + removedUserNoteCount,
      remainingCommentCount: remainingLiveCommentCount + remainingUserNoteCount,
      filePath,
      includeUser: options.includeUser,
      removedLiveCommentCount,
      removedUserNoteCount,
      remainingLiveCommentCount,
      remainingUserNoteCount,
    };
  };

  /** Start a human-authored draft note at the selected or requested hunk. */
  const startUserNote = (
    fileId = selectedFile()?.id,
    hunkIndex = selectedHunkIndex(),
    requestedTarget?: UserNoteLineTarget,
  ): DraftReviewNote | null => {
    const file = allFiles().find((candidate) => candidate.id === fileId);
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
  };

  /** Update the body of the active draft note. */
  const updateDraftNote = (body: string) => {
    setDraftNote((current) => (current ? { ...current, body } : current));
  };

  /** Discard the active human note draft. */
  const cancelDraftNote = () => {
    setDraftNote(null);
  };

  /** Persist the active draft into the in-memory user note collection. */
  const saveDraftNote = (): UserReviewNote | null => {
    const draft = draftNote();
    if (!draft) {
      return null;
    }

    const body = draft.body.trim();
    if (!body) {
      setDraftNote(null);
      return null;
    }

    const savedNote: UserReviewNote = {
      id: `user:${Date.now()}`,
      source: "user",
      filePath: draft.filePath,
      hunkIndex: draft.hunkIndex,
      side: draft.side,
      line: draft.line,
      oldRange: draft.oldRange,
      newRange: draft.newRange,
      summary: body,
      author: "user",
      createdAt: new Date().toISOString(),
      editable: true,
    };

    setUserNotesByFileId((notesByFile) => ({
      ...notesByFile,
      [draft.fileId]: [...(notesByFile[draft.fileId] ?? []), savedNote],
    }));
    setDraftNote(null);
    return savedNote;
  };

  /** Remove one in-memory user note by id. */
  const removeUserNote = (noteId: string) => {
    let removed = false;
    const next: Record<string, UserReviewNote[]> = {};

    for (const [fileId, notes] of Object.entries(userNotesByFileId())) {
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
  };

  /** Count all currently tracked live comments, including ones hidden by the active filter. */
  const liveCommentCount = createMemo(() =>
    Object.values(liveCommentsByFileId()).reduce((sum, comments) => sum + comments.length, 0),
  );

  /** Format current inline notes for daemon snapshots without exposing UI-only objects. */
  const reviewNoteSummaries = createMemo<SessionReviewNoteSummary[]>(() => {
    const noteSummaries: SessionReviewNoteSummary[] = [];

    files().forEach((file) => {
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

      (liveCommentsByFileId()[file.id] ?? []).forEach((comment) => {
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

      (userNotesByFileId()[file.id] ?? []).forEach((note) => {
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
  });

  /** Count all currently tracked review notes, including AI, agent, and user notes. */
  const reviewNoteCount = createMemo(() => reviewNoteSummaries().length);

  /** Format current live comments for daemon snapshots without exposing merged UI-only objects. */
  const liveCommentSummaries = createMemo<SessionLiveCommentSummary[]>(() =>
    allFiles().flatMap((file) =>
      (liveCommentsByFileId()[file.id] ?? []).map((comment) => ({
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
