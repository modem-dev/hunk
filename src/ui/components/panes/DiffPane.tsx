import {
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { DEFAULT_FILE_GAP, DEFAULT_HUNK_GAP } from "../../../core/run/reviewGap";
import { DEFAULT_TAB_WIDTH } from "../../../core/run/tabWidth";
import type { DiffFile } from "../../../core/changeset/model";
import type { CursorLine, LayoutMode } from "../../../core/run/commandInputs";
import type { UserNoteLineTarget } from "../../../core/liveComments";
import type { AgentAnnotation } from "../../../extension-api/types";
import { resolveReviewRevealNoteId } from "../../../core/review/selectors";
import {
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  reviewNoteVisibleByPolicy,
} from "../../../core/review/state";
import type { FileSourceStatus } from "../../diff/expandCollapsedRows";
import type { ActiveAddNoteAffordance } from "../../diff/DiffSectionBody";
import type { CursorHighlight } from "../../diff/cursorHighlight";
import { isNestedRowMouseAction } from "../../diff/rowMouseActions";
import { setMouseCapture } from "../../lib/mouseCapture";
import type { DraftReviewNote, StoredReviewNoteRenderMetadata } from "../../lib/reviewNoteMapping";
import {
  createVisibleAgentNote,
  reviewNoteSource,
  type VisibleAgentNote,
} from "../../lib/agentAnnotations";
import {
  computeRapidScrollOverscanRows,
  RAPID_SCROLL_OVERSCAN_IDLE_MS,
} from "../../lib/adaptiveScrollOverscan";
import {
  computeHunkRevealScrollTop,
  computeLineAlignmentScrollTop,
  computeLineRevealScrollTop,
  type CurrentLineAlignment,
  type LineRevealPlacement,
} from "../../lib/hunkScroll";
import { inlineNoteStableKey } from "../../diff/reviewRenderPlan";
import {
  buildLineCursors,
  clampLineCursorToViewport,
  createLineCursorStabilizer,
  EMPTY_LINE_CURSORS,
  firstLineCursorInHunk,
  type LineCursor,
  type LineCursorBoundsLookup,
} from "../../lib/lineCursors";
import {
  measureDiffSectionGeometry,
  type DiffSectionGeometry,
} from "../../diff/diffSectionGeometry";
import type { DiffSectionRowPlan } from "../../diff/diffSectionRowPlan";
import { createReviewMouseWheelScrollAcceleration } from "../../lib/scrollAcceleration";
import {
  buildFileSectionLayouts,
  buildInStreamFileHeaderHeights,
  collectIntersectingFileSectionIds,
  findHeaderOwningFileSection,
  shouldRenderInStreamFileHeader,
  type FileSectionLayout,
} from "../../lib/fileSectionLayout";
import { diffHunkId, diffSectionId } from "../../lib/ids";
import { findViewportCenteredHunkTarget } from "../../lib/viewportSelection";
import {
  estimateInitialRenderViewportHeight,
  resolveRenderViewportHeight,
  VIEWPORT_READ_COALESCE_MS,
} from "../../lib/viewportTiming";
import {
  findViewportRowAnchor,
  resolveViewportRowAnchorTop,
  type ViewportRowAnchor,
} from "../../lib/viewportAnchor";
import type { AppTheme } from "../../themes";
import { DiffSection } from "./DiffSection";
import type { FileViewRowFailure } from "../../fileViews/types";
import type { ValidatedLineHighlight } from "../../highlights/validate";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";
import {
  createExtensionCurrentLinePaint,
  type ExtensionCurrentLinePaintUpdate,
} from "../../lib/extensionCurrentLine";
import { VerticalScrollbar, type VerticalScrollbarHandle } from "../scrollbar/VerticalScrollbar";
import type { VisibleBodyBounds } from "../../diff/rowWindowing";
import type { ResolvedFileViewLayout } from "../../fileViews/useFileViews";
import { measureFileViewGeometry } from "../../fileViews/geometry";
import { buildFileViewRenderPlan } from "../../fileViews/renderPlan";
import { prefetchHighlightedDiff } from "../../diff/useHighlightedDiff";
import {
  buildFileRenderWindow,
  buildFileSectionIndexById,
  type FileRenderWindowItem,
} from "../../lib/fileRenderWindow";
import {
  buildCopySelectedRowKeys,
  clampCopyColumn,
  copySelectionDragIsClick,
  copySelectionPointsEqual,
  copySelectionPointsShareRow,
  expandSelectionPoint,
  findCopySelectionPoint,
  findLineCursorForClick,
  normalizeCopySelectionRange,
  renderCopySelectionText,
  resolveCopySelectionSide,
  type CopySelectionContext,
  type CopySelectionDrag,
  type CopySelectionPoint,
  type CopySelectionSide,
} from "./copySelection";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

/** Read terminal-only semantic note metadata without granting it to static sidecars. */
function storedReviewNoteMetadata(
  annotation: AgentAnnotation,
): StoredReviewNoteRenderMetadata | undefined {
  const candidate = annotation as AgentAnnotation & Partial<StoredReviewNoteRenderMetadata>;
  return candidate.semanticallyStored === true && typeof candidate.reviewNoteId === "string"
    ? (candidate as AgentAnnotation & StoredReviewNoteRenderMetadata)
    : undefined;
}

/** Grant saved-note card actions from semantic ownership rather than presentation labels. */
export function storedReviewNoteActions({
  editable,
  hasReplies,
  noteId,
  onEditUserNote,
  onRemoveLiveNote,
  onRemoveUserNote,
  onReplyToNote,
  source,
}: {
  editable: boolean;
  hasReplies: boolean;
  noteId: string;
  onEditUserNote?: (noteId: string, options?: { preserveViewport?: boolean }) => void;
  onRemoveLiveNote?: (noteId: string) => void;
  onRemoveUserNote?: (noteId: string) => void;
  onReplyToNote?: (noteId: string, options?: { preserveViewport?: boolean }) => void;
  source: "agent" | "ai" | "user";
}): VisibleAgentNote["actions"] {
  const actions: NonNullable<VisibleAgentNote["actions"]> = {};
  if (source === "user" && editable && onEditUserNote) {
    actions.onEdit = () => onEditUserNote(noteId, { preserveViewport: true });
  }
  if (onReplyToNote) {
    actions.onReply = () => onReplyToNote(noteId, { preserveViewport: true });
  }
  if (!hasReplies) {
    if (source === "user" && onRemoveUserNote) {
      actions.onDelete = () => onRemoveUserNote(noteId);
    } else if (source !== "user" && onRemoveLiveNote) {
      actions.onDelete = () => onRemoveLiveNote(noteId);
    }
  }
  return Object.keys(actions).length > 0 ? actions : undefined;
}

/**
 * Resets OpenTUI's wheel remainder after Hunk reroutes a shifted wheel event.
 *
 * OpenTUI 0.5.6 keeps this operation private, so retain this compatibility bridge only until
 * OpenTUI exposes a public reset API. A missing operation must fail loudly rather than let a
 * later vertical wheel event consume the stale remainder and move the review viewport.
 */
export function resetOpenTuiScrollAccumulators(scrollBox: ScrollBoxRenderable) {
  const compatibilityScrollBox = scrollBox as unknown as {
    resetScrollAccumulators?: () => void;
  };

  if (!compatibilityScrollBox.resetScrollAccumulators) {
    throw new Error(
      "OpenTUI 0.5.6 ScrollBoxRenderable.resetScrollAccumulators is required after shifted wheel input. Update this compatibility bridge when upgrading OpenTUI.",
    );
  }

  compatibilityScrollBox.resetScrollAccumulators();
}

/**
 * Clamp one vertical scroll target into the currently reachable review-stream extent.
 *
 * Selection-driven scroll requests can legitimately aim past the last reachable row — for example
 * when the user selects a short trailing file but asks for that file body to own the viewport top.
 * Every settle check must compare against this clamped value, not the raw request, or the pane can
 * keep re-applying a bottom-edge scroll and trap manual upward scrolling.
 */
function clampVerticalScrollTop(scrollTop: number, contentHeight: number, viewportHeight: number) {
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  return Math.min(Math.max(0, scrollTop), maxScrollTop);
}

/** Resolve one file-relative measured row through its precomputed whole-stream section layout. */
function streamRowBoundsAt(
  layouts: FileSectionLayout[],
  geometry: DiffSectionGeometry[],
  sectionIndex: number,
  stableKey: string,
) {
  const section = layouts[sectionIndex];
  const bounds = geometry[sectionIndex]?.rowBoundsByStableKey.get(stableKey);
  return section && bounds
    ? { top: section.bodyTop + bounds.top, height: bounds.height }
    : undefined;
}

/** Keep syntax highlighting warm for files immediately adjacent to the selection. */
function buildAdjacentPrefetchFileIds(files: DiffFile[], selectedFileId?: string) {
  if (!selectedFileId) {
    return new Set<string>();
  }

  const selectedIndex = files.findIndex((file) => file.id === selectedFileId);
  if (selectedIndex < 0) {
    return new Set<string>();
  }

  const next = new Set<string>();
  const previousFile = files[selectedIndex - 1];
  const nextFile = files[selectedIndex + 1];

  if (previousFile) {
    next.add(previousFile.id);
  }

  if (nextFile) {
    next.add(nextFile.id);
  }

  return next;
}

/**
 * Start highlight work before files visibly enter the review stream.
 *
 * Selected and adjacent files cover direct navigation, while the larger viewport halo keeps
 * wheel and track scrolling warm. Highlight prefetch does not force these files to mount.
 */
function buildHighlightPrefetchFileIds({
  adjacentPrefetchFileIds,
  fileSectionLayouts,
  rapidScrollOverscanRows,
  scrollTop,
  viewportHeight,
  selectedFileId,
}: {
  adjacentPrefetchFileIds: Set<string>;
  fileSectionLayouts: FileSectionLayout[];
  rapidScrollOverscanRows: number;
  scrollTop: number;
  viewportHeight: number;
  selectedFileId?: string;
}) {
  const next = new Set(adjacentPrefetchFileIds);

  if (selectedFileId) {
    next.add(selectedFileId);
  }

  const clampedViewportHeight = Math.max(1, viewportHeight);
  const prefetchRows = Math.max(24, clampedViewportHeight * 3, rapidScrollOverscanRows);
  const minPrefetchY = Math.max(0, scrollTop - prefetchRows);
  const maxPrefetchY = scrollTop + viewportHeight + prefetchRows;

  for (const fileId of collectIntersectingFileSectionIds(
    fileSectionLayouts,
    minPrefetchY,
    maxPrefetchY,
  )) {
    next.add(fileId);
  }

  return next;
}

const EMPTY_EXPANDED_GAP_KEYS: ReadonlySet<string> = new Set();
const EMPTY_EXPANDED_GAPS_BY_FILE_ID: Record<string, ReadonlySet<string>> = {};
const EMPTY_FILE_VIEWS: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();
const EMPTY_LINE_HIGHLIGHTS: ReadonlyMap<string, readonly ValidatedLineHighlight[]> = new Map();
const EMPTY_SOURCE_STATUS_BY_FILE_ID: Record<string, FileSourceStatus> = {};
const NOOP_TOGGLE_GAP = () => {};

/** Render the main multi-file review stream. */
export function DiffPane({
  codeHorizontalOffset = 0,
  diffContentWidth,
  expandedGapsByFileId = EMPTY_EXPANDED_GAPS_BY_FILE_ID,
  fileViews = EMPTY_FILE_VIEWS,
  files,
  offloadLargeDiff = false,
  lineHighlights = EMPTY_LINE_HIGHLIGHTS,
  headerLabelWidth,
  headerStatsWidth,
  layout,
  scrollRef,
  selectedFileId,
  selectedHunkIndex,
  cursorLine = "off",
  lineCursor = null,
  lineCursorRevealRequest = { id: 0, placement: "nearest" },
  lineCursorAlignmentRequest = { id: 0, alignment: "center" },
  scrollToNote = false,
  draftNote = null,
  draftNoteFocused = false,
  separatorWidth,
  pagerMode = false,
  copyDecorations = false,
  screenTop = 0,
  showTopChrome,
  showAgentNotes,
  showLineNumbers,
  showHunkHeaders,
  sourceStatusByFileId = EMPTY_SOURCE_STATUS_BY_FILE_ID,
  tabWidth = DEFAULT_TAB_WIDTH,
  fileGap = DEFAULT_FILE_GAP,
  hunkGap = DEFAULT_HUNK_GAP,
  wrapLines,
  wrapToggleScrollTop,
  layoutToggleScrollTop = null,
  layoutToggleRequestId = 0,
  scrollEdgeRequest,
  selectedFileTopAlignRequestId = 0,
  selectedHunkRevealRequestId,
  theme,
  width,
  height,
  cancelCopySelectionRef,
  onActiveAddNoteAffordanceChange,
  onEditUserNote,
  onReplyToNote,
  onRemoveLiveNote,
  onRemoveUserNote,
  onSaveDraftNote,
  draftSaveKeyLabel,
  onStartUserNoteAtHunk,
  onUpdateDraftNote,
  onBlurDraftNote,
  onCancelDraftNote,
  onFocusDraftNote,
  onCopyFeedback,
  onCopySelectionText,
  onFileViewRowFailure,
  onScrollCodeHorizontally = () => {},
  onSelectFile,
  onToggleGap = NOOP_TOGGLE_GAP,
  onLineCursorsChange,
  currentLinePaintRequested = false,
  onCurrentLinePaintChange,
  onViewportCenteredHunkChange,
  onViewportLineCursorChange,
}: {
  codeHorizontalOffset?: number;
  diffContentWidth: number;
  expandedGapsByFileId?: Record<string, ReadonlySet<string>>;
  /** Validated alternate layouts, keyed by file id; raw Pierre remains the fallback. */
  fileViews?: ReadonlyMap<string, ResolvedFileViewLayout>;
  files: DiffFile[];
  /** Offload eligible syntax highlighting for this launch. */
  offloadLargeDiff?: boolean;
  /** Validated extension line marks, keyed by file id. */
  lineHighlights?: ReadonlyMap<string, readonly ValidatedLineHighlight[]>;
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  selectedFileId?: string;
  selectedHunkIndex: number;
  cursorLine?: CursorLine;
  lineCursor?: LineCursor | null;
  lineCursorRevealRequest?: { id: number; placement: LineRevealPlacement };
  lineCursorAlignmentRequest?: { id: number; alignment: CurrentLineAlignment };
  scrollToNote?: boolean;
  draftNote?: DraftReviewNote | null;
  draftNoteFocused?: boolean;
  separatorWidth: number;
  pagerMode?: boolean;
  copyDecorations?: boolean;
  screenTop?: number;
  showTopChrome?: boolean;
  showAgentNotes: boolean;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  sourceStatusByFileId?: Record<string, FileSourceStatus>;
  tabWidth?: number;
  fileGap?: number;
  hunkGap?: number;
  wrapLines: boolean;
  wrapToggleScrollTop: number | null;
  layoutToggleScrollTop?: number | null;
  layoutToggleRequestId?: number;
  scrollEdgeRequest?: { id: number; edge: "top" | "bottom" };
  selectedFileTopAlignRequestId?: number;
  selectedHunkRevealRequestId?: number;
  theme: AppTheme;
  width: number;
  height?: number;
  cancelCopySelectionRef?: RefObject<(() => void) | null>;
  onActiveAddNoteAffordanceChange?: (
    affordance: (ActiveAddNoteAffordance & { fileId: string }) | null,
  ) => void;
  onEditUserNote?: (noteId: string, options?: { preserveViewport?: boolean }) => void;
  onReplyToNote?: (noteId: string, options?: { preserveViewport?: boolean }) => void;
  onRemoveLiveNote?: (noteId: string) => void;
  onRemoveUserNote?: (noteId: string) => void;
  onSaveDraftNote?: () => void;
  /** Live chord for the draft save action; omitted when `hunk.review.saveNote` is unbound. */
  draftSaveKeyLabel?: string;
  onStartUserNoteAtHunk?: (fileId: string, hunkIndex: number, target?: UserNoteLineTarget) => void;
  onUpdateDraftNote?: (body: string) => void;
  onBlurDraftNote?: () => void;
  onCancelDraftNote?: () => void;
  onFocusDraftNote?: () => void;
  onCopyFeedback?: (text: string) => void;
  onCopySelectionText?: (text: string) => void | boolean;
  onFileViewRowFailure?: (failure: FileViewRowFailure) => void;
  onScrollCodeHorizontally?: (delta: number) => void;
  onSelectFile: (fileId: string) => void;
  onToggleGap?: (fileId: string, gapKey: string) => void;
  onLineCursorsChange?: (cursors: LineCursor[]) => void;
  currentLinePaintRequested?: boolean;
  onCurrentLinePaintChange?: (update: ExtensionCurrentLinePaintUpdate) => void;
  onViewportCenteredHunkChange?: (fileId: string, hunkIndex: number) => void;
  onViewportLineCursorChange?: (cursor: LineCursor) => void;
}) {
  const renderTopChrome = showTopChrome ?? !pagerMode;
  const renderer = useRenderer();
  const mouseWheelScrollAcceleration = useMemo(
    () => createReviewMouseWheelScrollAcceleration(),
    [],
  );
  const [currentLineRowPlan, setCurrentLineRowPlan] = useState<{
    source: { file: DiffFile; theme: AppTheme; tabWidth: number };
    rowPlan: DiffSectionRowPlan;
    highlighted: boolean;
  } | null>(null);
  const [addNoteHoverClearSignal, setAddNoteHoverClearSignal] = useState(0);
  const [addNoteHoverClearFileId, setAddNoteHoverClearFileId] = useState<string | null>(null);
  const hoveredFileIdRef = useRef<string | null>(null);
  const onActiveAddNoteAffordanceChangeRef = useRef(onActiveAddNoteAffordanceChange);
  onActiveAddNoteAffordanceChangeRef.current = onActiveAddNoteAffordanceChange;

  /** Hide hover-only row controls when content scrolls under a stationary mouse pointer. */
  const clearAddNoteHoverForScroll = useCallback(() => {
    const hoveredFileId = hoveredFileIdRef.current;
    if (!hoveredFileId) {
      return;
    }

    setAddNoteHoverClearFileId(hoveredFileId);
    setAddNoteHoverClearSignal((current) => current + 1);
    setHoveredFileId(null);
    hoveredFileIdRef.current = null;
    onActiveAddNoteAffordanceChangeRef.current?.(null);
  }, []);

  const adjacentPrefetchFileIds = useMemo(
    () => buildAdjacentPrefetchFileIds(files, selectedFileId),
    [files, selectedFileId],
  );

  // Stable per-file select callbacks keep memoized sections from re-rendering just because
  // DiffPane re-rendered. The latest-onSelectFile ref means the cached closures never go
  // stale even though their identity is fixed for the life of the pane.
  const onSelectFileRef = useRef(onSelectFile);
  onSelectFileRef.current = onSelectFile;
  const selectFileCallbacksRef = useRef(new Map<string, () => void>());
  const selectFileCallback = useCallback((fileId: string) => {
    let callback = selectFileCallbacksRef.current.get(fileId);
    if (!callback) {
      callback = () => onSelectFileRef.current(fileId);
      selectFileCallbacksRef.current.set(fileId, callback);
    }
    return callback;
  }, []);

  // Add-note row handlers are cached per file so mounted DiffSections keep a stable prop identity,
  // while the ref indirection ensures clicks still use the latest App/review callback after hunk
  // navigation changes the selected-file defaults upstream.
  const onStartUserNoteAtHunkRef = useRef(onStartUserNoteAtHunk);
  onStartUserNoteAtHunkRef.current = onStartUserNoteAtHunk;
  const startUserNoteAtHunkCallbacksRef = useRef(
    new Map<string, (hunkIndex: number, target?: UserNoteLineTarget) => void>(),
  );
  const startUserNoteAtHunkCallback = useCallback((fileId: string) => {
    let callback = startUserNoteAtHunkCallbacksRef.current.get(fileId);
    if (!callback) {
      callback = (hunkIndex, target) =>
        onStartUserNoteAtHunkRef.current?.(fileId, hunkIndex, target);
      startUserNoteAtHunkCallbacksRef.current.set(fileId, callback);
    }
    return callback;
  }, []);

  const activeAddNoteAffordanceCallbacksRef = useRef(
    new Map<string, (affordance: ActiveAddNoteAffordance | null) => void>(),
  );
  const activeAddNoteAffordanceCallback = useCallback((fileId: string) => {
    let callback = activeAddNoteAffordanceCallbacksRef.current.get(fileId);
    if (!callback) {
      callback = (affordance) =>
        onActiveAddNoteAffordanceChangeRef.current?.(affordance ? { ...affordance, fileId } : null);
      activeAddNoteAffordanceCallbacksRef.current.set(fileId, callback);
    }
    return callback;
  }, []);

  /** Route shifted wheel input into horizontal code-column scrolling without disturbing vertical review scroll. */
  const handleMouseScroll = useCallback(
    (event: TuiMouseEvent) => {
      const scrollBox = scrollRef.current;
      const direction = event.scroll?.direction;
      if (!direction) {
        return;
      }

      clearAddNoteHoverForScroll();

      if (!scrollBox || wrapLines) {
        return;
      }

      const preservedScrollTop = scrollBox.scrollTop;
      const preservedScrollLeft = scrollBox.scrollLeft;
      const scrollInfo = event.scroll;

      if (direction === "left") {
        onScrollCodeHorizontally(-1);
      } else if (direction === "right") {
        onScrollCodeHorizontally(1);
      } else if (event.modifiers.shift && direction === "up") {
        onScrollCodeHorizontally(-1);
      } else if (event.modifiers.shift && direction === "down") {
        onScrollCodeHorizontally(1);
      } else {
        return;
      }

      // OpenTUI runs ScrollBox's own wheel handler after this listener and it ignores
      // preventDefault(). Zero the wheel delta first so native Shift+Wheel left/right events
      // cannot be remapped back into vertical scroll, then restore the viewport and clear any
      // residual fractional state on the next microtask as a final guard.
      if (scrollInfo) {
        scrollInfo.delta = 0;
      }

      queueMicrotask(() => {
        const currentScrollBox = scrollRef.current;
        if (!currentScrollBox) {
          return;
        }

        currentScrollBox.scrollTo({ x: preservedScrollLeft, y: preservedScrollTop });
        currentScrollBox.scrollAcceleration.reset();
        resetOpenTuiScrollAccumulators(currentScrollBox);
      });

      event.preventDefault();
      event.stopPropagation();
    },
    [clearAddNoteHoverForScroll, onScrollCodeHorizontally, scrollRef, wrapLines],
  );

  const allAgentNotesByFile = useMemo(() => {
    const next = new Map<string, VisibleAgentNote[]>();

    files.forEach((file) => {
      const allAnnotations = file.agent?.annotations ?? [];
      const annotations = allAnnotations.filter(
        // One shared visibility rule over the normalized note source, so the terminal and
        // any other surface hide the same notes when the layer is off.
        (annotation) =>
          reviewNoteVisibleByPolicy({ source: reviewNoteSource(annotation) }, showAgentNotes),
      );
      // Every note kind resolves its anchor through the shared resolver here, once, so the
      // render plan places sidecar annotations, agent comments, reviewer notes, and the open
      // draft from one decision about where each of them hangs.
      const hunks = file.metadata.hunks;
      const notes: VisibleAgentNote[] = annotations.flatMap((annotation, index) => {
        const source = reviewNoteSource(annotation);
        const metadata = storedReviewNoteMetadata(annotation);
        if (
          metadata &&
          draftNote?.kind === "edit" &&
          draftNote.targetNoteId === metadata.reviewNoteId
        ) {
          return [];
        }
        // Explicit ids and synthesized index ids live in disjoint namespaces so an
        // annotation named "3" can never collide with an id-less annotation at index 3 —
        // reveal resolves rows by this id, and a collision would aim it at the wrong note.
        const id = annotation.id
          ? `annotation:${file.id}:id:${annotation.id}`
          : `annotation:${file.id}:at:${index}`;
        const actions =
          metadata && !draftNote
            ? storedReviewNoteActions({
                editable: annotation.editable === true,
                hasReplies: metadata.hasReplies === true,
                noteId: metadata.reviewNoteId,
                onEditUserNote,
                onRemoveLiveNote,
                onRemoveUserNote,
                onReplyToNote,
                source,
              })
            : undefined;

        return [
          createVisibleAgentNote(hunks, {
            id,
            annotation,
            source,
            editable: source === "user" && annotation.editable === true,
            ...(metadata
              ? {
                  thread: {
                    noteId: metadata.reviewNoteId,
                    ...(metadata.parentId ? { parentId: metadata.parentId } : {}),
                    depth: metadata.threadDepth,
                    hasNextSibling: metadata.hasNextSibling,
                    ancestorHasNextSibling: metadata.ancestorHasNextSibling,
                  },
                }
              : {}),
            ...(actions ? { actions } : {}),
          }),
        ];
      });

      if (draftNote?.fileId === file.id) {
        const parentMetadata = allAnnotations
          .map(storedReviewNoteMetadata)
          .find(
            (metadata) => metadata?.reviewNoteId === (draftNote.parentId ?? draftNote.targetNoteId),
          );
        const threadDepth =
          draftNote.kind === "reply"
            ? (parentMetadata?.threadDepth ?? 0) + 1
            : (parentMetadata?.threadDepth ?? 0);
        const draftAnnotation: AgentAnnotation = {
          id: draftNote.id,
          source: "user-draft",
          title:
            draftNote.kind === "edit"
              ? "Edit note"
              : draftNote.kind === "reply"
                ? "Reply"
                : undefined,
          summary: draftNote.body || " ",
          oldRange: draftNote.oldRange,
          newRange: draftNote.newRange,
          editable: true,
        };
        const visibleDraft = createVisibleAgentNote(hunks, {
          id:
            draftNote.kind === "edit" && draftNote.targetNoteId
              ? `annotation:${file.id}:id:${draftNote.targetNoteId}`
              : draftNote.id,
          annotation: draftAnnotation,
          // The draft knows exactly where the reviewer opened it, including on an expanded
          // gap line no hunk contains.
          target: { hunkIndex: draftNote.hunkIndex, side: draftNote.side, line: draftNote.line },
          source: "draft",
          editable: true,
          thread: {
            noteId: draftNote.id,
            ...(draftNote.parentId ? { parentId: draftNote.parentId } : {}),
            depth: threadDepth,
            hasNextSibling: draftNote.kind === "edit" ? parentMetadata?.hasNextSibling : false,
            ancestorHasNextSibling:
              draftNote.kind === "reply"
                ? [
                    ...(parentMetadata?.ancestorHasNextSibling ?? []),
                    parentMetadata?.hasNextSibling ?? false,
                  ]
                : parentMetadata?.ancestorHasNextSibling,
          },
          draft: {
            body: draftNote.body,
            focused: draftNoteFocused,
            onBlur: onBlurDraftNote,
            onCancel: onCancelDraftNote ?? (() => {}),
            onFocus: onFocusDraftNote,
            onInput: onUpdateDraftNote ?? (() => {}),
            onSave: onSaveDraftNote ?? (() => {}),
            ...(draftSaveKeyLabel ? { saveKeyLabel: draftSaveKeyLabel } : {}),
          },
        });
        if (draftNote.kind === "edit" && draftNote.targetNoteId) {
          const targetIndex = annotations.findIndex(
            (annotation) =>
              storedReviewNoteMetadata(annotation)?.reviewNoteId === draftNote.targetNoteId,
          );
          notes.splice(targetIndex < 0 ? notes.length : targetIndex, 0, visibleDraft);
        } else if (draftNote.kind === "reply" && draftNote.parentId) {
          const parentIndex = notes.findIndex((note) => note.thread?.noteId === draftNote.parentId);
          let insertIndex = parentIndex < 0 ? notes.length : parentIndex + 1;
          const parentDepth = notes[parentIndex]?.thread?.depth ?? 0;
          while ((notes[insertIndex]?.thread?.depth ?? -1) > parentDepth) {
            insertIndex += 1;
          }

          // The unsaved reply is the new last sibling. Extend the previous sibling's rail
          // through its whole subtree so the draft joins the same visible thread immediately.
          let previousSiblingIndex = -1;
          for (let index = parentIndex + 1; index < insertIndex; index += 1) {
            const candidate = notes[index]?.thread;
            if (candidate?.parentId === draftNote.parentId && candidate.depth === threadDepth) {
              previousSiblingIndex = index;
            }
          }
          if (previousSiblingIndex >= 0) {
            const previousSibling = notes[previousSiblingIndex]!;
            notes[previousSiblingIndex] = {
              ...previousSibling,
              thread: { ...previousSibling.thread!, hasNextSibling: true },
            };
            for (let index = previousSiblingIndex + 1; index < insertIndex; index += 1) {
              const descendant = notes[index]!;
              if (!descendant.thread || descendant.thread.depth <= threadDepth) {
                break;
              }
              const ancestorHasNextSibling = [...(descendant.thread.ancestorHasNextSibling ?? [])];
              ancestorHasNextSibling[threadDepth] = true;
              notes[index] = {
                ...descendant,
                thread: { ...descendant.thread, ancestorHasNextSibling },
              };
            }
          }
          notes.splice(insertIndex, 0, visibleDraft);
        } else {
          notes.push(visibleDraft);
        }
      }

      if (notes.length > 0) {
        next.set(file.id, notes);
      }
    });

    return next;
  }, [
    draftNote,
    draftNoteFocused,
    files,
    onBlurDraftNote,
    onCancelDraftNote,
    onFocusDraftNote,
    onEditUserNote,
    onReplyToNote,
    onRemoveLiveNote,
    onRemoveUserNote,
    onSaveDraftNote,
    draftSaveKeyLabel,
    onUpdateDraftNote,
    showAgentNotes,
  ]);

  const fileViewRenderPlans = useMemo(() => {
    const next = new Map<
      string,
      { fileView: ResolvedFileViewLayout; rows: ReturnType<typeof buildFileViewRenderPlan>["rows"] }
    >();
    for (const file of files) {
      const fileView = fileViews.get(file.id);
      if (!fileView) continue;
      const plan = buildFileViewRenderPlan(
        fileView.layout,
        allAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES,
      );
      // Review data is never partially hidden: one unresolved note keeps this file on raw diff.
      if (plan.unresolvedNoteIds.length === 0) {
        next.set(file.id, { fileView, rows: plan.rows });
      }
    }
    return next;
  }, [allAgentNotesByFile, fileViews, files]);

  // Keep the full file-section path for wrapped lines, where exact wrapped heights depend on
  // mounting each section; nowrap reviews can window offscreen files behind exact spacers.
  const windowingEnabled = !wrapLines;
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });
  const [initialWrappedRenderWindowWarmed, setInitialWrappedRenderWindowWarmed] = useState(
    () => !wrapLines,
  );
  const [rapidScrollOverscanRows, setRapidScrollOverscanRows] = useState(0);
  const [hoveredFileId, setHoveredFileId] = useState<string | null>(null);
  const [copySelectionDrag, setCopySelectionDrag] = useState<CopySelectionDrag | null>(null);
  // Mirror the drag state in a ref so updateCopySelection can suppress native selection
  // on the very first drag event, before React has re-rendered with the new state.
  const copySelectionDragRef = useRef<CopySelectionDrag | null>(null);
  const lastClickTimeRef = useRef(0);
  const clickCountRef = useRef(0);
  const lastClickPointRef = useRef<CopySelectionPoint | null>(null);
  const scrollbarRef = useRef<VerticalScrollbarHandle>(null);
  const prevScrollTopRef = useRef(0);
  const hasReadScrollViewportRef = useRef(false);
  const previousSectionGeometryRef = useRef<DiffSectionGeometry[] | null>(null);
  const previousFilesRef = useRef<DiffFile[]>(files);
  const previousLayoutRef = useRef(layout);
  const previousWrapLinesRef = useRef(wrapLines);
  const previousViewportPaneHeightRef = useRef(height);
  const draftNoteId = draftNote?.id ?? null;
  const draftNoteFileId = draftNote?.fileId ?? null;
  const previousDraftNoteIdRef = useRef(draftNoteId);
  const previousSelectedFileTopAlignRequestIdRef = useRef(selectedFileTopAlignRequestId);
  const previousLayoutToggleRequestIdRef = useRef(layoutToggleRequestId);
  const previousSelectedHunkRevealRequestIdRef = useRef(selectedHunkRevealRequestId);
  const pendingFileTopAlignFileIdRef = useRef<string | null>(null);
  const suppressViewportSelectionSyncRef = useRef(false);
  const suppressViewportSelectionSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const rapidScrollOverscanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Initialized to null so the first render never fires a selection change; a real scroll
  // is required before passive viewport-follow selection can trigger.
  const lastViewportSelectionTopRef = useRef<number | null>(null);
  const lastViewportRowAnchorRef = useRef<ViewportRowAnchor | null>(null);
  // Track the previous selected anchor to detect actual selection changes.
  const prevSelectedAnchorIdRef = useRef<string | null>(null);
  const prevPinnedHeaderFileIdRef = useRef<string | null>(null);
  const pendingSelectionSettleRef = useRef(false);
  const pendingSelectionRevealTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /** Clear scheduled selection-reveal retries without changing the resettle policy. */
  const clearPendingSelectionRevealTimers = useCallback(() => {
    for (const timeout of pendingSelectionRevealTimeoutsRef.current) {
      clearTimeout(timeout);
    }
    pendingSelectionRevealTimeoutsRef.current = [];
  }, []);

  /** Retire selection reveal work once another explicit scroll policy becomes authoritative. */
  const supersedePendingSelectionReveal = useCallback(() => {
    clearPendingSelectionRevealTimers();
    pendingSelectionSettleRef.current = false;
  }, [clearPendingSelectionRevealTimers]);

  /** Clear any pending "selected file to top" follow-up. */
  const clearPendingFileTopAlign = useCallback(() => {
    pendingFileTopAlignFileIdRef.current = null;
  }, []);

  /** Track the currently hover-owned file without making scroll handlers depend on render state. */
  const setHoveredFileForRowActions = useCallback((fileId: string) => {
    hoveredFileIdRef.current = fileId;
    setHoveredFileId(fileId);
  }, []);

  /** Temporarily widen the mounted diff window while scroll input is arriving in bursts. */
  const activateRapidScrollOverscan = useCallback((overscanRows: number) => {
    if (overscanRows <= 0) {
      return;
    }

    setRapidScrollOverscanRows((current) => Math.max(current, overscanRows));
    if (rapidScrollOverscanTimeoutRef.current) {
      clearTimeout(rapidScrollOverscanTimeoutRef.current);
    }
    rapidScrollOverscanTimeoutRef.current = setTimeout(() => {
      rapidScrollOverscanTimeoutRef.current = null;
      setRapidScrollOverscanRows(0);
    }, RAPID_SCROLL_OVERSCAN_IDLE_MS);
  }, []);

  /**
   * Ignore viewport-follow selection updates while the pane is scrolling to an explicit selection.
   * That lets direct hunk/file navigation own the viewport until the jump settles.
   */
  const suppressViewportSelectionSync = useCallback((durationMs = 160) => {
    suppressViewportSelectionSyncRef.current = true;
    if (suppressViewportSelectionSyncTimeoutRef.current) {
      clearTimeout(suppressViewportSelectionSyncTimeoutRef.current);
    }
    suppressViewportSelectionSyncTimeoutRef.current = setTimeout(() => {
      suppressViewportSelectionSyncRef.current = false;
      suppressViewportSelectionSyncTimeoutRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    const warmInitialRenderWindow = wrapLines
      ? setTimeout(() => setInitialWrappedRenderWindowWarmed(true), VIEWPORT_READ_COALESCE_MS)
      : null;
    return () => {
      if (warmInitialRenderWindow) {
        clearTimeout(warmInitialRenderWindow);
      }
    };
  }, [wrapLines]);

  useEffect(() => {
    return () => {
      if (suppressViewportSelectionSyncTimeoutRef.current) {
        clearTimeout(suppressViewportSelectionSyncTimeoutRef.current);
      }
      if (rapidScrollOverscanTimeoutRef.current) {
        clearTimeout(rapidScrollOverscanTimeoutRef.current);
      }
    };
  }, []);

  // Mirror the imperative OpenTUI scrollbox state into React state so geometry planning,
  // windowing, pinned-header ownership, and prefetching can all read the same viewport snapshot.
  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox) {
      return;
    }
    const paneHeightChanged = previousViewportPaneHeightRef.current !== height;
    previousViewportPaneHeightRef.current = height;

    let cancelled = false;
    let scheduled = false;
    let scheduledViewportRead: ReturnType<typeof setTimeout> | null = null;
    let lastReadTop = scrollBox.scrollTop ?? 0;
    let lastReadHeight = scrollBox.viewport.height ?? 0;

    const readViewport = () => {
      const nextTop = scrollBox.scrollTop ?? 0;
      const nextHeight = scrollBox.viewport.height ?? 0;
      lastReadTop = nextTop;
      lastReadHeight = nextHeight;

      // The first viewport read is a baseline snapshot, not scroll input. The scroll box may retain
      // a non-zero top across remounts, so do not treat that retained position as a rapid burst.
      if (!hasReadScrollViewportRef.current) {
        hasReadScrollViewportRef.current = true;
        prevScrollTopRef.current = nextTop;
      } else if (nextTop !== prevScrollTopRef.current) {
        // Detect scroll activity, show scrollbar, and clear hover-only controls. The pointer may
        // now sit over a different row, but only an actual mouse move should reveal row actions.
        const previousTop = prevScrollTopRef.current;
        scrollbarRef.current?.show();
        clearAddNoteHoverForScroll();
        const rapidOverscanRows = computeRapidScrollOverscanRows({
          deltaRows: nextTop - previousTop,
          viewportHeight: nextHeight,
        });
        if (!wrapLines || rapidOverscanRows > nextHeight * 3) {
          activateRapidScrollOverscan(rapidOverscanRows);
        }
        prevScrollTopRef.current = nextTop;
      }

      setScrollViewport((current) =>
        current.top === nextTop && current.height === nextHeight
          ? current
          : { top: nextTop, height: nextHeight },
      );
    };

    // OpenTUI emits viewport events from its own layout and slider work. Keep React state updates
    // timer-deferred so wheel/key bursts collapse into bounded review-stream renders.
    /** Schedule at most one deferred read for the current viewport event burst. */
    const scheduleViewportRead = (delay: number) => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      scheduledViewportRead = setTimeout(() => {
        scheduledViewportRead = null;
        if (cancelled) {
          scheduled = false;
          return;
        }

        try {
          readViewport();
        } finally {
          scheduled = false;
        }
      }, delay);
    };

    const handleViewportChange = () => {
      if (
        (scrollBox.scrollTop ?? 0) === lastReadTop &&
        (scrollBox.viewport.height ?? 0) === lastReadHeight
      ) {
        return;
      }
      scheduleViewportRead(
        wrapLines ? Math.floor(VIEWPORT_READ_COALESCE_MS / 2) : VIEWPORT_READ_COALESCE_MS,
      );
    };

    // Wait for one real Yoga height change only when geometry is still unknown or the planned pane
    // height changed. Leaving this armed after a successful read feeds later content relayouts back
    // into React even though the viewport height is already authoritative.
    const handleViewportResize = () => {
      if ((scrollBox.viewport.height ?? 0) === lastReadHeight) {
        return;
      }
      scrollBox.viewport.off("resize", handleViewportResize);
      if (wrapLines) {
        queueMicrotask(() => {
          if (!cancelled) {
            readViewport();
          }
        });
        return;
      }
      // The exact nowrap estimate already fills the first paint. Publish Yoga's measured height on
      // the next frame so later input shares the authoritative window without rendering twice.
      scheduleViewportRead(VIEWPORT_READ_COALESCE_MS);
    };

    readViewport();
    scrollBox.verticalScrollBar.on("change", handleViewportChange);
    if (lastReadHeight <= 0 || paneHeightChanged) {
      scrollBox.viewport.on("resize", handleViewportResize);
    }

    return () => {
      cancelled = true;
      if (scheduledViewportRead) {
        clearTimeout(scheduledViewportRead);
      }
      scrollBox.verticalScrollBar.off("change", handleViewportChange);
      scrollBox.viewport.off("resize", handleViewportResize);
    };
  }, [
    activateRapidScrollOverscan,
    clearAddNoteHoverForScroll,
    files.length,
    height,
    scrollRef,
    wrapLines,
  ]);

  const sectionHeaderHeights = useMemo(() => buildInStreamFileHeaderHeights(files), [files]);
  const reserveAddNoteColumn = Boolean(onStartUserNoteAtHunk);

  const baseSectionGeometry = useMemo(
    () =>
      files.map((file) => {
        const plannedFileView = fileViewRenderPlans.get(file.id);
        if (plannedFileView) {
          return measureFileViewGeometry({
            resolved: plannedFileView.fileView,
            plannedRows: plannedFileView.rows,
            width: diffContentWidth,
          });
        }
        return measureDiffSectionGeometry(
          file,
          layout,
          showHunkHeaders,
          theme,
          EMPTY_VISIBLE_AGENT_NOTES,
          diffContentWidth,
          showLineNumbers,
          wrapLines,
          expandedGapsByFileId[file.id] ?? EMPTY_EXPANDED_GAP_KEYS,
          sourceStatusByFileId[file.id],
          reserveAddNoteColumn,
          tabWidth,
          hunkGap,
        );
      }),
    [
      diffContentWidth,
      expandedGapsByFileId,
      fileViewRenderPlans,
      files,
      hunkGap,
      layout,
      reserveAddNoteColumn,
      showHunkHeaders,
      showLineNumbers,
      sourceStatusByFileId,
      tabWidth,
      theme,
      wrapLines,
    ],
  );
  // Measure with the *full* set of agent notes per file, not just the visible-viewport set.
  // The visible set is correct for rendering (skip painting cards on off-screen files), but
  // using it here makes total content height fluctuate with scroll position: as a file with
  // notes leaves the viewport, its measurement shrinks back to the no-notes baseline, which
  // shrinks `totalContentHeight`, which tightens `clampReviewScrollTop`'s ceiling, which
  // snaps the viewport upward by the height of the off-top note rows. Always include notes
  // in geometry for stable bottom-edge clamping.
  const sectionGeometry = useMemo(
    () =>
      files.map((file, index) => {
        if (fileViewRenderPlans.has(file.id)) {
          return baseSectionGeometry[index]!;
        }
        const notes = allAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES;
        if (notes.length === 0) return baseSectionGeometry[index]!;

        return measureDiffSectionGeometry(
          file,
          layout,
          showHunkHeaders,
          theme,
          notes,
          diffContentWidth,
          showLineNumbers,
          wrapLines,
          expandedGapsByFileId[file.id] ?? EMPTY_EXPANDED_GAP_KEYS,
          sourceStatusByFileId[file.id],
          reserveAddNoteColumn,
          tabWidth,
          hunkGap,
        );
      }),
    [
      allAgentNotesByFile,
      baseSectionGeometry,
      diffContentWidth,
      expandedGapsByFileId,
      fileViewRenderPlans,
      files,
      hunkGap,
      layout,
      reserveAddNoteColumn,
      showHunkHeaders,
      showLineNumbers,
      sourceStatusByFileId,
      tabWidth,
      theme,
      wrapLines,
    ],
  );
  const estimatedBodyHeights = useMemo(
    () => sectionGeometry.map((metrics) => metrics.bodyHeight),
    [sectionGeometry],
  );
  const fileSectionLayouts = useMemo(
    () => buildFileSectionLayouts(files, estimatedBodyHeights, sectionHeaderHeights, fileGap),
    [estimatedBodyHeights, fileGap, files, sectionHeaderHeights],
  );
  const totalContentHeight = fileSectionLayouts[fileSectionLayouts.length - 1]?.sectionBottom ?? 0;
  const previousScrollEdgeRequestIdRef = useRef(scrollEdgeRequest?.id ?? 0);
  const pendingScrollEdgeRequest =
    scrollEdgeRequest && scrollEdgeRequest.id !== previousScrollEdgeRequestIdRef.current
      ? scrollEdgeRequest
      : null;
  const scrollEdgeViewportHeight = Math.max(
    scrollViewport.height,
    scrollRef.current?.viewport.height ?? 0,
  );
  const requestedScrollEdgeTop = pendingScrollEdgeRequest
    ? clampVerticalScrollTop(
        pendingScrollEdgeRequest.edge === "bottom" ? totalContentHeight : 0,
        totalContentHeight,
        scrollEdgeViewportHeight,
      )
    : null;
  const renderScrollTop = requestedScrollEdgeTop ?? scrollViewport.top;

  // Edge jumps render their destination rows before moving OpenTUI's native viewport, avoiding a
  // frame where viewport culling points at rows that React has not mounted yet.
  useLayoutEffect(() => {
    if (!pendingScrollEdgeRequest || requestedScrollEdgeTop === null) {
      return;
    }
    const scrollBox = scrollRef.current;
    if (!scrollBox) {
      return;
    }

    supersedePendingSelectionReveal();
    clearPendingFileTopAlign();
    previousScrollEdgeRequestIdRef.current = pendingScrollEdgeRequest.id;
    const viewportHeight = scrollBox.viewport.height || scrollEdgeViewportHeight;
    const nextTop = clampVerticalScrollTop(
      requestedScrollEdgeTop,
      totalContentHeight,
      viewportHeight,
    );
    setScrollViewport({ top: nextTop, height: viewportHeight });
    scrollBox.scrollTo(nextTop);
  }, [
    clearPendingFileTopAlign,
    pendingScrollEdgeRequest,
    requestedScrollEdgeTop,
    scrollEdgeViewportHeight,
    scrollRef,
    supersedePendingSelectionReveal,
    totalContentHeight,
  ]);
  const fileSectionIndexById = useMemo(
    () => buildFileSectionIndexById(fileSectionLayouts),
    [fileSectionLayouts],
  );

  const measuredLineCursors = useMemo(
    // Nothing reads the stops while the marker is off, and enumerating them costs one object per
    // rendered row of the whole changeset every time geometry is remeasured.
    () => (cursorLine === "off" ? EMPTY_LINE_CURSORS : buildLineCursors(files, sectionGeometry)),
    [cursorLine, files, sectionGeometry],
  );
  const lineCursorStabilizerRef = useRef<ReturnType<typeof createLineCursorStabilizer> | null>(
    null,
  );
  lineCursorStabilizerRef.current ??= createLineCursorStabilizer();
  const lineCursors = lineCursorStabilizerRef.current(measuredLineCursors);
  /** Locate one measured row in whole-stream rows, addressed by its file and plan anchor. */
  const rowBoundsInStream = useCallback(
    (fileId: string, stableKey: string) => {
      const sectionIndex = fileSectionIndexById.get(fileId);
      if (sectionIndex === undefined) {
        return undefined;
      }

      return streamRowBoundsAt(fileSectionLayouts, sectionGeometry, sectionIndex, stableKey);
    },
    [fileSectionIndexById, fileSectionLayouts, sectionGeometry],
  );
  const lineCursorBoundsOf = useCallback<LineCursorBoundsLookup>(
    (cursor) => rowBoundsInStream(cursor.fileId, cursor.stableKey),
    [rowBoundsInStream],
  );

  useEffect(() => {
    onLineCursorsChange?.(lineCursors);
  }, [lineCursors, onLineCursorsChange]);

  // Read the live scroll box position during render so pinned-header ownership flips
  // immediately after imperative scrolls instead of waiting for the polled viewport snapshot.
  const effectiveScrollTop = pendingScrollEdgeRequest
    ? renderScrollTop
    : (scrollRef.current?.scrollTop ?? scrollViewport.top);
  const pinnedHeaderFile = useMemo(() => {
    if (files.length === 0) {
      return null;
    }

    // The current file header always owns the pinned top row.
    // Use the previous visible row to decide ownership so the next file's real header can still
    // scroll through the stream before the pinned header hands off to it on the following row.
    const owner = findHeaderOwningFileSection(
      fileSectionLayouts,
      Math.max(0, effectiveScrollTop - 1),
    );

    return owner ? (files[owner.sectionIndex] ?? null) : (files[0] ?? null);
  }, [effectiveScrollTop, fileSectionLayouts, files]);
  const pinnedHeaderFileId = pinnedHeaderFile?.id ?? null;

  const copySelectionContext = useMemo(
    (): CopySelectionContext => ({
      codeHorizontalOffset,
      copyDecorations,
      files,
      fileSectionLayouts,
      headerLabelWidth,
      headerStatsWidth,
      layout,
      pinnedHeaderFile,
      reserveAddNoteColumn,
      sectionGeometry,
      showHunkHeaders,
      showLineNumbers,
      width: diffContentWidth,
      wrapLines,
    }),
    [
      codeHorizontalOffset,
      copyDecorations,
      diffContentWidth,
      fileSectionLayouts,
      files,
      headerLabelWidth,
      headerStatsWidth,
      layout,
      pinnedHeaderFile,
      reserveAddNoteColumn,
      sectionGeometry,
      showHunkHeaders,
      showLineNumbers,
      wrapLines,
    ],
  );

  // In split layout, anchor the visible selection (and clipboard copy) to whichever side of
  // the diff the drag began on. Stack layout has only one column, so the side stays undefined.
  const copySelectionSide: CopySelectionSide | undefined = useMemo(() => {
    if (!copySelectionDrag || copySelectionDrag.anchor.kind !== "review-row") {
      return undefined;
    }
    return resolveCopySelectionSide(copySelectionDrag.anchor.column, layout, diffContentWidth);
  }, [copySelectionDrag, diffContentWidth, layout]);

  // Display the selected hunk's first line on the initial mount while the controller adopts the
  // measured cursor list. Because both paths reuse the same cursor object, the follow-up state
  // publication does not invalidate and repaint an expensive wrapped row.
  const renderedLineCursor = useMemo(
    () => lineCursor ?? firstLineCursorInHunk(lineCursors, selectedFileId, selectedHunkIndex),
    [lineCursor, lineCursors, selectedFileId, selectedHunkIndex],
  );

  // One object per cursor move, so the section and row memos below only see a new reference when
  // the current line actually moves.
  const cursorHighlight = useMemo(
    () =>
      cursorLine === "off" || !renderedLineCursor
        ? undefined
        : ({
            stableKey: renderedLineCursor.stableKey,
            style: cursorLine,
            side: renderedLineCursor.target.side,
          } satisfies CursorHighlight),
    [cursorLine, renderedLineCursor],
  );

  // Current-line paint closes over the exact accepted renderer plan. It remains opaque to
  // extensions and never introduces another highlight request, cache, or cursor model.
  const currentLinePaintFile = useMemo(() => {
    if (
      !currentLinePaintRequested ||
      layout !== "split" ||
      cursorLine === "off" ||
      !renderedLineCursor ||
      pagerMode ||
      fileViewRenderPlans.has(renderedLineCursor.fileId)
    )
      return undefined;
    const sectionIndex = fileSectionIndexById.get(renderedLineCursor.fileId);
    return sectionIndex === undefined ? undefined : files[sectionIndex];
  }, [
    currentLinePaintRequested,
    cursorLine,
    fileSectionIndexById,
    fileViewRenderPlans,
    files,
    layout,
    pagerMode,
    renderedLineCursor,
  ]);

  const currentLinePaintSource = useMemo(
    () => (currentLinePaintFile ? { file: currentLinePaintFile, theme, tabWidth } : null),
    [currentLinePaintFile, tabWidth, theme],
  );

  const currentLineRowPlanCallback = useMemo(() => {
    if (!currentLinePaintSource) return undefined;
    return (rowPlan: DiffSectionRowPlan, highlighted: boolean) => {
      setCurrentLineRowPlan((current) =>
        current?.source === currentLinePaintSource &&
        current.rowPlan === rowPlan &&
        current.highlighted === highlighted
          ? current
          : { source: currentLinePaintSource, rowPlan, highlighted },
      );
    };
  }, [currentLinePaintSource]);

  const currentLinePaint = useMemo(() => {
    if (
      !currentLinePaintSource ||
      !renderedLineCursor ||
      !currentLineRowPlan?.highlighted ||
      currentLineRowPlan.source !== currentLinePaintSource
    )
      return null;
    return createExtensionCurrentLinePaint({
      cursor: renderedLineCursor,
      rowPlan: currentLineRowPlan.rowPlan,
      showLineNumbers,
      codeHorizontalOffset,
      theme,
    });
  }, [
    codeHorizontalOffset,
    currentLinePaintSource,
    currentLineRowPlan,
    renderedLineCursor,
    showLineNumbers,
    theme,
  ]);

  const currentLinePaintUpdate = useMemo<ExtensionCurrentLinePaintUpdate>(() => {
    if (!currentLinePaintSource) return { status: "unavailable" };
    if (
      !renderedLineCursor ||
      !currentLineRowPlan?.highlighted ||
      currentLineRowPlan.source !== currentLinePaintSource
    )
      return { status: "pending" };
    return currentLinePaint
      ? {
          status: "ready",
          fileId: renderedLineCursor.fileId,
          cursorKey: renderedLineCursor.stableKey,
          paint: currentLinePaint,
        }
      : { status: "unavailable" };
  }, [currentLinePaint, currentLinePaintSource, currentLineRowPlan, renderedLineCursor]);

  useLayoutEffect(() => {
    onCurrentLinePaintChange?.(currentLinePaintUpdate);
  }, [currentLinePaintUpdate, onCurrentLinePaintChange]);
  useLayoutEffect(
    () => () => onCurrentLinePaintChange?.({ status: "unavailable" }),
    [onCurrentLinePaintChange],
  );

  const copySelectedRowKeysByFile = useMemo(
    () =>
      buildCopySelectedRowKeys({
        drag: copySelectionDrag,
        fileSectionLayouts,
        sectionGeometry,
        width: diffContentWidth,
      }),
    [copySelectionDrag, diffContentWidth, fileSectionLayouts, sectionGeometry],
  );

  /** Copy selected text through the injected boundary or the renderer's OSC 52 clipboard support. */
  const copySelectionText = useCallback(
    (text: string) => {
      if (text.length === 0) {
        return;
      }

      if (onCopySelectionText) {
        onCopySelectionText(text);
        return;
      }

      const supportsOsc52 = renderer.isOsc52Supported?.() ?? false;
      if (supportsOsc52 && typeof renderer.copyToClipboardOSC52 === "function") {
        renderer.copyToClipboardOSC52(text);
        onCopyFeedback?.("Copied selection to clipboard");
        return;
      }

      onCopyFeedback?.(
        "Clipboard copy unsupported in this terminal (enable OSC 52 to capture selections)",
      );
    },
    [onCopyFeedback, onCopySelectionText, renderer],
  );

  /** Convert one mouse event into a review-stream copy-selection point. */
  const resolveCopySelectionPoint = useCallback(
    (event: TuiMouseEvent): CopySelectionPoint | null => {
      const scrollBox = scrollRef.current;
      if (!scrollBox) {
        return null;
      }

      // Resolve against OpenTUI's measured viewport instead of reconstructing its screen position
      // from borders, padding, chrome, and the pinned-header lane. Those decorations can shift by
      // a row as layouts settle, while the measured viewport and translated content coordinates
      // always match what OpenTUI actually painted and hit-tested.
      const viewportScreenX = scrollBox.viewport.screenX;
      const viewportScreenY = scrollBox.viewport.screenY;
      const contentScreenY = scrollBox.content.screenY;
      const column = Math.floor(event.x - viewportScreenX);
      if (copyDecorations && pinnedHeaderFileId && Math.floor(event.y) === viewportScreenY - 1) {
        return {
          kind: "pinned-header",
          column: clampCopyColumn(column, diffContentWidth),
          fileId: pinnedHeaderFileId,
          nextVisualRow: Math.floor(viewportScreenY - contentScreenY),
        };
      }

      const viewportY = Math.floor(event.y - viewportScreenY);
      if (viewportY < 0 || viewportY >= Math.max(1, scrollBox.viewport.height ?? 0)) {
        return null;
      }

      return findCopySelectionPoint({
        column,
        copyDecorations,
        fileSectionLayouts,
        sectionGeometry,
        visualRow: Math.floor(event.y - contentScreenY),
        width: diffContentWidth,
      });
    },
    [
      copyDecorations,
      diffContentWidth,
      fileSectionLayouts,
      pinnedHeaderFileId,
      scrollRef,
      sectionGeometry,
    ],
  );

  // OpenTUI starts a native cross-renderable text selection on mouse-down over any selectable
  // <text> before our handler runs. That native selection ignores element bounds and paints
  // across the whole screen, so we eagerly clear it whenever Hunk owns the drag.
  const suppressNativeSelection = useCallback(() => {
    if (renderer.hasSelection) {
      renderer.clearSelection();
    }
  }, [renderer]);

  /** Start selecting diff text when the user drags inside the review stream. */
  const beginCopySelection = useCallback(
    (event: TuiMouseEvent) => {
      if (event.button !== MouseButton.LEFT) {
        return;
      }

      const point = resolveCopySelectionPoint(event);
      if (!point) {
        copySelectionDragRef.current = null;
        clickCountRef.current = 0;
        lastClickPointRef.current = null;
        setCopySelectionDrag(null);
        return;
      }

      // Detect double-click and triple-click for word/line selection.
      const now = Date.now();
      const timeSinceLastClick = now - lastClickTimeRef.current;
      const previousClickPoint = lastClickPointRef.current;
      const repeatedClickTarget =
        previousClickPoint !== null &&
        copySelectionPointsShareRow(previousClickPoint, point) &&
        Math.abs(previousClickPoint.column - point.column) <= 2;
      lastClickTimeRef.current = now;
      lastClickPointRef.current = point;

      let clickCount = 1;
      if (timeSinceLastClick < 350 && timeSinceLastClick >= 0 && repeatedClickTarget) {
        clickCountRef.current += 1;
        clickCount = Math.min(clickCountRef.current, 3);
      } else {
        clickCountRef.current = 1;
      }

      if (clickCount >= 2 && point.kind === "review-row") {
        const expanded = expandSelectionPoint(point, clickCount as 2 | 3, copySelectionContext);
        if (expanded) {
          const drag: CopySelectionDrag = {
            anchor: { ...point, column: expanded.startCol },
            focus: { ...point, column: expanded.endCol },
            moved: true,
            expanded: true,
          };
          copySelectionDragRef.current = drag;
          setCopySelectionDrag(drag);
          suppressNativeSelection();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const initial: CopySelectionDrag = { anchor: point, focus: point, moved: false };
      copySelectionDragRef.current = initial;
      setCopySelectionDrag(initial);
      suppressNativeSelection();
      event.preventDefault();
      event.stopPropagation();
    },
    [copySelectionContext, resolveCopySelectionPoint, suppressNativeSelection],
  );

  /** Extend the active diff text selection while the pointer moves. */
  const updateCopySelection = useCallback(
    (event: TuiMouseEvent) => {
      // Use the ref (not state) so that native-selection suppression fires on the very
      // first drag event, before React has re-rendered with the new copySelectionDrag.
      setCopySelectionDrag((current) => {
        if (!current) {
          return current;
        }

        const point = resolveCopySelectionPoint(event);
        if (!point) {
          return current;
        }

        return {
          anchor: current.anchor,
          focus: point,
          moved: current.moved || !copySelectionPointsEqual(point, current.anchor),
          expanded: current.expanded,
        };
      });

      // The state updater above sets the ref during the render phase. Update the ref
      // synchronously as well so that endCopySelection can read the correct moved flag
      // even if the mouse-up event fires before React processes the pending state update.
      const refDrag = copySelectionDragRef.current;
      if (refDrag) {
        const point = resolveCopySelectionPoint(event);
        if (point) {
          copySelectionDragRef.current = {
            anchor: refDrag.anchor,
            focus: point,
            moved: refDrag.moved || !copySelectionPointsEqual(point, refDrag.anchor),
            expanded: refDrag.expanded,
          };
        }
      }

      if (copySelectionDragRef.current) {
        const scrollBox = scrollRef.current;
        if (scrollBox) {
          setMouseCapture(renderer, scrollBox);
        }
        suppressNativeSelection();
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [renderer, resolveCopySelectionPoint, scrollRef, suppressNativeSelection],
  );

  /** Finish a mouse gesture by selecting its clicked line or copying its deliberate drag. */
  const endCopySelection = useCallback(
    (event?: TuiMouseEvent) => {
      const pending = copySelectionDragRef.current;
      if (!pending) {
        return;
      }

      // Resolve mouse-up itself because terminal hosts may coalesce the final motion event.
      const endPoint = event && !pending.expanded ? resolveCopySelectionPoint(event) : null;
      const current = endPoint
        ? {
            anchor: pending.anchor,
            focus: endPoint,
            moved: pending.moved || !copySelectionPointsEqual(endPoint, pending.anchor),
            expanded: pending.expanded,
          }
        : pending;

      copySelectionDragRef.current = null;
      setCopySelectionDrag(null);
      event?.preventDefault();
      event?.stopPropagation();

      if (copySelectionDragIsClick(current)) {
        if (event && isNestedRowMouseAction(event)) {
          return;
        }

        const clickedCursor = findLineCursorForClick({
          cursors: lineCursors,
          fileSectionLayouts,
          point: current.anchor,
          sectionGeometry,
          side: resolveCopySelectionSide(current.anchor.column, layout, diffContentWidth),
        });
        if (clickedCursor && onViewportLineCursorChange) {
          onViewportLineCursorChange(clickedCursor);
          return;
        }
        if (!current.moved) {
          return;
        }
      }

      const { start, end } = normalizeCopySelectionRange(current.anchor, current.focus);
      const text = renderCopySelectionText({
        context: copySelectionContext,
        end,
        side: copySelectionSide,
        start,
      });
      copySelectionText(text);
    },
    [
      copySelectionContext,
      copySelectionSide,
      copySelectionText,
      diffContentWidth,
      fileSectionLayouts,
      layout,
      lineCursors,
      onViewportLineCursorChange,
      resolveCopySelectionPoint,
      sectionGeometry,
    ],
  );

  // Expose the cancel hook so an ancestor (App's outer container) can release a stuck drag when
  // the pointer leaves the diff pane and is released over the sidebar, menu bar, or status bar.
  useEffect(() => {
    if (!cancelCopySelectionRef) {
      return;
    }
    cancelCopySelectionRef.current = () => endCopySelection();
    return () => {
      if (cancelCopySelectionRef.current) {
        cancelCopySelectionRef.current = null;
      }
    };
  }, [cancelCopySelectionRef, endCopySelection]);

  /** Clamp one requested review scroll target against the latest planned content height. */
  const clampReviewScrollTop = useCallback(
    (requestedTop: number, viewportHeight: number) =>
      clampVerticalScrollTop(requestedTop, totalContentHeight, viewportHeight),
    [totalContentHeight],
  );

  const highlightPrefetchFileIds = useMemo(
    () =>
      buildHighlightPrefetchFileIds({
        adjacentPrefetchFileIds,
        fileSectionLayouts,
        rapidScrollOverscanRows,
        scrollTop: renderScrollTop,
        viewportHeight: scrollViewport.height,
        selectedFileId,
      }),
    [
      adjacentPrefetchFileIds,
      fileSectionLayouts,
      rapidScrollOverscanRows,
      scrollViewport.height,
      renderScrollTop,
      selectedFileId,
    ],
  );

  // Kick off highlight work from viewport planning rather than waiting for the section to mount.
  // That avoids the "plain rows first, color later" stutter when a file is about to scroll onscreen.
  useEffect(() => {
    if (files.length === 0 || (wrapLines && !initialWrappedRenderWindowWarmed)) {
      return;
    }

    for (const file of files) {
      if (!highlightPrefetchFileIds.has(file.id)) {
        continue;
      }

      void prefetchHighlightedDiff({
        file,
        offloadLargeDiff,
        theme,
      });
    }
  }, [
    files,
    highlightPrefetchFileIds,
    initialWrappedRenderWindowWarmed,
    offloadLargeDiff,
    theme,
    wrapLines,
  ]);

  // Keep the selected file/hunk derived from the visible viewport for actual scroll-driven
  // movement, while leaving the initial mount and non-scroll relayouts alone.
  useLayoutEffect(() => {
    const previousViewportTop = lastViewportSelectionTopRef.current;
    lastViewportSelectionTopRef.current = scrollViewport.top;

    if (
      previousViewportTop === null ||
      previousViewportTop === scrollViewport.top ||
      suppressViewportSelectionSyncRef.current ||
      // A requested file-top align is still settling, so this viewport move is our own scroll
      // rather than the user's. The timed suppression above can expire before the align lands on
      // a loaded machine, and adopting the centered hunk there would silently undo the navigation
      // that asked for the align in the first place.
      pendingFileTopAlignFileIdRef.current !== null ||
      files.length === 0 ||
      scrollViewport.height <= 0
    ) {
      return;
    }

    if (lineCursors.length > 0) {
      const clampedCursor = clampLineCursorToViewport({
        boundsOf: lineCursorBoundsOf,
        current: lineCursor,
        cursors: lineCursors,
        scrollTop: scrollViewport.top,
        viewportHeight: scrollViewport.height,
      });
      if (clampedCursor && clampedCursor !== lineCursor) {
        onViewportLineCursorChange?.(clampedCursor);
      }
      return;
    }

    const centeredTarget = findViewportCenteredHunkTarget({
      files,
      fileSectionLayouts,
      sectionGeometry,
      scrollTop: scrollViewport.top,
      viewportHeight: scrollViewport.height,
    });
    if (!centeredTarget) {
      return;
    }

    if (
      centeredTarget.fileId === selectedFileId &&
      centeredTarget.hunkIndex === selectedHunkIndex
    ) {
      return;
    }

    onViewportCenteredHunkChange?.(centeredTarget.fileId, centeredTarget.hunkIndex);
  }, [
    fileSectionLayouts,
    files,
    lineCursor,
    lineCursorBoundsOf,
    lineCursors,
    onViewportCenteredHunkChange,
    onViewportLineCursorChange,
    scrollViewport.height,
    scrollViewport.top,
    sectionGeometry,
    selectedFileId,
    selectedHunkIndex,
  ]);

  useLayoutEffect(() => {
    renderer.intermediateRender();
  }, [renderer, pinnedHeaderFileId]);

  const fullFileRenderItems = useMemo(
    (): FileRenderWindowItem[] =>
      files.map((file, sectionIndex) => ({ kind: "file", fileId: file.id, sectionIndex })),
    [files],
  );
  const initialRenderViewportHeight = estimateInitialRenderViewportHeight(
    renderer.height,
    screenTop,
    height,
  );
  // File windowing must not see height 0: that range is only the first file plus one overscan
  // neighbor, which leaves a tall first paint blank until the scrollbox later publishes geometry.
  const fileWindowViewportHeight = resolveRenderViewportHeight(
    scrollViewport.height,
    initialRenderViewportHeight,
  );
  const fileRenderWindow = useMemo(
    () =>
      windowingEnabled
        ? buildFileRenderWindow({
            fileSectionLayouts,
            indexByFileId: fileSectionIndexById,
            overscanFiles: 1,
            scrollTop: renderScrollTop,
            selectedFileId,
            viewportHeight: fileWindowViewportHeight,
          })
        : null,
    [
      fileSectionIndexById,
      fileSectionLayouts,
      fileWindowViewportHeight,
      renderScrollTop,
      selectedFileId,
      windowingEnabled,
    ],
  );
  const fileRenderItems = fileRenderWindow?.items ?? fullFileRenderItems;
  const mountedFileIndices = fileRenderWindow?.mountedFileIndices ?? null;
  // Render note rows for exactly the mounted sections (all sections when windowing is off).
  // Section layouts and spacer heights are measured with the full note set, so a mounted section
  // that skipped its notes would paint shorter than its layout height and transiently shrink the
  // scrollbox content height, clamping bottom-edge scrolls. A viewport-proximity set cannot be
  // the source of truth here: it decays with rapid-scroll state on a timer, while the mounted
  // window extends beyond it via file overscan and prefetch.
  const visibleAgentNotesByFile = useMemo(() => {
    const next = new Map<string, VisibleAgentNote[]>();

    const mountedFileIds = mountedFileIndices
      ? mountedFileIndices.map((index) => files[index]?.id)
      : files.map((file) => file.id);

    for (const fileId of mountedFileIds) {
      if (!fileId) {
        continue;
      }

      const visibleNotes = allAgentNotesByFile.get(fileId);
      if (visibleNotes && visibleNotes.length > 0) {
        next.set(fileId, visibleNotes);
      }
    }

    return next;
  }, [allAgentNotesByFile, files, mountedFileIndices]);
  // Previous snapshot used to keep VisibleBodyBounds object identity stable across scroll
  // commits; DiffSection's memo comparator checks `visibleBodyBounds` by reference, so handing
  // back the prior object when top/height are numerically unchanged lets mounted sections skip
  // re-rendering even though the Map itself is rebuilt every snapshot.
  const previousVisibleBodyBoundsRef = useRef<Map<string, VisibleBodyBounds>>(new Map());
  const visibleBodyBoundsByFile = useMemo(() => {
    const previous = previousVisibleBodyBoundsRef.current;
    const next = new Map<string, VisibleBodyBounds>();
    if (!wrapLines && scrollViewport.height <= 0) {
      previousVisibleBodyBoundsRef.current = next;
      return next;
    }

    // Keep this provisional height render-only. Navigation and selection effects must continue to
    // wait for the exact scrollbox viewport represented by scrollViewport.height.
    const hasMeasuredViewport = scrollViewport.height > 0;
    const renderViewportHeight = hasMeasuredViewport
      ? scrollViewport.height
      : initialRenderViewportHeight;
    // Wrapped startup mounts only the exact estimated viewport (plus a fitting selected hunk), then
    // warms three viewports after one frame. Nowrap keeps its two-viewport window unchanged.
    const isInitialWrappedPaint =
      wrapLines && !hasMeasuredViewport && !initialWrappedRenderWindowWarmed;
    const baseOverscanRows = isInitialWrappedPaint ? 0 : renderViewportHeight * (wrapLines ? 3 : 2);
    const overscanTerminalRows = Math.max(
      isInitialWrappedPaint ? 0 : 24,
      baseOverscanRows,
      rapidScrollOverscanRows,
    );

    const indicesToMeasure = mountedFileIndices ?? files.map((_, index) => index);

    for (const index of indicesToMeasure) {
      const file = files[index];
      const sectionLayout = fileSectionLayouts[index];
      const geometry = sectionGeometry[index];
      if (!file || !sectionLayout || !geometry) {
        continue;
      }

      // Convert the absolute review-stream viewport into file-body-local coordinates.
      // Example: if the viewport starts at row 2_000 globally and this file body starts at row
      // 1_940, then the file-local visible top is 60 rows into this file.
      let minTop = renderScrollTop - sectionLayout.bodyTop - overscanTerminalRows;
      let maxBottom =
        renderScrollTop + renderViewportHeight - sectionLayout.bodyTop + overscanTerminalRows;

      // A fitting selected hunk must remain fully mounted even during the zero-halo first paint.
      // Oversized hunks keep ordinary viewport windowing so one selection cannot defeat startup.
      if (isInitialWrappedPaint && file.id === selectedFileId) {
        const clampedHunkIndex = Math.max(
          0,
          Math.min(selectedHunkIndex, file.metadata.hunks.length - 1),
        );
        const selectedBounds = geometry.hunkBounds.get(clampedHunkIndex);
        if (selectedBounds && selectedBounds.height <= renderViewportHeight) {
          minTop = Math.min(minTop, selectedBounds.top);
          maxBottom = Math.max(maxBottom, selectedBounds.top + selectedBounds.height);
        }
      }

      // Clamp the requested file-local interval back into the real body extent, then store it as
      // { top, height } so the row slicer can rebuild the matching [top, bottom) window later.
      const clampedTop = Math.min(geometry.bodyHeight, Math.max(0, minTop));
      const clampedBottom = Math.min(geometry.bodyHeight, Math.max(clampedTop, maxBottom));
      const height = clampedBottom - clampedTop;
      const previousBounds = previous.get(file.id);
      next.set(
        file.id,
        previousBounds && previousBounds.top === clampedTop && previousBounds.height === height
          ? previousBounds
          : { top: clampedTop, height },
      );
    }

    previousVisibleBodyBoundsRef.current = next;
    return next;
  }, [
    fileSectionLayouts,
    files,
    initialWrappedRenderWindowWarmed,
    rapidScrollOverscanRows,
    scrollViewport.height,
    renderScrollTop,
    initialRenderViewportHeight,
    sectionGeometry,
    mountedFileIndices,
    selectedFileId,
    selectedHunkIndex,
    wrapLines,
  ]);

  const selectedFileIndex = selectedFileId
    ? files.findIndex((file) => file.id === selectedFileId)
    : -1;
  const selectedFile = selectedFileIndex >= 0 ? files[selectedFileIndex] : undefined;
  const selectedAnchorId = selectedFile
    ? selectedFile.metadata.hunks[selectedHunkIndex]
      ? diffHunkId(selectedFile.id, selectedHunkIndex)
      : diffSectionId(selectedFile.id)
    : null;
  const selectedEstimatedHunkBounds = useMemo(() => {
    if (!selectedFile || selectedFileIndex < 0 || selectedFile.metadata.hunks.length === 0) {
      return null;
    }

    const selectedFileSectionLayout = fileSectionLayouts[selectedFileIndex];
    if (!selectedFileSectionLayout) {
      return null;
    }

    const clampedHunkIndex = Math.max(
      0,
      Math.min(selectedHunkIndex, selectedFile.metadata.hunks.length - 1),
    );
    const hunkBounds = sectionGeometry[selectedFileIndex]?.hunkBounds.get(clampedHunkIndex);
    if (!hunkBounds) {
      return null;
    }

    return {
      top: selectedFileSectionLayout.bodyTop + hunkBounds.top,
      height: hunkBounds.height,
      startRowId: hunkBounds.startRowId,
      endRowId: hunkBounds.endRowId,
      sectionTop: selectedFileSectionLayout.sectionTop,
    };
  }, [fileSectionLayouts, sectionGeometry, selectedFile, selectedFileIndex, selectedHunkIndex]);

  /**
   * The note a note-preferring reveal aims at, named by the shared policy.
   *
   * The candidates are this pane's own — sidecar annotations, agent comments, the
   * reviewer's notes, and the open draft, each hanging from the hunk its resolved anchor
   * names — while which of them wins is the one rule every review surface answers with.
   */
  const revealNoteId = useMemo(() => {
    if (!scrollToNote || !selectedFileId) {
      return null;
    }

    const notes = allAgentNotesByFile.get(selectedFileId);
    return notes
      ? (resolveReviewRevealNoteId(
          notes.flatMap((note) =>
            reviewNoteOwnerHunkIndex(note) === selectedHunkIndex
              ? [
                  {
                    id: note.id,
                    line: reviewNoteAnchorLine(note).line,
                    draft: note.source === "draft",
                  },
                ]
              : [],
          ),
        ) ?? null)
      : null;
  }, [allAgentNotesByFile, scrollToNote, selectedFileId, selectedHunkIndex]);

  /** Absolute scroll offset and height of the note that reveal aims at, once it is measured. */
  const selectedNoteBounds = useMemo(() => {
    if (!revealNoteId || !selectedEstimatedHunkBounds || selectedFileIndex < 0) {
      return null;
    }

    const noteRow = sectionGeometry[selectedFileIndex]?.rowBoundsByStableKey.get(
      inlineNoteStableKey(revealNoteId),
    );
    if (!noteRow) {
      return null;
    }

    return {
      top: selectedEstimatedHunkBounds.sectionTop + noteRow.top,
      height: noteRow.height,
    };
  }, [revealNoteId, sectionGeometry, selectedEstimatedHunkBounds, selectedFileIndex]);
  const selectedEstimatedHunkTop = selectedEstimatedHunkBounds?.top ?? null;
  const selectedEstimatedHunkHeight = selectedEstimatedHunkBounds?.height ?? null;
  const selectedEstimatedHunkStartRowId = selectedEstimatedHunkBounds?.startRowId ?? null;
  const selectedEstimatedHunkEndRowId = selectedEstimatedHunkBounds?.endRowId ?? null;
  const selectedNoteTop = selectedNoteBounds?.top ?? null;
  const selectedNoteHeight = selectedNoteBounds?.height ?? null;

  /** The bodyTop of the currently selected file's section layout, used to floor hunk reveal scroll targets so they never cross above the owning file boundary. */
  const selectedFileBodyTop =
    selectedFileIndex >= 0 ? (fileSectionLayouts[selectedFileIndex]?.bodyTop ?? 0) : 0;

  /**
   * Report whether the align has landed as far as the rest of this pane can observe it.
   *
   * `scrollViewport` is a coalesced read of the scroll box, so it trails `scrollBox.scrollTop` by at
   * least one read interval and by much more on a loaded machine. Viewport-follow selection reacts
   * to that trailing value, so an align counts as settled only once the trailing value agrees.
   */
  const isFileTopAlignSettled = useCallback(
    (desiredTop: number) => Math.abs(scrollViewport.top - desiredTop) <= 0.5,
    [scrollViewport.top],
  );

  /**
   * Resolve the scroll top that makes one file own the viewport top, or null when the planned
   * geometry is not measurable yet.
   *
   * The pinned header owns the top row, so align the review stream to the file body. Clamp the
   * target so short trailing files still settle cleanly at the reachable bottom edge: the last
   * short file often cannot actually own the viewport top near EOF, and treating that unreachable
   * top as the target would keep snapping manual upward scrolling back down to the bottom edge.
   */
  const resolveFileTopAlignScrollTop = useCallback(
    (fileId: string) => {
      const targetSection = fileSectionLayouts.find((layout) => layout.fileId === fileId);
      if (!targetSection) {
        return null;
      }

      const scrollBox = scrollRef.current;
      if (!scrollBox) {
        return null;
      }

      const viewportHeight = Math.max(scrollViewport.height, scrollBox.viewport.height ?? 0);
      return clampReviewScrollTop(targetSection.bodyTop, viewportHeight);
    },
    [clampReviewScrollTop, fileSectionLayouts, scrollRef, scrollViewport.height],
  );

  /** Scroll one file so it immediately owns the viewport top using the latest planned geometry. */
  const scrollFileHeaderToTop = useCallback(
    (fileId: string) => {
      const desiredTop = resolveFileTopAlignScrollTop(fileId);
      if (desiredTop === null) {
        return false;
      }

      scrollRef.current?.scrollTo(desiredTop);
      return true;
    },
    [resolveFileTopAlignScrollTop, scrollRef],
  );

  useLayoutEffect(() => {
    const layoutChanged = previousLayoutRef.current !== layout;
    const explicitLayoutToggle = previousLayoutToggleRequestIdRef.current !== layoutToggleRequestId;
    const wrapChanged = previousWrapLinesRef.current !== wrapLines;
    const previousSectionMetrics = previousSectionGeometryRef.current;
    const previousFiles = previousFilesRef.current;
    const currentDraftNoteId = draftNoteId;
    const draftChanged = previousDraftNoteIdRef.current !== currentDraftNoteId;

    if (draftChanged && previousSectionMetrics && previousFiles.length > 0) {
      const previousScrollTop = scrollRef.current?.scrollTop ?? scrollViewport.top;
      const previousSectionHeaderHeights = buildInStreamFileHeaderHeights(previousFiles);
      const anchor =
        lastViewportRowAnchorRef.current ??
        findViewportRowAnchor(
          previousFiles,
          previousSectionMetrics,
          previousScrollTop,
          previousSectionHeaderHeights,
          undefined,
          fileGap,
        );
      const cursorToPreserve = scrollToNote ? null : lineCursor;
      const previousCursorSectionIndex = cursorToPreserve
        ? previousFiles.findIndex((file) => file.id === cursorToPreserve.fileId)
        : -1;
      const previousCursorBounds =
        previousCursorSectionIndex >= 0 && cursorToPreserve
          ? streamRowBoundsAt(
              buildFileSectionLayouts(
                previousFiles,
                previousSectionMetrics.map((metrics) => metrics?.bodyHeight ?? 0),
                previousSectionHeaderHeights,
                fileGap,
              ),
              previousSectionMetrics,
              previousCursorSectionIndex,
              cursorToPreserve.stableKey,
            )
          : undefined;
      const currentCursorBounds = cursorToPreserve
        ? rowBoundsInStream(cursorToPreserve.fileId, cursorToPreserve.stableKey)
        : undefined;
      const cursorAnchoredTop =
        previousCursorBounds && currentCursorBounds
          ? currentCursorBounds.top - (previousCursorBounds.top - previousScrollTop)
          : null;
      const anchorTop =
        cursorAnchoredTop ??
        (anchor
          ? resolveViewportRowAnchorTop(
              files,
              sectionGeometry,
              anchor,
              sectionHeaderHeights,
              fileGap,
            )
          : null);

      if (anchorTop !== null) {
        const draftBounds =
          draftNoteId && draftNoteFileId && scrollToNote
            ? rowBoundsInStream(draftNoteFileId, inlineNoteStableKey(draftNoteId))
            : undefined;
        const nextTop = draftBounds
          ? computeLineRevealScrollTop({
              lineTop: draftBounds.top,
              lineHeight: draftBounds.height,
              scrollTop: anchorTop,
              viewportHeight: scrollRef.current?.viewport.height || scrollViewport.height,
            })
          : anchorTop;
        const restoreViewportAnchor = () => {
          // Cursor- and click-targeted composers are already at the reviewer's position, so their
          // stream geometry pushes following rows down without pulling the target line upward.
          // Default draft starts still reveal the full composer because they may target offscreen.
          scrollRef.current?.scrollTo(nextTop);
        };

        if (anchor) {
          lastViewportRowAnchorRef.current = anchor;
        }
        suppressViewportSelectionSync();
        restoreViewportAnchor();
        const retryDelays = [0, 16, 48];
        const timeouts = retryDelays.map((delay) => setTimeout(restoreViewportAnchor, delay));

        previousDraftNoteIdRef.current = currentDraftNoteId;
        previousLayoutRef.current = layout;
        previousLayoutToggleRequestIdRef.current = layoutToggleRequestId;
        previousWrapLinesRef.current = wrapLines;
        previousSectionGeometryRef.current = sectionGeometry;
        previousFilesRef.current = files;

        return () => {
          timeouts.forEach((timeout) => clearTimeout(timeout));
        };
      }
    }

    if ((layoutChanged || wrapChanged) && previousSectionMetrics && previousFiles.length > 0) {
      const previousSectionHeaderHeights = buildInStreamFileHeaderHeights(previousFiles);
      const previousScrollTop =
        // Prefer the synchronously captured pre-toggle position so anchor restoration does not
        // race the polling-based viewport snapshot.
        wrapChanged && wrapToggleScrollTop != null
          ? wrapToggleScrollTop
          : layoutChanged && explicitLayoutToggle && layoutToggleScrollTop != null
            ? layoutToggleScrollTop
            : (scrollRef.current?.scrollTop ??
              Math.max(prevScrollTopRef.current, scrollViewport.top));
      const anchor = findViewportRowAnchor(
        previousFiles,
        previousSectionMetrics,
        previousScrollTop,
        previousSectionHeaderHeights,
        lastViewportRowAnchorRef.current?.stableKey,
        fileGap,
      );
      if (anchor) {
        const nextTop = resolveViewportRowAnchorTop(
          files,
          sectionGeometry,
          anchor,
          sectionHeaderHeights,
          fileGap,
        );
        const restoreViewportAnchor = () => {
          scrollRef.current?.scrollTo(nextTop);
        };

        lastViewportRowAnchorRef.current = anchor;
        suppressViewportSelectionSync();
        restoreViewportAnchor();
        // Retry across a couple of repaint cycles so the restored top-row anchor sticks
        // after wrapped row heights and viewport culling settle.
        const retryDelays = [0, 16, 48];
        const timeouts = retryDelays.map((delay) => setTimeout(restoreViewportAnchor, delay));

        previousLayoutRef.current = layout;
        previousLayoutToggleRequestIdRef.current = layoutToggleRequestId;
        previousWrapLinesRef.current = wrapLines;
        previousSectionGeometryRef.current = sectionGeometry;
        previousFilesRef.current = files;

        return () => {
          timeouts.forEach((timeout) => clearTimeout(timeout));
        };
      }
    }

    previousDraftNoteIdRef.current = currentDraftNoteId;
    previousLayoutRef.current = layout;
    previousLayoutToggleRequestIdRef.current = layoutToggleRequestId;
    previousWrapLinesRef.current = wrapLines;
    previousSectionGeometryRef.current = sectionGeometry;
    previousFilesRef.current = files;
  }, [
    draftNoteFileId,
    draftNoteId,
    fileGap,
    files,
    layout,
    lineCursor,
    layoutToggleRequestId,
    layoutToggleScrollTop,
    rowBoundsInStream,
    scrollRef,
    scrollViewport.height,
    scrollViewport.top,
    sectionGeometry,
    sectionHeaderHeights,
    scrollToNote,
    suppressViewportSelectionSync,
    wrapLines,
    wrapToggleScrollTop,
  ]);

  useLayoutEffect(() => {
    if (files.length === 0) {
      lastViewportRowAnchorRef.current = null;
      return;
    }

    const currentScrollTop = scrollRef.current?.scrollTop ?? scrollViewport.top;
    const nextAnchor = findViewportRowAnchor(
      files,
      sectionGeometry,
      currentScrollTop,
      sectionHeaderHeights,
      lastViewportRowAnchorRef.current?.stableKey,
      fileGap,
    );

    if (nextAnchor) {
      lastViewportRowAnchorRef.current = nextAnchor;
    }
  }, [fileGap, files, scrollRef, scrollViewport.top, sectionGeometry, sectionHeaderHeights]);

  useLayoutEffect(() => {
    if (previousSelectedFileTopAlignRequestIdRef.current === selectedFileTopAlignRequestId) {
      return;
    }

    previousSelectedFileTopAlignRequestIdRef.current = selectedFileTopAlignRequestId;
    clearPendingFileTopAlign();

    if (!selectedFileId || selectedFileIndex < 0) {
      return;
    }

    // Sidebar navigation should make the selected file immediately own the viewport top.
    suppressViewportSelectionSync();
    // Only track the align as pending while the stream still has to travel. Marking an
    // already-aligned file pending would hold viewport-driven selection off until the next
    // relayout happened to clear it.
    //
    // Testing the coalesced read rather than the live scroll top is deliberate, and safe even
    // when the two disagree. Skipping requires the coalesced read to already sit on the target,
    // and the align below puts the live position on that same target synchronously — so the next
    // coalesced read can only report the value viewport-follow selection last recorded. It never
    // observes a move, so it cannot mistake this align for user scrolling. Where the live
    // position sat when the request arrived does not enter into it.
    const desiredTop = resolveFileTopAlignScrollTop(selectedFileId);
    if (desiredTop === null || !isFileTopAlignSettled(desiredTop)) {
      pendingFileTopAlignFileIdRef.current = selectedFileId;
    }
    scrollFileHeaderToTop(selectedFileId);
  }, [
    clearPendingFileTopAlign,
    isFileTopAlignSettled,
    resolveFileTopAlignScrollTop,
    scrollFileHeaderToTop,
    selectedFileTopAlignRequestId,
    selectedFileId,
    selectedFileIndex,
    suppressViewportSelectionSync,
  ]);

  useLayoutEffect(() => {
    const pendingFileId = pendingFileTopAlignFileIdRef.current;
    if (!pendingFileId) {
      return;
    }

    // Stop retrying if the sidebar selection points at a file that disappeared mid-settle.
    const fileStillPresent = files.some((file) => file.id === pendingFileId);
    if (!fileStillPresent) {
      clearPendingFileTopAlign();
      return;
    }

    const desiredTop = resolveFileTopAlignScrollTop(pendingFileId);
    if (desiredTop === null) {
      return;
    }

    if (isFileTopAlignSettled(desiredTop)) {
      clearPendingFileTopAlign();
      return;
    }

    // The scroll box may already sit on target while the coalesced viewport read has not caught up
    // yet. Stay pending in that window instead of re-issuing the same scroll.
    if (Math.abs((scrollRef.current?.scrollTop ?? scrollViewport.top) - desiredTop) <= 0.5) {
      return;
    }

    suppressViewportSelectionSync();
    scrollFileHeaderToTop(pendingFileId);
  }, [
    clearPendingFileTopAlign,
    files,
    isFileTopAlignSettled,
    resolveFileTopAlignScrollTop,
    scrollFileHeaderToTop,
    scrollRef,
    scrollViewport.top,
    suppressViewportSelectionSync,
  ]);

  useLayoutEffect(() => {
    const revealFollowsSelectionChange = selectedHunkRevealRequestId === undefined;
    const revealRequested = revealFollowsSelectionChange
      ? prevSelectedAnchorIdRef.current !== selectedAnchorId
      : previousSelectedHunkRevealRequestIdRef.current !== selectedHunkRevealRequestId;
    previousSelectedHunkRevealRequestIdRef.current = selectedHunkRevealRequestId;

    if (!selectedAnchorId && !selectedEstimatedHunkBounds) {
      prevSelectedAnchorIdRef.current = null;
      prevPinnedHeaderFileIdRef.current = pinnedHeaderFileId;
      pendingSelectionSettleRef.current = false;
      return;
    }

    const shouldTrackPinnedHeaderResettle =
      selectedFileIndex > 0 || selectedHunkIndex > 0 || selectedNoteBounds !== null;
    const pinnedHeaderChangedWhileSettling =
      shouldTrackPinnedHeaderResettle &&
      pendingSelectionSettleRef.current &&
      prevPinnedHeaderFileIdRef.current !== pinnedHeaderFileId;
    prevSelectedAnchorIdRef.current = selectedAnchorId;
    prevPinnedHeaderFileIdRef.current = pinnedHeaderFileId;

    if (!revealRequested && !pinnedHeaderChangedWhileSettling) {
      return;
    }

    const scrollSelectionIntoView = () => {
      const scrollBox = scrollRef.current;
      if (!scrollBox) {
        return;
      }

      const viewportHeight = Math.max(scrollViewport.height, scrollBox.viewport.height ?? 0);
      const preferredTopPadding = Math.max(2, Math.floor(viewportHeight * 0.25));

      // When navigating comment-to-comment, scroll the inline note card near the viewport top
      // instead of positioning the entire hunk. Clamp the reveal target too: notes in the final
      // hunk can request a top offset that is no longer reachable once the viewport hits EOF.
      // Using the reachable value keeps the reveal logic from fighting later manual scrolling.
      if (selectedNoteBounds) {
        const revealScrollTop = computeHunkRevealScrollTop({
          hunkTop: selectedNoteBounds.top,
          hunkHeight: selectedNoteBounds.height,
          preferredTopPadding,
          viewportHeight,
        });
        // Floor against the owning file's body boundary so the viewport never crosses above it
        // and triggers a pinned-header flash.
        const flooredScrollTop = Math.max(revealScrollTop, selectedFileBodyTop);
        scrollBox.scrollTo(clampReviewScrollTop(flooredScrollTop, viewportHeight));
        return;
      }

      if (selectedEstimatedHunkBounds) {
        const viewportTop = scrollBox.viewport.y;
        const currentScrollTop = scrollBox.scrollTop;
        const startRow = scrollBox.content.findDescendantById(
          selectedEstimatedHunkBounds.startRowId,
        );
        const endRow = scrollBox.content.findDescendantById(selectedEstimatedHunkBounds.endRowId);

        // Prefer exact mounted bounds when both edges are available. If only one edge has mounted
        // so far, fall back to the planned bounds as one atomic estimate instead of mixing sources.
        // The final reveal target still gets clamped below so a bottom-edge hunk does not keep
        // re-requesting an impossible scrollTop after the selection settles.
        const renderedTop = startRow ? currentScrollTop + (startRow.y - viewportTop) : null;
        const renderedBottom = endRow
          ? currentScrollTop + (endRow.y + endRow.height - viewportTop)
          : null;
        const renderedBoundsReady = renderedTop !== null && renderedBottom !== null;
        const hunkTop = renderedBoundsReady ? renderedTop : selectedEstimatedHunkBounds.top;
        const hunkHeight = renderedBoundsReady
          ? Math.max(0, renderedBottom - renderedTop)
          : selectedEstimatedHunkBounds.height;

        const revealScrollTop = computeHunkRevealScrollTop({
          hunkTop,
          hunkHeight,
          preferredTopPadding,
          viewportHeight,
        });
        // Floor against the owning file's body boundary so the viewport never crosses above it
        // and triggers a pinned-header flash.
        const flooredScrollTop = Math.max(revealScrollTop, selectedFileBodyTop);
        scrollBox.scrollTo(clampReviewScrollTop(flooredScrollTop, viewportHeight));
        return;
      }

      if (selectedAnchorId) {
        scrollBox.scrollChildIntoView(selectedAnchorId);
      }
    };

    // Run after this pane renders the selected section/hunk, then retry once on the next task
    // after the mounted row bounds settle.
    clearPendingSelectionRevealTimers();
    suppressViewportSelectionSync();
    scrollSelectionIntoView();
    pendingSelectionSettleRef.current = shouldTrackPinnedHeaderResettle;
    const timeouts = [setTimeout(scrollSelectionIntoView, 0)];
    if (shouldTrackPinnedHeaderResettle) {
      timeouts.push(
        setTimeout(() => {
          pendingSelectionSettleRef.current = false;
        }, 120),
      );
    }
    pendingSelectionRevealTimeoutsRef.current = timeouts;
    return clearPendingSelectionRevealTimers;
  }, [
    clampReviewScrollTop,
    clearPendingSelectionRevealTimers,
    pinnedHeaderFileId,
    scrollRef,
    scrollViewport.height,
    selectedAnchorId,
    selectedEstimatedHunkEndRowId,
    selectedEstimatedHunkHeight,
    selectedEstimatedHunkStartRowId,
    selectedEstimatedHunkTop,
    selectedFileIndex,
    selectedHunkIndex,
    selectedHunkRevealRequestId,
    selectedFileBodyTop,
    selectedNoteHeight,
    selectedNoteTop,
    suppressViewportSelectionSync,
  ]);

  const previousLineCursorRevealRequestIdRef = useRef(lineCursorRevealRequest.id);

  useLayoutEffect(() => {
    if (previousLineCursorRevealRequestIdRef.current === lineCursorRevealRequest.id) {
      return;
    }
    previousLineCursorRevealRequestIdRef.current = lineCursorRevealRequest.id;

    const scrollBox = scrollRef.current;
    if (!scrollBox || !lineCursor) {
      return;
    }

    const bounds = lineCursorBoundsOf(lineCursor);
    if (!bounds) {
      return;
    }

    const viewportHeight = scrollBox.viewport.height || scrollViewport.height;
    // A jump lands the line where hunk and note reveals land theirs; stepping only closes the
    // gap to the viewport edge, so a held key does not drag the whole stream past the marker.
    const revealScrollTop =
      lineCursorRevealRequest.placement === "reveal"
        ? computeHunkRevealScrollTop({
            hunkTop: bounds.top,
            hunkHeight: bounds.height,
            preferredTopPadding: Math.max(2, Math.floor(viewportHeight * 0.25)),
            viewportHeight,
          })
        : computeLineRevealScrollTop({
            lineTop: bounds.top,
            lineHeight: bounds.height,
            scrollTop: scrollBox.scrollTop,
            viewportHeight,
          });
    // A named line is the final scroll policy for this request, exactly as an
    // explicit alignment is: a cross-file reveal changes the selection, and the
    // selection reveal it schedules would otherwise run its zero-delay retry
    // after this layout effect and drag the viewport back to the hunk anchor.
    // Superseding here is what keeps a reveal into another file line-exact.
    supersedePendingSelectionReveal();
    clearPendingFileTopAlign();

    if (revealScrollTop === scrollBox.scrollTop) {
      return;
    }

    suppressViewportSelectionSync();
    scrollBox.scrollTo(clampReviewScrollTop(revealScrollTop, viewportHeight));
  }, [
    clampReviewScrollTop,
    clearPendingFileTopAlign,
    lineCursor,
    lineCursorBoundsOf,
    lineCursorRevealRequest,
    scrollRef,
    scrollViewport.height,
    supersedePendingSelectionReveal,
    suppressViewportSelectionSync,
  ]);

  const previousLineCursorAlignmentRequestIdRef = useRef(lineCursorAlignmentRequest.id);

  useLayoutEffect(() => {
    if (previousLineCursorAlignmentRequestIdRef.current === lineCursorAlignmentRequest.id) {
      return;
    }

    const scrollBox = scrollRef.current;
    if (
      !scrollBox ||
      !lineCursor ||
      lineCursor.fileId !== selectedFileId ||
      lineCursor.hunkIndex !== selectedHunkIndex
    ) {
      return;
    }
    const bounds = lineCursorBoundsOf(lineCursor);
    if (!bounds) return;

    const viewportHeight = scrollBox.viewport.height || scrollViewport.height;
    const desiredTop = computeLineAlignmentScrollTop({
      alignment: lineCursorAlignmentRequest.alignment,
      lineTop: bounds.top,
      lineHeight: bounds.height,
      viewportHeight,
    });
    // Explicit alignment is the final scroll policy for a composed semantic
    // command sequence; selection/file reveal retries must not overwrite it.
    supersedePendingSelectionReveal();
    clearPendingFileTopAlign();
    suppressViewportSelectionSync();
    scrollBox.scrollTo(clampReviewScrollTop(desiredTop, viewportHeight));
    // Consume only after the selected cursor was measured and aligned. A
    // navigation command may update selection before cursor reconciliation.
    previousLineCursorAlignmentRequestIdRef.current = lineCursorAlignmentRequest.id;
  }, [
    clampReviewScrollTop,
    clearPendingFileTopAlign,
    lineCursor,
    lineCursorAlignmentRequest,
    lineCursorBoundsOf,
    scrollRef,
    scrollViewport.height,
    selectedFileId,
    selectedHunkIndex,
    supersedePendingSelectionReveal,
    suppressViewportSelectionSync,
  ]);

  // Keep keyboard step scrolling at exactly one row while wheel scrolling uses its own multiplier.
  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (scrollBox) {
      scrollBox.verticalScrollBar.scrollStep = 1;
    }
  }, [scrollRef]);

  return (
    <box
      style={{
        width,
        ...(height === undefined ? {} : { height }),
        border: renderTopChrome ? ["top"] : [],
        borderColor: theme.border,
        backgroundColor: theme.panel,
        paddingX: 0,
        flexDirection: "column",
        ...(renderTopChrome
          ? { paddingY: 1 }
          : { paddingTop: 0, paddingBottom: pagerMode ? 0 : 1 }),
      }}
      onMouseDragEnd={endCopySelection}
      onMouseUp={endCopySelection}
    >
      {files.length > 0 ? (
        <box style={{ width: "100%", height: "100%", flexGrow: 1, flexDirection: "column" }}>
          {/* Always pin the current file header in a dedicated top row. */}
          {pinnedHeaderFile ? (
            <box
              style={{ width: "100%", height: 1, minHeight: 1, flexShrink: 0 }}
              onMouseDown={beginCopySelection}
              onMouseDrag={updateCopySelection}
              onMouseDragEnd={endCopySelection}
              onMouseUp={endCopySelection}
            >
              <DiffFileHeaderRow
                file={pinnedHeaderFile}
                headerLabelWidth={headerLabelWidth}
                headerStatsWidth={headerStatsWidth}
                theme={theme}
                onSelect={() => onSelectFile(pinnedHeaderFile.id)}
              />
            </box>
          ) : null}
          <box style={{ width: "100%", flexGrow: 1, flexDirection: "column" }}>
            <box style={{ position: "relative", width: "100%", flexGrow: 1 }}>
              <scrollbox
                ref={scrollRef}
                width="100%"
                height="100%"
                scrollY={true}
                viewportCulling={true}
                focused={pagerMode}
                onMouseDown={beginCopySelection}
                onMouseDrag={updateCopySelection}
                onMouseDragEnd={endCopySelection}
                onMouseScroll={handleMouseScroll}
                onMouseUp={endCopySelection}
                scrollAcceleration={mouseWheelScrollAcceleration}
                rootOptions={{ backgroundColor: theme.panel }}
                wrapperOptions={{ backgroundColor: theme.panel }}
                viewportOptions={{ backgroundColor: theme.panel }}
                contentOptions={{ backgroundColor: theme.panel }}
                verticalScrollbarOptions={{ visible: false }}
                horizontalScrollbarOptions={{ visible: false }}
              >
                <box
                  // Remount the diff content when width/layout/wrap mode changes so viewport culling
                  // recomputes against the new row geometry, while the outer scrollbox keeps its state.
                  key={`diff-content:${layout}:${wrapLines ? "wrap" : "nowrap"}:tabs-${tabWidth}:${width}`}
                  style={{ width: "100%", flexDirection: "column", overflow: "visible" }}
                >
                  {fileRenderItems.map((item) => {
                    if (item.kind === "spacer") {
                      return (
                        <box
                          key={item.key}
                          style={{
                            width: "100%",
                            height: item.height,
                            backgroundColor: theme.panel,
                          }}
                        />
                      );
                    }

                    const { sectionIndex: index } = item;
                    const file = files[index];
                    if (!file) {
                      return null;
                    }

                    return (
                      <DiffSection
                        key={file.id}
                        codeHorizontalOffset={codeHorizontalOffset}
                        expandedGapKeys={expandedGapsByFileId[file.id] ?? EMPTY_EXPANDED_GAP_KEYS}
                        extensionLineHighlights={lineHighlights.get(file.id)}
                        file={file}
                        fileView={fileViewRenderPlans.get(file.id)?.fileView}
                        offloadLargeDiff={offloadLargeDiff}
                        headerLabelWidth={headerLabelWidth}
                        headerStatsWidth={headerStatsWidth}
                        layout={layout}
                        selectedHunkIndex={file.id === selectedFileId ? selectedHunkIndex : -1}
                        copySelectedRowRanges={copySelectedRowKeysByFile.get(file.id)}
                        copySelectedSide={copySelectionSide}
                        cursorHighlight={
                          file.id === renderedLineCursor?.fileId ? cursorHighlight : undefined
                        }
                        shouldLoadHighlight={
                          (!wrapLines || initialWrappedRenderWindowWarmed) &&
                          highlightPrefetchFileIds.has(file.id)
                        }
                        sectionGeometry={sectionGeometry[index]}
                        separatorWidth={separatorWidth}
                        showHeader={shouldRenderInStreamFileHeader(index)}
                        separatorHeight={index > 0 ? fileGap : 0}
                        showLineNumbers={showLineNumbers}
                        showHunkHeaders={showHunkHeaders}
                        sourceStatus={sourceStatusByFileId[file.id]}
                        tabWidth={tabWidth}
                        hunkGap={hunkGap}
                        wrapLines={wrapLines}
                        theme={theme}
                        hoverActive={hoveredFileId === null || hoveredFileId === file.id}
                        hoverClearSignal={
                          addNoteHoverClearFileId === file.id ? addNoteHoverClearSignal : 0
                        }
                        viewWidth={diffContentWidth}
                        visibleAgentNotes={
                          visibleAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES
                        }
                        visibleBodyBounds={visibleBodyBoundsByFile.get(file.id)}
                        onHover={() => setHoveredFileForRowActions(file.id)}
                        onMouseScroll={clearAddNoteHoverForScroll}
                        onFileViewRowFailure={onFileViewRowFailure}
                        onActiveAddNoteAffordanceChange={
                          onActiveAddNoteAffordanceChange
                            ? activeAddNoteAffordanceCallback(file.id)
                            : undefined
                        }
                        onStartUserNoteAtHunk={
                          reserveAddNoteColumn ? startUserNoteAtHunkCallback(file.id) : undefined
                        }
                        onRowPlanChange={
                          file.id === currentLinePaintFile?.id
                            ? currentLineRowPlanCallback
                            : undefined
                        }
                        onSelect={selectFileCallback(file.id)}
                        onToggleGap={(gapKey) => onToggleGap(file.id, gapKey)}
                      />
                    );
                  })}
                </box>
              </scrollbox>
              <VerticalScrollbar
                ref={scrollbarRef}
                scrollRef={scrollRef}
                contentHeight={totalContentHeight}
                height={scrollViewport.height}
                theme={theme}
              />
            </box>
          </box>
        </box>
      ) : (
        <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
          <text fg={theme.muted}>No files match the current filter.</text>
        </box>
      )}
    </box>
  );
}
