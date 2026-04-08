import { type MouseEvent as TuiMouseEvent, type ScrollBoxRenderable } from "@opentui/core";
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
import type { DiffFile, LayoutMode } from "../../../core/types";
import type { VisibleAgentNote } from "../../lib/agentAnnotations";
import { computeHunkRevealScrollTop } from "../../lib/hunkScroll";
import {
  measureDiffSectionGeometry,
  type DiffSectionGeometry,
} from "../../lib/diffSectionGeometry";
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
import { prefetchHighlightedDiff } from "../../diff/useHighlightedDiff";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

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

/** Render the main multi-file review stream. */
export function DiffPane({
  codeHorizontalOffset = 0,
  diffContentWidth,
  files,
  headerLabelWidth,
  headerStatsWidth,
  layout,
  scrollRef,
  selectedFileId,
  selectedHunkIndex,
  scrollToNote = false,
  separatorWidth,
  pagerMode = false,
  showAgentNotes,
  showLineNumbers,
  showHunkHeaders,
  wrapLines,
  wrapToggleScrollTop,
  layoutToggleScrollTop = null,
  layoutToggleRequestId = 0,
  selectedFileTopAlignRequestId = 0,
  selectedHunkRevealRequestId,
  theme,
  width,
  onOpenAgentNotesAtHunk,
  onScrollCodeHorizontally = () => {},
  onSelectFile,
  onViewportCenteredHunkChange,
}: {
  codeHorizontalOffset?: number;
  diffContentWidth: number;
  files: DiffFile[];
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  selectedFileId?: string;
  selectedHunkIndex: number;
  scrollToNote?: boolean;
  separatorWidth: number;
  pagerMode?: boolean;
  showAgentNotes: boolean;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  wrapToggleScrollTop: number | null;
  layoutToggleScrollTop?: number | null;
  layoutToggleRequestId?: number;
  selectedFileTopAlignRequestId?: number;
  selectedHunkRevealRequestId?: number;
  theme: AppTheme;
  width: number;
  onOpenAgentNotesAtHunk: (fileId: string, hunkIndex: number) => void;
  onScrollCodeHorizontally?: (delta: number) => void;
  onSelectFile: (fileId: string) => void;
  onViewportCenteredHunkChange?: (fileId: string, hunkIndex: number) => void;
}) {
  const renderer = useRenderer();

  const adjacentPrefetchFileIds = useMemo(
    () => buildAdjacentPrefetchFileIds(files, selectedFileId),
    [files, selectedFileId],
  );

  /** Route shifted wheel input into horizontal code-column scrolling without disturbing vertical review scroll. */
  const handleMouseScroll = useCallback(
    (event: TuiMouseEvent) => {
      const scrollBox = scrollRef.current;
      const direction = event.scroll?.direction;
      if (!direction || !scrollBox || wrapLines) {
        return;
      }

      const preservedScrollTop = scrollBox.scrollTop;
      const preservedScrollLeft = scrollBox.scrollLeft;

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

      // OpenTUI runs ScrollBox's own wheel handler after this listener and it does not honor
      // preventDefault(), so restore the pre-event viewport position on the next microtask.
      queueMicrotask(() => {
        const currentScrollBox = scrollRef.current;
        if (!currentScrollBox) {
          return;
        }

        currentScrollBox.scrollTo({ x: preservedScrollLeft, y: preservedScrollTop });
      });

      event.preventDefault();
      event.stopPropagation();
    },
    [onScrollCodeHorizontally, scrollRef, wrapLines],
  );

  const allAgentNotesByFile = useMemo(() => {
    const next = new Map<string, VisibleAgentNote[]>();

    if (!showAgentNotes) {
      return next;
    }

    files.forEach((file) => {
      const annotations = file.agent?.annotations ?? [];
      if (annotations.length === 0) {
        return;
      }

      next.set(
        file.id,
        annotations.map((annotation, index) => ({
          id: `annotation:${file.id}:${annotation.id ?? index}`,
          annotation,
        })),
      );
    });

    return next;
  }, [files, showAgentNotes]);

  // Keep exact row rendering for wrapped lines and the selected file's visible notes;
  // other files can still use placeholders and viewport windowing.
  const windowingEnabled = !wrapLines;
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });
  const scrollbarRef = useRef<VerticalScrollbarHandle>(null);
  const prevScrollTopRef = useRef(0);
  const previousSectionGeometryRef = useRef<DiffSectionGeometry[] | null>(null);
  const previousFilesRef = useRef<DiffFile[]>(files);
  const previousLayoutRef = useRef(layout);
  const previousWrapLinesRef = useRef(wrapLines);
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

    const updateViewport = () => {
      const nextTop = scrollBox.scrollTop ?? 0;
      const nextHeight = scrollBox.viewport.height ?? 0;

      // Detect scroll activity and show scrollbar.
      if (nextTop !== prevScrollTopRef.current) {
        scrollbarRef.current?.show();
        prevScrollTopRef.current = nextTop;
      }

      setScrollViewport((current) =>
        current.top === nextTop && current.height === nextHeight
          ? current
          : { top: nextTop, height: nextHeight },
      );
    };

    const handleViewportChange = () => {
      updateViewport();
    };

    updateViewport();
    scrollBox.verticalScrollBar.on("change", handleViewportChange);
    scrollBox.viewport.on("layout-changed", handleViewportChange);
    scrollBox.viewport.on("resized", handleViewportChange);

    return () => {
      scrollBox.verticalScrollBar.off("change", handleViewportChange);
      scrollBox.viewport.off("layout-changed", handleViewportChange);
      scrollBox.viewport.off("resized", handleViewportChange);
    };
  }, [files.length, scrollRef]);

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
        ),
      ),
    [diffContentWidth, files, layout, showHunkHeaders, showLineNumbers, theme, wrapLines],
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
    const overscanRows = 8;
    const minVisibleY = Math.max(0, scrollViewport.top - overscanRows);
    const maxVisibleY = scrollViewport.top + scrollViewport.height + overscanRows;
    return collectIntersectingFileSectionIds(baseFileSectionLayouts, minVisibleY, maxVisibleY);
  }, [baseFileSectionLayouts, scrollViewport.height, scrollViewport.top]);

  const visibleAgentNotesByFile = useMemo(() => {
    const next = new Map<string, VisibleAgentNote[]>();

    if (!showAgentNotes) {
      return next;
    }

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

  const sectionGeometry = useMemo(
    () =>
      files.map((file, index) => {
        const visibleNotes = visibleAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES;
        if (visibleNotes.length === 0) {
          return baseSectionGeometry[index]!;
        }

        return measureDiffSectionGeometry(
          file,
          layout,
          showHunkHeaders,
          theme,
          visibleNotes,
          diffContentWidth,
          showLineNumbers,
          wrapLines,
        );
      }),
    [
      baseSectionGeometry,
      diffContentWidth,
      files,
      layout,
      showHunkHeaders,
      showLineNumbers,
      theme,
      visibleAgentNotesByFile,
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

  // Read the live scroll box position during render so pinned-header ownership flips
  // immediately after imperative scrolls instead of waiting for the polled viewport snapshot.
  const effectiveScrollTop = scrollRef.current?.scrollTop ?? scrollViewport.top;

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

      // The pinned header owns the top row, so align the review stream to the file body.
      scrollBox.scrollTo(targetSection.bodyTop);
      return true;
    },
    [fileSectionLayouts, scrollRef],
  );

  useLayoutEffect(() => {
    const layoutChanged = previousLayoutRef.current !== layout;
    const explicitLayoutToggle = previousLayoutToggleRequestIdRef.current !== layoutToggleRequestId;
    const wrapChanged = previousWrapLinesRef.current !== wrapLines;
    const previousSectionMetrics = previousSectionGeometryRef.current;
    const previousFiles = previousFilesRef.current;

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

    previousLayoutRef.current = layout;
    previousLayoutToggleRequestIdRef.current = layoutToggleRequestId;
    previousWrapLinesRef.current = wrapLines;
    previousSectionGeometryRef.current = sectionGeometry;
    previousFilesRef.current = files;
  }, [
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

    const desiredTop = targetSection.bodyTop;

    const currentTop = scrollRef.current?.scrollTop ?? scrollViewport.top;
    if (Math.abs(currentTop - desiredTop) <= 0.5) {
      clearPendingFileTopAlign();
      return;
    }

    suppressViewportSelectionSync();
    scrollFileHeaderToTop(pendingFileId);
  }, [
    clearPendingFileTopAlign,
    fileSectionLayouts,
    files,
    scrollFileHeaderToTop,
    scrollRef,
    scrollViewport.top,
    suppressViewportSelectionSync,
  ]);

  useLayoutEffect(() => {
    const pinnedHeaderFileId = pinnedHeaderFile?.id ?? null;
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
      // instead of positioning the entire hunk. Uses the same reveal function so the padding
      // behavior matches regular hunk navigation.
      if (selectedNoteBounds) {
        scrollBox.scrollTo(
          computeHunkRevealScrollTop({
            hunkTop: selectedNoteBounds.top,
            hunkHeight: selectedNoteBounds.height,
            preferredTopPadding,
            viewportHeight,
          }),
        );
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
        const renderedTop = startRow ? currentScrollTop + (startRow.y - viewportTop) : null;
        const renderedBottom = endRow
          ? currentScrollTop + (endRow.y + endRow.height - viewportTop)
          : null;
        const renderedBoundsReady = renderedTop !== null && renderedBottom !== null;
        const hunkTop = renderedBoundsReady ? renderedTop : selectedEstimatedHunkBounds.top;
        const hunkHeight = renderedBoundsReady
          ? Math.max(0, renderedBottom - renderedTop)
          : selectedEstimatedHunkBounds.height;

        scrollBox.scrollTo(
          computeHunkRevealScrollTop({
            hunkTop,
            hunkHeight,
            preferredTopPadding,
            viewportHeight,
          }),
        );
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
    pinnedHeaderFile?.id,
    scrollRef,
    scrollViewport.height,
    selectedAnchorId,
    selectedEstimatedHunkBounds,
    selectedFileIndex,
    selectedHunkIndex,
    selectedHunkRevealRequestId,
    selectedNoteBounds,
    suppressViewportSelectionSync,
  ]);

  // Configure scroll step size to scroll exactly 1 line per step
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
    >
      {files.length > 0 ? (
        <box style={{ width: "100%", height: "100%", flexGrow: 1, flexDirection: "column" }}>
          {/* Always pin the current file header in a dedicated top row. */}
          {pinnedHeaderFile ? (
            <box style={{ width: "100%", height: 1, minHeight: 1, flexShrink: 0 }}>
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
              onMouseScroll={handleMouseScroll}
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
                      file={file}
                      headerLabelWidth={headerLabelWidth}
                      headerStatsWidth={headerStatsWidth}
                      layout={layout}
                      selectedHunkIndex={file.id === selectedFileId ? selectedHunkIndex : -1}
                      shouldLoadHighlight={highlightPrefetchFileIds.has(file.id)}
                      separatorWidth={separatorWidth}
                      showHeader={shouldRenderInStreamFileHeader(index)}
                      showSeparator={index > 0}
                      showLineNumbers={showLineNumbers}
                      showHunkHeaders={showHunkHeaders}
                      wrapLines={wrapLines}
                      theme={theme}
                      viewWidth={diffContentWidth}
                      visibleAgentNotes={
                        visibleAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES
                      }
                      onOpenAgentNotesAtHunk={(hunkIndex) =>
                        onOpenAgentNotesAtHunk(file.id, hunkIndex)
                      }
                      onSelect={() => onSelectFile(file.id)}
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
