import type { ScrollBoxRenderable } from "@opentui/core";
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
  type DiffSectionRowBounds,
} from "../../lib/diffSectionGeometry";
import {
  buildFileSectionLayouts,
  buildInStreamFileHeaderHeights,
  findHeaderOwningFileSection,
  shouldRenderInStreamFileHeader,
} from "../../lib/fileSectionLayout";
import { diffHunkId, diffSectionId } from "../../lib/ids";
import type { AppTheme } from "../../themes";
import { DiffSection } from "./DiffSection";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";
import { DiffSectionPlaceholder } from "./DiffSectionPlaceholder";
import { VerticalScrollbar, type VerticalScrollbarHandle } from "../scrollbar/VerticalScrollbar";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

/** Identify the rendered diff row that currently owns the top of the viewport. */
interface ViewportRowAnchor {
  fileId: string;
  rowKey: string;
  rowOffsetWithin: number;
}

/** Find the rendered row bounds covering a vertical offset within one file body. */
function binarySearchRowBounds(sectionRowBounds: DiffSectionRowBounds[], relativeTop: number) {
  let low = 0;
  let high = sectionRowBounds.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const rowBounds = sectionRowBounds[mid]!;

    if (relativeTop < rowBounds.top) {
      high = mid - 1;
    } else if (relativeTop >= rowBounds.top + rowBounds.height) {
      low = mid + 1;
    } else {
      return rowBounds;
    }
  }

  return undefined;
}

/** Capture a stable top-row anchor from the pre-toggle layout so it can be restored later. */
function findViewportRowAnchor(
  files: DiffFile[],
  sectionGeometry: DiffSectionGeometry[],
  scrollTop: number,
  headerHeights: number[],
) {
  const fileSectionLayouts = buildFileSectionLayouts(
    files,
    sectionGeometry.map((metrics) => metrics?.bodyHeight ?? 0),
    headerHeights,
  );

  for (let index = 0; index < files.length; index += 1) {
    const sectionLayout = fileSectionLayouts[index];
    const bodyTop = sectionLayout?.bodyTop ?? 0;
    const geometry = sectionGeometry[index];
    const bodyHeight = geometry?.bodyHeight ?? 0;
    const relativeTop = scrollTop - bodyTop;

    if (relativeTop >= 0 && relativeTop < bodyHeight && geometry) {
      const rowBounds = binarySearchRowBounds(geometry.rowBounds, relativeTop);
      if (rowBounds) {
        return {
          fileId: files[index]!.id,
          rowKey: rowBounds.key,
          rowOffsetWithin: relativeTop - rowBounds.top,
        } satisfies ViewportRowAnchor;
      }
    }
  }

  return null;
}

/** Resolve a captured row anchor into its new scrollTop after wrapping or layout changes. */
function resolveViewportRowAnchorTop(
  files: DiffFile[],
  sectionGeometry: DiffSectionGeometry[],
  anchor: ViewportRowAnchor,
  headerHeights: number[],
) {
  const fileSectionLayouts = buildFileSectionLayouts(
    files,
    sectionGeometry.map((metrics) => metrics?.bodyHeight ?? 0),
    headerHeights,
  );

  for (let index = 0; index < files.length; index += 1) {
    const sectionLayout = fileSectionLayouts[index];
    const bodyTop = sectionLayout?.bodyTop ?? 0;
    const file = files[index];
    const geometry = sectionGeometry[index];
    if (file?.id === anchor.fileId && geometry) {
      const rowBounds = geometry.rowBoundsByKey.get(anchor.rowKey);
      if (rowBounds) {
        return bodyTop + rowBounds.top + Math.min(anchor.rowOffsetWithin, rowBounds.height - 1);
      }
      return bodyTop;
    }
  }

  return 0;
}

/** Render the main multi-file review stream. */
export function DiffPane({
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
  selectedFileTopAlignRequestId = 0,
  theme,
  width,
  onOpenAgentNotesAtHunk,
  onSelectFile,
}: {
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
  selectedFileTopAlignRequestId?: number;
  theme: AppTheme;
  width: number;
  onOpenAgentNotesAtHunk: (fileId: string, hunkIndex: number) => void;
  onSelectFile: (fileId: string) => void;
}) {
  const renderer = useRenderer();
  const [prefetchAnchorKey, setPrefetchAnchorKey] = useState<string | null>(null);
  const selectedHighlightKey = selectedFileId ? `${theme.appearance}:${selectedFileId}` : null;

  useEffect(() => {
    setPrefetchAnchorKey(null);
  }, [selectedHighlightKey]);

  // Hold background prefetches until the currently selected file has painted once.
  const adjacentPrefetchFileIds = useMemo(() => {
    if (!selectedHighlightKey || prefetchAnchorKey !== selectedHighlightKey || !selectedFileId) {
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
  }, [files, prefetchAnchorKey, selectedFileId, selectedHighlightKey]);

  const handleSelectedHighlightReady = useCallback(() => {
    if (!selectedHighlightKey) {
      return;
    }

    setPrefetchAnchorKey((current) => current ?? selectedHighlightKey);
  }, [selectedHighlightKey]);

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
  const previousWrapLinesRef = useRef(wrapLines);
  const previousSelectedFileTopAlignRequestIdRef = useRef(selectedFileTopAlignRequestId);
  const suppressNextSelectionAutoScrollRef = useRef(false);
  const pendingFileTopAlignFileIdRef = useRef<string | null>(null);

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
    return new Set(
      baseFileSectionLayouts
        .filter((metric) => metric.sectionBottom >= minVisibleY && metric.sectionTop <= maxVisibleY)
        .map((metric) => metric.fileId),
    );
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
    const wrapChanged = previousWrapLinesRef.current !== wrapLines;
    const previousSectionMetrics = previousSectionGeometryRef.current;
    const previousFiles = previousFilesRef.current;
    const previousSectionHeaderHeights = buildInStreamFileHeaderHeights(previousFiles);

    if (wrapChanged && previousSectionMetrics && previousFiles.length > 0) {
      const previousScrollTop =
        // Prefer the synchronously captured pre-toggle position so anchor restoration does not
        // race the polling-based viewport snapshot.
        wrapToggleScrollTop != null
          ? wrapToggleScrollTop
          : Math.max(prevScrollTopRef.current, scrollViewport.top);
      const anchor = findViewportRowAnchor(
        previousFiles,
        previousSectionMetrics,
        previousScrollTop,
        previousSectionHeaderHeights,
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

        restoreViewportAnchor();
        // The wrap-toggle anchor restore should win over the usual selection-following behavior.
        suppressNextSelectionAutoScrollRef.current = true;
        // Retry across a couple of repaint cycles so the restored top-row anchor sticks
        // after wrapped row heights and viewport culling settle.
        const retryDelays = [0, 16, 48];
        const timeouts = retryDelays.map((delay) => setTimeout(restoreViewportAnchor, delay));

        previousWrapLinesRef.current = wrapLines;
        previousSectionGeometryRef.current = sectionGeometry;
        previousFilesRef.current = files;

        return () => {
          timeouts.forEach((timeout) => clearTimeout(timeout));
        };
      }
    }

    previousWrapLinesRef.current = wrapLines;
    previousSectionGeometryRef.current = sectionGeometry;
    previousFilesRef.current = files;
  }, [
    files,
    scrollRef,
    scrollViewport.top,
    sectionGeometry,
    sectionHeaderHeights,
    wrapLines,
    wrapToggleScrollTop,
  ]);

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
    suppressNextSelectionAutoScrollRef.current = true;
    pendingFileTopAlignFileIdRef.current = selectedFileId;
    scrollFileHeaderToTop(selectedFileId);
  }, [
    clearPendingFileTopAlign,
    scrollFileHeaderToTop,
    selectedFileTopAlignRequestId,
    selectedFileId,
    selectedFileIndex,
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

    scrollFileHeaderToTop(pendingFileId);
  }, [
    clearPendingFileTopAlign,
    fileSectionLayouts,
    files,
    scrollFileHeaderToTop,
    scrollRef,
    scrollViewport.top,
  ]);

  useLayoutEffect(() => {
    const pinnedHeaderFileId = pinnedHeaderFile?.id ?? null;

    if (suppressNextSelectionAutoScrollRef.current) {
      suppressNextSelectionAutoScrollRef.current = false;
      // Consume this selection transition so the next render does not re-center the selected hunk.
      prevSelectedAnchorIdRef.current = selectedAnchorId;
      prevPinnedHeaderFileIdRef.current = pinnedHeaderFileId;
      pendingSelectionSettleRef.current = false;
      return;
    }

    if (!selectedAnchorId && !selectedEstimatedHunkBounds) {
      prevSelectedAnchorIdRef.current = null;
      prevPinnedHeaderFileIdRef.current = pinnedHeaderFileId;
      pendingSelectionSettleRef.current = false;
      return;
    }

    const shouldTrackPinnedHeaderResettle =
      selectedFileIndex > 0 || selectedHunkIndex > 0 || selectedNoteBounds !== null;

    // Only auto-scroll when the selection actually changes, not when geometry updates during
    // scrolling or when the selected section refines its measured bounds. One exception: after a
    // programmatic jump to a later file/hunk, rerun the settle scroll once if the pinned header
    // hands off to a different file while the selected content is still settling.
    const isSelectionChange = prevSelectedAnchorIdRef.current !== selectedAnchorId;
    const pinnedHeaderChangedWhileSettling =
      shouldTrackPinnedHeaderResettle &&
      pendingSelectionSettleRef.current &&
      prevPinnedHeaderFileIdRef.current !== pinnedHeaderFileId;
    prevSelectedAnchorIdRef.current = selectedAnchorId;
    prevPinnedHeaderFileIdRef.current = pinnedHeaderFileId;

    if (!isSelectionChange && !pinnedHeaderChangedWhileSettling) {
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
    scrollRef,
    scrollViewport.height,
    selectedAnchorId,
    selectedEstimatedHunkBounds,
    selectedFileIndex,
    selectedHunkIndex,
    selectedNoteBounds,
    pinnedHeaderFile?.id,
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
                  const shouldPrefetchVisibleHighlight =
                    Boolean(selectedHighlightKey) &&
                    prefetchAnchorKey === selectedHighlightKey &&
                    visibleViewportFileIds.has(file.id);

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
                      file={file}
                      headerLabelWidth={headerLabelWidth}
                      headerStatsWidth={headerStatsWidth}
                      layout={layout}
                      selectedHunkIndex={file.id === selectedFileId ? selectedHunkIndex : -1}
                      shouldLoadHighlight={
                        file.id === selectedFileId ||
                        adjacentPrefetchFileIds.has(file.id) ||
                        shouldPrefetchVisibleHighlight
                      }
                      onHighlightReady={
                        file.id === selectedFileId ? handleSelectedHighlightReady : undefined
                      }
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
