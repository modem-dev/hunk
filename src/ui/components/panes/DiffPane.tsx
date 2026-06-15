import {
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  Match,
  mergeProps,
  onCleanup,
  Show,
  Switch,
  untrack,
  type Accessor,
} from "solid-js";
import { useRenderer } from "@opentui/solid";
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
import {
  computeRapidScrollOverscanRows,
  RAPID_SCROLL_OVERSCAN_IDLE_MS,
} from "../../lib/adaptiveScrollOverscan";
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
  VIEWPORT_HEIGHT_SEED_MAX_ATTEMPTS,
  VIEWPORT_HEIGHT_SEED_RETRY_MS,
  VIEWPORT_READ_COALESCE_MS,
} from "../../lib/viewportTiming";
import {
  findViewportRowAnchor,
  resolveViewportRowAnchorTop,
  type ViewportRowAnchor,
} from "../../lib/viewportAnchor";
import type { AppTheme } from "../../themes";
import { DiffSection } from "./DiffSection";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";
import { VerticalScrollbar, type VerticalScrollbarHandle } from "../scrollbar/VerticalScrollbar";
import type { VisibleBodyBounds } from "../../diff/rowWindowing";
import { prefetchHighlightedDiff } from "../../diff/useHighlightedDiff";
import {
  buildFileRenderWindow,
  buildFileSectionIndexById,
  type FileRenderWindowItem,
} from "../../lib/fileRenderWindow";
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
const EMPTY_SOURCE_STATUS_BY_FILE_ID: Record<string, FileSourceStatus> = {};
const NOOP_TOGGLE_GAP = () => {};

/**
 * Props for {@link DiffPane}.
 *
 * Several review-state fields arrive as `Accessor<T>` getters because they originate from
 * `useReviewController` (whose reactive state is uniformly exposed as accessors). They keep their
 * original prop NAMES so callers don't have to rename anything; DiffPane simply calls them.
 * The accessor-typed props are:
 *   files, selectedFileId, selectedHunkIndex, scrollToNote, draftNote, expandedGapsByFileId,
 *   sourceStatusByFileId, showAgentNotes, selectedFileTopAlignRequestId, selectedHunkRevealRequestId.
 */
interface DiffPaneProps {
  codeHorizontalOffset?: number;
  diffContentWidth: number;
  expandedGapsByFileId?: Accessor<Record<string, ReadonlySet<string>>>;
  files: Accessor<DiffFile[]>;
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  scrollRef: { current: ScrollBoxRenderable | null };
  selectedFileId?: Accessor<string | undefined>;
  selectedHunkIndex: Accessor<number>;
  scrollToNote?: Accessor<boolean>;
  draftNote?: Accessor<DraftReviewNote | null>;
  draftNoteFocused?: boolean;
  separatorWidth: number;
  pagerMode?: boolean;
  copyDecorations?: boolean;
  screenLeft?: number;
  screenTop?: number;
  showAgentNotes: Accessor<boolean>;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  sourceStatusByFileId?: Accessor<Record<string, FileSourceStatus>>;
  wrapLines: boolean;
  wrapToggleScrollTop: number | null;
  layoutToggleScrollTop?: number | null;
  layoutToggleRequestId?: number;
  selectedFileTopAlignRequestId?: Accessor<number>;
  selectedHunkRevealRequestId?: Accessor<number | undefined>;
  theme: AppTheme;
  width: number;
  cancelCopySelectionRef?: { current: (() => void) | null };
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
}

/** Render the main multi-file review stream. */
export function DiffPane(props: DiffPaneProps) {
  // Defaults for optional props. Function-valued accessor defaults are wrapped so reading them is
  // identical to reading a real review-controller accessor.
  const merged = mergeProps(
    {
      codeHorizontalOffset: 0,
      expandedGapsByFileId: (() => EMPTY_EXPANDED_GAPS_BY_FILE_ID) as Accessor<
        Record<string, ReadonlySet<string>>
      >,
      scrollToNote: (() => false) as Accessor<boolean>,
      draftNote: (() => null) as Accessor<DraftReviewNote | null>,
      draftNoteFocused: false,
      pagerMode: false,
      copyDecorations: false,
      screenLeft: 0,
      screenTop: 0,
      sourceStatusByFileId: (() => EMPTY_SOURCE_STATUS_BY_FILE_ID) as Accessor<
        Record<string, FileSourceStatus>
      >,
      layoutToggleScrollTop: null as number | null,
      layoutToggleRequestId: 0,
      selectedFileTopAlignRequestId: (() => 0) as Accessor<number>,
      onScrollCodeHorizontally: (() => {}) as (delta: number) => void,
      onToggleGap: NOOP_TOGGLE_GAP,
    },
    props,
  );

  // Accessor convenience readers. These call the review-controller accessors so the rest of the
  // body can read review state with simple function calls and Solid tracks them fine-grained.
  const files = () => merged.files();
  const selectedFileId = () => merged.selectedFileId?.();
  const selectedHunkIndex = () => merged.selectedHunkIndex();
  const scrollToNote = () => merged.scrollToNote();
  const draftNote = () => merged.draftNote();
  const expandedGapsByFileId = () => merged.expandedGapsByFileId();
  const sourceStatusByFileId = () => merged.sourceStatusByFileId();
  const showAgentNotes = () => merged.showAgentNotes();
  const selectedFileTopAlignRequestId = () => merged.selectedFileTopAlignRequestId();
  const selectedHunkRevealRequestId = () => merged.selectedHunkRevealRequestId?.();

  const renderer = useRenderer();
  // Created once for the lifetime of the pane (was useMemo([])).
  const mouseWheelScrollAcceleration = createReviewMouseWheelScrollAcceleration();

  const [addNoteHoverClearSignal, setAddNoteHoverClearSignal] = createSignal(0);
  const [addNoteHoverClearFileId, setAddNoteHoverClearFileId] = createSignal<string | null>(null);
  const hoveredFileIdRef: { current: string | null } = { current: null };
  // Latest-callback ref so cached per-file closures never call a stale handler.
  const onActiveAddNoteAffordanceChangeRef: {
    current:
      | ((affordance: (ActiveAddNoteAffordance & { fileId: string }) | null) => void)
      | undefined;
  } = { current: merged.onActiveAddNoteAffordanceChange };
  createRenderEffect(() => {
    onActiveAddNoteAffordanceChangeRef.current = merged.onActiveAddNoteAffordanceChange;
  });

  /** Hide hover-only row controls when content scrolls under a stationary mouse pointer. */
  const clearAddNoteHoverForScroll = () => {
    const hoveredFileId = hoveredFileIdRef.current;
    if (!hoveredFileId) {
      return;
    }

    setAddNoteHoverClearFileId(hoveredFileId);
    setAddNoteHoverClearSignal((current) => current + 1);
    setHoveredFileId(null);
    hoveredFileIdRef.current = null;
    onActiveAddNoteAffordanceChangeRef.current?.(null);
  };

  const adjacentPrefetchFileIds = createMemo(() =>
    buildAdjacentPrefetchFileIds(files(), selectedFileId()),
  );

  // Stable per-file select callbacks keep mounted sections from re-running just because DiffPane
  // re-derived. The latest-onSelectFile ref means the cached closures never go stale even though
  // their identity is fixed for the life of the pane.
  const onSelectFileRef: { current: (fileId: string) => void } = { current: merged.onSelectFile };
  createRenderEffect(() => {
    onSelectFileRef.current = merged.onSelectFile;
  });
  const selectFileCallbacksRef: { current: Map<string, () => void> } = { current: new Map() };
  const selectFileCallback = (fileId: string) => {
    let callback = selectFileCallbacksRef.current.get(fileId);
    if (!callback) {
      callback = () => onSelectFileRef.current(fileId);
      selectFileCallbacksRef.current.set(fileId, callback);
    }
    return callback;
  };

  // Add-note row handlers are cached per file so mounted DiffSections keep a stable prop identity,
  // while the ref indirection ensures clicks still use the latest App/review callback after hunk
  // navigation changes the selected-file defaults upstream.
  const onStartUserNoteAtHunkRef: {
    current: ((fileId: string, hunkIndex: number, target?: UserNoteLineTarget) => void) | undefined;
  } = { current: merged.onStartUserNoteAtHunk };
  createRenderEffect(() => {
    onStartUserNoteAtHunkRef.current = merged.onStartUserNoteAtHunk;
  });
  const startUserNoteAtHunkCallbacksRef: {
    current: Map<string, (hunkIndex: number, target?: UserNoteLineTarget) => void>;
  } = { current: new Map() };
  const startUserNoteAtHunkCallback = (fileId: string) => {
    let callback = startUserNoteAtHunkCallbacksRef.current.get(fileId);
    if (!callback) {
      callback = (hunkIndex, target) =>
        onStartUserNoteAtHunkRef.current?.(fileId, hunkIndex, target);
      startUserNoteAtHunkCallbacksRef.current.set(fileId, callback);
    }
    return callback;
  };

  const activeAddNoteAffordanceCallbacksRef: {
    current: Map<string, (affordance: ActiveAddNoteAffordance | null) => void>;
  } = { current: new Map() };
  const activeAddNoteAffordanceCallback = (fileId: string) => {
    let callback = activeAddNoteAffordanceCallbacksRef.current.get(fileId);
    if (!callback) {
      callback = (affordance) =>
        onActiveAddNoteAffordanceChangeRef.current?.(affordance ? { ...affordance, fileId } : null);
      activeAddNoteAffordanceCallbacksRef.current.set(fileId, callback);
    }
    return callback;
  };

  /** Route shifted wheel input into horizontal code-column scrolling without disturbing vertical review scroll. */
  const handleMouseScroll = (event: TuiMouseEvent) => {
    const scrollBox = merged.scrollRef.current;
    const direction = event.scroll?.direction;
    if (!direction) {
      return;
    }

    clearAddNoteHoverForScroll();

    if (!scrollBox || merged.wrapLines) {
      return;
    }

    const preservedScrollTop = scrollBox.scrollTop;
    const preservedScrollLeft = scrollBox.scrollLeft;
    const scrollInfo = event.scroll;

    if (direction === "left") {
      merged.onScrollCodeHorizontally(-1);
    } else if (direction === "right") {
      merged.onScrollCodeHorizontally(1);
    } else if (event.modifiers.shift && direction === "up") {
      merged.onScrollCodeHorizontally(-1);
    } else if (event.modifiers.shift && direction === "down") {
      merged.onScrollCodeHorizontally(1);
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
      const currentScrollBox = merged.scrollRef.current;
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
  };

  const allAgentNotesByFile = createMemo(() => {
    const next = new Map<string, VisibleAgentNote[]>();
    const currentDraftNote = draftNote();
    const currentShowAgentNotes = showAgentNotes();

    files().forEach((file) => {
      const annotations = (file.agent?.annotations ?? []).filter(
        (annotation) => currentShowAgentNotes || alwaysShowReviewNote(annotation),
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
          onRemove: annotation.id ? () => merged.onRemoveUserNote?.(annotation.id!) : undefined,
        };
      });

      if (currentDraftNote?.fileId === file.id) {
        const draftAnnotation: AgentAnnotation = {
          id: currentDraftNote.id,
          source: "user-draft",
          summary: currentDraftNote.body || " ",
          oldRange: currentDraftNote.oldRange,
          newRange: currentDraftNote.newRange,
          editable: true,
        };
        notes.push({
          id: currentDraftNote.id,
          annotation: draftAnnotation,
          source: "draft",
          editable: true,
          draft: {
            body: currentDraftNote.body,
            focused: merged.draftNoteFocused,
            onBlur: merged.onBlurDraftNote,
            onCancel: merged.onCancelDraftNote ?? (() => {}),
            onFocus: merged.onFocusDraftNote,
            onInput: merged.onUpdateDraftNote ?? (() => {}),
            onSave: merged.onSaveDraftNote ?? (() => {}),
          },
        });
      }

      if (notes.length > 0) {
        next.set(file.id, notes);
      }
    });

    return next;
  });

  // Keep the full file-section path for wrapped lines, where exact wrapped heights depend on
  // mounting each section; nowrap reviews can window offscreen files behind exact spacers.
  const windowingEnabled = () => !merged.wrapLines;
  const [scrollViewport, setScrollViewport] = createSignal({ top: 0, height: 0 });
  const [rapidScrollOverscanRows, setRapidScrollOverscanRows] = createSignal(0);
  const [hoveredFileId, setHoveredFileId] = createSignal<string | null>(null);
  const [copySelectionDrag, setCopySelectionDrag] = createSignal<CopySelectionDrag | null>(null);
  // Mirror the drag state in a ref so updateCopySelection can suppress native selection
  // on the very first drag event, before a re-render has applied the new state.
  const copySelectionDragRef: { current: CopySelectionDrag | null } = { current: null };
  const lastClickTimeRef = { current: 0 };
  const clickCountRef = { current: 0 };
  const lastClickPointRef: { current: CopySelectionPoint | null } = { current: null };
  const scrollbarRef: { current: VerticalScrollbarHandle | null } = { current: null };
  const prevScrollTopRef = { current: 0 };
  const hasReadScrollViewportRef = { current: false };
  const previousSectionGeometryRef: { current: DiffSectionGeometry[] | null } = { current: null };
  const previousFilesRef: { current: DiffFile[] } = { current: untrack(files) };
  const previousLayoutRef = { current: merged.layout };
  const previousWrapLinesRef = { current: merged.wrapLines };
  const previousDraftNoteIdRef: { current: string | null } = {
    current: untrack(draftNote)?.id ?? null,
  };
  const previousSelectedFileTopAlignRequestIdRef = {
    current: untrack(selectedFileTopAlignRequestId),
  };
  const previousLayoutToggleRequestIdRef = { current: merged.layoutToggleRequestId };
  const previousSelectedHunkRevealRequestIdRef: { current: number | undefined } = {
    current: untrack(selectedHunkRevealRequestId),
  };
  const pendingFileTopAlignFileIdRef: { current: string | null } = { current: null };
  const suppressViewportSelectionSyncRef = { current: false };
  const suppressViewportSelectionSyncTimeoutRef: {
    current: ReturnType<typeof setTimeout> | null;
  } = { current: null };
  const rapidScrollOverscanTimeoutRef: { current: ReturnType<typeof setTimeout> | null } = {
    current: null,
  };
  // Initialized to null so the first read never fires a selection change; a real scroll
  // is required before passive viewport-follow selection can trigger.
  const lastViewportSelectionTopRef: { current: number | null } = { current: null };
  const lastViewportRowAnchorRef: { current: ViewportRowAnchor | null } = { current: null };

  /** Track the currently hover-owned file without making scroll handlers depend on render state. */
  const setHoveredFileForRowActions = (fileId: string) => {
    hoveredFileIdRef.current = fileId;
    setHoveredFileId(fileId);
  };

  /** Temporarily widen the mounted diff window while scroll input is arriving in bursts. */
  const activateRapidScrollOverscan = (overscanRows: number) => {
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
  };

  /**
   * Ignore viewport-follow selection updates while the pane is scrolling to an explicit selection.
   * That lets direct hunk/file navigation own the viewport until the jump settles.
   */
  const suppressViewportSelectionSync = (durationMs = 160) => {
    suppressViewportSelectionSyncRef.current = true;
    if (suppressViewportSelectionSyncTimeoutRef.current) {
      clearTimeout(suppressViewportSelectionSyncTimeoutRef.current);
    }
    suppressViewportSelectionSyncTimeoutRef.current = setTimeout(() => {
      suppressViewportSelectionSyncRef.current = false;
      suppressViewportSelectionSyncTimeoutRef.current = null;
    }, durationMs);
  };

  onCleanup(() => {
    if (suppressViewportSelectionSyncTimeoutRef.current) {
      clearTimeout(suppressViewportSelectionSyncTimeoutRef.current);
    }
    if (rapidScrollOverscanTimeoutRef.current) {
      clearTimeout(rapidScrollOverscanTimeoutRef.current);
    }
  });

  // Mirror the imperative OpenTUI scrollbox state into a signal so geometry planning, windowing,
  // pinned-header ownership, and prefetching can all read the same viewport snapshot. Re-bind when
  // the file count or scroll ref changes (was [files.length, scrollRef] deps).
  createEffect(() => {
    // Track the dependencies that should force a re-bind.
    void files().length;
    const scrollBox = merged.scrollRef.current;
    if (!scrollBox) {
      return;
    }

    let cancelled = false;
    let scheduled = false;
    let scheduledViewportRead: ReturnType<typeof setTimeout> | null = null;

    const readViewport = () => {
      const nextTop = scrollBox.scrollTop ?? 0;
      const nextHeight = scrollBox.viewport.height ?? 0;

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
        activateRapidScrollOverscan(
          computeRapidScrollOverscanRows({
            deltaRows: nextTop - previousTop,
            viewportHeight: nextHeight,
          }),
        );
        prevScrollTopRef.current = nextTop;
      }

      setScrollViewport((current) =>
        current.top === nextTop && current.height === nextHeight
          ? current
          : { top: nextTop, height: nextHeight },
      );
    };

    // OpenTUI emits `change` synchronously from inside its own slider sync, and other render
    // effects in this pane scroll the box from inside the commit phase. Calling setScrollViewport
    // directly from the listener can run a write while a paint is already committing — which
    // downstream layout effects can amplify into a render loop. Coalesce listener events into one
    // timer-deferred read so rapid wheel/key bursts collapse into at most one update per frame
    // instead of turning every native scroll delta into a full review-stream re-plan.
    const handleViewportChange = () => {
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
      }, VIEWPORT_READ_COALESCE_MS);
    };

    readViewport();
    scrollBox.verticalScrollBar.on("change", handleViewportChange);
    scrollBox.viewport.on("layout-changed", handleViewportChange);
    scrollBox.viewport.on("resized", handleViewportChange);

    // First-paint height seed. OpenTUI computes the viewport height during its first layout
    // pass; that pass can finish after this effect runs, so the initial `layout-changed` event
    // fires before the listener above is attached and is lost. Nothing recalculates layout again
    // until a scroll, so without this the windowing memo plans against height 0 and the bottom of
    // the first frame is left under-filled until the user scrolls. Poll the already-computed
    // height a few early frames apart until it materializes, then read it once and stop — a
    // bounded one-shot, not a steady-state cost (the synchronous read above already covers the
    // common case where layout has settled before this effect runs).
    let seedAttempts = 0;
    let seedTimer: ReturnType<typeof setTimeout> | null = null;
    const seedViewportHeight = () => {
      seedTimer = null;
      if (cancelled) {
        return;
      }
      if ((scrollBox.viewport.height ?? 0) > 0) {
        readViewport();
        return;
      }
      if (seedAttempts >= VIEWPORT_HEIGHT_SEED_MAX_ATTEMPTS) {
        return;
      }
      seedAttempts += 1;
      seedTimer = setTimeout(seedViewportHeight, VIEWPORT_HEIGHT_SEED_RETRY_MS);
    };
    if ((scrollBox.viewport.height ?? 0) <= 0) {
      seedTimer = setTimeout(seedViewportHeight, VIEWPORT_HEIGHT_SEED_RETRY_MS);
    }

    onCleanup(() => {
      cancelled = true;
      if (scheduledViewportRead) {
        clearTimeout(scheduledViewportRead);
      }
      if (seedTimer) {
        clearTimeout(seedTimer);
      }
      scrollBox.verticalScrollBar.off("change", handleViewportChange);
      scrollBox.viewport.off("layout-changed", handleViewportChange);
      scrollBox.viewport.off("resized", handleViewportChange);
    });
  });

  const sectionHeaderHeights = createMemo(() => buildInStreamFileHeaderHeights(files()));
  const reserveAddNoteColumn = () => Boolean(merged.onStartUserNoteAtHunk);

  const baseSectionGeometry = createMemo(() => {
    const currentExpanded = expandedGapsByFileId();
    const currentSourceStatus = sourceStatusByFileId();
    return files().map((file) =>
      measureDiffSectionGeometry(
        file,
        merged.layout,
        merged.showHunkHeaders,
        merged.theme,
        EMPTY_VISIBLE_AGENT_NOTES,
        merged.diffContentWidth,
        merged.showLineNumbers,
        merged.wrapLines,
        currentExpanded[file.id] ?? EMPTY_EXPANDED_GAP_KEYS,
        currentSourceStatus[file.id],
        reserveAddNoteColumn(),
      ),
    );
  });
  const baseEstimatedBodyHeights = createMemo(() =>
    baseSectionGeometry().map((metrics) => metrics.bodyHeight),
  );
  const baseFileSectionLayouts = createMemo(() =>
    buildFileSectionLayouts(files(), baseEstimatedBodyHeights(), sectionHeaderHeights()),
  );

  const visibleViewportFileIds = createMemo(() => {
    const viewport = scrollViewport();
    const overscanTerminalRows = Math.max(8, rapidScrollOverscanRows());
    const minVisibleY = Math.max(0, viewport.top - overscanTerminalRows);
    const maxVisibleY = viewport.top + viewport.height + overscanTerminalRows;
    return collectIntersectingFileSectionIds(baseFileSectionLayouts(), minVisibleY, maxVisibleY);
  });

  const visibleAgentNotesByFile = createMemo(() => {
    const next = new Map<string, VisibleAgentNote[]>();

    const fileIdsToMeasure = new Set(visibleViewportFileIds());
    // Always measure the selected file with its real note rows so hunk navigation can compute
    // accurate bounds even before the file scrolls into the visible viewport.
    const currentSelectedFileId = selectedFileId();
    if (currentSelectedFileId) {
      fileIdsToMeasure.add(currentSelectedFileId);
    }

    const notesByFile = allAgentNotesByFile();
    for (const fileId of fileIdsToMeasure) {
      const visibleNotes = notesByFile.get(fileId);
      if (visibleNotes && visibleNotes.length > 0) {
        next.set(fileId, visibleNotes);
      }
    }

    return next;
  });

  // Measure with the *full* set of agent notes per file, not just the visible-viewport set.
  // The visible set is correct for rendering (skip painting cards on off-screen files), but
  // using it here makes total content height fluctuate with scroll position: as a file with
  // notes leaves the viewport, its measurement shrinks back to the no-notes baseline, which
  // shrinks `totalContentHeight`, which tightens `clampReviewScrollTop`'s ceiling, which
  // snaps the viewport upward by the height of the off-top note rows. Always include notes
  // in geometry for stable bottom-edge clamping.
  const sectionGeometry = createMemo(() => {
    const notesByFile = allAgentNotesByFile();
    const baseGeometry = baseSectionGeometry();
    const currentExpanded = expandedGapsByFileId();
    const currentSourceStatus = sourceStatusByFileId();
    return files().map((file, index) => {
      const notes = notesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES;
      if (notes.length === 0) {
        return baseGeometry[index]!;
      }

      return measureDiffSectionGeometry(
        file,
        merged.layout,
        merged.showHunkHeaders,
        merged.theme,
        notes,
        merged.diffContentWidth,
        merged.showLineNumbers,
        merged.wrapLines,
        currentExpanded[file.id] ?? EMPTY_EXPANDED_GAP_KEYS,
        currentSourceStatus[file.id],
        reserveAddNoteColumn(),
      );
    });
  });
  const estimatedBodyHeights = createMemo(() =>
    sectionGeometry().map((metrics) => metrics.bodyHeight),
  );
  const fileSectionLayouts = createMemo(() =>
    buildFileSectionLayouts(files(), estimatedBodyHeights(), sectionHeaderHeights()),
  );
  const totalContentHeight = () => {
    const layouts = fileSectionLayouts();
    return layouts[layouts.length - 1]?.sectionBottom ?? 0;
  };

  // Read the live scroll box position when computing pinned-header ownership so it flips
  // immediately after imperative scrolls instead of waiting for the polled viewport snapshot.
  // Always read `scrollViewport()` first so callers running inside a tracking scope (e.g. the
  // `pinnedHeaderFile` memo) take a reactive dependency on it: the polled snapshot updates on every
  // scroll event, which is what re-runs the memo. Without this read, the `??` short-circuit would
  // skip `scrollViewport()` whenever the live value is present, leaving the memo with no scroll
  // dependency and a stale pinned header after imperative scrolls.
  const effectiveScrollTop = () => {
    const polledTop = scrollViewport().top;
    return merged.scrollRef.current?.scrollTop ?? polledTop;
  };
  const pinnedHeaderFile = createMemo(() => {
    const currentFiles = files();
    if (currentFiles.length === 0) {
      return null;
    }

    // The current file header always owns the pinned top row.
    // Use the previous visible row to decide ownership so the next file's real header can still
    // scroll through the stream before the pinned header hands off to it on the following row.
    const owner = findHeaderOwningFileSection(
      fileSectionLayouts(),
      Math.max(0, effectiveScrollTop() - 1),
    );

    return owner ? (currentFiles[owner.sectionIndex] ?? null) : (currentFiles[0] ?? null);
  });
  const pinnedHeaderFileId = () => pinnedHeaderFile()?.id ?? null;

  const copySelectionContext = createMemo(
    (): CopySelectionContext => ({
      codeHorizontalOffset: merged.codeHorizontalOffset,
      copyDecorations: merged.copyDecorations,
      files: files(),
      fileSectionLayouts: fileSectionLayouts(),
      headerLabelWidth: merged.headerLabelWidth,
      headerStatsWidth: merged.headerStatsWidth,
      layout: merged.layout,
      pinnedHeaderFile: pinnedHeaderFile(),
      sectionGeometry: sectionGeometry(),
      showHunkHeaders: merged.showHunkHeaders,
      showLineNumbers: merged.showLineNumbers,
      theme: merged.theme,
      width: merged.diffContentWidth,
      wrapLines: merged.wrapLines,
    }),
  );

  // In split layout, anchor the visible selection (and clipboard copy) to whichever side of
  // the diff the drag began on. Stack layout has only one column, so the side stays undefined.
  const copySelectionSide = createMemo((): CopySelectionSide | undefined => {
    const drag = copySelectionDrag();
    if (!drag || drag.anchor.kind !== "review-row") {
      return undefined;
    }
    return resolveCopySelectionSide(drag.anchor.column, merged.layout, merged.diffContentWidth);
  });

  const copySelectedRowKeysByFile = createMemo(() =>
    buildCopySelectedRowKeys({
      drag: copySelectionDrag(),
      fileSectionLayouts: fileSectionLayouts(),
      sectionGeometry: sectionGeometry(),
      width: merged.diffContentWidth,
    }),
  );

  /** Copy selected text through the injected boundary or the renderer's OSC 52 clipboard support. */
  const copySelectionText = (text: string) => {
    if (text.length === 0) {
      return;
    }

    if (merged.onCopySelectionText) {
      merged.onCopySelectionText(text);
      return;
    }

    const supportsOsc52 = renderer.isOsc52Supported?.() ?? false;
    if (supportsOsc52 && typeof renderer.copyToClipboardOSC52 === "function") {
      renderer.copyToClipboardOSC52(text);
      merged.onCopyFeedback?.("Copied selection to clipboard");
      return;
    }

    merged.onCopyFeedback?.(
      "Clipboard copy unsupported in this terminal (enable OSC 52 to capture selections)",
    );
  };

  /** Convert one mouse event into a review-stream copy-selection point. */
  const resolveCopySelectionPoint = (event: TuiMouseEvent): CopySelectionPoint | null => {
    const scrollBox = merged.scrollRef.current;
    if (!scrollBox) {
      return null;
    }

    const currentPinnedHeaderFileId = pinnedHeaderFileId();
    const reviewPaneTopChromeRows = merged.pagerMode ? 0 : 2;
    const pinnedHeaderHeight = currentPinnedHeaderFileId ? 1 : 0;
    const paneY = Math.floor(event.y - merged.screenTop);
    const pinnedHeaderY = reviewPaneTopChromeRows;
    if (merged.copyDecorations && currentPinnedHeaderFileId && paneY === pinnedHeaderY) {
      return {
        kind: "pinned-header",
        column: clampCopyColumn(Math.floor(event.x - merged.screenLeft), merged.diffContentWidth),
        fileId: currentPinnedHeaderFileId,
        nextVisualRow: Math.floor(scrollBox.scrollTop ?? 0),
      };
    }

    const paneChromeHeight = reviewPaneTopChromeRows + pinnedHeaderHeight;
    const viewportY = Math.floor(event.y - merged.screenTop - paneChromeHeight);
    if (viewportY < 0 || viewportY >= Math.max(1, scrollBox.viewport.height ?? 0)) {
      return null;
    }

    return findCopySelectionPoint({
      column: Math.floor(event.x - merged.screenLeft),
      copyDecorations: merged.copyDecorations,
      fileSectionLayouts: fileSectionLayouts(),
      sectionGeometry: sectionGeometry(),
      visualRow: Math.floor((scrollBox.scrollTop ?? 0) + viewportY),
      width: merged.diffContentWidth,
    });
  };

  // OpenTUI starts a native cross-renderable text selection on mouse-down over any selectable
  // <text> before our handler runs. That native selection ignores element bounds and paints
  // across the whole screen, so we eagerly clear it whenever Hunk owns the drag.
  const suppressNativeSelection = () => {
    if (renderer.hasSelection) {
      renderer.clearSelection();
    }
  };

  /** Start selecting diff text when the user drags inside the review stream. */
  const beginCopySelection = (event: TuiMouseEvent) => {
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
      const expanded = expandSelectionPoint(point, clickCount as 2 | 3, copySelectionContext());
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
  };

  /** Extend the active diff text selection while the pointer moves. */
  const updateCopySelection = (event: TuiMouseEvent) => {
    // Use the ref (not the signal) so that native-selection suppression fires on the very
    // first drag event, before the next render has applied the new copySelectionDrag.
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

    // The updater above does not touch the ref; update the ref synchronously here so that
    // endCopySelection can read the correct moved flag even if the mouse-up event fires before
    // the pending signal write is observed.
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
  };

  /** Finish a drag selection and copy its rendered text. */
  const endCopySelection = (event?: TuiMouseEvent) => {
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
      context: copySelectionContext(),
      end,
      side: copySelectionSide(),
      start,
    });
    copySelectionText(text);
  };

  // Expose the cancel hook so an ancestor (App's outer container) can release a stuck drag when
  // the pointer leaves the diff pane and is released over the sidebar, menu bar, or status bar.
  createEffect(() => {
    const cancelRef = merged.cancelCopySelectionRef;
    if (!cancelRef) {
      return;
    }
    cancelRef.current = () => endCopySelection();
    onCleanup(() => {
      if (cancelRef.current) {
        cancelRef.current = null;
      }
    });
  });

  /** Clamp one requested review scroll target against the latest planned content height. */
  const clampReviewScrollTop = (requestedTop: number, viewportHeight: number) =>
    clampVerticalScrollTop(requestedTop, totalContentHeight(), viewportHeight);

  const highlightPrefetchFileIds = createMemo(() => {
    const viewport = scrollViewport();
    return buildHighlightPrefetchFileIds({
      adjacentPrefetchFileIds: adjacentPrefetchFileIds(),
      fileSectionLayouts: fileSectionLayouts(),
      rapidScrollOverscanRows: rapidScrollOverscanRows(),
      scrollTop: viewport.top,
      viewportHeight: viewport.height,
      selectedFileId: selectedFileId(),
    });
  });

  // Kick off highlight work from viewport planning rather than waiting for the section to mount.
  // That avoids the "plain rows first, color later" stutter when a file is about to scroll onscreen.
  createEffect(() => {
    const currentFiles = files();
    if (currentFiles.length === 0) {
      return;
    }

    const prefetchIds = highlightPrefetchFileIds();
    const appearance = merged.theme.appearance;
    for (const file of currentFiles) {
      if (!prefetchIds.has(file.id)) {
        continue;
      }

      void prefetchHighlightedDiff({
        file,
        appearance,
      });
    }
  });

  // Keep the selected file/hunk derived from the visible viewport for actual scroll-driven
  // movement, while leaving the initial mount and non-scroll relayouts alone. Runs before paint
  // (createRenderEffect) like the former useLayoutEffect.
  createRenderEffect(() => {
    const viewport = scrollViewport();
    const previousViewportTop = lastViewportSelectionTopRef.current;
    lastViewportSelectionTopRef.current = viewport.top;

    const onViewportCenteredHunkChange = merged.onViewportCenteredHunkChange;
    const currentFiles = files();

    if (
      previousViewportTop === null ||
      previousViewportTop === viewport.top ||
      !onViewportCenteredHunkChange ||
      suppressViewportSelectionSyncRef.current ||
      currentFiles.length === 0 ||
      viewport.height <= 0
    ) {
      return;
    }

    const centeredTarget = findViewportCenteredHunkTarget({
      files: currentFiles,
      fileSectionLayouts: fileSectionLayouts(),
      sectionGeometry: sectionGeometry(),
      scrollTop: viewport.top,
      viewportHeight: viewport.height,
    });
    if (!centeredTarget) {
      return;
    }

    if (
      centeredTarget.fileId === selectedFileId() &&
      centeredTarget.hunkIndex === selectedHunkIndex()
    ) {
      return;
    }

    onViewportCenteredHunkChange(centeredTarget.fileId, centeredTarget.hunkIndex);
  });

  // Re-paint when the pinned header owner changes so the sticky row updates in lockstep with the
  // stream (was a useLayoutEffect keyed on pinnedHeaderFileId).
  createRenderEffect(() => {
    void pinnedHeaderFileId();
    renderer.intermediateRender();
  });

  const fullFileRenderItems = createMemo((): FileRenderWindowItem[] =>
    files().map((file, sectionIndex) => ({ kind: "file", fileId: file.id, sectionIndex })),
  );
  const fileSectionIndexById = createMemo(() => buildFileSectionIndexById(fileSectionLayouts()));
  const fileRenderWindow = createMemo(() => {
    if (!windowingEnabled()) {
      return null;
    }
    const viewport = scrollViewport();
    return buildFileRenderWindow({
      fileSectionLayouts: fileSectionLayouts(),
      includeFileIds: adjacentPrefetchFileIds(),
      indexByFileId: fileSectionIndexById(),
      overscanFiles: 2,
      scrollTop: viewport.top,
      selectedFileId: selectedFileId(),
      viewportHeight: viewport.height,
    });
  });
  // Solid's <For> reconciles rows by object identity. buildFileRenderWindow returns brand-new
  // item objects on every scroll/selection change, which would tear down and recreate every
  // mounted section each navigation — re-running each section's expensive Pierre row plan and
  // span flattening (the dominant per-press cost). Reconcile against the previous snapshot so
  // unchanged file/spacer items keep their reference and their <For> rows stay mounted; only
  // genuinely new or resized items get fresh objects.
  const previousRenderItemsRef: { current: Map<string, FileRenderWindowItem> } = {
    current: new Map(),
  };
  const fileRenderItems = createMemo<FileRenderWindowItem[]>(() => {
    const raw = fileRenderWindow()?.items ?? fullFileRenderItems();
    const previous = previousRenderItemsRef.current;
    const next = new Map<string, FileRenderWindowItem>();
    const result = raw.map((item) => {
      const key = item.kind === "file" ? `file:${item.fileId}` : `spacer:${item.key}`;
      const prior = previous.get(key);
      const unchanged =
        prior?.kind === item.kind &&
        (item.kind === "file"
          ? prior.kind === "file" && prior.sectionIndex === item.sectionIndex
          : prior.kind === "spacer" &&
            prior.height === item.height &&
            prior.startIndex === item.startIndex &&
            prior.endIndex === item.endIndex);
      const reused = unchanged ? prior! : item;
      next.set(key, reused);
      return reused;
    });
    previousRenderItemsRef.current = next;
    return result;
  });
  const mountedFileIndices = () => fileRenderWindow()?.mountedFileIndices ?? null;
  // Previous snapshot used to keep VisibleBodyBounds object identity stable across scroll
  // commits; reusing the prior object when top/height are numerically unchanged lets mounted
  // sections skip re-rendering even though the Map itself is rebuilt every snapshot.
  const previousVisibleBodyBoundsRef: { current: Map<string, VisibleBodyBounds> } = {
    current: new Map(),
  };
  const visibleBodyBoundsByFile = createMemo(() => {
    const viewport = scrollViewport();
    const previous = previousVisibleBodyBoundsRef.current;
    const next = new Map<string, VisibleBodyBounds>();
    if (viewport.height <= 0) {
      previousVisibleBodyBoundsRef.current = next;
      return next;
    }

    const overscanTerminalRows = Math.max(24, viewport.height * 2, rapidScrollOverscanRows());

    const currentFiles = files();
    const layouts = fileSectionLayouts();
    const geometry = sectionGeometry();
    const indicesToMeasure = mountedFileIndices() ?? currentFiles.map((_, index) => index);

    for (const index of indicesToMeasure) {
      const file = currentFiles[index];
      const sectionLayout = layouts[index];
      const fileGeometry = geometry[index];
      if (!file || !sectionLayout || !fileGeometry) {
        continue;
      }

      // Convert the absolute review-stream viewport into file-body-local coordinates.
      // Example: if the viewport starts at row 2_000 globally and this file body starts at row
      // 1_940, then the file-local visible top is 60 rows into this file.
      const minTop = viewport.top - sectionLayout.bodyTop - overscanTerminalRows;
      const maxBottom =
        viewport.top + viewport.height - sectionLayout.bodyTop + overscanTerminalRows;

      // Keep the mounted rows bounded to the viewport slice. Selection reveal uses planned hunk
      // geometry as its fallback, so mounting an offscreen selected hunk is not necessary and would
      // remount very large hunks in full.

      // Clamp the requested file-local interval back into the real body extent, then store it as
      // { top, height } so the row slicer can rebuild the matching [top, bottom) window later.
      const clampedTop = Math.min(fileGeometry.bodyHeight, Math.max(0, minTop));
      const clampedBottom = Math.min(fileGeometry.bodyHeight, Math.max(clampedTop, maxBottom));
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
  });

  const selectedFileIndex = () => {
    const id = selectedFileId();
    return id ? files().findIndex((file) => file.id === id) : -1;
  };
  const selectedFile = () => {
    const index = selectedFileIndex();
    return index >= 0 ? files()[index] : undefined;
  };
  const selectedAnchorId = () => {
    const file = selectedFile();
    if (!file) {
      return null;
    }
    return file.metadata.hunks[selectedHunkIndex()]
      ? diffHunkId(file.id, selectedHunkIndex())
      : diffSectionId(file.id);
  };
  const selectedEstimatedHunkBounds = createMemo(() => {
    const file = selectedFile();
    const index = selectedFileIndex();
    if (!file || index < 0 || file.metadata.hunks.length === 0) {
      return null;
    }

    const selectedFileSectionLayout = fileSectionLayouts()[index];
    if (!selectedFileSectionLayout) {
      return null;
    }

    const clampedHunkIndex = Math.max(
      0,
      Math.min(selectedHunkIndex(), file.metadata.hunks.length - 1),
    );
    const hunkBounds = sectionGeometry()[index]?.hunkBounds.get(clampedHunkIndex);
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
  });

  /** Absolute scroll offset and height of the first inline note in the selected hunk, if any. */
  const selectedNoteBounds = createMemo(() => {
    const hunkBounds = selectedEstimatedHunkBounds();
    const index = selectedFileIndex();
    if (!scrollToNote() || !hunkBounds || index < 0) {
      return null;
    }

    const geometry = sectionGeometry()[index];
    if (!geometry) {
      return null;
    }

    const sectionRelativeHunkTop = hunkBounds.top - hunkBounds.sectionTop;
    const sectionRelativeHunkBottom = sectionRelativeHunkTop + hunkBounds.height;
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
      top: hunkBounds.sectionTop + noteRow.top,
      height: noteRow.height,
    };
  });
  const selectedEstimatedHunkTop = () => selectedEstimatedHunkBounds()?.top ?? null;
  const selectedEstimatedHunkHeight = () => selectedEstimatedHunkBounds()?.height ?? null;
  const selectedEstimatedHunkStartRowId = () => selectedEstimatedHunkBounds()?.startRowId ?? null;
  const selectedEstimatedHunkEndRowId = () => selectedEstimatedHunkBounds()?.endRowId ?? null;
  const selectedNoteTop = () => selectedNoteBounds()?.top ?? null;
  const selectedNoteHeight = () => selectedNoteBounds()?.height ?? null;

  /** The bodyTop of the currently selected file's section layout, used to floor hunk reveal scroll targets so they never cross above the owning file boundary. */
  const selectedFileBodyTop = () => {
    const index = selectedFileIndex();
    return index >= 0 ? (fileSectionLayouts()[index]?.bodyTop ?? 0) : 0;
  };

  // Track the previous selected anchor to detect actual selection changes.
  const prevSelectedAnchorIdRef: { current: string | null } = { current: null };
  const prevPinnedHeaderFileIdRef: { current: string | null } = { current: null };
  const pendingSelectionSettleRef = { current: false };

  /** Clear any pending "selected file to top" follow-up. */
  const clearPendingFileTopAlign = () => {
    pendingFileTopAlignFileIdRef.current = null;
  };

  /** Scroll one file so it immediately owns the viewport top using the latest planned geometry. */
  const scrollFileHeaderToTop = (fileId: string) => {
    const targetSection = fileSectionLayouts().find((layout) => layout.fileId === fileId);
    if (!targetSection) {
      return false;
    }

    const scrollBox = merged.scrollRef.current;
    if (!scrollBox) {
      return false;
    }

    const viewportHeight = Math.max(scrollViewport().height, scrollBox.viewport.height ?? 0);

    // The pinned header owns the top row, so align the review stream to the file body. Clamp the
    // request so short trailing files can still settle cleanly at the reachable bottom edge.
    scrollBox.scrollTo(clampReviewScrollTop(targetSection.bodyTop, viewportHeight));
    return true;
  };

  // Restore the viewport anchor across layout/wrap/draft-note relayouts. Auto-tracks layout,
  // wrapLines, draftNote id, files, sectionGeometry, sectionHeaderHeights, scrollViewport.top,
  // layoutToggleRequestId, layoutToggleScrollTop, and wrapToggleScrollTop (matches former deps).
  createRenderEffect(() => {
    const layout = merged.layout;
    const wrapLines = merged.wrapLines;
    const layoutToggleRequestId = merged.layoutToggleRequestId;
    const layoutToggleScrollTop = merged.layoutToggleScrollTop;
    const wrapToggleScrollTop = merged.wrapToggleScrollTop;
    const currentFiles = files();
    const currentSectionGeometry = sectionGeometry();
    const currentSectionHeaderHeights = sectionHeaderHeights();
    const viewportTop = scrollViewport().top;

    const layoutChanged = previousLayoutRef.current !== layout;
    const explicitLayoutToggle = previousLayoutToggleRequestIdRef.current !== layoutToggleRequestId;
    const wrapChanged = previousWrapLinesRef.current !== wrapLines;
    const previousSectionMetrics = previousSectionGeometryRef.current;
    const previousFiles = previousFilesRef.current;
    const currentDraftNoteId = draftNote()?.id ?? null;
    const draftChanged = previousDraftNoteIdRef.current !== currentDraftNoteId;

    if (draftChanged && previousSectionMetrics && previousFiles.length > 0) {
      const previousScrollTop = merged.scrollRef.current?.scrollTop ?? viewportTop;
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
          currentFiles,
          currentSectionGeometry,
          anchor,
          currentSectionHeaderHeights,
        );
        const restoreViewportAnchor = () => {
          merged.scrollRef.current?.scrollTo(nextTop);
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
        previousSectionGeometryRef.current = currentSectionGeometry;
        previousFilesRef.current = currentFiles;

        onCleanup(() => {
          timeouts.forEach((timeout) => clearTimeout(timeout));
        });
        return;
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
            : (merged.scrollRef.current?.scrollTop ??
              Math.max(prevScrollTopRef.current, viewportTop));
      const anchor = findViewportRowAnchor(
        previousFiles,
        previousSectionMetrics,
        previousScrollTop,
        previousSectionHeaderHeights,
        lastViewportRowAnchorRef.current?.stableKey,
      );
      if (anchor) {
        const nextTop = resolveViewportRowAnchorTop(
          currentFiles,
          currentSectionGeometry,
          anchor,
          currentSectionHeaderHeights,
        );
        const restoreViewportAnchor = () => {
          merged.scrollRef.current?.scrollTo(nextTop);
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
        previousSectionGeometryRef.current = currentSectionGeometry;
        previousFilesRef.current = currentFiles;

        onCleanup(() => {
          timeouts.forEach((timeout) => clearTimeout(timeout));
        });
        return;
      }
    }

    previousDraftNoteIdRef.current = currentDraftNoteId;
    previousLayoutRef.current = layout;
    previousLayoutToggleRequestIdRef.current = layoutToggleRequestId;
    previousWrapLinesRef.current = wrapLines;
    previousSectionGeometryRef.current = currentSectionGeometry;
    previousFilesRef.current = currentFiles;
  });

  // Keep the row anchor tracking the live viewport top so later relayouts have a fresh anchor.
  createRenderEffect(() => {
    const currentFiles = files();
    const currentSectionGeometry = sectionGeometry();
    const currentSectionHeaderHeights = sectionHeaderHeights();
    const viewportTop = scrollViewport().top;

    if (currentFiles.length === 0) {
      lastViewportRowAnchorRef.current = null;
      return;
    }

    const currentScrollTop = merged.scrollRef.current?.scrollTop ?? viewportTop;
    const nextAnchor = findViewportRowAnchor(
      currentFiles,
      currentSectionGeometry,
      currentScrollTop,
      currentSectionHeaderHeights,
      lastViewportRowAnchorRef.current?.stableKey,
    );

    if (nextAnchor) {
      lastViewportRowAnchorRef.current = nextAnchor;
    }
  });

  // Sidebar navigation should make the selected file immediately own the viewport top. Auto-tracks
  // selectedFileTopAlignRequestId, selectedFileId, and selectedFileIndex (former deps).
  createRenderEffect(() => {
    const currentRequestId = selectedFileTopAlignRequestId();
    const currentSelectedFileId = selectedFileId();
    const index = selectedFileIndex();

    if (previousSelectedFileTopAlignRequestIdRef.current === currentRequestId) {
      return;
    }

    previousSelectedFileTopAlignRequestIdRef.current = currentRequestId;
    clearPendingFileTopAlign();

    if (!currentSelectedFileId || index < 0) {
      return;
    }

    suppressViewportSelectionSync();
    pendingFileTopAlignFileIdRef.current = currentSelectedFileId;
    scrollFileHeaderToTop(currentSelectedFileId);
  });

  // Re-settle a pending "selected file to top" request as geometry/viewport changes. Auto-tracks
  // files, fileSectionLayouts, scrollViewport (height/top) like the former deps array.
  createRenderEffect(() => {
    const currentFiles = files();
    const layouts = fileSectionLayouts();
    const viewport = scrollViewport();

    const pendingFileId = pendingFileTopAlignFileIdRef.current;
    if (!pendingFileId) {
      return;
    }

    // Stop retrying if the sidebar selection points at a file that disappeared mid-settle.
    const fileStillPresent = currentFiles.some((file) => file.id === pendingFileId);
    if (!fileStillPresent) {
      clearPendingFileTopAlign();
      return;
    }

    const targetSection = layouts.find((layout) => layout.fileId === pendingFileId);
    if (!targetSection) {
      return;
    }

    const viewportHeight = Math.max(
      viewport.height,
      merged.scrollRef.current?.viewport.height ?? 0,
    );
    // Compare against the reachable target, not the raw file body top. The last short file often
    // cannot actually own the viewport top near EOF, and treating that unreachable top as pending
    // would keep snapping manual upward scrolling back down to the bottom edge.
    const desiredTop = clampReviewScrollTop(targetSection.bodyTop, viewportHeight);

    const currentTop = merged.scrollRef.current?.scrollTop ?? viewport.top;
    if (Math.abs(currentTop - desiredTop) <= 0.5) {
      clearPendingFileTopAlign();
      return;
    }

    suppressViewportSelectionSync();
    scrollFileHeaderToTop(pendingFileId);
  });

  // Reveal the selected hunk/note. Auto-tracks the same reactive values the former useLayoutEffect
  // listed (selection ids, hunk/note bounds, pinned header, viewport height, reveal request id).
  createRenderEffect(() => {
    const currentSelectedAnchorId = selectedAnchorId();
    const currentHunkBounds = selectedEstimatedHunkBounds();
    const currentNoteBounds = selectedNoteBounds();
    const currentPinnedHeaderFileId = pinnedHeaderFileId();
    const index = selectedFileIndex();
    const hunkIndex = selectedHunkIndex();
    const fileBodyTop = selectedFileBodyTop();
    const viewportHeightSignal = scrollViewport().height;
    const revealRequestId = selectedHunkRevealRequestId();
    // Establish dependence on the derived bound accessors so this re-runs as they change.
    void selectedEstimatedHunkTop();
    void selectedEstimatedHunkHeight();
    void selectedEstimatedHunkStartRowId();
    void selectedEstimatedHunkEndRowId();
    void selectedNoteTop();
    void selectedNoteHeight();

    const revealFollowsSelectionChange = revealRequestId === undefined;
    const revealRequested = revealFollowsSelectionChange
      ? prevSelectedAnchorIdRef.current !== currentSelectedAnchorId
      : previousSelectedHunkRevealRequestIdRef.current !== revealRequestId;
    previousSelectedHunkRevealRequestIdRef.current = revealRequestId;

    if (!currentSelectedAnchorId && !currentHunkBounds) {
      prevSelectedAnchorIdRef.current = null;
      prevPinnedHeaderFileIdRef.current = currentPinnedHeaderFileId;
      pendingSelectionSettleRef.current = false;
      return;
    }

    const shouldTrackPinnedHeaderResettle =
      index > 0 || hunkIndex > 0 || currentNoteBounds !== null;
    const pinnedHeaderChangedWhileSettling =
      shouldTrackPinnedHeaderResettle &&
      pendingSelectionSettleRef.current &&
      prevPinnedHeaderFileIdRef.current !== currentPinnedHeaderFileId;
    prevSelectedAnchorIdRef.current = currentSelectedAnchorId;
    prevPinnedHeaderFileIdRef.current = currentPinnedHeaderFileId;

    if (!revealRequested && !pinnedHeaderChangedWhileSettling) {
      return;
    }

    const scrollSelectionIntoView = () => {
      const scrollBox = merged.scrollRef.current;
      if (!scrollBox) {
        return;
      }

      const viewportHeight = Math.max(viewportHeightSignal, scrollBox.viewport.height ?? 0);
      const preferredTopPadding = Math.max(2, Math.floor(viewportHeight * 0.25));

      // When navigating comment-to-comment, scroll the inline note card near the viewport top
      // instead of positioning the entire hunk. Clamp the reveal target too: notes in the final
      // hunk can request a top offset that is no longer reachable once the viewport hits EOF.
      // Using the reachable value keeps the reveal logic from fighting later manual scrolling.
      if (currentNoteBounds) {
        const revealScrollTop = computeHunkRevealScrollTop({
          hunkTop: currentNoteBounds.top,
          hunkHeight: currentNoteBounds.height,
          preferredTopPadding,
          viewportHeight,
        });
        // Floor against the owning file's body boundary so the viewport never crosses above it
        // and triggers a pinned-header flash.
        const flooredScrollTop = Math.max(revealScrollTop, fileBodyTop);
        scrollBox.scrollTo(clampReviewScrollTop(flooredScrollTop, viewportHeight));
        return;
      }

      if (currentHunkBounds) {
        const viewportTop = scrollBox.viewport.y;
        const currentScrollTop = scrollBox.scrollTop;
        const startRow = scrollBox.content.findDescendantById(currentHunkBounds.startRowId);
        const endRow = scrollBox.content.findDescendantById(currentHunkBounds.endRowId);

        // Prefer exact mounted bounds when both edges are available. If only one edge has mounted
        // so far, fall back to the planned bounds as one atomic estimate instead of mixing sources.
        // The final reveal target still gets clamped below so a bottom-edge hunk does not keep
        // re-requesting an impossible scrollTop after the selection settles.
        const renderedTop = startRow ? currentScrollTop + (startRow.y - viewportTop) : null;
        const renderedBottom = endRow
          ? currentScrollTop + (endRow.y + endRow.height - viewportTop)
          : null;
        const renderedBoundsReady = renderedTop !== null && renderedBottom !== null;
        const hunkTop = renderedBoundsReady ? renderedTop : currentHunkBounds.top;
        const hunkHeight = renderedBoundsReady
          ? Math.max(0, renderedBottom - renderedTop)
          : currentHunkBounds.height;

        const revealScrollTop = computeHunkRevealScrollTop({
          hunkTop,
          hunkHeight,
          preferredTopPadding,
          viewportHeight,
        });
        // Floor against the owning file's body boundary so the viewport never crosses above it
        // and triggers a pinned-header flash.
        const flooredScrollTop = Math.max(revealScrollTop, fileBodyTop);
        scrollBox.scrollTo(clampReviewScrollTop(flooredScrollTop, viewportHeight));
        return;
      }

      if (currentSelectedAnchorId) {
        scrollBox.scrollChildIntoView(currentSelectedAnchorId);
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
    onCleanup(() => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
      if (settleReset) {
        clearTimeout(settleReset);
      }
    });
  });

  // Keep keyboard step scrolling at exactly one row while wheel scrolling uses its own multiplier.
  createEffect(() => {
    const scrollBox = merged.scrollRef.current;
    if (scrollBox) {
      scrollBox.verticalScrollBar.scrollStep = 1;
    }
  });

  return (
    <box
      style={{
        width: merged.width,
        border: merged.pagerMode ? [] : ["top"],
        borderColor: merged.theme.border,
        backgroundColor: merged.theme.panel,
        paddingY: merged.pagerMode ? 0 : 1,
        paddingX: 0,
        flexDirection: "column",
      }}
      onMouseDragEnd={endCopySelection}
      onMouseUp={endCopySelection}
    >
      <Show
        when={files().length > 0}
        fallback={
          <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
            <text fg={merged.theme.muted}>No files match the current filter.</text>
          </box>
        }
      >
        <box style={{ width: "100%", height: "100%", flexGrow: 1, flexDirection: "column" }}>
          {/* Always pin the current file header in a dedicated top row. */}
          <Show when={pinnedHeaderFile()}>
            {(pinned) => (
              <box
                style={{ width: "100%", height: 1, minHeight: 1, flexShrink: 0 }}
                onMouseDown={beginCopySelection}
                onMouseDrag={updateCopySelection}
                onMouseDragEnd={endCopySelection}
                onMouseUp={endCopySelection}
              >
                <DiffFileHeaderRow
                  file={pinned()}
                  headerLabelWidth={merged.headerLabelWidth}
                  headerStatsWidth={merged.headerStatsWidth}
                  theme={merged.theme}
                  onSelect={() => merged.onSelectFile(pinned().id)}
                />
              </box>
            )}
          </Show>
          <box style={{ position: "relative", width: "100%", flexGrow: 1 }}>
            <scrollbox
              ref={(el) => (merged.scrollRef.current = el)}
              width="100%"
              height="100%"
              scrollY={true}
              viewportCulling={true}
              focused={merged.pagerMode}
              onMouseDown={beginCopySelection}
              onMouseDrag={updateCopySelection}
              onMouseDragEnd={endCopySelection}
              onMouseScroll={handleMouseScroll}
              onMouseUp={endCopySelection}
              scrollAcceleration={mouseWheelScrollAcceleration}
              rootOptions={{ backgroundColor: merged.theme.panel }}
              wrapperOptions={{ backgroundColor: merged.theme.panel }}
              viewportOptions={{ backgroundColor: merged.theme.panel }}
              contentOptions={{ backgroundColor: merged.theme.panel }}
              verticalScrollbarOptions={{ visible: false }}
              horizontalScrollbarOptions={{ visible: false }}
            >
              {/* Remount the diff content when width/layout/wrap mode changes so viewport culling
                  recomputes against the new row geometry, while the outer scrollbox keeps its
                  state. The keyed Show forces a fresh subtree on those changes. */}
              <Show
                when={`diff-content:${merged.layout}:${merged.wrapLines ? "wrap" : "nowrap"}:${merged.width}`}
                keyed
              >
                <box style={{ width: "100%", flexDirection: "column", overflow: "visible" }}>
                  <For each={fileRenderItems()}>
                    {(item) => (
                      <Switch>
                        {/* Spacer rows reserve the exact height of windowed-out files. */}
                        <Match when={item.kind === "spacer" ? item : null}>
                          {(spacer) => (
                            <box
                              style={{
                                width: "100%",
                                height: spacer().height,
                                backgroundColor: merged.theme.panel,
                              }}
                            />
                          )}
                        </Match>
                        <Match when={item.kind === "file" ? item : null}>
                          {(fileItem) => {
                            const index = () => fileItem().sectionIndex;
                            const file = () => files()[index()];
                            return (
                              <Show when={file()}>
                                {(presentFile) => (
                                  <DiffSection
                                    codeHorizontalOffset={merged.codeHorizontalOffset}
                                    expandedGapKeys={
                                      expandedGapsByFileId()[presentFile().id] ??
                                      EMPTY_EXPANDED_GAP_KEYS
                                    }
                                    file={presentFile()}
                                    headerLabelWidth={merged.headerLabelWidth}
                                    headerStatsWidth={merged.headerStatsWidth}
                                    layout={merged.layout}
                                    selectedHunkIndex={
                                      presentFile().id === selectedFileId()
                                        ? selectedHunkIndex()
                                        : -1
                                    }
                                    copySelectedRowRanges={copySelectedRowKeysByFile().get(
                                      presentFile().id,
                                    )}
                                    copySelectedSide={copySelectionSide()}
                                    shouldLoadHighlight={highlightPrefetchFileIds().has(
                                      presentFile().id,
                                    )}
                                    sectionGeometry={sectionGeometry()[index()]}
                                    separatorWidth={merged.separatorWidth}
                                    showHeader={shouldRenderInStreamFileHeader(index())}
                                    showSeparator={index() > 0}
                                    showLineNumbers={merged.showLineNumbers}
                                    showHunkHeaders={merged.showHunkHeaders}
                                    sourceStatus={sourceStatusByFileId()[presentFile().id]}
                                    wrapLines={merged.wrapLines}
                                    theme={merged.theme}
                                    hoverActive={
                                      hoveredFileId() === null ||
                                      hoveredFileId() === presentFile().id
                                    }
                                    hoverClearSignal={
                                      addNoteHoverClearFileId() === presentFile().id
                                        ? addNoteHoverClearSignal()
                                        : 0
                                    }
                                    viewWidth={merged.diffContentWidth}
                                    visibleAgentNotes={
                                      visibleAgentNotesByFile().get(presentFile().id) ??
                                      EMPTY_VISIBLE_AGENT_NOTES
                                    }
                                    visibleBodyBounds={visibleBodyBoundsByFile().get(
                                      presentFile().id,
                                    )}
                                    onHover={() => setHoveredFileForRowActions(presentFile().id)}
                                    onMouseScroll={clearAddNoteHoverForScroll}
                                    onActiveAddNoteAffordanceChange={
                                      merged.onActiveAddNoteAffordanceChange
                                        ? activeAddNoteAffordanceCallback(presentFile().id)
                                        : undefined
                                    }
                                    onStartUserNoteAtHunk={
                                      reserveAddNoteColumn()
                                        ? startUserNoteAtHunkCallback(presentFile().id)
                                        : undefined
                                    }
                                    onSelect={selectFileCallback(presentFile().id)}
                                    onToggleGap={(gapKey) =>
                                      merged.onToggleGap(presentFile().id, gapKey)
                                    }
                                  />
                                )}
                              </Show>
                            );
                          }}
                        </Match>
                      </Switch>
                    )}
                  </For>
                </box>
              </Show>
            </scrollbox>
            <VerticalScrollbar
              apiRef={(api) => (scrollbarRef.current = api)}
              scrollRef={merged.scrollRef}
              contentHeight={totalContentHeight()}
              height={scrollViewport().height}
              theme={merged.theme}
            />
          </box>
        </box>
      </Show>
    </box>
  );
}
