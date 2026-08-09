/**
 * Terminal review-stream state projected from the runtime-owned semantic store.
 *
 * This hook owns renderer-local filtering, merged note presentation, selection,
 * drafts, cursor movement, and relative terminal navigation. Session commands
 * mutate the same store exclusively through ReviewSessionRuntime.
 */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { firstCommentTargetForHunk } from "../../core/liveComments";
import { reviewLineContextDigest } from "../../core/review/reconcile";
import { projectReviewNote } from "../../core/review/notes";
import { isRenderableStoredReviewNote } from "../../core/review/state";
import type { ReviewStore } from "../../core/review/store";
import type { ReviewFileV1, ReviewNoteV1 } from "../../core/review/types";
import type { AgentAnnotation, DiffFile, UserNoteLineTarget } from "../../core/types";
import type { LiveComment } from "../../session/types";
import type { FileSourceStatus } from "../diff/expandCollapsedRows";
import { selectGapForKeyboardToggle } from "../diff/expandCollapsedRows";
import { trailingCollapsedLines } from "../diff/pierre";
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
import {
  buildReviewStreamState,
  findNextAnnotatedFile,
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

export interface ReviewSelectionOptions {
  alignFileHeaderTop?: boolean;
  preserveViewport?: boolean;
  scrollToNote?: boolean;
}

export interface ReviewController {
  store: ReviewStore;
  allFiles: DiffFile[];
  expandedGapsByFileId: Record<string, ReadonlySet<string>>;
  filter: string;
  draftNote: DraftReviewNote | null;
  liveCommentsByFileId: Record<string, LiveComment[]>;
  showAgentNotes: boolean;
  setShowAgentNotes: (visible: boolean) => void;
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
  clearFilter: () => void;
  cancelDraftNote: () => void;
  removeUserNote: (noteId: string) => void;
  saveDraftNote: () => UserReviewNote | null;
  selectFile: (fileId: string, nextHunkIndex?: number, options?: ReviewSelectionOptions) => void;
  selectHunk: (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => void;
  startUserNote: (
    fileId?: string,
    hunkIndex?: number,
    target?: UserNoteLineTarget,
    options?: { preserveViewport?: boolean },
  ) => DraftReviewNote | null;
  setFilter: (value: string) => void;
  updateDraftNote: (body: string) => void;
}

/** Adapt one renderer-neutral mutable note back to the terminal annotation model. */
function noteToTerminalAnnotation(note: ReviewNoteV1, filePath: string): LiveComment {
  const preferred = note.anchor.preferred ?? { side: "new" as const, line: 1 };
  return {
    id: note.id,
    source: "mcp",
    filePath,
    hunkIndex: note.anchor.ownerHunkIndex ?? 0,
    side: preferred.side,
    line: preferred.line,
    ...(note.anchor.oldRange ? { oldRange: [...note.anchor.oldRange] as [number, number] } : {}),
    ...(note.anchor.newRange ? { newRange: [...note.anchor.newRange] as [number, number] } : {}),
    summary: note.summary,
    ...(note.rationale !== undefined ? { rationale: note.rationale } : {}),
    ...(note.markup !== undefined ? { markup: note.markup } : {}),
    ...(note.author !== undefined ? { author: note.author } : {}),
    createdAt: note.createdAt ?? "1970-01-01T00:00:00.000Z",
  };
}

/** Capture independent reload evidence for every side range a mutable note declares. */
function mutableNoteContextDigests(
  file: ReviewFileV1,
  ranges: Pick<AgentAnnotation, "oldRange" | "newRange">,
) {
  return {
    ...(ranges.oldRange ? { old: reviewLineContextDigest(file, "old", ranges.oldRange[0]) } : {}),
    ...(ranges.newRange ? { new: reviewLineContextDigest(file, "new", ranges.newRange[0]) } : {}),
  };
}

export function useReviewController({
  files,
  reviewStore,
  lineCursors = EMPTY_LINE_CURSORS,
  onMutationError,
  toggleSourceGap,
}: {
  files: DiffFile[];
  reviewStore: ReviewStore;
  /**
   * Navigable lines in rendered order, published by the pane that measures the review stream.
   * Headless callers get none, which leaves `j` and `k` scrolling the viewport.
   */
  lineCursors?: LineCursor[];
  /** Surface a rejected authoritative mutation without discarding local draft state. */
  onMutationError?: (error: unknown) => void;
  /** Runtime-owned generation-safe source expansion adapter. */
  toggleSourceGap?: (fileKey: string, gapId: string) => void;
}): ReviewController {
  const store = reviewStore;
  const document = reviewStore.getSnapshot().document;
  const reviewSnapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const filter = reviewSnapshot.filter;
  const selectedFileKey = reviewSnapshot.selection.fileKey;
  const selectedHunkIndex = reviewSnapshot.selection.hunkIndex;
  const selectedFileTopAlignRequestId = reviewSnapshot.reveal.fileTopToken;
  const selectedHunkRevealRequestId = reviewSnapshot.reveal.hunkToken;
  const [lineCursor, setLineCursor] = useState<LineCursor | null>(null);
  // A held key drains as one stdin chunk, so every press in the burst would otherwise read the
  // same pre-batch state and the cursor would advance a single row.
  const lineCursorRef = useRef<LineCursor | null>(null);
  // The store owns reveal intent. This ref only withholds that token from the renderer until its
  // measured cursor has adopted the same semantic address.
  const renderedLineRevealTokenRef = useRef(0);
  const previousLineCursorsRef = useRef(lineCursors);
  const pendingLineCursorRef = useRef<
    | { kind: "reveal"; fileId: string; gapKey: string }
    | { kind: "restore"; cursor: LineCursor }
    | null
  >(null);
  const lineCursorBeforeExpandRef = useRef(new Map<string, LineCursor>());
  const scrollToNote = reviewSnapshot.reveal.scrollToNote;
  const keyByFileId = useMemo(
    () => new Map(document.files.map((file) => [file.runtimeId, file.key])),
    [document],
  );
  const semanticFileByKey = useMemo(
    () => new Map(document.files.map((file) => [file.key, file])),
    [document],
  );
  const lineCursorMatchesSelection =
    lineCursor !== null &&
    keyByFileId.get(lineCursor.fileId) === reviewSnapshot.selection.fileKey &&
    lineCursor.hunkIndex === reviewSnapshot.selection.hunkIndex &&
    lineCursor.target.side === reviewSnapshot.selection.side &&
    lineCursor.target.line === reviewSnapshot.selection.line;
  if (lineCursorMatchesSelection) {
    renderedLineRevealTokenRef.current = reviewSnapshot.reveal.lineToken;
  }
  const lineCursorRevealRequestId = renderedLineRevealTokenRef.current;
  const terminalFileByKey = useMemo(() => {
    const terminalByRuntimeId = new Map(files.map((file) => [file.id, file] as const));
    return new Map(
      document.files.flatMap((semantic) => {
        const file = terminalByRuntimeId.get(semantic.runtimeId);
        return file ? [[semantic.key, file] as const] : [];
      }),
    );
  }, [document.files, files]);
  const liveCommentsByFileId = useMemo<Record<string, LiveComment[]>>(() => {
    const result: Record<string, LiveComment[]> = {};
    for (const entry of reviewSnapshot.liveNotes) {
      if (!isRenderableStoredReviewNote(entry)) continue;
      const file = terminalFileByKey.get(entry.note.fileKey);
      if (!file) continue;
      result[file.id] = [
        ...(result[file.id] ?? []),
        noteToTerminalAnnotation(entry.note, file.path),
      ];
    }
    return result;
  }, [reviewSnapshot.liveNotes, terminalFileByKey]);
  const userNotesByFileId = useMemo<Record<string, UserReviewNote[]>>(() => {
    const result: Record<string, UserReviewNote[]> = {};
    for (const entry of reviewSnapshot.userNotes) {
      if (!isRenderableStoredReviewNote(entry)) continue;
      const file = terminalFileByKey.get(entry.note.fileKey);
      if (!file) continue;
      const annotation = noteToTerminalAnnotation(entry.note, file.path);
      result[file.id] = [
        ...(result[file.id] ?? []),
        {
          ...annotation,
          source: "user",
          editable: true,
          author: entry.note.author ?? "user",
        },
      ];
    }
    return result;
  }, [reviewSnapshot.userNotes, terminalFileByKey]);
  // Monotonic suffix keeps human note ids unique inside one millisecond.
  const userNoteSequenceRef = useRef(0);
  const draftNote = useMemo<DraftReviewNote | null>(() => {
    const draft = reviewSnapshot.draftNote;
    if (!draft) return null;
    const file = terminalFileByKey.get(draft.fileKey);
    if (!file) return null;
    return { ...draft, fileId: file.id, filePath: file.path };
  }, [reviewSnapshot.draftNote, terminalFileByKey]);
  const expandedGapsByFileId = useMemo<Record<string, ReadonlySet<string>>>(() => {
    const result: Record<string, ReadonlySet<string>> = {};
    for (const gap of reviewSnapshot.expandedGaps) {
      const file = terminalFileByKey.get(gap.fileKey);
      if (!file) continue;
      const gaps = new Set(result[file.id] ?? []);
      if (gap.expanded) gaps.add(gap.gapId);
      else gaps.delete(gap.gapId);
      result[file.id] = gaps;
    }
    return result;
  }, [reviewSnapshot.expandedGaps, terminalFileByKey]);
  const sourceStatusByFileId = useMemo<Record<string, FileSourceStatus>>(() => {
    const result: Record<string, FileSourceStatus> = {};
    for (const [fileKey, status] of Object.entries(reviewSnapshot.sourceStatusByFileKey)) {
      const file = terminalFileByKey.get(fileKey);
      if (file && status.kind !== "idle") result[file.id] = status;
    }
    return result;
  }, [reviewSnapshot.sourceStatusByFileKey, terminalFileByKey]);
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
  const selectedFileId = terminalFileByKey.get(selectedFileKey ?? "")?.id ?? "";
  const selectedFile = useMemo(
    () => resolveSelectedFile(visibleFiles, selectedFileId),
    [selectedFileId, visibleFiles],
  );
  const selectedHunk = selectedFile?.metadata.hunks[selectedHunkIndex];

  /** Update authoritative semantic selection and reveal intent in one dispatch. */
  const selectHunk = useCallback(
    (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => {
      const fileKey = keyByFileId.get(fileId);
      if (!fileKey) return;
      const current = store.getSnapshot().selection;
      const preserveAddress =
        options?.preserveViewport && current.fileKey === fileKey && current.hunkIndex === hunkIndex;
      store.dispatch({
        type: "selection/select",
        selection: preserveAddress ? { ...current, fileKey, hunkIndex } : { fileKey, hunkIndex },
        ...(!options?.preserveViewport
          ? {
              reveal: {
                kind: options?.alignFileHeaderTop ? ("file-top" as const) : ("hunk" as const),
                scrollToNote: options?.scrollToNote,
              },
            }
          : {}),
      });
    },
    [keyByFileId, store],
  );

  /** Select one file and optionally one specific hunk within it. */
  const selectFile = useCallback(
    (fileId: string, nextHunkIndex = 0, options?: ReviewSelectionOptions) => {
      selectHunk(fileId, nextHunkIndex, options);
    },
    [selectHunk],
  );

  /**
   * Keep the current line on a row the review stream still renders.
   *
   * Seeding from the selected hunk makes the marker visible from launch, not just after the
   * first keypress.
   */
  const applyLineCursor = useCallback(
    (next: LineCursor | null, options?: { reveal?: boolean }) => {
      lineCursorRef.current = next;
      setLineCursor(next);
      if (!next) return;
      const fileKey = keyByFileId.get(next.fileId);
      const semanticFile = fileKey ? semanticFileByKey.get(fileKey) : undefined;
      if (!fileKey || !semanticFile) return;
      store.dispatch({
        type: "selection/set-line",
        fileKey,
        hunkIndex: next.hunkIndex,
        side: next.target.side,
        line: next.target.line,
        contextDigest: reviewLineContextDigest(semanticFile, next.target.side, next.target.line),
        reveal: options?.reveal,
      });
    },
    [keyByFileId, semanticFileByKey, store],
  );

  /** Move the current line to a row the reviewer just asked to see, and scroll to it. */
  const revealLineCursor = useCallback(
    (cursor: LineCursor) => {
      applyLineCursor(cursor, { reveal: true });
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

    const semanticSelection = store.getSnapshot().selection;
    if (
      semanticSelection.fileKey === selectedFileKey &&
      semanticSelection.side &&
      semanticSelection.line !== undefined
    ) {
      // External store dispatches own the semantic line. React only resolves that address
      // to the renderer's measured cursor and must never overwrite it from stale local state.
      applyLineCursor(
        lineCursors.length > 0
          ? lineCursorAt(lineCursors, selectedFileId, selectedHunkIndex, {
              side: semanticSelection.side,
              line: semanticSelection.line,
            })
          : null,
      );
      return;
    }

    const resolved = resolveLineCursor(lineCursors, lineCursorRef.current);
    if (resolved?.fileId === selectedFileId && resolved?.hunkIndex === selectedHunkIndex) {
      applyLineCursor(resolved);
      return;
    }

    applyLineCursor(firstLineCursorInHunk(lineCursors, selectedFileId, selectedHunkIndex));
  }, [
    applyLineCursor,
    lineCursors,
    revealLineCursor,
    selectedFileId,
    reviewSnapshot.selection.contextDigest,
    reviewSnapshot.selection.line,
    reviewSnapshot.selection.side,
    selectedFileKey,
    selectedHunkIndex,
    store,
  ]);

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

  /** Set the shared semantic file filter. */
  const setFilter = useCallback(
    (value: string) => store.dispatch({ type: "filter/set", filter: value }),
    [store],
  );

  /** Set shared note-layer visibility. */
  const setShowAgentNotes = useCallback(
    (visible: boolean) => store.dispatch({ type: "notes/set-visibility", visible }),
    [store],
  );

  /** Clear the active file filter without touching the current selection. */
  const clearFilter = useCallback(() => {
    setFilter("");
  }, [setFilter]);

  /** Keep terminal cursor restoration local while runtime owns expansion and source loading. */
  const toggleGap = useCallback(
    (fileId: string, gapKey: string) => {
      const file = allFiles.find((entry) => entry.id === fileId);
      const fileKey = keyByFileId.get(fileId);
      if (!file?.sourceFetcher || !fileKey || !toggleSourceGap) return;
      const restorePointKey = `${fileId}:${gapKey}`;
      const restorePoint = lineCursorBeforeExpandRef.current.get(restorePointKey) ?? null;
      const expanding = !store
        .getSnapshot()
        .expandedGaps.some(
          (gap) => gap.fileKey === fileKey && gap.gapId === gapKey && gap.expanded,
        );
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
      toggleSourceGap(fileKey, gapKey);
    },
    [allFiles, keyByFileId, store, toggleSourceGap],
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
      if (!file || !hunk) {
        return null;
      }

      const target = requestedTarget ?? firstCommentTargetForHunk(hunk);
      applyLineCursor(lineCursorAt(lineCursors, file.id, hunkIndex, target));
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
      store.dispatch({
        type: "draft/start",
        expectedGeneration: store.getSnapshot().documentGeneration,
        draft: {
          id: draft.id,
          fileKey: keyByFileId.get(file.id)!,
          hunkIndex,
          side: draft.side,
          line: draft.line,
          ...(draft.oldRange ? { oldRange: draft.oldRange } : {}),
          ...(draft.newRange ? { newRange: draft.newRange } : {}),
          body: "",
        },
      });
      selectHunk(
        file.id,
        hunkIndex,
        options?.preserveViewport ? { preserveViewport: true } : { scrollToNote: true },
      );
      return draft;
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
      const snapshot = store.getSnapshot();
      store.dispatch({
        type: "draft/update",
        expectedGeneration: snapshot.documentGeneration,
        body,
      });
    },
    [store],
  );

  /** Discard the active human note draft. */
  const cancelDraftNote = useCallback(() => {
    const snapshot = store.getSnapshot();
    store.dispatch({ type: "draft/cancel", expectedGeneration: snapshot.documentGeneration });
  }, [store]);

  /** Persist the active draft into the authoritative user-note collection exactly once. */
  const saveDraftNote = useCallback((): UserReviewNote | null => {
    const snapshot = store.getSnapshot();
    const semanticDraft = snapshot.draftNote;
    if (!semanticDraft) return null;
    const file = terminalFileByKey.get(semanticDraft.fileKey);
    if (!file) return null;
    const body = semanticDraft.body.trim();
    if (!body) {
      store.dispatch({ type: "draft/cancel", expectedGeneration: snapshot.documentGeneration });
      return null;
    }

    const savedNote: UserReviewNote = {
      id: `user:${Date.now()}-${++userNoteSequenceRef.current}`,
      source: "user",
      filePath: file.path,
      hunkIndex: semanticDraft.hunkIndex,
      side: semanticDraft.side,
      line: semanticDraft.line,
      oldRange: semanticDraft.oldRange,
      newRange: semanticDraft.newRange,
      summary: body,
      author: "user",
      createdAt: new Date().toISOString(),
      editable: true,
    };
    const semanticFile = semanticFileByKey.get(semanticDraft.fileKey)!;
    const beforeCount = snapshot.userNotes.length;
    try {
      store.dispatch({
        type: "draft/save",
        expectedGeneration: snapshot.documentGeneration,
        note: {
          note: projectReviewNote({
            annotation: savedNote,
            fileKey: semanticDraft.fileKey,
            hunks: file.metadata.hunks,
            origin: "user",
            editable: true,
          }),
          contextDigest: reviewLineContextDigest(
            semanticFile,
            semanticDraft.side,
            semanticDraft.line,
          ),
          contextDigests: mutableNoteContextDigests(semanticFile, semanticDraft),
          resolution: "active",
        },
      });
    } catch (error) {
      onMutationError?.(error);
      return null;
    }
    const storedId = store.getSnapshot().userNotes[beforeCount]?.note.id;
    return storedId && storedId !== savedNote.id ? { ...savedNote, id: storedId } : savedNote;
  }, [onMutationError, semanticFileByKey, store, terminalFileByKey]);

  /** Remove one in-memory user note by id. */
  const removeUserNote = useCallback(
    (noteId: string) => {
      const snapshot = store.getSnapshot();
      if (!snapshot.userNotes.some((entry) => entry.note.id === noteId)) {
        throw new Error(`No user note matches id ${noteId}.`);
      }
      store.dispatch({
        type: "notes/remove-user",
        expectedGeneration: snapshot.documentGeneration,
        noteId,
      });
    },
    [store],
  );

  return {
    store,
    allFiles,
    draftNote,
    expandedGapsByFileId,
    filter,
    liveCommentsByFileId,
    lineCursor,
    lineCursorRevealRequestId,
    showAgentNotes: reviewSnapshot.showAgentNotes,
    setShowAgentNotes,
    userNotesByFileId,
    scrollToNote,
    selectedFile,
    selectedFileId,
    selectedFileTopAlignRequestId,
    selectedHunkRevealRequestId,
    selectedHunk,
    selectedHunkIndex,
    sourceStatusByFileId,
    toggleGap,
    toggleSelectedHunkGap,
    visibleFiles,
    anchorLineCursor,
    clearFilter,
    cancelDraftNote,
    moveLineCursor,
    moveToAnnotatedFile,
    moveToAnnotatedHunk,
    moveToFile,
    moveToHunk,
    removeUserNote,
    saveDraftNote,
    selectFile,
    selectHunk,
    startUserNote,
    setFilter,
    updateDraftNote,
  };
}
