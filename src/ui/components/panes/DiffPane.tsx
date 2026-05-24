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
import type {
  AgentAnnotation,
  DiffFile,
  LayoutMode,
  UserNoteLineTarget,
} from "../../../core/types";
import type { FileSourceStatus } from "../../diff/expandCollapsedRows";
import type { ActiveAddNoteAffordance } from "../../diff/PierreDiffView";
import type { DraftReviewNote } from "../../hooks/useReviewController";
import {
  alwaysShowReviewNote,
  reviewNoteSource,
  type VisibleAgentNote,
} from "../../lib/agentAnnotations";
import { computeHunkRevealScrollTop } from "../../lib/hunkScroll";
import {
  measureDiffSectionGeometry,
  type DiffSectionGeometry,
} from "../../diff/diffSectionGeometry";
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
  findViewportRowAnchor,
  resolveViewportRowAnchorTop,
  type ViewportRowAnchor,
} from "../../lib/viewportAnchor";
import type { AppTheme } from "../../themes";
import { DiffSection } from "./DiffSection";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";
import { DiffSectionPlaceholder } from "./DiffSectionPlaceholder";
import { VerticalScrollbar, type VerticalScrollbarHandle } from "../scrollbar/VerticalScrollbar";
import type { VisibleBodyBounds } from "../../diff/rowWindowing";
import { prefetchHighlightedDiff } from "../../diff/useHighlightedDiff";
import {
  buildCopySelectedRowKeys,
  clampCopyColumn,
  copySelectionPointsEqual,
  copySelectionPointsShareRow,
  expandSelectionPoint,
  findCopySelectionPoint,
  normalizeCopySelectionRange,
  renderCopySelectionText,
  resolveCopySelectionSide,
  type CopySelectionContext,
  type CopySelectionDrag,
  type CopySelectionPoint,
  type CopySelectionSide,
} from "./copySelection";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

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

/** Keep syntax-highlight warm for the files immediately adjacent to the current selection. */
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
 * We intentionally include three groups:
 * - the selected file, so direct navigation always warms the active target
 * - adjacent files, so hunk/file navigation does not wait on a cold highlight
 * - files within a larger viewport halo, so wheel/track scrolling sees colorized rows already ready
 */
function buildHighlightPrefetchFileIds({
  adjacentPrefetchFileIds,
  fileSectionLayouts,
  scrollTop,
  viewportHeight,
  selectedFileId,
}: {
  adjacentPrefetchFileIds: Set<string>;
  fileSectionLayouts: FileSectionLayout[];
  scrollTop: number;
  viewportHeight: number;
  selectedFileId?: string;
}) {
  const next = new Set(adjacentPrefetchFileIds);

  if (selectedFileId) {
    next.add(selectedFileId);
  }

  const clampedViewportHeight = Math.max(1, viewportHeight);
  const prefetchRows = Math.max(24, clampedViewportHeight * 3);
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
const EMPTY_SOURCE_STATUS_BY_FILE_ID: Record<string, FileSourceStatus> = {};
const NOOP_TOGGLE_GAP = () => {};

/** Render the main multi-file review stream. */
export function DiffPane({
  codeHorizontalOffset = 0,
  diffContentWidth,
  expandedGapsByFileId = EMPTY_EXPANDED_GAPS_BY_FILE_ID,
  files,
  headerLabelWidth,
  headerStatsWidth,
  layout,
  scrollRef,
  selectedFileId,
  selectedHunkIndex,
  scrollToNote = false,
  draftNote = null,
  draftNoteFocused = false,
  separatorWidth,
  pagerMode = false,
  copyDecorations = false,
  screenLeft = 0,
  screenTop = 0,
  showAgentNotes,
  showLineNumbers,
  showHunkHeaders,
  sourceStatusByFileId = EMPTY_SOURCE_STATUS_BY_FILE_ID,
  wrapLines,
  wrapToggleScrollTop,
  layoutToggleScrollTop = null,
  layoutToggleRequestId = 0,
  selectedFileTopAlignRequestId = 0,
  selectedHunkRevealRequestId,
  theme,
  width,
  cancelCopySelectionRef,
  onActiveAddNoteAffordanceChange,
  onRemoveUserNote,
  onSaveDraftNote,
  onStartUserNoteAtHunk,
  onUpdateDraftNote,
  onBlurDraftNote,
  onCancelDraftNote,
  onFocusDraftNote,
  onCopyFeedback,
  onCopySelectionText,
  onScrollCodeHorizontally = () => {},
  onSelectFile,
  onToggleGap = NOOP_TOGGLE_GAP,
  onViewportCenteredHunkChange,
}: {
  codeHorizontalOffset?: number;
  diffContentWidth: number;
  expandedGapsByFileId?: Record<string, ReadonlySet<string>>;
  files: DiffFile[];
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  selectedFileId?: string;
  selectedHunkIndex: number;
  scrollToNote?: boolean;
  draftNote?: DraftReviewNote | null;
  draftNoteFocused?: boolean;
  separatorWidth: number;
  pagerMode?: boolean;
  copyDecorations?: boolean;
  screenLeft?: number;
  screenTop?: number;
  showAgentNotes: boolean;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  sourceStatusByFileId?: Record<string, FileSourceStatus>;
  wrapLines: boolean;
  wrapToggleScrollTop: number | null;
  layoutToggleScrollTop?: number | null;
  layoutToggleRequestId?: number;
  selectedFileTopAlignRequestId?: number;
  selectedHunkRevealRequestId?: number;
  theme: AppTheme;
  width: number;
  cancelCopySelectionRef?: RefObject<(() => void) | null>;
  onActiveAddNoteAffordanceChange?: (
    affordance: (ActiveAddNoteAffordance & { fileId: string }) | null,
  ) => void;
  onRemoveUserNote?: (noteId: string) => void;
  onSaveDraftNote?: () => void;
  onStartUserNoteAtHunk?: (fileId: string, hunkIndex: number, target?: UserNoteLineTarget) => void;
  onUpdateDraftNote?: (body: string) => void;
  onBlurDraftNote?: () => void;
  onCancelDraftNote?: () => void;
  onFocusDraftNote?: () => void;
  onCopyFeedback?: (text: string) => void;
  onCopySelectionText?: (text: string) => void | boolean;
  onScrollCodeHorizontally?: (delta: number) => void;
  onSelectFile: (fileId: string) => void;
  onToggleGap?: (fileId: string, gapKey: string) => void;
  onViewportCenteredHunkChange?: (fileId: string, hunkIndex: number) => void;
}) {
  const renderer = useRenderer();
  const mouseWheelScrollAcceleration = useMemo(
    () => createReviewMouseWheelScrollAcceleration(),
    [],
  );
  const [addNoteHoverClearSignal, setAddNoteHoverClearSignal] = useState(0);

  /** Hide hover-only row controls when content scrolls under a stationary mouse pointer. */
  const clearAddNoteHoverForScroll = useCallback(() => {
    setAddNoteHoverClearSignal((current) => current + 1);
    onActiveAddNoteAffordanceChange?.(null);
  }, [onActiveAddNoteAffordanceChange]);

  const adjacentPrefetchFileIds = useMemo(
    () => buildAdjacentPrefetchFileIds(files, selectedFileId),
    [files, selectedFileId],
  );

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
        (
          currentScrollBox as unknown as { resetScrollAccumulators?: () => void }
        ).resetScrollAccumulators?.();
      });

      event.preventDefault();
      event.stopPropagation();
    },
    [clearAddNoteHoverForScroll, onScrollCodeHorizontally, scrollRef, wrapLines],
  );

  const allAgentNotesByFile = useMemo(() => {
    const next = new Map<string, VisibleAgentNote[]>();

    files.forEach((file) => {
      const annotations = (file.agent?.annotations ?? []).filter(
        (annotation) => showAgentNotes || alwaysShowReviewNote(annotation),
      );
      const notes: VisibleAgentNote[] = annotations.map((annotation, index) => {
        const source = reviewNoteSource(annotation);
        if (source !== "user") {
          return {
            id: `annotation:${file.id}:${annotation.id ?? index}`,
            annotation,
          };
        }

        return {
          id: `annotation:${file.id}:${annotation.id ?? index}`,
          annotation,
          source,
          editable: true,
          onRemove: annotation.id ? () => onRemoveUserNote?.(annotation.id!) : undefined,
        };
      });

      if (draftNote?.fileId === file.id) {
        const draftAnnotation: AgentAnnotation = {
          id: draftNote.id,
          source: "user-draft",
          summary: draftNote.body || " ",
          oldRange: draftNote.oldRange,
          newRange: draftNote.newRange,
          editable: true,
        };
        notes.push({
          id: draftNote.id,
          annotation: draftAnnotation,
          source: "draft",
          editable: true,
          draft: {
            body: draftNote.body,
            focused: draftNoteFocused,
            onBlur: onBlurDraftNote,
            onCancel: onCancelDraftNote ?? (() => {}),
            onFocus: onFocusDraftNote,
            onInput: onUpdateDraftNote ?? (() => {}),
            onSave: onSaveDraftNote ?? (() => {}),
          },
        });
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
    onRemoveUserNote,
    onSaveDraftNote,
    onUpdateDraftNote,
    showAgentNotes,
  ]);

  // Keep exact row rendering for wrapped lines and the selected file's visible notes;
  // other files can still use placeholders and viewport windowing.
  const windowingEnabled = !wrapLines;
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });
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
  const previousSectionGeometryRef = useRef<DiffSectionGeometry[] | null>(null);
  const previousFilesRef = useRef<DiffFile[]>(files);
  const previousLayoutRef = useRef(layout);
  const previousWrapLinesRef = useRef(wrapLines);
  const previousDraftNoteIdRef = useRef(draftNote?.id ?? null);
  const previousSelectedFileTopAlignRequestIdRef = useRef(selectedFileTopAlignRequestId);
  const previousLayoutToggleRequestIdRef = useRef(layoutToggleRequestId);
  const previousSelectedHunkRevealRequestIdRef = useRef(selectedHunkRevealRequestId);
  const pendingFileTopAlignFileIdRef = useRef<string | null>(null);
  const suppressViewportSelectionSyncRef = useRef(false);
  const suppressViewportSelectionSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Initialized to null so the first render never fires a selection change; a real scroll
  // is required before passive viewport-follow selection can trigger.
  const lastViewportSelectionTopRef = useRef<number | null>(null);
  const lastViewportRowAnchorRef = useRef<ViewportRowAnchor | null>(null);

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
    return () => {
      if (suppressViewportSelectionSyncTimeoutRef.current) {
        clearTimeout(suppressViewportSelectionSyncTimeoutRef.current);
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

    let cancelled = false;
    let scheduled = false;

    const readViewport = () => {
      const nextTop = scrollBox.scrollTop ?? 0;
      const nextHeight = scrollBox.viewport.height ?? 0;

      // Detect scroll activity, show scrollbar, and clear hover-only controls. The pointer may
      // now sit over a different row, but only an actual mouse move should reveal row actions.
      if (nextTop !== prevScrollTopRef.current) {
        scrollbarRef.current?.show();
        clearAddNoteHoverForScroll();
        prevScrollTopRef.current = nextTop;
      }

      setScrollViewport((current) =>
        current.top === nextTop && current.height === nextHeight
          ? current
          : { top: nextTop, height: nextHeight },
      );
    };

    // OpenTUI emits `change` synchronously from inside its own slider sync, and other
    // useLayoutEffects in this pane scroll the box from inside React's commit phase.
    // Calling setScrollViewport directly from the listener can run setState while React
    // is already committing — which downstream layout effects can amplify into a render
    // loop and trip React's max-update-depth guard. Coalesce listener events into a
    // single microtask-deferred read so the setState is dispatched outside the emit
    // call stack and repeated events between paints collapse into one update.
    const handleViewportChange = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        if (cancelled) {
          scheduled = false;
          return;
        }

        try {
          readViewport();
        } finally {
          scheduled = false;
        }
      });
    };

    readViewport();
    scrollBox.verticalScrollBar.on("change", handleViewportChange);
    scrollBox.viewport.on("layout-changed", handleViewportChange);
    scrollBox.viewport.on("resized", handleViewportChange);

    return () => {
      cancelled = true;
      scrollBox.verticalScrollBar.off("change", handleViewportChange);
      scrollBox.viewport.off("layout-changed", handleViewportChange);
      scrollBox.viewport.off("resized", handleViewportChange);
    };
  }, [clearAddNoteHoverForScroll, files.length, scrollRef]);

  const sectionHeaderHeights = useMemo(() => buildInStreamFileHeaderHeights(files), [files]);

  const baseSectionGeometry = useMemo(
    () =>
      files.map((file) =>
        measureDiffSectionGeometry(
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
        ),
      ),
    [
      diffContentWidth,
      expandedGapsByFileId,
      files,
      layout,
      showHunkHeaders,
      showLineNumbers,
      sourceStatusByFileId,
      theme,
      wrapLines,
    ],
  );
  const baseEstimatedBodyHeights = useMemo(
    () => baseSectionGeometry.map((metrics) => metrics.bodyHeight),
    [baseSectionGeometry],
  );
  const baseFileSectionLayouts = useMemo(
    () => buildFileSectionLayouts(files, baseEstimatedBodyHeights, sectionHeaderHeights),
    [baseEstimatedBodyHeights, files, sectionHeaderHeights],
  );

  const visibleViewportFileIds = useMemo(() => {
    const overscanTerminalRows = 8;
    const minVisibleY = Math.max(0, scrollViewport.top - overscanTerminalRows);
    const maxVisibleY = scrollViewport.top + scrollViewport.height + overscanTerminalRows;
    return collectIntersectingFileSectionIds(baseFileSectionLayouts, minVisibleY, maxVisibleY);
  }, [baseFileSectionLayouts, scrollViewport.height, scrollViewport.top]);

  const visibleAgentNotesByFile = useMemo(() => {
    const next = new Map<string, VisibleAgentNote[]>();

    const fileIdsToMeasure = new Set(visibleViewportFileIds);
    // Always measure the selected file with its real note rows so hunk navigation can compute
    // accurate bounds even before the file scrolls into the visible viewport.
    if (selectedFileId) {
      fileIdsToMeasure.add(selectedFileId);
    }

    for (const fileId of fileIdsToMeasure) {
      const visibleNotes = allAgentNotesByFile.get(fileId);
      if (visibleNotes && visibleNotes.length > 0) {
        next.set(fileId, visibleNotes);
      }
    }

    return next;
  }, [allAgentNotesByFile, selectedFileId, showAgentNotes, visibleViewportFileIds]);

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
        const notes = allAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES;
        if (notes.length === 0) {
          return baseSectionGeometry[index]!;
        }

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
        );
      }),
    [
      allAgentNotesByFile,
      baseSectionGeometry,
      diffContentWidth,
      expandedGapsByFileId,
      files,
      layout,
      showHunkHeaders,
      showLineNumbers,
      sourceStatusByFileId,
      theme,
      wrapLines,
    ],
  );
  const estimatedBodyHeights = useMemo(
    () => sectionGeometry.map((metrics) => metrics.bodyHeight),
    [sectionGeometry],
  );
  const fileSectionLayouts = useMemo(
    () => buildFileSectionLayouts(files, estimatedBodyHeights, sectionHeaderHeights),
    [estimatedBodyHeights, files, sectionHeaderHeights],
  );
  const totalContentHeight = fileSectionLayouts[fileSectionLayouts.length - 1]?.sectionBottom ?? 0;

  // Read the live scroll box position during render so pinned-header ownership flips
  // immediately after imperative scrolls instead of waiting for the polled viewport snapshot.
  const effectiveScrollTop = scrollRef.current?.scrollTop ?? scrollViewport.top;
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
      sectionGeometry,
      showHunkHeaders,
      showLineNumbers,
      theme,
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
      sectionGeometry,
      showHunkHeaders,
      showLineNumbers,
      theme,
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

      const reviewPaneTopChromeRows = pagerMode ? 0 : 2;
      const pinnedHeaderHeight = pinnedHeaderFileId ? 1 : 0;
      const paneY = Math.floor(event.y - screenTop);
      const pinnedHeaderY = reviewPaneTopChromeRows;
      if (copyDecorations && pinnedHeaderFileId && paneY === pinnedHeaderY) {
        return {
          kind: "pinned-header",
          column: clampCopyColumn(Math.floor(event.x - screenLeft), diffContentWidth),
          fileId: pinnedHeaderFileId,
          nextVisualRow: Math.floor(scrollBox.scrollTop ?? 0),
        };
      }

      const paneChromeHeight = reviewPaneTopChromeRows + pinnedHeaderHeight;
      const viewportY = Math.floor(event.y - screenTop - paneChromeHeight);
      if (viewportY < 0 || viewportY >= Math.max(1, scrollBox.viewport.height ?? 0)) {
        return null;
      }

      return findCopySelectionPoint({
        column: Math.floor(event.x - screenLeft),
        copyDecorations,
        fileSectionLayouts,
        sectionGeometry,
        visualRow: Math.floor((scrollBox.scrollTop ?? 0) + viewportY),
        width: diffContentWidth,
      });
    },
    [
      copyDecorations,
      diffContentWidth,
      fileSectionLayouts,
      pagerMode,
      pinnedHeaderFileId,
      screenLeft,
      screenTop,
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
          };
        }
      }

      if (copySelectionDragRef.current) {
        suppressNativeSelection();
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [resolveCopySelectionPoint, suppressNativeSelection],
  );

  /** Finish a drag selection and copy its rendered text. */
  const endCopySelection = useCallback(
    (event?: TuiMouseEvent) => {
      const current = copySelectionDragRef.current;
      if (!current) {
        return;
      }

      copySelectionDragRef.current = null;
      setCopySelectionDrag(null);
      event?.preventDefault();
      event?.stopPropagation();

      if (!current.moved) {
        return;
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
    [copySelectionContext, copySelectionSide, copySelectionText],
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
        scrollTop: scrollViewport.top,
        viewportHeight: scrollViewport.height,
        selectedFileId,
      }),
    [
      adjacentPrefetchFileIds,
      fileSectionLayouts,
      scrollViewport.height,
      scrollViewport.top,
      selectedFileId,
    ],
  );

  // Kick off highlight work from viewport planning rather than waiting for the section to mount.
  // That avoids the "plain rows first, color later" stutter when a file is about to scroll onscreen.
  useEffect(() => {
    if (files.length === 0) {
      return;
    }

    for (const file of files) {
      if (!highlightPrefetchFileIds.has(file.id)) {
        continue;
      }

      void prefetchHighlightedDiff({
        file,
        appearance: theme.appearance,
      });
    }
  }, [files, highlightPrefetchFileIds, theme.appearance]);

  // Keep the selected file/hunk derived from the visible viewport for actual scroll-driven
  // movement, while leaving the initial mount and non-scroll relayouts alone.
  useLayoutEffect(() => {
    const previousViewportTop = lastViewportSelectionTopRef.current;
    lastViewportSelectionTopRef.current = scrollViewport.top;

    if (
      previousViewportTop === null ||
      previousViewportTop === scrollViewport.top ||
      !onViewportCenteredHunkChange ||
      suppressViewportSelectionSyncRef.current ||
      files.length === 0 ||
      scrollViewport.height <= 0
    ) {
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

    onViewportCenteredHunkChange(centeredTarget.fileId, centeredTarget.hunkIndex);
  }, [
    fileSectionLayouts,
    files,
    onViewportCenteredHunkChange,
    scrollViewport.height,
    scrollViewport.top,
    sectionGeometry,
    selectedFileId,
    selectedHunkIndex,
  ]);

  useLayoutEffect(() => {
    renderer.intermediateRender();
  }, [renderer, pinnedHeaderFileId]);

  const visibleWindowedFileIds = useMemo(() => {
    if (!windowingEnabled) {
      return null;
    }

    const next = new Set(visibleViewportFileIds);

    if (selectedFileId) {
      next.add(selectedFileId);
    }

    for (const fileId of adjacentPrefetchFileIds) {
      next.add(fileId);
    }

    return next;
  }, [adjacentPrefetchFileIds, selectedFileId, visibleViewportFileIds, windowingEnabled]);
  const visibleBodyBoundsByFile = useMemo(() => {
    const next = new Map<string, VisibleBodyBounds>();
    if (scrollViewport.height <= 0) {
      return next;
    }

    const overscanTerminalRows = Math.max(24, scrollViewport.height * 2);

    files.forEach((file, index) => {
      const sectionLayout = fileSectionLayouts[index];
      const geometry = sectionGeometry[index];
      if (!sectionLayout || !geometry) {
        return;
      }

      const shouldRenderSection = visibleWindowedFileIds?.has(file.id) ?? true;
      if (!shouldRenderSection) {
        return;
      }

      // Convert the absolute review-stream viewport into file-body-local coordinates.
      // Example: if the viewport starts at row 2_000 globally and this file body starts at row
      // 1_940, then the file-local visible top is 60 rows into this file.
      const minTop = scrollViewport.top - sectionLayout.bodyTop - overscanTerminalRows;
      const maxBottom =
        scrollViewport.top + scrollViewport.height - sectionLayout.bodyTop + overscanTerminalRows;

      // Keep the mounted rows bounded to the viewport slice. Selection reveal uses planned hunk
      // geometry as its fallback, so mounting an offscreen selected hunk is not necessary and would
      // remount very large hunks in full.

      // Clamp the requested file-local interval back into the real body extent, then store it as
      // { top, height } so the row slicer can rebuild the matching [top, bottom) window later.
      const clampedTop = Math.min(geometry.bodyHeight, Math.max(0, minTop));
      const clampedBottom = Math.min(geometry.bodyHeight, Math.max(clampedTop, maxBottom));
      next.set(file.id, {
        top: clampedTop,
        height: clampedBottom - clampedTop,
      });
    });

    return next;
  }, [
    fileSectionLayouts,
    files,
    scrollViewport.height,
    scrollViewport.top,
    sectionGeometry,
    visibleWindowedFileIds,
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

  /** Absolute scroll offset and height of the first inline note in the selected hunk, if any. */
  const selectedNoteBounds = useMemo(() => {
    if (!scrollToNote || !selectedEstimatedHunkBounds || selectedFileIndex < 0) {
      return null;
    }

    const geometry = sectionGeometry[selectedFileIndex];
    if (!geometry) {
      return null;
    }

    const sectionRelativeHunkTop =
      selectedEstimatedHunkBounds.top - selectedEstimatedHunkBounds.sectionTop;
    const sectionRelativeHunkBottom = sectionRelativeHunkTop + selectedEstimatedHunkBounds.height;
    const noteRow = geometry.rowBounds.find(
      (row) =>
        row.key.startsWith("inline-note:") &&
        row.top >= sectionRelativeHunkTop &&
        row.top < sectionRelativeHunkBottom,
    );

    if (!noteRow) {
      return null;
    }

    return {
      top: selectedEstimatedHunkBounds.sectionTop + noteRow.top,
      height: noteRow.height,
    };
  }, [scrollToNote, sectionGeometry, selectedEstimatedHunkBounds, selectedFileIndex]);
  const selectedEstimatedHunkTop = selectedEstimatedHunkBounds?.top ?? null;
  const selectedEstimatedHunkHeight = selectedEstimatedHunkBounds?.height ?? null;
  const selectedEstimatedHunkStartRowId = selectedEstimatedHunkBounds?.startRowId ?? null;
  const selectedEstimatedHunkEndRowId = selectedEstimatedHunkBounds?.endRowId ?? null;
  const selectedNoteTop = selectedNoteBounds?.top ?? null;
  const selectedNoteHeight = selectedNoteBounds?.height ?? null;

  /** The bodyTop of the currently selected file's section layout, used to floor hunk reveal scroll targets so they never cross above the owning file boundary. */
  const selectedFileBodyTop =
    selectedFileIndex >= 0 ? (fileSectionLayouts[selectedFileIndex]?.bodyTop ?? 0) : 0;

  // Track the previous selected anchor to detect actual selection changes.
  const prevSelectedAnchorIdRef = useRef<string | null>(null);
  const prevPinnedHeaderFileIdRef = useRef<string | null>(null);
  const pendingSelectionSettleRef = useRef(false);

  /** Clear any pending "selected file to top" follow-up. */
  const clearPendingFileTopAlign = useCallback(() => {
    pendingFileTopAlignFileIdRef.current = null;
  }, []);

  /** Scroll one file so it immediately owns the viewport top using the latest planned geometry. */
  const scrollFileHeaderToTop = useCallback(
    (fileId: string) => {
      const targetSection = fileSectionLayouts.find((layout) => layout.fileId === fileId);
      if (!targetSection) {
        return false;
      }

      const scrollBox = scrollRef.current;
      if (!scrollBox) {
        return false;
      }

      const viewportHeight = Math.max(scrollViewport.height, scrollBox.viewport.height ?? 0);

      // The pinned header owns the top row, so align the review stream to the file body. Clamp the
      // request so short trailing files can still settle cleanly at the reachable bottom edge.
      scrollBox.scrollTo(clampReviewScrollTop(targetSection.bodyTop, viewportHeight));
      return true;
    },
    [clampReviewScrollTop, fileSectionLayouts, scrollRef, scrollViewport.height],
  );

  useLayoutEffect(() => {
    const layoutChanged = previousLayoutRef.current !== layout;
    const explicitLayoutToggle = previousLayoutToggleRequestIdRef.current !== layoutToggleRequestId;
    const wrapChanged = previousWrapLinesRef.current !== wrapLines;
    const previousSectionMetrics = previousSectionGeometryRef.current;
    const previousFiles = previousFilesRef.current;
    const currentDraftNoteId = draftNote?.id ?? null;
    const draftChanged = previousDraftNoteIdRef.current !== currentDraftNoteId;

    if (draftChanged && previousSectionMetrics && previousFiles.length > 0) {
      const previousScrollTop = scrollRef.current?.scrollTop ?? scrollViewport.top;
      const anchor =
        lastViewportRowAnchorRef.current ??
        findViewportRowAnchor(
          previousFiles,
          previousSectionMetrics,
          previousScrollTop,
          buildInStreamFileHeaderHeights(previousFiles),
        );
      if (anchor) {
        const nextTop = resolveViewportRowAnchorTop(
          files,
          sectionGeometry,
          anchor,
          sectionHeaderHeights,
        );
        const restoreViewportAnchor = () => {
          scrollRef.current?.scrollTo(nextTop);
        };

        lastViewportRowAnchorRef.current = anchor;
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
      );
      if (anchor) {
        const nextTop = resolveViewportRowAnchorTop(
          files,
          sectionGeometry,
          anchor,
          sectionHeaderHeights,
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
    draftNote?.id,
    files,
    layout,
    layoutToggleRequestId,
    layoutToggleScrollTop,
    scrollRef,
    scrollViewport.top,
    sectionGeometry,
    sectionHeaderHeights,
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
    );

    if (nextAnchor) {
      lastViewportRowAnchorRef.current = nextAnchor;
    }
  }, [files, scrollRef, scrollViewport.top, sectionGeometry, sectionHeaderHeights]);

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
    pendingFileTopAlignFileIdRef.current = selectedFileId;
    scrollFileHeaderToTop(selectedFileId);
  }, [
    clearPendingFileTopAlign,
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

    const targetSection = fileSectionLayouts.find((layout) => layout.fileId === pendingFileId);
    if (!targetSection) {
      return;
    }

    const viewportHeight = Math.max(scrollViewport.height, scrollRef.current?.viewport.height ?? 0);
    // Compare against the reachable target, not the raw file body top. The last short file often
    // cannot actually own the viewport top near EOF, and treating that unreachable top as pending
    // would keep snapping manual upward scrolling back down to the bottom edge.
    const desiredTop = clampReviewScrollTop(targetSection.bodyTop, viewportHeight);

    const currentTop = scrollRef.current?.scrollTop ?? scrollViewport.top;
    if (Math.abs(currentTop - desiredTop) <= 0.5) {
      clearPendingFileTopAlign();
      return;
    }

    suppressViewportSelectionSync();
    scrollFileHeaderToTop(pendingFileId);
  }, [
    clampReviewScrollTop,
    clearPendingFileTopAlign,
    fileSectionLayouts,
    files,
    scrollFileHeaderToTop,
    scrollRef,
    scrollViewport.height,
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

    // Run after this pane renders the selected section/hunk, then retry briefly while layout
    // settles across a couple of repaint cycles.
    suppressViewportSelectionSync();
    scrollSelectionIntoView();
    pendingSelectionSettleRef.current = shouldTrackPinnedHeaderResettle;
    const retryDelays = [0, 16, 48];
    const timeouts = retryDelays.map((delay) => setTimeout(scrollSelectionIntoView, delay));
    const settleReset = shouldTrackPinnedHeaderResettle
      ? setTimeout(() => {
          pendingSelectionSettleRef.current = false;
        }, 120)
      : null;
    return () => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
      if (settleReset) {
        clearTimeout(settleReset);
      }
    };
  }, [
    clampReviewScrollTop,
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
        border: pagerMode ? [] : ["top"],
        borderColor: theme.border,
        backgroundColor: theme.panel,
        paddingY: pagerMode ? 0 : 1,
        paddingX: 0,
        flexDirection: "column",
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
                key={`diff-content:${layout}:${wrapLines ? "wrap" : "nowrap"}:${width}`}
                style={{ width: "100%", flexDirection: "column", overflow: "visible" }}
              >
                {files.map((file, index) => {
                  const shouldRenderSection = visibleWindowedFileIds?.has(file.id) ?? true;

                  // Windowing keeps offscreen files cheap: render placeholders with identical
                  // section geometry so scroll math and pinned-header ownership stay stable.
                  if (!shouldRenderSection) {
                    return (
                      <DiffSectionPlaceholder
                        key={file.id}
                        bodyHeight={estimatedBodyHeights[index] ?? 0}
                        file={file}
                        headerLabelWidth={headerLabelWidth}
                        headerStatsWidth={headerStatsWidth}
                        separatorWidth={separatorWidth}
                        showHeader={shouldRenderInStreamFileHeader(index)}
                        showSeparator={index > 0}
                        theme={theme}
                        onSelect={() => onSelectFile(file.id)}
                      />
                    );
                  }

                  return (
                    <DiffSection
                      key={file.id}
                      codeHorizontalOffset={codeHorizontalOffset}
                      expandedGapKeys={expandedGapsByFileId[file.id] ?? EMPTY_EXPANDED_GAP_KEYS}
                      file={file}
                      headerLabelWidth={headerLabelWidth}
                      headerStatsWidth={headerStatsWidth}
                      layout={layout}
                      selectedHunkIndex={file.id === selectedFileId ? selectedHunkIndex : -1}
                      copySelectedRowRanges={copySelectedRowKeysByFile.get(file.id)}
                      copySelectedSide={copySelectionSide}
                      shouldLoadHighlight={highlightPrefetchFileIds.has(file.id)}
                      sectionGeometry={sectionGeometry[index]}
                      separatorWidth={separatorWidth}
                      showHeader={shouldRenderInStreamFileHeader(index)}
                      showSeparator={index > 0}
                      showLineNumbers={showLineNumbers}
                      showHunkHeaders={showHunkHeaders}
                      sourceStatus={sourceStatusByFileId[file.id]}
                      wrapLines={wrapLines}
                      theme={theme}
                      hoverActive={hoveredFileId === null || hoveredFileId === file.id}
                      hoverClearSignal={addNoteHoverClearSignal}
                      viewWidth={diffContentWidth}
                      visibleAgentNotes={
                        visibleAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES
                      }
                      visibleBodyBounds={visibleBodyBoundsByFile.get(file.id)}
                      onHover={() => setHoveredFileId(file.id)}
                      onMouseScroll={clearAddNoteHoverForScroll}
                      onActiveAddNoteAffordanceChange={(affordance) =>
                        onActiveAddNoteAffordanceChange?.(
                          affordance ? { ...affordance, fileId: file.id } : null,
                        )
                      }
                      onStartUserNoteAtHunk={(hunkIndex, target) =>
                        onStartUserNoteAtHunk?.(file.id, hunkIndex, target)
                      }
                      onSelect={() => onSelectFile(file.id)}
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
      ) : (
        <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
          <text fg={theme.muted}>No files match the current filter.</text>
        </box>
      )}
    </box>
  );
}
