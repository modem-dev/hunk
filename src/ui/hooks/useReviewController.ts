/**
 * Terminal review state, projected from the shared review store.
 *
 * The semantic state of a review — selection, reveal intent, filter, note visibility,
 * notes, drafts, and gap expansion — lives in `src/core/review`, so the terminal, the
 * session bridge, and later surfaces all read one answer. This hook owns what is
 * genuinely terminal: projecting that state onto the diff-file model the panes render,
 * the measured current-line cursor, and the source loading a gap expansion triggers.
 *
 * `App` uses it for rendering and keyboard or menu actions; the session bridge uses the
 * same controller for daemon-driven navigation and agent notes.
 */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildLiveComment,
  findDiffFileByPath,
  resolveCommentTarget,
} from "../../core/liveComments";
import { SourceTextTooLargeError } from "../../core/fileSource";
import {
  applyReviewIntent,
  ReviewIntentPlanningError,
  type ReviewIntent,
  type ReviewIntentFacts,
} from "../../core/review/intents";
import { projectReviewDocument } from "../../core/review/document";
import { reviewExpansionSide, reviewTrailingGap } from "../../core/review/expansion";
import { reviewDefaultHunkLineTarget } from "../../core/review/geometry";
import {
  isReviewGapExpanded,
  reviewFileKeysWithRetiredContent,
  selectExpandedGapIdsByFileKey,
} from "../../core/review/selectors";
import type { ReviewDraftNote, ReviewRevealRequest } from "../../core/review/state";
import { createReviewStore, type ReviewStore } from "../../core/review/store";
import { noDiffFileMatchesMessage } from "../../session/agent/errors";
import type { AgentAnnotation, DiffFile, LayoutMode, UserNoteLineTarget } from "../../core/types";
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
} from "../../session/types";
import type { FileSourceStatus } from "../diff/expandCollapsedRows";
import { selectGapForKeyboardToggle } from "../diff/expandCollapsedRows";

import { findNextHunkCursor } from "../lib/hunks";
import {
  EMPTY_LINE_CURSORS,
  findNextLineCursor,
  firstLineCursorInHunk,
  hasLineCursor,
  lineCursorAt,
  resolveLineCursor,
  type LineCursor,
} from "../lib/lineCursors";
import { agentNoteMarkupWidth } from "../lib/agentNoteGeometry";
import { reviewNoteSource } from "../lib/agentAnnotations";
import { STML_REFERENCE_WIDTH, validateStmlMarkup } from "../lib/stml/layout";
import {
  groupStoredNotesByFileId,
  liveCommentToStoredNote,
  storedDraftToDraftNote,
  storedNoteToLiveComment,
  storedNoteToUserNote,
  type DraftReviewNote,
  type UserReviewNote,
} from "../lib/reviewProjection";
import {
  buildReviewStreamState,
  buildSelectedHunkSummary,
  findNextAnnotatedFile,
  resolveReviewNavigationTarget,
  resolveSelectedFile,
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

/**
 * Observe the review store as ordinary React state.
 *
 * Deliberately not `useSyncExternalStore`: a held key drains as one stdin chunk, and the
 * terminal routes that whole burst against one committed snapshot. Forcing a synchronous
 * re-render per dispatch would re-enter key routing part-way through a burst.
 */
function useReviewStoreSnapshot(store: ReviewStore) {
  const [snapshot, setSnapshot] = useState(store.getSnapshot);
  useEffect(() => {
    // Adopt anything dispatched between the first render and this subscription.
    setSnapshot(store.getSnapshot());
    return store.subscribe(() => setSnapshot(store.getSnapshot()));
  }, [store]);
  return snapshot;
}

/** Re-raise a missing-note rejection as the message agent surfaces already report. */
function withMissingNoteMessage<T>(run: () => T, message: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ReviewIntentPlanningError && error.code === "note-not-found") {
      throw new Error(message);
    }
    throw error;
  }
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

/**
 * Translate the terminal's selection options into the shared reveal request.
 *
 * File-header alignment outranks viewport preservation: a caller passing both is
 * crossing into another file, where the header is what belongs on screen.
 */
function revealRequestFor(options?: ReviewSelectionOptions): ReviewRevealRequest {
  return {
    anchor: options?.alignFileHeaderTop ? "file-top" : options?.preserveViewport ? "none" : "hunk",
    scrollToNote: Boolean(options?.scrollToNote),
  };
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
  showAgentNotes: boolean;
  userNotesByFileId: Record<string, UserReviewNote[]>;
  lineCursor: LineCursor | null;
  lineCursorRevealRequestId: number;
  anchorLineCursor: (cursor: LineCursor) => void;
  moveLineCursor: (delta: number) => void;
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
  setShowAgentNotes: (visible: boolean) => void;
  startUserNote: (
    fileId?: string,
    hunkIndex?: number,
    target?: UserNoteLineTarget,
    options?: { preserveViewport?: boolean },
  ) => DraftReviewNote | null;
  setFilter: (value: string) => void;
  updateDraftNote: (body: string) => void;
}

/** Live note-card geometry the app publishes for markup validation. */
export interface AgentNoteGeometrySnapshot {
  layout: Exclude<LayoutMode, "auto">;
  /** Diff pane content width — the width the diff view renders at. */
  width: number;
}

/** Own the shared review stream state used by both the UI and session bridge. */
export function useReviewController({
  files,
  initialShowAgentNotes = false,
  lineCursors = EMPTY_LINE_CURSORS,
  noteGeometry,
  stmlEnabled = false,
}: {
  files: DiffFile[];
  /** Note-layer visibility the launch configuration resolved for this review. */
  initialShowAgentNotes?: boolean;
  /**
   * Navigable lines in rendered order, published by the pane that measures the review stream.
   * Headless callers get none, which leaves `j` and `k` scrolling the viewport.
   */
  lineCursors?: LineCursor[];
  /** Allow STML bodies for live comments in this explicitly opted-in session. */
  stmlEnabled?: boolean;
  /**
   * Mutable ref the app keeps pointed at the current layout and pane width.
   * A ref (not a value) because App computes geometry after this hook runs;
   * daemon commands arrive asynchronously, so reads always see fresh state.
   */
  noteGeometry?: { current: AgentNoteGeometrySnapshot | null };
}): ReviewController {
  const document = useMemo(() => projectReviewDocument(files), [files]);
  const [store] = useState(() =>
    createReviewStore(document, { showAgentNotes: initialShowAgentNotes }),
  );
  const sourceLoadRequestsRef = useRef(new Map<string, SourceLoadRequest>());
  const nextSourceLoadRequestIdRef = useRef(1);
  const lineCursorBeforeExpandRef = useRef(new Map<string, LineCursor>());

  const reconciledDocumentRef = useRef(document);

  // Adopt a replacement file list in the same commit that renders it, so a soft reload
  // never paints new files against state the previous patch produced. The store retires
  // content-derived state itself; the work here is the cursor and in-flight source
  // bookkeeping only this renderer knows about.
  useLayoutEffect(() => {
    const previous = reconciledDocumentRef.current;
    if (previous === document) {
      return;
    }

    reconciledDocumentRef.current = document;
    for (const fileKey of reviewFileKeysWithRetiredContent(previous, document)) {
      sourceLoadRequestsRef.current.delete(fileKey);
      for (const restorePointKey of lineCursorBeforeExpandRef.current.keys()) {
        if (restorePointKey.startsWith(`${fileKey}:`)) {
          lineCursorBeforeExpandRef.current.delete(restorePointKey);
        }
      }
    }
    store.dispatch({ type: "document/reconcile", document });
  }, [document, store]);

  const state = useReviewStoreSnapshot(store);
  const filter = state.filter;
  const selectedHunkIndex = state.selection.hunkIndex;
  const scrollToNote = state.reveal.scrollToNote;
  const [lineCursor, setLineCursor] = useState<LineCursor | null>(null);
  // A held key drains as one stdin chunk, so every press in the burst would otherwise read the
  // same pre-batch state and the cursor would advance a single row.
  const lineCursorRef = useRef<LineCursor | null>(null);
  const [lineCursorRevealRequestId, setLineCursorRevealRequestId] = useState(0);
  const previousLineCursorsRef = useRef(lineCursors);
  const pendingLineCursorRef = useRef<
    | { kind: "reveal"; fileId: string; gapKey: string }
    | { kind: "restore"; cursor: LineCursor }
    | null
  >(null);
  // Monotonic suffix that keeps `user:*` note ids unique within one millisecond.
  const userNoteSequenceRef = useRef(0);

  const keyByFileId = useMemo(
    () => new Map(document.files.map((file) => [file.runtimeId, file.key] as const)),
    [document],
  );
  const fileByKey = useMemo(() => {
    const byRuntimeId = new Map(files.map((file) => [file.id, file] as const));
    return new Map(
      document.files.flatMap((semantic) => {
        const file = byRuntimeId.get(semantic.runtimeId);
        return file ? [[semantic.key, file] as const] : [];
      }),
    );
  }, [document, files]);

  const liveCommentsByFileId = useMemo(
    () => groupStoredNotesByFileId(state.liveNotes, fileByKey, storedNoteToLiveComment),
    [fileByKey, state.liveNotes],
  );
  const userNotesByFileId = useMemo(
    () => groupStoredNotesByFileId(state.userNotes, fileByKey, storedNoteToUserNote),
    [fileByKey, state.userNotes],
  );
  const draftNote = useMemo(() => {
    const draft = state.draftNote;
    const file = draft ? fileByKey.get(draft.fileKey) : undefined;
    return draft && file ? storedDraftToDraftNote(draft, file) : null;
  }, [fileByKey, state.draftNote]);
  const expandedGaps = state.expandedGaps;
  const expandedGapsByFileId = useMemo(() => {
    const result: Record<string, ReadonlySet<string>> = {};
    for (const [fileKey, gapIds] of Object.entries(
      selectExpandedGapIdsByFileKey({ expandedGaps }),
    )) {
      const file = fileByKey.get(fileKey);
      if (file) {
        result[file.id] = gapIds;
      }
    }
    return result;
  }, [expandedGaps, fileByKey]);
  const sourceStatusByFileId = useMemo(() => {
    const result: Record<string, FileSourceStatus> = {};
    for (const [fileKey, status] of Object.entries(state.sourceStatusByFileKey)) {
      const file = fileByKey.get(fileKey);
      if (file) {
        result[file.id] = status;
      }
    }
    return result;
  }, [fileByKey, state.sourceStatusByFileKey]);

  const deferredFilter = useDeferredValue(filter);
  const { allFiles, visibleFiles, hunkCursors, annotatedHunkCursors } = useMemo(
    () =>
      buildReviewStreamState({
        files,
        liveCommentsByFileId: mergeAnnotationMaps(liveCommentsByFileId, userNotesByFileId),
        filterQuery: deferredFilter,
      }),
    [deferredFilter, files, liveCommentsByFileId, userNotesByFileId],
  );
  const selectedFileId = state.selection.fileKey
    ? (fileByKey.get(state.selection.fileKey)?.id ?? "")
    : "";
  const selectedFile = useMemo(
    () => resolveSelectedFile(allFiles, visibleFiles, selectedFileId),
    [allFiles, selectedFileId, visibleFiles],
  );
  const selectedHunk = selectedFile?.metadata.hunks[selectedHunkIndex];

  /** Run one semantic intent against the review store. */
  const runIntent = useCallback(
    <T extends ReviewIntent>(intent: T, facts?: ReviewIntentFacts) =>
      applyReviewIntent(store, intent, facts),
    [store],
  );

  /** Update the selection and its reveal request together so diff scrolling stays explicit. */
  const selectHunk = useCallback(
    (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => {
      const fileKey = keyByFileId.get(fileId);
      if (!fileKey) {
        return;
      }

      runIntent({
        type: "selection/select",
        fileKey,
        hunkIndex,
        reveal: revealRequestFor(options),
      });
    },
    [keyByFileId, runIntent],
  );

  /** Select one file and optionally one specific hunk within it. */
  const selectFile = useCallback(
    (fileId: string, nextHunkIndex = 0, options?: ReviewSelectionOptions) => {
      selectHunk(fileId, nextHunkIndex, options);
    },
    [selectHunk],
  );

  /**
   * Keep the selection on a file the review stream still shows, with its hunk in range.
   *
   * Reconciliation carries no reveal request: filters and reloads move the selection on
   * the reviewer's behalf, and must not also move the viewport under them.
   */
  const reconcileSelection = useCallback(() => {
    const selection = store.getSnapshot().selection;
    const selected = selection.fileKey ? fileByKey.get(selection.fileKey) : undefined;
    const isVisible =
      selected !== undefined && visibleFiles.some((file) => file.id === selected.id);
    const fallback = visibleFiles[0];

    if (!isVisible && fallback) {
      const fallbackKey = keyByFileId.get(fallback.id);
      if (fallbackKey) {
        store.dispatch({ type: "selection/select", fileKey: fallbackKey, hunkIndex: 0 });
      }
      return;
    }

    if (selection.fileKey) {
      store.dispatch({
        type: "selection/select",
        fileKey: selection.fileKey,
        hunkIndex: selection.hunkIndex,
      });
    }
  }, [fileByKey, keyByFileId, store, visibleFiles]);

  useEffect(() => {
    reconcileSelection();
    // The store's own state is what needs reconciling, so re-run when it moves.
  }, [reconcileSelection, state.document, state.selection]);

  /**
   * Keep the current line on a row the review stream still renders.
   *
   * Seeding from the selected hunk makes the marker visible from launch, not just after the
   * first keypress.
   */
  const applyLineCursor = useCallback((next: LineCursor | null) => {
    lineCursorRef.current = next;
    setLineCursor(next);
  }, []);

  /** Move the current line to a row the reviewer just asked to see, and scroll to it. */
  const revealLineCursor = useCallback(
    (cursor: LineCursor) => {
      applyLineCursor(cursor);
      setLineCursorRevealRequestId((current) => current + 1);
      selectHunk(cursor.fileId, cursor.hunkIndex, { preserveViewport: true });
    },
    [applyLineCursor, selectHunk],
  );

  const reconcileLineCursor = useCallback(() => {
    // Expansion remeasures before its source text loads, so a toggle records what it wants and
    // this waits for the list that actually carries the revealed rows. Each request survives until
    // it resolves or the next toggle replaces it.
    const previousCursors = previousLineCursorsRef.current;
    previousLineCursorsRef.current = lineCursors;

    const pending = pendingLineCursorRef.current;
    if (pending?.kind === "reveal") {
      const alreadyStopped = new Set(
        previousCursors
          .filter((cursor) => cursor.fileId === pending.fileId)
          .map((cursor) => cursor.stableKey),
      );
      const firstRevealed = lineCursors.find(
        (cursor) =>
          cursor.fileId === pending.fileId &&
          cursor.expandedGapKey === pending.gapKey &&
          !alreadyStopped.has(cursor.stableKey),
      );
      if (firstRevealed) {
        pendingLineCursorRef.current = null;
        revealLineCursor(firstRevealed);
        return;
      }
    }

    // Only take the restore point when the collapse actually retired the row the marker was on;
    // the reviewer may have stepped well clear of the gap since expanding it.
    if (pending?.kind === "restore" && !hasLineCursor(lineCursors, lineCursorRef.current)) {
      const restored = resolveLineCursor(lineCursors, pending.cursor);
      if (restored) {
        pendingLineCursorRef.current = null;
        revealLineCursor(restored);
        return;
      }
    }

    const resolved = resolveLineCursor(lineCursors, lineCursorRef.current);
    if (resolved?.fileId === selectedFileId && resolved?.hunkIndex === selectedHunkIndex) {
      applyLineCursor(resolved);
      return;
    }

    applyLineCursor(firstLineCursorInHunk(lineCursors, selectedFileId, selectedHunkIndex));
  }, [applyLineCursor, lineCursors, revealLineCursor, selectedFileId, selectedHunkIndex]);

  useEffect(() => {
    reconcileLineCursor();
  }, [reconcileLineCursor]);

  /** Adopt a current line the viewport already settled on, without scrolling back to it. */
  const anchorLineCursor = useCallback(
    (cursor: LineCursor) => {
      applyLineCursor(cursor);
      selectHunk(cursor.fileId, cursor.hunkIndex, { preserveViewport: true });
    },
    [applyLineCursor, selectHunk],
  );

  /** Move the current line one row through the visible review stream. */
  const moveLineCursor = useCallback(
    (delta: number) => {
      const nextCursor = findNextLineCursor(lineCursors, lineCursorRef.current, delta);
      if (!nextCursor) {
        return;
      }

      revealLineCursor(nextCursor);
    },
    [lineCursors, revealLineCursor],
  );

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

  /** Set the shared file filter. */
  const setFilter = useCallback(
    (value: string) => {
      runIntent({ type: "filter/set", filter: value });
    },
    [runIntent],
  );

  /** Clear the active file filter without touching the current selection. */
  const clearFilter = useCallback(() => {
    setFilter("");
  }, [setFilter]);

  /** Show or hide the shared agent note layer. */
  const setShowAgentNotes = useCallback(
    (visible: boolean) => {
      runIntent({ type: "notes/set-visibility", visible });
    },
    [runIntent],
  );

  /** Start one full-source load and mirror its progress into review state as a status. */
  const startSourceLoad = useCallback(
    (file: DiffFile, fileKey: string) => {
      if (!file.sourceFetcher) {
        return;
      }
      // The fetcher caches its own resolved text; we mirror it into review state as a
      // tagged status so the UI can distinguish loading, loaded, and error states. Skip
      // the fetch when one is already in flight or has resolved to avoid redundant work
      // and stale "loading" flicker.
      const currentStatus = store.getSnapshot().sourceStatusByFileKey[fileKey]?.kind;
      if (currentStatus === "loaded" || currentStatus === "loading") {
        return;
      }

      const side = reviewExpansionSide(file.metadata.type);
      const request = {
        fetcher: file.sourceFetcher,
        requestId: nextSourceLoadRequestIdRef.current,
        side,
      } satisfies SourceLoadRequest;
      nextSourceLoadRequestIdRef.current += 1;
      sourceLoadRequestsRef.current.set(fileKey, request);
      store.dispatch({
        type: "expansion/set-source-status",
        fileKey,
        status: { kind: "loading" },
      });

      const isCurrentRequest = () => {
        const current = sourceLoadRequestsRef.current.get(fileKey);
        return (
          current?.requestId === request.requestId &&
          current.fetcher === request.fetcher &&
          current.side === request.side
        );
      };

      const setSettledStatus = (status: FileSourceStatus) => {
        if (!isCurrentRequest()) {
          return;
        }

        sourceLoadRequestsRef.current.delete(fileKey);
        store.dispatch({ type: "expansion/set-source-status", fileKey, status });
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
          setSettledStatus({ kind: "error", reason });
        });
    },
    [store],
  );

  // A reload drops unattested source text while its gap stays open (the reducer's
  // attestation rule), so an open gap refetches instead of rendering lines the source
  // may no longer contain.
  useEffect(() => {
    const snapshot = store.getSnapshot();
    for (const gap of snapshot.expandedGaps) {
      if (!gap.expanded || snapshot.sourceStatusByFileKey[gap.fileKey]) {
        continue;
      }
      const file = fileByKey.get(gap.fileKey);
      if (file?.sourceFetcher) {
        startSourceLoad(file, gap.fileKey);
      }
    }
  }, [fileByKey, startSourceLoad, store, state.document]);

  /** Toggle expansion of one collapsed gap and lazily load source when needed. */
  const toggleGap = useCallback(
    (fileId: string, gapKey: string) => {
      const file = allFiles.find((entry) => entry.id === fileId);
      const fileKey = keyByFileId.get(fileId);
      if (!file?.sourceFetcher || !fileKey) {
        return;
      }

      const restorePointKey = `${fileId}:${gapKey}`;
      const restorePoint = lineCursorBeforeExpandRef.current.get(restorePointKey) ?? null;
      const expanding = !isReviewGapExpanded(store.getSnapshot(), fileKey, gapKey);
      if (expanding) {
        if (lineCursorRef.current) {
          lineCursorBeforeExpandRef.current.set(restorePointKey, lineCursorRef.current);
        }
        pendingLineCursorRef.current = { kind: "reveal", fileId, gapKey };
      } else {
        lineCursorBeforeExpandRef.current.delete(restorePointKey);
        pendingLineCursorRef.current = restorePoint
          ? { kind: "restore", cursor: restorePoint }
          : null;
      }

      store.dispatch({ type: "expansion/toggle", fileKey, gapId: gapKey, expanded: expanding });
      startSourceLoad(file, fileKey);
    },
    [allFiles, keyByFileId, startSourceLoad, store],
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
      reviewTrailingGap(file.metadata) !== undefined,
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

  /**
   * Validate one comment's STML markup at the width the note will actually
   * render at right now — live layout mode and pane width, falling back to
   * the documented reference width when geometry is not published (tests,
   * headless callers). Reports the width back so agents can preview at it.
   */
  const markupFeedback = useCallback(
    (
      markup: string | undefined,
      anchorSide: "old" | "new",
    ): Pick<AppliedCommentResult, "markupWidth" | "markupNotes"> => {
      if (!markup) {
        return {};
      }

      if (!stmlEnabled) {
        throw new Error(
          "STML markup is disabled for this session. Relaunch Hunk with --experimental, or omit markup.",
        );
      }

      const geometry = noteGeometry?.current;
      const markupWidth = geometry
        ? agentNoteMarkupWidth({ anchorSide, layout: geometry.layout, width: geometry.width })
        : STML_REFERENCE_WIDTH;
      const markupNotes = validateStmlMarkup(markup, markupWidth);
      return {
        markupWidth,
        ...(markupNotes.length > 0 ? { markupNotes } : {}),
      };
    },
    [noteGeometry, stmlEnabled],
  );

  /** Resolve one comment request against the review stream, rejecting unknown files. */
  const resolveCommentRequest = useCallback(
    (input: CommentToolInput | CommentBatchItemInput) => {
      const file = findDiffFileByPath(allFiles, input.filePath);
      const fileKey = file ? keyByFileId.get(file.id) : undefined;
      if (!file || !fileKey) {
        throw new Error(noDiffFileMatchesMessage(input.filePath));
      }

      const target = resolveCommentTarget(file, input);
      return { file, fileKey, target, feedback: markupFeedback(input.markup, target.side) };
    },
    [allFiles, keyByFileId, markupFeedback],
  );

  /** Add one live comment, optionally revealing its hunk in the active review. */
  const addLiveComment = useCallback(
    (
      input: CommentToolInput,
      commentId: string,
      options?: { reveal?: boolean },
    ): AppliedCommentResult => {
      const { file, fileKey, target, feedback } = resolveCommentRequest(input);
      const liveComment = buildLiveComment(
        { ...input, side: target.side, line: target.line },
        commentId,
        new Date().toISOString(),
        target.hunkIndex,
      );
      store.dispatch({
        type: "notes/add-live",
        notes: [liveCommentToStoredNote(liveComment, fileKey, file.metadata.hunks)],
      });

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
        ...feedback,
      };
    },
    [resolveCommentRequest, selectHunk, store],
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
        const resolved = resolveCommentRequest(input);
        return {
          ...resolved,
          liveComment: buildLiveComment(
            { ...input, side: resolved.target.side, line: resolved.target.line },
            `mcp:${requestId}:${index}`,
            createdAt,
            resolved.target.hunkIndex,
          ),
        };
      });

      if (prepared.length > 0) {
        store.dispatch({
          type: "notes/add-live",
          notes: prepared.map((entry) =>
            liveCommentToStoredNote(entry.liveComment, entry.fileKey, entry.file.metadata.hunks),
          ),
        });
      }

      const first = prepared[0];
      if (options?.revealMode === "first" && first) {
        selectHunk(first.file.id, first.target.hunkIndex);
      }

      return {
        applied: prepared.map(({ feedback, file, target, liveComment }) => ({
          commentId: liveComment.id,
          fileId: file.id,
          filePath: file.path,
          hunkIndex: target.hunkIndex,
          side: target.side,
          line: target.line,
          ...feedback,
        })),
      };
    },
    [resolveCommentRequest, selectHunk, store],
  );

  /** Remove one daemon-addressable comment, including human notes by stable `user:*` id. */
  const removeLiveComment = useCallback(
    (commentId: string): RemovedCommentResult => {
      const isUserNote = commentId.startsWith("user:");
      withMissingNoteMessage(
        () =>
          runIntent(
            isUserNote
              ? { type: "notes/remove-user", noteId: commentId }
              : { type: "notes/remove-live", noteId: commentId },
          ),
        isUserNote
          ? `No user note matches id ${commentId}.`
          : `No live comment matches id ${commentId}.`,
      );

      const snapshot = store.getSnapshot();
      return {
        commentId,
        removed: true,
        remainingCommentCount: snapshot.liveNotes.length + snapshot.userNotes.length,
        source: isUserNote ? "user" : "agent",
      };
    },
    [runIntent, store],
  );

  /** Clear live comments, optionally including human notes, globally or for one file. */
  const clearLiveComments = useCallback(
    (filePath?: string, options: { includeUser?: boolean } = {}): ClearedCommentsResult => {
      const file = filePath ? findDiffFileByPath(allFiles, filePath) : undefined;
      const fileKey = file ? keyByFileId.get(file.id) : undefined;
      if (filePath && !fileKey) {
        throw new Error(noDiffFileMatchesMessage(filePath));
      }

      const cleared = runIntent({
        type: "notes/clear",
        ...(fileKey ? { fileKey } : {}),
        ...(options.includeUser ? { includeUser: true } : {}),
      });

      return {
        removedCount: cleared.removedLiveCount + cleared.removedUserCount,
        remainingCommentCount: cleared.remainingLiveCount + cleared.remainingUserCount,
        filePath,
        includeUser: options.includeUser,
        removedLiveCommentCount: cleared.removedLiveCount,
        removedUserNoteCount: cleared.removedUserCount,
        remainingLiveCommentCount: cleared.remainingLiveCount,
        remainingUserNoteCount: cleared.remainingUserCount,
      };
    },
    [allFiles, keyByFileId, runIntent],
  );

  /** Start a human-authored draft note at the selected or requested hunk. */
  const startUserNote = useCallback(
    (
      fileId = selectedFile?.id,
      hunkIndex = selectedHunkIndex,
      requestedTarget?: UserNoteLineTarget,
      options?: { preserveViewport?: boolean },
    ): DraftReviewNote | null => {
      const file = allFiles.find((candidate) => candidate.id === fileId);
      const hunk = file?.metadata.hunks[hunkIndex];
      const fileKey = file ? keyByFileId.get(file.id) : undefined;
      if (!file || !hunk || !fileKey) {
        return null;
      }

      const target = requestedTarget ?? reviewDefaultHunkLineTarget(hunk);
      applyLineCursor(lineCursorAt(lineCursors, file.id, hunkIndex, target));
      const draft: ReviewDraftNote = {
        id: `draft:${file.id}:${hunkIndex}:${Date.now()}`,
        fileKey,
        hunkIndex,
        side: target.side,
        line: target.line,
        body: "",
      };
      store.dispatch({ type: "draft/start", draft });
      selectHunk(
        file.id,
        hunkIndex,
        options?.preserveViewport ? { preserveViewport: true } : { scrollToNote: true },
      );
      return storedDraftToDraftNote(draft, file);
    },
    [
      allFiles,
      applyLineCursor,
      keyByFileId,
      lineCursors,
      selectHunk,
      selectedFile?.id,
      selectedHunkIndex,
      store,
    ],
  );

  /** Update the body of the active draft note. */
  const updateDraftNote = useCallback(
    (body: string) => {
      store.dispatch({ type: "draft/update", body });
    },
    [store],
  );

  /** Discard the active human note draft. */
  const cancelDraftNote = useCallback(() => {
    store.dispatch({ type: "draft/cancel" });
  }, [store]);

  /**
   * Persist the active draft into the review's user notes exactly once.
   *
   * The store settles synchronously, so a coalesced repeat of the save key finds no
   * draft left to consume rather than needing its own guard.
   */
  const saveDraftNote = useCallback((): UserReviewNote | null => {
    const draft = store.getSnapshot().draftNote;
    const file = draft ? fileByKey.get(draft.fileKey) : undefined;
    if (!draft || !file) {
      return null;
    }

    const created = runIntent(
      { type: "notes/create-user", consumeDraft: true },
      {
        noteId: `user:${Date.now()}-${++userNoteSequenceRef.current}`,
        timestamp: new Date().toISOString(),
      },
    );
    return created ? storedNoteToUserNote(created.note.note, file.path) : null;
  }, [fileByKey, runIntent, store]);

  /** Remove one in-memory user note by id. */
  const removeUserNote = useCallback(
    (noteId: string) => {
      withMissingNoteMessage(
        () => runIntent({ type: "notes/remove-user", noteId }),
        `No user note matches id ${noteId}.`,
      );
    },
    [runIntent],
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
    // Counted from the store, so notes on a file a reload retired still count as tracked.
    liveCommentCount: state.liveNotes.length,
    liveCommentSummaries,
    liveCommentsByFileId,
    lineCursor,
    lineCursorRevealRequestId,
    reviewNoteCount: reviewNoteSummaries.length,
    reviewNoteSummaries,
    showAgentNotes: state.showAgentNotes,
    userNotesByFileId,
    scrollToNote,
    selectedFile,
    selectedFileId,
    selectedFileTopAlignRequestId: state.reveal.fileTopToken,
    selectedHunkRevealRequestId: state.reveal.hunkToken,
    selectedHunk,
    selectedHunkIndex,
    sourceStatusByFileId,
    toggleGap,
    toggleSelectedHunkGap,
    visibleFiles,
    addLiveComment,
    addLiveCommentBatch,
    anchorLineCursor,
    clearFilter,
    cancelDraftNote,
    clearLiveComments,
    moveLineCursor,
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
    setShowAgentNotes,
    startUserNote,
    setFilter,
    updateDraftNote,
  };
}
