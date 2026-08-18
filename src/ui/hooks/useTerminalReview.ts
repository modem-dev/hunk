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
 * same hook for daemon-driven navigation and agent notes.
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
  type UserNoteLineTarget,
} from "../../core/liveComments";
import {
  builtinAppCommand,
  lowerAppCommandToReviewIntent,
  type AppCommandId,
  type AppCommandLoweringContext,
} from "../../core/run/commandCatalog";
import { SourceTextTooLargeError } from "../../core/changeset/fileSource";
import {
  applyReviewIntent,
  ReviewIntentPlanningError,
  type ReviewIntent,
  type ReviewIntentFacts,
} from "../../core/review/intents";
import { projectReviewDocument } from "../../core/review/document";
import { reviewExpansionSide } from "../../core/review/expansion";
import { reviewHunkIndexForLine } from "../../core/review/geometry";
import type { ReviewSelectionScope } from "../../core/review/navigation";
import {
  reviewFileKeysWithRetiredContent,
  selectExpandedGapIdsByFileKey,
  selectNormalizedSelection,
} from "../../core/review/selectors";
import { REVIEW_VIEWPORT_ANCHOR_REVEAL, type ReviewRevealRequest } from "../../core/review/state";
import { createReviewStore, type ReviewStore } from "../../core/review/store";
import { noDiffFileMatchesMessage } from "../../session/agent/errors";
import type { DiffFile } from "../../core/changeset/model";
import type { LayoutMode } from "../../core/run/commandInputs";
import type { AgentAnnotation } from "../../extension-api/types";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  AppliedHighlightResult,
  ClearedCommentsResult,
  ClearedHighlightsResult,
  CommentBatchItemInput,
  CommentToolInput,
  HighlightToolInput,
  LiveComment,
  NavigateToHunkToolInput,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../../session/types";
import type { FileSourceStatus } from "../diff/expandCollapsedRows";
import { carryOverLineHighlights } from "../highlights/reconcile";
import {
  MAX_LINE_HIGHLIGHTS_PER_FILE,
  MAX_LINE_HIGHLIGHTS_PER_LINE,
  validateLineHighlights,
  type ValidatedLineHighlight,
} from "../highlights/validate";

import type { LineRevealPlacement } from "../lib/hunkScroll";
import {
  EMPTY_LINE_CURSORS,
  findLineCursorAt,
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
} from "../lib/reviewNoteMapping";
import { buildReviewAnnotationIndex } from "../../core/review/annotations";
import {
  buildReviewStreamState,
  buildSelectedHunkSummary,
  planTerminalSelectionReconciliation,
  resolveReviewNavigationTarget,
} from "../lib/reviewState";

const EMPTY_AGENT_LINE_HIGHLIGHTS: ReadonlyMap<string, readonly ValidatedLineHighlight[]> =
  new Map();

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

/**
 * One request to scroll the current line into view, and how far it may move the viewport.
 *
 * Carried as one object because the id and the placement have to change together: a consumer
 * that read a bumped id against a stale placement would scroll by the previous policy.
 */
export interface LineCursorRevealRequest {
  id: number;
  placement: LineRevealPlacement;
}

/**
 * What a `revealLine` call could actually reach.
 *
 * `"line"` landed on the requested line, `"hunk"` fell back to the hunk containing it because
 * the review stream draws no row for that line, and `"none"` means no hunk covers it either.
 */
export type RevealedLineResult = "line" | "hunk" | "none";

export interface ReviewSelectionOptions {
  alignFileHeaderTop?: boolean;
  scrollToNote?: boolean;
}

/**
 * Translate the terminal's selection options into the shared reveal request.
 *
 * Selections that deliberately leave the viewport alone do not come through here at all:
 * that is the viewport-anchor policy, expressed as its own intent.
 */
function revealRequestFor(options?: ReviewSelectionOptions): ReviewRevealRequest {
  return {
    anchor: options?.alignFileHeaderTop ? "file-top" : "hunk",
    scrollToNote: Boolean(options?.scrollToNote),
  };
}

export interface TerminalReview {
  allFiles: DiffFile[];
  /**
   * The semantic review store this controller owns.
   *
   * Exposed so the host can attach it to the producer that publishes this review: a
   * brokered action and a key press must plan against the same state, not against two
   * stores that happen to hold the same content.
   */
  store: ReviewStore;
  /** The store's monotonic revision, reported to anyone ordering this review's publications. */
  stateRevision: number;
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
  /** Read the current cursor synchronously between terminal key events. */
  getLineCursor: () => LineCursor | null;
  /** Read the current normalized selection synchronously with the cursor. */
  getSelection: () => { fileId: string | null; hunkIndex: number | null };
  lineCursorRevealRequest: LineCursorRevealRequest;
  anchorLineCursor: (cursor: LineCursor) => void;
  /** Adopt the hunk a viewport settled on, without asking any viewport to move. */
  anchorSelection: (fileId: string, hunkIndex: number) => void;
  moveLineCursor: (delta: number) => void;
  /** Step the selection through one navigable scope; the scope owns wrap and reveal. */
  moveSelection: (scope: ReviewSelectionScope, delta: number) => void;
  revealLine: (fileId: string, side: "old" | "new", line: number) => RevealedLineResult;
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
  /** Agent attention marks per file id, painted through the extension line-highlight pipeline. */
  agentLineHighlightsByFileId: ReadonlyMap<string, readonly ValidatedLineHighlight[]>;
  addAgentLineHighlight: (input: HighlightToolInput) => AppliedHighlightResult;
  clearAgentLineHighlights: (filePath?: string) => ClearedHighlightsResult;
  cancelDraftNote: () => void;
  removeUserNote: (noteId: string) => void;
  saveDraftNote: () => UserReviewNote | null;
  /** Jump to one file; the shared file-jump rule decides which hunk it lands on. */
  selectFile: (fileId: string, options?: ReviewSelectionOptions) => void;
  selectHunk: (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => void;
  setShowAgentNotes: (visible: boolean) => void;
  /** Flip the note layer the way the catalogued toggle command declares it. */
  toggleAgentNotes: () => void;
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
export function useTerminalReview({
  files,
  initialShowAgentNotes = false,
  lineCursors = EMPTY_LINE_CURSORS,
  noteGeometry,
  sourceLabel = "",
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
  /**
   * Identity of the review's input as a whole.
   *
   * Part of every semantic file key, so the document this controller projects addresses
   * files exactly as the producer's published generation does. Without it the two would
   * key the same review differently and an action addressed by one could not be planned
   * against the other.
   */
  sourceLabel?: string;
  /** Allow STML bodies for live comments in this explicitly opted-in session. */
  stmlEnabled?: boolean;
  /**
   * Mutable ref the app keeps pointed at the current layout and pane width.
   * A ref (not a value) because App computes geometry after this hook runs;
   * daemon commands arrive asynchronously, so reads always see fresh state.
   */
  noteGeometry?: { current: AgentNoteGeometrySnapshot | null };
}): TerminalReview {
  const document = useMemo(
    () => projectReviewDocument(files, { sourceLabel }),
    [files, sourceLabel],
  );
  const [store] = useState(() =>
    createReviewStore(document, { showAgentNotes: initialShowAgentNotes }),
  );
  const sourceLoadRequestsRef = useRef(new Map<string, SourceLoadRequest>());
  const nextSourceLoadRequestIdRef = useRef(1);
  const lineCursorBeforeExpandRef = useRef(new Map<string, LineCursor>());

  const reconciledDocumentRef = useRef(document);

  // Agent attention marks, keyed by runtime file id. A ref backs the state so daemon
  // handlers can compute counts synchronously; both always move together.
  const agentLineHighlightsRef = useRef(EMPTY_AGENT_LINE_HIGHLIGHTS);
  const [agentLineHighlightsByFileId, setAgentLineHighlightsByFileId] = useState(
    EMPTY_AGENT_LINE_HIGHLIGHTS,
  );
  const commitAgentLineHighlights = useCallback(
    (next: ReadonlyMap<string, readonly ValidatedLineHighlight[]>) => {
      agentLineHighlightsRef.current = next;
      setAgentLineHighlightsByFileId(next);
    },
    [],
  );

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
    // Marks address exact character offsets in specific line content, and nothing re-derives
    // them after a reload the way extension highlighters re-run — a stale mark would silently
    // light up different text. Files that came back with identical content keep their marks,
    // re-keyed onto the replacement runtime ids; every other mark is dropped.
    if (agentLineHighlightsRef.current.size > 0) {
      const carried = carryOverLineHighlights(agentLineHighlightsRef.current, previous, document);
      commitAgentLineHighlights(carried.size > 0 ? carried : EMPTY_AGENT_LINE_HIGHLIGHTS);
    }
    store.dispatch({ type: "document/reconcile", document });
  }, [commitAgentLineHighlights, document, store]);

  const state = useReviewStoreSnapshot(store);
  const filter = state.filter;
  const scrollToNote = state.reveal.scrollToNote;
  const [lineCursor, setLineCursor] = useState<LineCursor | null>(null);
  // A held key drains as one stdin chunk, so every press in the burst would otherwise read the
  // same pre-batch state and the cursor would advance a single row.
  const lineCursorRef = useRef<LineCursor | null>(null);
  /** Read the latest cursor without waiting for React to publish a render. */
  const getLineCursor = useCallback(() => lineCursorRef.current, []);
  const [lineCursorRevealRequest, setLineCursorRevealRequest] = useState<LineCursorRevealRequest>({
    id: 0,
    placement: "nearest",
  });
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
  const { allFiles, visibleFiles } = useMemo(
    () =>
      buildReviewStreamState({
        files,
        liveCommentsByFileId: mergeAnnotationMaps(liveCommentsByFileId, userNotesByFileId),
        filterQuery: deferredFilter,
      }),
    [deferredFilter, files, liveCommentsByFileId, userNotesByFileId],
  );
  // Which files and hunks carry notes, for the shared annotated-navigation planner. Built
  // from the merged stream, so a live comment that just arrived is navigable immediately.
  const annotations = useMemo(
    () => buildReviewAnnotationIndex(allFiles, keyByFileId),
    [allFiles, keyByFileId],
  );
  // The shared normalization rule, not a terminal copy: a selected file the filter hides
  // is still the selection, and only a file the document lost falls back to the first
  // visible one.
  const normalizedSelection = selectNormalizedSelection(state);
  const selectedHunkIndex = normalizedSelection.hunkIndex;
  const selectedFileId = normalizedSelection.fileKey
    ? (fileByKey.get(normalizedSelection.fileKey)?.id ?? "")
    : "";
  const selectedFile = normalizedSelection.fileKey
    ? fileByKey.get(normalizedSelection.fileKey)
    : undefined;
  const selectedHunk = selectedFile?.metadata.hunks[selectedHunkIndex];

  /** Read the normalized selection from the store without waiting for a React render. */
  const getSelection = useCallback(() => {
    const selection = selectNormalizedSelection(store.getSnapshot());
    const file = selection.fileKey ? fileByKey.get(selection.fileKey) : undefined;
    return { fileId: file?.id ?? null, hunkIndex: file ? selection.hunkIndex : null };
  }, [fileByKey, store]);

  /** Run one semantic intent against the review store. */
  const runIntent = useCallback(
    <T extends ReviewIntent>(intent: T, facts?: ReviewIntentFacts) =>
      applyReviewIntent(store, intent, facts),
    [store],
  );

  /**
   * Lower one built-in command to the intent its catalog entry declares.
   *
   * The terminal invokes these commands from keys, menus, and the mouse, and lowers each
   * one here rather than restating its effect: what "toggle the note layer" or "toggle the
   * nearest gap" means is the catalog's declaration, and this hook only supplies the facts
   * a renderer owns and keeps the bookkeeping that follows.
   */
  const lowerCommand = useCallback(
    (id: AppCommandId, facts?: Omit<AppCommandLoweringContext, "count" | "state">) =>
      lowerAppCommandToReviewIntent(builtinAppCommand(id), {
        count: 1,
        state: store.getSnapshot(),
        ...facts,
      }),
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

  /**
   * Adopt a selection the viewport arrived at on its own.
   *
   * Scrolling reports where the reviewer is; it never asks to be scrolled back, and with
   * several surfaces attached to one review it must not move anybody else's viewport
   * either. That is the shared anchor policy rather than a local "preserve viewport" flag.
   */
  const anchorSelection = useCallback(
    (fileId: string, hunkIndex: number) => {
      const fileKey = keyByFileId.get(fileId);
      if (!fileKey) {
        return;
      }

      runIntent({ type: "selection/anchor", fileKey, hunkIndex });
    },
    [keyByFileId, runIntent],
  );

  /** Jump to one file through the shared file-jump rule. */
  const selectFile = useCallback(
    (fileId: string, options?: ReviewSelectionOptions) => {
      const fileKey = keyByFileId.get(fileId);
      if (!fileKey) {
        return;
      }

      runIntent({ type: "selection/select-file", fileKey, reveal: revealRequestFor(options) });
    },
    [keyByFileId, runIntent],
  );

  /** Reconcile only a stale document selection; filtering preserves the reviewer's place. */
  const reconcileSelection = useCallback(() => {
    const action = planTerminalSelectionReconciliation(store.getSnapshot());
    if (action) {
      store.dispatch(action);
    }
  }, [store]);

  useEffect(() => {
    reconcileSelection();
    // The store's own state is what needs reconciling, so re-run when it moves.
  }, [reconcileSelection, state.document, state.filter, state.selection]);

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
    (cursor: LineCursor, placement: LineRevealPlacement = "nearest") => {
      applyLineCursor(cursor);
      setLineCursorRevealRequest((current) => ({ id: current.id + 1, placement }));
      // The line cursor carries its own reveal request; the selection only follows it.
      anchorSelection(cursor.fileId, cursor.hunkIndex);
    },
    [anchorSelection, applyLineCursor],
  );

  const reconcileLineCursor = useCallback(() => {
    // A hidden line-level navigation (`cursor_line = "off"`) keeps no stop list, so there
    // is nothing to resolve against: keep a cursor a direct reveal placed on the selected
    // hunk, and drop it once the selection moves somewhere else.
    if (lineCursors.length === 0) {
      const current = lineCursorRef.current;
      if (
        current !== null &&
        (current.fileId !== selectedFileId || current.hunkIndex !== selectedHunkIndex)
      ) {
        applyLineCursor(null);
      }
      return;
    }

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
      anchorSelection(cursor.fileId, cursor.hunkIndex);
    },
    [anchorSelection, applyLineCursor],
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

  // `revealLine` is handed to surfaces that hold it across commits — a memoized
  // extension pane keeps its mount-time `actions`, and an async command handler
  // may navigate long after its dispatch render. Reading these through the
  // callback's own closure silently downgraded such a call to the hunk
  // fallback: at mount the pane captured a `revealLine` whose cursor list was
  // still the pre-measurement empty state, so the first deferred jump of a
  // session landed on the hunk anchor. Refs keep any held reference live.
  const lineCursorsForRevealRef = useRef(lineCursors);
  lineCursorsForRevealRef.current = lineCursors;
  const visibleFilesRef = useRef(visibleFiles);
  visibleFilesRef.current = visibleFiles;

  /**
   * Step the selection through one navigable scope.
   *
   * The walk itself — which hunk or file is next, whether the scope wraps, and what the
   * landing asks the viewport to reveal — lives in the shared planner, so the keyboard,
   * the session's comment navigation, and later a browser client all move identically.
   */
  const moveSelection = useCallback(
    (scope: ReviewSelectionScope, delta: number) =>
      runIntent({ type: "selection/move", scope, delta }, { annotations }),
    [annotations, runIntent],
  );

  /**
   * Jump to one file's source line, addressed the way a patch numbers it.
   *
   * Cursors are measured for every visible file, not just the selected one, so a cross-file
   * jump resolves in the same pass as a local one. A line the stream draws no row for — hidden
   * inside a collapsed gap, or never numbered by a partial patch — has no row to scroll to, so
   * the jump degrades to the hunk containing it and reports which target it reached.
   */
  const revealLine = useCallback(
    (fileId: string, side: "old" | "new", line: number): RevealedLineResult => {
      const cursors = lineCursorsForRevealRef.current;
      const stopped = findLineCursorAt(cursors, fileId, side, line);
      if (stopped) {
        revealLineCursor(stopped, "reveal");
        return "line";
      }

      const file = visibleFilesRef.current.find((candidate) => candidate.id === fileId);
      const hunkIndex = file ? reviewHunkIndexForLine(file.metadata.hunks, side, line) : -1;
      if (hunkIndex < 0) {
        return "none";
      }

      // An empty list means line-level navigation is hidden (`cursor_line = "off"`), not
      // that the target row is missing: synthesize the line's cursor and reveal it exactly.
      if (cursors.length === 0) {
        revealLineCursor(lineCursorAt(cursors, fileId, hunkIndex, { side, line }), "reveal");
        return "line";
      }

      selectHunk(fileId, hunkIndex);
      return "hunk";
    },
    [revealLineCursor, selectHunk],
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

  /** Flip the shared agent note layer, as the catalogued command declares that flip. */
  const toggleAgentNotes = useCallback(() => {
    const intent = lowerCommand("hunk.view.toggleAgentNotes");
    if (intent) {
      runIntent(intent);
    }
  }, [lowerCommand, runIntent]);

  /** Start one full-source load and mirror its progress into review state as a status. */
  const startSourceLoad = useCallback(
    (file: DiffFile, fileKey: string, side: SourceLoadRequest["side"]) => {
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
  // may no longer contain. The side is the shared expansion-side policy, since no
  // intent outcome is in hand on a reload.
  useEffect(() => {
    const snapshot = store.getSnapshot();
    for (const gap of snapshot.expandedGaps) {
      if (!gap.expanded || snapshot.sourceStatusByFileKey[gap.fileKey]) {
        continue;
      }
      const file = fileByKey.get(gap.fileKey);
      if (file?.sourceFetcher) {
        startSourceLoad(file, gap.fileKey, reviewExpansionSide(file.metadata.type));
      }
    }
  }, [fileByKey, startSourceLoad, store, state.document]);

  /** Run one expansion toggle plus the line-cursor bookkeeping that belongs to the terminal. */
  const applyGapToggle = useCallback(
    (file: DiffFile, intent: Extract<ReviewIntent, { type: "expansion/toggle" }>) => {
      const restorePointKey = `${file.id}:${intent.gapId}`;
      const restorePoint = lineCursorBeforeExpandRef.current.get(restorePointKey) ?? null;
      const cursorBeforeToggle = lineCursorRef.current;
      // The intent decides whether this is an expand or a collapse and reports the side
      // whose source fills the gap; the line-cursor bookkeeping below is the terminal's
      // own, and reads that decision rather than predicting it.
      const toggled = runIntent(intent);
      if (toggled.expanded) {
        if (cursorBeforeToggle) {
          lineCursorBeforeExpandRef.current.set(restorePointKey, cursorBeforeToggle);
        }
        pendingLineCursorRef.current = { kind: "reveal", fileId: file.id, gapKey: intent.gapId };
      } else {
        lineCursorBeforeExpandRef.current.delete(restorePointKey);
        pendingLineCursorRef.current = restorePoint
          ? { kind: "restore", cursor: restorePoint }
          : null;
      }

      startSourceLoad(file, intent.fileKey, toggled.side);
    },
    [runIntent, startSourceLoad],
  );

  /** Toggle expansion of one collapsed gap the renderer addressed by file id. */
  const toggleGap = useCallback(
    (fileId: string, gapKey: string) => {
      const file = allFiles.find((entry) => entry.id === fileId);
      const fileKey = keyByFileId.get(fileId);
      if (!file?.sourceFetcher || !fileKey) {
        return;
      }

      applyGapToggle(file, { type: "expansion/toggle", fileKey, gapId: gapKey });
    },
    [allFiles, applyGapToggle, keyByFileId],
  );

  /** Toggle the collapsed gap the catalogued "toggle unchanged context" command reaches. */
  const toggleSelectedHunkGap = useCallback(() => {
    const intent = lowerCommand("hunk.review.toggleHunkGap");
    if (intent?.type !== "expansion/toggle") {
      return;
    }

    const file = fileByKey.get(intent.fileKey);
    if (file?.sourceFetcher) {
      applyGapToggle(file, intent);
    }
  }, [applyGapToggle, fileByKey, lowerCommand]);

  /**
   * Resolve one session-daemon navigation request against the current review and select it.
   *
   * Relative comment navigation is the same walk the keyboard performs and goes through
   * the shared planner; only absolute addressing (a path plus a hunk or a line) is
   * resolved against the terminal's diff-file model here.
   */
  const navigateToLocation = useCallback(
    (input: NavigateToHunkToolInput): NavigatedSelectionResult => {
      if (input.commentDirection) {
        const moved = moveSelection("annotated-hunk", input.commentDirection === "next" ? 1 : -1);
        if (!moved) {
          throw new Error("No annotated hunks found in the current review.");
        }

        const file = fileByKey.get(moved.fileKey);
        if (!file) {
          throw new Error("Resolved annotated hunk references an unknown file.");
        }

        return {
          fileId: file.id,
          filePath: file.path,
          hunkIndex: moved.hunkIndex,
          selectedHunk: buildSelectedHunkSummary(file, moved.hunkIndex),
        };
      }

      const target = resolveReviewNavigationTarget({ allFiles, input });

      // A line target lands the viewport on the exact line through the same reveal path
      // `ctx.navigation.revealLine` uses, degrading to the hunk when the stream renders no
      // row for the line. `"none"` means the file is not currently visible, where only the
      // plain hunk selection below has defined behavior.
      if (input.hunkIndex === undefined && input.side && input.line !== undefined) {
        const reached = revealLine(target.file.id, input.side, input.line);
        if (reached !== "none") {
          return {
            fileId: target.file.id,
            filePath: target.file.path,
            hunkIndex: target.hunkIndex,
            selectedHunk: buildSelectedHunkSummary(target.file, target.hunkIndex),
            revealed: reached,
            side: input.side,
            line: input.line,
          };
        }
      }

      selectHunk(target.file.id, target.hunkIndex);
      return {
        fileId: target.file.id,
        filePath: target.file.path,
        hunkIndex: target.hunkIndex,
        selectedHunk: buildSelectedHunkSummary(target.file, target.hunkIndex),
      };
    },
    [allFiles, fileByKey, moveSelection, revealLine, selectHunk],
  );

  /**
   * Paint one agent attention mark, validated by the same contract extension line
   * highlighters answer to, so both sources feed one painted-mark pipeline.
   */
  const addAgentLineHighlight = useCallback(
    (input: HighlightToolInput): AppliedHighlightResult => {
      const file = findDiffFileByPath(allFiles, input.filePath);
      if (!file) {
        throw new Error(noDiffFileMatchesMessage(input.filePath));
      }

      // Requiring hunk coverage catches line-number typos the way comment targets do; the
      // agent-visible review model only exposes hunk-covered lines anyway.
      const hunkIndex = reviewHunkIndexForLine(file.metadata.hunks, input.side, input.line);
      if (hunkIndex < 0) {
        throw new Error(
          `No ${input.side} diff hunk in ${input.filePath} covers line ${input.line}.`,
        );
      }

      const validation = validateLineHighlights([
        { side: input.side, line: input.line, range: [input.start, input.end], tone: input.tone },
      ]);
      const mark = validation.ok ? validation.marks[0] : undefined;
      if (!mark) {
        throw new Error(
          `Highlight range [${input.start}, ${input.end}) is not a valid [start, end) character range.`,
        );
      }

      const existing = agentLineHighlightsRef.current.get(file.id) ?? [];
      if (existing.length >= MAX_LINE_HIGHLIGHTS_PER_FILE) {
        throw new Error(
          `${input.filePath} already carries ${MAX_LINE_HIGHLIGHTS_PER_FILE} attention marks. Clear some first.`,
        );
      }
      const marksOnLine = existing.filter(
        (candidate) => candidate.side === mark.side && candidate.line === mark.line,
      ).length;
      if (marksOnLine >= MAX_LINE_HIGHLIGHTS_PER_LINE) {
        throw new Error(
          `${input.filePath}:${input.line} already carries ${MAX_LINE_HIGHLIGHTS_PER_LINE} attention marks. Clear some first.`,
        );
      }

      const next = new Map(agentLineHighlightsRef.current);
      next.set(file.id, [...existing, mark]);
      commitAgentLineHighlights(next);

      let revealed: "line" | "hunk" | undefined;
      if (input.reveal ?? false) {
        const reached = revealLine(file.id, mark.side, mark.line);
        if (reached === "none") {
          selectHunk(file.id, hunkIndex);
          revealed = "hunk";
        } else {
          revealed = reached;
        }
      }

      return {
        fileId: file.id,
        filePath: file.path,
        hunkIndex,
        side: mark.side,
        line: mark.line,
        start: mark.start,
        end: mark.end,
        tone: mark.tone,
        fileMarkCount: existing.length + 1,
        ...(revealed ? { revealed } : {}),
      };
    },
    [allFiles, commitAgentLineHighlights, revealLine, selectHunk],
  );

  /** Clear agent attention marks, globally or for one file. */
  const clearAgentLineHighlights = useCallback(
    (filePath?: string): ClearedHighlightsResult => {
      const current = agentLineHighlightsRef.current;
      const total = [...current.values()].reduce((sum, marks) => sum + marks.length, 0);

      if (!filePath) {
        if (total > 0) {
          commitAgentLineHighlights(EMPTY_AGENT_LINE_HIGHLIGHTS);
        }
        return { removedCount: total, remainingCount: 0 };
      }

      const file = findDiffFileByPath(allFiles, filePath);
      if (!file) {
        throw new Error(noDiffFileMatchesMessage(filePath));
      }

      const removed = current.get(file.id)?.length ?? 0;
      if (removed > 0) {
        const next = new Map(current);
        next.delete(file.id);
        commitAgentLineHighlights(next);
      }

      return { removedCount: removed, remainingCount: total - removed, filePath };
    },
    [allFiles, commitAgentLineHighlights],
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

      // Where the note lands is the catalogued command's effect: the row this renderer
      // measured when it has one, the shared whole-hunk default when it does not.
      const intent = lowerCommand("hunk.review.startNote", {
        noteLocation: { fileKey, hunkIndex },
        ...(requestedTarget ? { noteTarget: requestedTarget } : {}),
      });
      if (intent?.type !== "notes/start-draft") {
        return null;
      }

      // The draft's identity is the caller's to own, and adopting a position the viewport
      // already settled on is the shared anchor policy, so such a draft asks for no reveal.
      const { draft } = runIntent(
        {
          ...intent,
          ...(options?.preserveViewport ? { reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL } : {}),
        },
        { draftId: `draft:${file.id}:${hunkIndex}:${Date.now()}` },
      );
      applyLineCursor(
        lineCursorAt(lineCursors, file.id, hunkIndex, { side: draft.side, line: draft.line }),
      );
      return storedDraftToDraftNote(draft, file);
    },
    [
      allFiles,
      applyLineCursor,
      keyByFileId,
      lineCursors,
      lowerCommand,
      runIntent,
      selectedFile?.id,
      selectedHunkIndex,
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
    store,
    stateRevision: state.stateRevision,
    draftNote,
    expandedGapsByFileId,
    filter,
    // Counted from the store, so notes on a file a reload retired still count as tracked.
    liveCommentCount: state.liveNotes.length,
    liveCommentSummaries,
    liveCommentsByFileId,
    lineCursor,
    getLineCursor,
    getSelection,
    lineCursorRevealRequest,
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
    addAgentLineHighlight,
    addLiveComment,
    addLiveCommentBatch,
    agentLineHighlightsByFileId,
    anchorLineCursor,
    anchorSelection,
    clearAgentLineHighlights,
    clearFilter,
    cancelDraftNote,
    clearLiveComments,
    moveLineCursor,
    moveSelection,
    navigateToLocation,
    removeLiveComment,
    removeUserNote,
    revealLine,
    saveDraftNote,
    selectFile,
    selectHunk,
    setShowAgentNotes,
    toggleAgentNotes,
    startUserNote,
    setFilter,
    updateDraftNote,
  };
}
