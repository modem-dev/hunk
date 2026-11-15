/**
 * Terminal review state, projected from the shared review store.
 *
 * The semantic state of a review — selection, reveal intent, filter, note visibility,
 * notes, drafts, and gap expansion — lives in `packages/hunk/src/core/review`, and one live
 * review is owned by `ReviewSessionHost` (`app/review/reviewSessionHost.ts`): the store, intent
 * facts, live-comment ingestion, agent navigation and highlights, and gap source loading. This
 * hook subscribes to that host and keeps what is genuinely terminal: projecting state onto the
 * diff-file model the panes render, the measured current-line cursor and its reveal requests,
 * and the presentation-scoped navigation the panes expose.
 *
 * `App` uses it for rendering and keyboard or menu actions; the session bridge uses the
 * same hook for daemon-driven navigation and agent notes, which the host answers with this
 * hook's measured facts supplied as explicit inputs.
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
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { ReviewSelectionChangedOutcome } from "../../core/review/intents";
import { projectReviewDocument } from "../../core/review/document";
import { reviewHunkIndexForLine } from "../../core/review/geometry";
import {
  planReviewSelectionMove,
  REVIEW_FILE_JUMP_HUNK_INDEX,
  type ReviewSelectionScope,
  type ReviewNavigationFile,
} from "../../core/review/navigation";
import {
  selectActiveStoredReviewNote,
  selectExpandedGapIdsByFileKey,
  selectNavigableStoredReviewNotes,
  selectNormalizedSelection,
  selectThreadedStoredReviewNotes,
  selectVisibleThreadedStoredReviewNotes,
} from "../../core/review/selectors";
import { REVIEW_VIEWPORT_ANCHOR_REVEAL, reviewNoteAnchorLine } from "../../core/review/state";
import type { ReviewNoteTargetV1 } from "../../core/review/types";
import type { ReviewStore } from "../../core/review/store";
import type { DiffFile } from "../../core/changeset/model";
import type { LayoutMode } from "../../core/run/commandInputs";
import type { ExtensionReviewPresentationScope } from "../../extension-api/types";
import {
  ReviewSessionHost,
  revealRequestFor,
  type MeasureMarkupFn,
  type ReviewGapToggle,
  type ReviewSelectionOptions,
  type RevealedLineResult,
} from "../../app/review/reviewSessionHost";
import {
  buildLiveCommentSummaries,
  buildReviewNoteSummaries,
  buildReviewSessionAnnotationIndex,
  indexReviewFiles,
} from "../../app/review/reviewSessionProjections";
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
import type { ValidatedLineHighlight } from "../highlights/validate";

import type { LineRevealPlacement } from "../lib/hunkScroll";
import {
  EMPTY_LINE_CURSORS,
  findLineCursorAt,
  firstLineCursorInHunk,
  hasLineCursor,
  lineCursorAt,
  resolveLineCursor,
  type LineCursor,
} from "../lib/lineCursors";
import {
  EMPTY_REVIEW_VERTICAL_STOPS,
  findNextReviewNoteStop,
  findNextReviewVerticalStop,
  type ReviewVerticalStop,
} from "../lib/reviewVerticalStops";
import { agentNoteMarkupWidth } from "../lib/agentNoteGeometry";
import { STML_REFERENCE_WIDTH, validateStmlMarkup } from "../../core/stml/layout";
import {
  groupStoredNotesByFileId,
  groupThreadedStoredNotesByFileId,
  storedDraftToDraftNote,
  storedNoteToLiveComment,
  storedNoteToUserNote,
  type DraftReviewNote,
  type UserReviewNote,
} from "../lib/reviewNoteMapping";
import { buildReviewStreamState } from "../lib/reviewState";
import { filterFilesByExtensionPresentationScope } from "../lib/extensionPresentationScope";

export type { RevealedLineResult, ReviewSelectionOptions };

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

/**
 * Observe the host's agent attention marks as ordinary React state, like the store snapshot.
 */
function useAgentLineHighlights(host: ReviewSessionHost) {
  const [highlights, setHighlights] = useState(() => host.getAgentLineHighlights());
  useEffect(() => {
    setHighlights(host.getAgentLineHighlights());
    return host.subscribeAgentLineHighlights(() => setHighlights(host.getAgentLineHighlights()));
  }, [host]);
  return highlights;
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
  /** Explicit measured row used when the active vertical stop is a note rather than a line. */
  target?: { fileId: string; stableKey: string };
}

/** Location a keyboard-started note adopts from the selected note card. */
export interface ActiveNoteTarget {
  fileId: string;
  hunkIndex: number;
  target: UserNoteLineTarget;
}

export interface TerminalReview {
  allFiles: DiffFile[];
  /** Projected content and source identities keyed by runtime file id. */
  semanticFileIdentityByFileId: ReadonlyMap<string, string>;
  /**
   * The semantic review store of the `ReviewSessionHost` this controller mounted.
   *
   * Exposed so the app can attach it to the producer that publishes this review: a
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
  /** Read the selected note card's line synchronously, for keyboard note starts. */
  getActiveNoteTarget: () => ActiveNoteTarget | null;
  /** Read the current normalized selection synchronously with the cursor. */
  getSelection: () => { fileId: string | null; hunkIndex: number | null };
  lineCursorRevealRequest: LineCursorRevealRequest;
  anchorLineCursor: (cursor: LineCursor) => void;
  /** Adopt the hunk a viewport settled on, without asking any viewport to move. */
  anchorSelection: (fileId: string, hunkIndex: number) => void;
  moveLineCursor: (delta: number) => void;
  /** Select a visible semantic note without moving the viewport. */
  activateNote: (noteId: string) => void;
  /** Step only between semantic note cards in their rendered order. */
  moveNoteCursor: (delta: number) => void;
  /** Step the selection through one navigable scope; the scope owns wrap and reveal. */
  moveSelection: (
    scope: ReviewSelectionScope,
    delta: number,
    options?: { projection?: "visible" | "canonical" },
  ) => ReviewSelectionChangedOutcome | undefined;
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
  /** Hunk indexes retained by the active extension presentation scope, keyed by runtime file id. */
  visibleHunkIndexesByFileId: ReadonlyMap<string, ReadonlySet<number>> | null;
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
  /** Select only a file currently exposed by the terminal presentation projection. */
  selectVisibleFile: (fileId: string, options?: ReviewSelectionOptions) => void;
  /** Select only a hunk currently exposed by the terminal presentation projection. */
  selectVisibleHunk: (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => void;
  setShowAgentNotes: (visible: boolean) => void;
  /** Flip the note layer the way the catalogued toggle command declares it. */
  toggleAgentNotes: () => void;
  startUserNoteEdit: (
    noteId: string,
    options?: { preserveViewport?: boolean },
  ) => DraftReviewNote | null;
  startUserNoteReply: (
    noteId: string,
    options?: { preserveViewport?: boolean },
  ) => DraftReviewNote | null;
  startUserNote: (
    fileId?: string,
    hunkIndex?: number,
    target?: ReviewNoteTargetV1,
    options?: { preserveViewport?: boolean },
  ) => DraftReviewNote | null;
  setFilter: (value: string) => void;
  updateDraftNote: (body: string, expectedDraftId?: string) => boolean;
}

/** Live note-card geometry the app publishes for markup validation. */
export interface AgentNoteGeometrySnapshot {
  layout: Exclude<LayoutMode, "auto">;
  /** Diff pane content width — the width the diff view renders at. */
  width: number;
}

/** Mount one review session host and project its state for the UI and session bridge. */
export function useTerminalReview({
  files,
  initialShowAgentNotes = false,
  lineCursors = EMPTY_LINE_CURSORS,
  reviewVerticalStops = EMPTY_REVIEW_VERTICAL_STOPS,
  noteGeometry,
  presentationScope = null,
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
  /** Mixed rendered line and semantic-note stops used by vertical keyboard movement. */
  reviewVerticalStops?: ReviewVerticalStop[];
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
  /** Host-owned extension projection applied after the user's canonical file filter. */
  presentationScope?: ExtensionReviewPresentationScope | null;
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
  const [host] = useState(
    () =>
      new ReviewSessionHost({
        files,
        sourceLabel,
        document,
        showAgentNotes: initialShowAgentNotes,
        stmlEnabled,
      }),
  );
  const store = host.store;
  const lineCursorBeforeExpandRef = useRef(new Map<string, LineCursor>());

  useLayoutEffect(() => {
    host.setStmlEnabled(stmlEnabled);
  }, [host, stmlEnabled]);

  // Adopt a replacement file list in the same commit that renders it, so a soft reload
  // never paints new files against state the previous patch produced. The host and its
  // store retire content-derived state; the work here is the cursor bookkeeping only this
  // renderer knows about.
  useLayoutEffect(() => {
    for (const fileKey of host.replaceFiles(files, { sourceLabel, document })) {
      for (const restorePointKey of lineCursorBeforeExpandRef.current.keys()) {
        if (restorePointKey.startsWith(`${fileKey}:`)) {
          lineCursorBeforeExpandRef.current.delete(restorePointKey);
        }
      }
    }
  }, [document, files, host, sourceLabel]);

  const agentLineHighlightsByFileId = useAgentLineHighlights(host);
  const state = useReviewStoreSnapshot(store);
  const filter = state.filter;
  const scrollToNote = state.reveal.scrollToNote;
  const [lineCursor, setLineCursor] = useState<LineCursor | null>(null);
  // A held key drains as one stdin chunk, so every press in the burst would otherwise read the
  // same pre-batch state and the cursor would advance a single row.
  const lineCursorRef = useRef<LineCursor | null>(null);
  const lineCursorsRef = useRef(lineCursors);
  lineCursorsRef.current = lineCursors;
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

  // Render-time lookups for the files this render draws; the host adopts the same files in the
  // layout effect above.
  const fileIndex = useMemo(() => indexReviewFiles(document, files), [document, files]);
  const { keyByFileId, fileByKey } = fileIndex;
  const semanticFileIdentityByFileId = useMemo(
    () =>
      new Map(
        document.files.map(
          (file) =>
            [
              file.runtimeId,
              `${file.key}:${file.contentIdentity}:${file.sourceIdentity ?? ""}`,
            ] as const,
        ),
      ),
    [document],
  );
  const liveCommentsByFileId = useMemo(
    () => groupStoredNotesByFileId(state.liveNotes, fileByKey, storedNoteToLiveComment),
    [fileByKey, state.liveNotes],
  );
  const userNotesByFileId = useMemo(
    () => groupStoredNotesByFileId(state.userNotes, fileByKey, storedNoteToUserNote),
    [fileByKey, state.userNotes],
  );
  const threadedStoredNotes = useMemo(
    () => selectThreadedStoredReviewNotes(state),
    [state.liveNotes, state.userNotes],
  );
  const visibleThreadById = useMemo(
    () =>
      new Map(
        selectVisibleThreadedStoredReviewNotes(state).map((item) => [item.entry.note.id, item]),
      ),
    [state.liveNotes, state.showAgentNotes, state.userNotes],
  );
  const storedNotesByFileId = useMemo(
    () =>
      groupThreadedStoredNotesByFileId(
        threadedStoredNotes,
        fileByKey,
        (note, filePath, depth, hasReplies) => {
          const visibleThread = visibleThreadById.get(note.id);
          const renderDepth = visibleThread?.visibleDepth ?? depth;
          const threadGuide = {
            hasNextSibling: visibleThread?.hasNextVisibleSibling ?? false,
            ancestorHasNextSibling: visibleThread?.visibleAncestorHasNextSibling ?? [],
          };
          return note.source === "user"
            ? storedNoteToUserNote(note, filePath, renderDepth, hasReplies, threadGuide)
            : storedNoteToLiveComment(note, filePath, renderDepth, hasReplies, threadGuide);
        },
      ),
    [fileByKey, threadedStoredNotes, visibleThreadById],
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
  const { allFiles, visibleFiles: userVisibleFiles } = useMemo(
    () =>
      buildReviewStreamState({
        files,
        liveCommentsByFileId: storedNotesByFileId,
        filterQuery: deferredFilter,
      }),
    [deferredFilter, files, storedNotesByFileId],
  );
  const visibleHunkIndexesByFileId = useMemo(() => {
    if (!presentationScope) return null;
    return new Map(
      presentationScope.files.map((entry) => [entry.fileId, new Set(entry.hunkIndexes)] as const),
    );
  }, [presentationScope]);
  const visibleFiles = useMemo(
    () => filterFilesByExtensionPresentationScope(userVisibleFiles, presentationScope),
    [presentationScope, userVisibleFiles],
  );
  // Which files and hunks carry notes, for the shared annotated-navigation planner, from the
  // same derivation the host plans canonical moves with.
  const annotations = useMemo(
    () => buildReviewSessionAnnotationIndex(files, fileIndex, state),
    [fileIndex, files, state.liveNotes, state.userNotes],
  );
  const projectedNavigationFiles = useMemo<ReviewNavigationFile[]>(
    () =>
      visibleFiles.flatMap((file) => {
        const fileKey = keyByFileId.get(file.id);
        if (!fileKey) return [];
        const hunkIndexes = visibleHunkIndexesByFileId?.get(file.id);
        // A presentation scope that leaves a file no hunks hides it from navigation. Without a
        // scope, files with no hunks at all (binary, skipped) stay navigable: file moves and
        // file jumps land on them, while hunk moves pass over them because they add no cursors.
        if (hunkIndexes) {
          const indexes = [...hunkIndexes].sort((left, right) => left - right);
          return indexes.length > 0
            ? [{ fileKey, hunkCount: indexes.length, hunkIndexes: indexes }]
            : [];
        }
        const indexes = file.metadata.hunks.map((_hunk, index) => index);
        return [{ fileKey, hunkCount: indexes.length, hunkIndexes: indexes }];
      }),
    [keyByFileId, visibleFiles, visibleHunkIndexesByFileId],
  );
  const projectedNavigation = useMemo(() => {
    const visibleFilesByKey = new Map(
      projectedNavigationFiles.map((file) => [file.fileKey, new Set(file.hunkIndexes ?? [])]),
    );
    const annotatedHunkIndicesByFileKey = new Map<string, ReadonlySet<number>>();
    for (const [fileKey, indexes] of annotations.annotatedHunkIndicesByFileKey) {
      const visibleIndexes = visibleFilesByKey.get(fileKey);
      if (!visibleIndexes) continue;
      const projectedIndexes = new Set([...indexes].filter((index) => visibleIndexes.has(index)));
      if (projectedIndexes.size > 0) annotatedHunkIndicesByFileKey.set(fileKey, projectedIndexes);
    }
    const annotatedFileKeys = new Set(
      [...annotations.annotatedFileKeys].filter((fileKey) => visibleFilesByKey.has(fileKey)),
    );
    const notes = selectNavigableStoredReviewNotes(state)
      .filter((item) => visibleFilesByKey.get(item.fileKey)?.has(item.hunkIndex))
      .map((item) => ({
        fileKey: item.fileKey,
        hunkIndex: item.hunkIndex,
        noteId: item.entry.note.id,
      }));
    return {
      files: projectedNavigationFiles,
      annotations: { annotatedHunkIndicesByFileKey, annotatedFileKeys },
      notes,
      activeNoteId: selectActiveStoredReviewNote(state)?.note.id,
    };
  }, [annotations, projectedNavigationFiles, state]);
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

  /** Read the normalized selection from the host without waiting for a React render. */
  const getSelection = useCallback(() => host.getSelection(), [host]);

  /**
   * Read the line the selected note card hangs from, as a new note's implicit target.
   *
   * Selecting a note clears the line cursor, so without this a keyboard start would fall back
   * to the hunk's default line instead of the line the reviewer is looking at.
   */
  const getActiveNoteTarget = useCallback((): ActiveNoteTarget | null => {
    const snapshot = store.getSnapshot();
    const entry = selectActiveStoredReviewNote(snapshot);
    const file = entry ? fileByKey.get(entry.note.fileKey) : undefined;
    if (!entry || !file) {
      return null;
    }

    // An active note only ever resolves inside the selected hunk, which owns its card.
    const { hunkIndex } = selectNormalizedSelection(snapshot);
    const { side, line } = reviewNoteAnchorLine(entry.note);
    return { fileId: file.id, hunkIndex, target: { side, line } };
  }, [fileByKey, store]);

  /** Run one semantic intent against the review store. */
  const runIntent = useCallback<ReviewSessionHost["applyIntent"]>(
    (intent, facts) => host.applyIntent(intent, facts),
    [host],
  );

  /** Update the selection and its reveal request together so diff scrolling stays explicit. */
  const selectHunk = useCallback(
    (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) =>
      host.selectHunk(fileId, hunkIndex, options),
    [host],
  );

  /** Adopt a selection the viewport arrived at on its own, through the shared anchor policy. */
  const anchorSelection = useCallback(
    (fileId: string, hunkIndex: number) => host.anchorSelection(fileId, hunkIndex),
    [host],
  );

  /** Jump to one file through the shared file-jump rule. */
  const selectFile = useCallback(
    (fileId: string, options?: ReviewSelectionOptions) => host.selectFile(fileId, options),
    [host],
  );

  const selectVisibleFile = useCallback(
    (fileId: string, options?: ReviewSelectionOptions) => {
      const fileKey = keyByFileId.get(fileId);
      const navigationFile = projectedNavigationFiles.find((file) => file.fileKey === fileKey);
      if (!fileKey || !navigationFile) return;
      // A file without hunks (binary, skipped) is still selectable, like a core file jump.
      runIntent({
        type: "selection/select",
        fileKey,
        hunkIndex: navigationFile.hunkIndexes?.[0] ?? REVIEW_FILE_JUMP_HUNK_INDEX,
        reveal: revealRequestFor(options),
      });
    },
    [keyByFileId, projectedNavigationFiles, runIntent],
  );

  const selectVisibleHunk = useCallback(
    (fileId: string, hunkIndex: number, options?: ReviewSelectionOptions) => {
      const fileKey = keyByFileId.get(fileId);
      const file = projectedNavigationFiles.find((entry) => entry.fileKey === fileKey);
      if (!file || !(file.hunkIndexes ?? []).includes(hunkIndex)) {
        return;
      }
      selectHunk(fileId, hunkIndex, options);
    },
    [keyByFileId, projectedNavigationFiles, selectHunk],
  );

  // The host repairs a stale document selection when it replaces files; this re-checks after
  // any other store change, so filtering still preserves the reviewer's place.
  useEffect(() => {
    host.repairSelection();
  }, [host, state.document, state.filter, state.selection]);

  const previousPresentationScopeRef = useRef<ExtensionReviewPresentationScope | null>(null);
  useEffect(() => {
    const previous = previousPresentationScopeRef.current;
    previousPresentationScopeRef.current = presentationScope;
    if (previous === presentationScope || !presentationScope) return;

    const selection = selectNormalizedSelection(store.getSnapshot());
    const selectedFile = projectedNavigationFiles.find(
      (file) => file.fileKey === selection.fileKey,
    );
    if (selectedFile?.hunkIndexes?.includes(selection.hunkIndex)) return;
    const first = projectedNavigationFiles[0];
    const hunkIndex = first?.hunkIndexes?.[0];
    if (!first || hunkIndex === undefined) return;
    store.dispatch({ type: "selection/select", fileKey: first.fileKey, hunkIndex });
  }, [presentationScope, projectedNavigationFiles, store]);

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
      const fileKey = keyByFileId.get(cursor.fileId);
      if (!fileKey) return;
      applyLineCursor(cursor);
      setLineCursorRevealRequest((current) => ({ id: current.id + 1, placement }));
      // A source line and note card are mutually exclusive vertical stops. This viewport-preserving
      // selection follows the line while clearing any exact semantic note focus.
      runIntent({
        type: "selection/select",
        fileKey,
        hunkIndex: cursor.hunkIndex,
        reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL,
      });
    },
    [applyLineCursor, keyByFileId, runIntent],
  );

  const reconcileLineCursor = useCallback(() => {
    if (selectActiveStoredReviewNote(store.getSnapshot())) {
      applyLineCursor(null);
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
  }, [
    applyLineCursor,
    lineCursors,
    revealLineCursor,
    selectedFileId,
    selectedHunkIndex,
    state.activeNoteId,
    store,
  ]);

  useEffect(() => {
    reconcileLineCursor();
  }, [reconcileLineCursor]);

  /** Adopt a current line the viewport already settled on, without scrolling back to it. */
  const anchorLineCursor = useCallback(
    (cursor: LineCursor) => {
      const fileKey = keyByFileId.get(cursor.fileId);
      if (!fileKey) return;
      applyLineCursor(cursor);
      runIntent({
        type: "selection/select",
        fileKey,
        hunkIndex: cursor.hunkIndex,
        reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL,
      });
    },
    [applyLineCursor, keyByFileId, runIntent],
  );

  // Read stops through a ref so this callback stays stable across reloads. Closures from one
  // render share its scope, so a callback rebuilt when stops change would retain the render that
  // rebuilt `resolveCommentRequest` for new files, and through it every earlier review generation.
  const reviewVerticalStopsRef = useRef(reviewVerticalStops);
  reviewVerticalStopsRef.current = reviewVerticalStops;

  /** Read the exact rendered stop that currently owns keyboard focus. */
  const currentReviewVerticalStop = useCallback((): ReviewVerticalStop | null => {
    const activeNoteId = selectActiveStoredReviewNote(store.getSnapshot())?.note.id;
    if (activeNoteId) {
      return (
        reviewVerticalStopsRef.current.find(
          (stop) => stop.kind === "note" && stop.noteId === activeNoteId,
        ) ?? null
      );
    }
    return lineCursorRef.current ? { kind: "line", cursor: lineCursorRef.current } : null;
  }, [store]);

  /** Focus one measured note stop through its current semantic owner. */
  const focusReviewNoteStop = useCallback(
    (next: Extract<ReviewVerticalStop, { kind: "note" }>) => {
      const snapshot = store.getSnapshot();
      const target = selectNavigableStoredReviewNotes(snapshot).find(
        (item) => item.entry.note.id === next.noteId,
      );
      if (!target || keyByFileId.get(next.fileId) !== target.fileKey) return;

      applyLineCursor(null);
      runIntent({
        type: "selection/select",
        fileKey: target.fileKey,
        hunkIndex: target.hunkIndex,
        activeNoteId: next.noteId,
        reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL,
      });
      setLineCursorRevealRequest((request) => ({
        id: request.id + 1,
        placement: "nearest",
        target: { fileId: next.fileId, stableKey: next.stableKey },
      }));
    },
    [applyLineCursor, keyByFileId, runIntent, store],
  );

  /** Select one visible semantic note as the keyboard action target without scrolling. */
  const activateNote = useCallback(
    (noteId: string) => {
      const target = selectNavigableStoredReviewNotes(store.getSnapshot()).find(
        (item) => item.entry.note.id === noteId,
      );
      if (!target) return;

      applyLineCursor(null);
      runIntent({
        type: "selection/select",
        fileKey: target.fileKey,
        hunkIndex: target.hunkIndex,
        activeNoteId: noteId,
        reveal: REVIEW_VIEWPORT_ANCHOR_REVEAL,
      });
    },
    [applyLineCursor, runIntent, store],
  );

  /** Move through source lines and semantic note cards in exact rendered order. */
  const moveLineCursor = useCallback(
    (delta: number) => {
      const next = findNextReviewVerticalStop(
        reviewVerticalStops,
        currentReviewVerticalStop(),
        delta,
      );
      if (!next) return;
      if (next.kind === "line") revealLineCursor(next.cursor);
      else focusReviewNoteStop(next);
    },
    [currentReviewVerticalStop, focusReviewNoteStop, reviewVerticalStops, revealLineCursor],
  );

  /** Move only through note cards, using the active presentation's visual order. */
  const moveNoteCursor = useCallback(
    (delta: number) => {
      const next = findNextReviewNoteStop(reviewVerticalStops, currentReviewVerticalStop(), delta);
      if (next) focusReviewNoteStop(next);
    },
    [currentReviewVerticalStop, focusReviewNoteStop, reviewVerticalStops],
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
   * The walk itself — which projected hunk or file is next, whether the scope wraps, and what
   * the landing asks the viewport to reveal — lives in the shared planner. Agent/session
   * addressing opts into the canonical document walk explicitly.
   */
  const moveSelection = useCallback(
    (
      scope: ReviewSelectionScope,
      delta: number,
      options?: { projection?: "visible" | "canonical" },
    ) => {
      if (options?.projection === "canonical") {
        return host.moveSelection(scope, delta);
      }
      const stateSnapshot = store.getSnapshot();
      const target = planReviewSelectionMove(
        projectedNavigation,
        selectNormalizedSelection(stateSnapshot),
        { scope, delta },
      );
      if (!target) return;
      runIntent({
        type: "selection/select",
        fileKey: target.fileKey,
        hunkIndex: target.hunkIndex,
        reveal: target.reveal,
        ...(target.activeNoteId ? { activeNoteId: target.activeNoteId } : {}),
      });
      return {
        type: "selection/changed" as const,
        fileKey: target.fileKey,
        hunkIndex: target.hunkIndex,
      };
    },
    [host, projectedNavigation, runIntent, store],
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
      const cursor = findLineCursorAt(lineCursorsForRevealRef.current, fileId, side, line);
      if (cursor) {
        revealLineCursor(cursor, "reveal");
        return "line";
      }

      const file = visibleFilesRef.current.find((candidate) => candidate.id === fileId);
      const hunkIndex = file ? reviewHunkIndexForLine(file.metadata.hunks, side, line) : -1;
      if (hunkIndex < 0) {
        return "none";
      }

      selectHunk(fileId, hunkIndex);
      return "hunk";
    },
    [revealLineCursor, selectHunk],
  );

  /** Set the shared file filter. */
  const setFilter = useCallback((value: string) => host.setFilter(value), [host]);

  /** Clear the active file filter without touching the current selection. */
  const clearFilter = useCallback(() => {
    setFilter("");
  }, [setFilter]);

  /** Show or hide the shared agent note layer. */
  const setShowAgentNotes = useCallback(
    (visible: boolean) => host.setShowAgentNotes(visible),
    [host],
  );

  /** Flip the shared agent note layer, as the catalogued command declares that flip. */
  const toggleAgentNotes = useCallback(() => host.toggleAgentNotes(), [host]);

  /**
   * Record the line-cursor bookkeeping that follows one gap toggle the host applied.
   *
   * The host decided whether this was an expand or a collapse; this keeps the terminal's own
   * restore point and the pending reveal of the first newly revealed row.
   */
  const recordGapToggle = useCallback((toggled: ReviewGapToggle | undefined) => {
    if (!toggled) {
      return;
    }

    const restorePointKey = `${toggled.fileId}:${toggled.gapId}`;
    const restorePoint = lineCursorBeforeExpandRef.current.get(restorePointKey) ?? null;
    const cursorBeforeToggle = lineCursorRef.current;
    if (toggled.expanded) {
      if (cursorBeforeToggle) {
        lineCursorBeforeExpandRef.current.set(restorePointKey, cursorBeforeToggle);
      }
      pendingLineCursorRef.current = {
        kind: "reveal",
        fileId: toggled.fileId,
        gapKey: toggled.gapId,
      };
    } else {
      lineCursorBeforeExpandRef.current.delete(restorePointKey);
      pendingLineCursorRef.current = restorePoint
        ? { kind: "restore", cursor: restorePoint }
        : null;
    }
  }, []);

  /** Toggle expansion of one collapsed gap the renderer addressed by file id. */
  const toggleGap = useCallback(
    (fileId: string, gapKey: string) => recordGapToggle(host.toggleGap(fileId, gapKey)),
    [host, recordGapToggle],
  );

  /** Toggle the collapsed gap the catalogued "toggle unchanged context" command reaches. */
  const toggleSelectedHunkGap = useCallback(
    () => recordGapToggle(host.toggleSelectedHunkGap()),
    [host, recordGapToggle],
  );

  /** Resolve one session-daemon navigation request, landing line targets on measured rows. */
  const navigateToLocation = useCallback(
    (input: NavigateToHunkToolInput): NavigatedSelectionResult =>
      host.navigateToLocation(input, { revealLine }),
    [host, revealLine],
  );

  /** Paint one agent attention mark, revealing its measured line when asked. */
  const addAgentLineHighlight = useCallback(
    (input: HighlightToolInput): AppliedHighlightResult =>
      host.addAgentLineHighlight(input, { revealLine }),
    [host, revealLine],
  );

  /** Clear agent attention marks, globally or for one file. */
  const clearAgentLineHighlights = useCallback(
    (filePath?: string): ClearedHighlightsResult => host.clearAgentLineHighlights(filePath),
    [host],
  );

  /**
   * Validate one comment's STML markup at the width the note will actually render at right
   * now — live layout mode and pane width, falling back to the documented reference width
   * when geometry is not published (tests, headless callers). Reports the width back so
   * agents can preview at it. The host decides whether markup is allowed at all.
   */
  const measureMarkup = useCallback<MeasureMarkupFn>(
    (markup, anchorSide) => {
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
    [noteGeometry],
  );

  /** Add one live comment, optionally revealing its hunk in the active review. */
  const addLiveComment = useCallback(
    (
      input: CommentToolInput,
      commentId: string,
      options?: { reveal?: boolean },
    ): AppliedCommentResult =>
      host.addLiveComment(input, commentId, { reveal: options?.reveal, measureMarkup }),
    [host, measureMarkup],
  );

  /** Apply several live comments together after validating every target first. */
  const addLiveCommentBatch = useCallback(
    (
      inputs: CommentBatchItemInput[],
      requestId: string,
      options?: { revealMode?: "none" | "first" },
    ): AppliedCommentBatchResult =>
      host.addLiveCommentBatch(inputs, requestId, {
        revealMode: options?.revealMode,
        measureMarkup,
      }),
    [host, measureMarkup],
  );

  /** Remove one daemon-addressable comment, including human notes by stable `user:*` id. */
  const removeLiveComment = useCallback(
    (commentId: string): RemovedCommentResult => host.removeLiveComment(commentId),
    [host],
  );

  /** Clear live comments, optionally including human notes, globally or for one file. */
  const clearLiveComments = useCallback(
    (filePath?: string, options?: { includeUser?: boolean }): ClearedCommentsResult =>
      host.clearLiveComments(filePath, options),
    [host],
  );

  /** Start a human-authored draft note at the selected or requested hunk. */
  const startUserNote = useCallback(
    (
      fileId = selectedFile?.id,
      hunkIndex = selectedHunkIndex,
      requestedTarget?: ReviewNoteTargetV1,
      options?: { preserveViewport?: boolean },
    ): DraftReviewNote | null => {
      // The host owns the draft's identity and where the note lands; this renderer supplies
      // the row it measured and moves the current line onto the draft.
      const started = host.startUserNote({
        fileId,
        hunkIndex,
        target: requestedTarget,
        preserveViewport: options?.preserveViewport,
      });
      if (!started) {
        return null;
      }

      const { draft, file } = started;
      applyLineCursor(
        lineCursorAt(lineCursors, file.id, hunkIndex, { side: draft.side, line: draft.line }),
      );
      return storedDraftToDraftNote(draft, file);
    },
    [applyLineCursor, host, lineCursors, selectedFile?.id, selectedHunkIndex],
  );

  /** Open one saved reviewer note in the shared composer. */
  const startUserNoteEdit = useCallback(
    (noteId: string, options?: { preserveViewport?: boolean }): DraftReviewNote | null => {
      const { draft, file } = host.startUserNoteEdit(noteId, options);
      if (!file) {
        return null;
      }
      if (!options?.preserveViewport) {
        applyLineCursor(
          lineCursorAt(lineCursorsRef.current, file.id, draft.hunkIndex, {
            side: draft.side,
            line: draft.line,
          }),
        );
      }
      return storedDraftToDraftNote(draft, file);
    },
    [applyLineCursor, host],
  );

  /** Open a reply composer under one semantically stored note. */
  const startUserNoteReply = useCallback(
    (noteId: string, options?: { preserveViewport?: boolean }): DraftReviewNote | null => {
      const { draft, file } = host.startUserNoteReply(noteId, options);
      if (!file) {
        return null;
      }
      if (!options?.preserveViewport) {
        applyLineCursor(
          lineCursorAt(lineCursorsRef.current, file.id, draft.hunkIndex, {
            side: draft.side,
            line: draft.line,
          }),
        );
      }
      return storedDraftToDraftNote(draft, file);
    },
    [applyLineCursor, host],
  );

  /** Update the expected active draft through the shared intent path. */
  const updateDraftNote = useCallback(
    (body: string, expectedDraftId?: string) => host.updateDraftNote(body, expectedDraftId),
    [host],
  );

  /** Discard the active human note draft through the shared intent path. */
  const cancelDraftNote = useCallback(() => host.cancelDraftNote(), [host]);

  /**
   * Persist the active draft into the review's user notes exactly once.
   *
   * The store settles synchronously, so a coalesced repeat of the save key finds no
   * draft left to consume rather than needing its own guard.
   */
  const saveDraftNote = useCallback((): UserReviewNote | null => {
    const saved = host.saveDraftNote();
    if (saved) {
      // Saving transfers vertical focus to the note in the same synchronous input turn, before
      // viewport settlement can re-anchor the source-line cursor that opened the composer.
      applyLineCursor(null);
    }
    return saved ? storedNoteToUserNote(saved.note, saved.file.path) : null;
  }, [applyLineCursor, host]);

  /** Remove one in-memory user note by id. */
  const removeUserNote = useCallback((noteId: string) => host.removeUserNote(noteId), [host]);

  /** Format current inline notes for daemon snapshots without exposing UI-only objects. */
  const reviewNoteSummaries = useMemo<SessionReviewNoteSummary[]>(
    () => buildReviewNoteSummaries(files, fileIndex, state),
    [fileIndex, files, state.liveNotes, state.userNotes],
  );

  /** Format current live comments for daemon snapshots without exposing merged UI-only objects. */
  const liveCommentSummaries = useMemo<SessionLiveCommentSummary[]>(
    () => buildLiveCommentSummaries(files, fileIndex, state),
    [fileIndex, files, state.liveNotes],
  );

  return {
    allFiles,
    semanticFileIdentityByFileId,
    store,
    stateRevision: state.stateRevision,
    draftNote,
    expandedGapsByFileId,
    filter,
    // Counted from the published summaries: the daemon refuses a snapshot whose count differs
    // from its list. A note on a file a reload retired stays in the store and returns to both
    // when a later reload brings the file back.
    liveCommentCount: liveCommentSummaries.length,
    liveCommentSummaries,
    liveCommentsByFileId,
    lineCursor,
    getLineCursor,
    getActiveNoteTarget,
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
    visibleHunkIndexesByFileId,
    addAgentLineHighlight,
    addLiveComment,
    addLiveCommentBatch,
    agentLineHighlightsByFileId,
    activateNote,
    anchorLineCursor,
    anchorSelection,
    clearAgentLineHighlights,
    clearFilter,
    cancelDraftNote,
    clearLiveComments,
    moveLineCursor,
    moveNoteCursor,
    moveSelection,
    navigateToLocation,
    removeLiveComment,
    removeUserNote,
    revealLine,
    saveDraftNote,
    selectFile,
    selectHunk,
    selectVisibleFile,
    selectVisibleHunk,
    setShowAgentNotes,
    toggleAgentNotes,
    startUserNote,
    startUserNoteEdit,
    startUserNoteReply,
    setFilter,
    updateDraftNote,
  };
}
