import type { ScrollBoxRenderable } from "@opentui/core";
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
  measureDiffSectionMetrics,
  type DiffSectionMetrics,
  type DiffSectionRowMetric,
} from "../../lib/sectionHeights";
import {
  buildSectionLayoutMetrics,
  findHeaderOwningSection,
  resolveFileHeaderTop,
} from "../../lib/sectionLayout";
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

/** Find the rendered row metric covering a vertical offset within one file body. */
function binarySearchRowMetric(rowMetrics: DiffSectionRowMetric[], relativeTop: number) {
  let low = 0;
  let high = rowMetrics.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const rowMetric = rowMetrics[mid]!;

    if (relativeTop < rowMetric.offset) {
      high = mid - 1;
    } else if (relativeTop >= rowMetric.offset + rowMetric.height) {
      low = mid + 1;
    } else {
      return rowMetric;
    }
  }

  return undefined;
}

/** Capture a stable top-row anchor from the pre-toggle layout so it can be restored later. */
function findViewportRowAnchor(
  files: DiffFile[],
  sectionMetrics: DiffSectionMetrics[],
  scrollTop: number,
) {
  const sectionLayoutMetrics = buildSectionLayoutMetrics(
    files,
    sectionMetrics.map((metrics) => metrics?.bodyHeight ?? 0),
  );

  for (let index = 0; index < files.length; index += 1) {
    const layoutMetric = sectionLayoutMetrics[index];
    const bodyTop = layoutMetric?.bodyTop ?? 0;
    const metrics = sectionMetrics[index];
    const bodyHeight = metrics?.bodyHeight ?? 0;
    const relativeTop = scrollTop - bodyTop;

    if (relativeTop >= 0 && relativeTop < bodyHeight && metrics) {
      const rowMetric = binarySearchRowMetric(metrics.rowMetrics, relativeTop);
      if (rowMetric) {
        return {
          fileId: files[index]!.id,
          rowKey: rowMetric.key,
          rowOffsetWithin: relativeTop - rowMetric.offset,
        } satisfies ViewportRowAnchor;
      }
    }
  }

  return null;
}

/** Resolve a captured row anchor into its new scrollTop after wrapping/layout metrics change. */
function resolveViewportRowAnchorTop(
  files: DiffFile[],
  sectionMetrics: DiffSectionMetrics[],
  anchor: ViewportRowAnchor,
) {
  const sectionLayoutMetrics = buildSectionLayoutMetrics(
    files,
    sectionMetrics.map((metrics) => metrics?.bodyHeight ?? 0),
  );

  for (let index = 0; index < files.length; index += 1) {
    const layoutMetric = sectionLayoutMetrics[index];
    const bodyTop = layoutMetric?.bodyTop ?? 0;
    const file = files[index];
    const metrics = sectionMetrics[index];
    if (file?.id === anchor.fileId && metrics) {
      const rowMetric = metrics.rowMetricsByKey.get(anchor.rowKey);
      if (rowMetric) {
        return bodyTop + rowMetric.offset + Math.min(anchor.rowOffsetWithin, rowMetric.height - 1);
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
  const previousSectionMetricsRef = useRef<DiffSectionMetrics[] | null>(null);
  const previousFilesRef = useRef<DiffFile[]>(files);
  const previousWrapLinesRef = useRef(wrapLines);
  const previousSelectedFileTopAlignRequestIdRef = useRef(selectedFileTopAlignRequestId);
  const suppressNextSelectionAutoScrollRef = useRef(false);
  const pendingFileTopAlignFileIdRef = useRef<string | null>(null);

  useEffect(() => {
    const updateViewport = () => {
      const nextTop = scrollRef.current?.scrollTop ?? 0;
      const nextHeight = scrollRef.current?.viewport.height ?? 0;

      // Detect scroll activity and show scrollbar
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

    updateViewport();
    const interval = setInterval(updateViewport, 50);
    return () => clearInterval(interval);
  }, [scrollRef]);

  const baseSectionMetrics = useMemo(
    () =>
      files.map((file) =>
        measureDiffSectionMetrics(
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
    () => baseSectionMetrics.map((metrics) => metrics.bodyHeight),
    [baseSectionMetrics],
  );
  const baseSectionLayoutMetrics = useMemo(
    () => buildSectionLayoutMetrics(files, baseEstimatedBodyHeights),
    [baseEstimatedBodyHeights, files],
  );

  const visibleViewportFileIds = useMemo(() => {
    const overscanRows = 8;
    const minVisibleY = Math.max(0, scrollViewport.top - overscanRows);
    const maxVisibleY = scrollViewport.top + scrollViewport.height + overscanRows;
    return new Set(
      baseSectionLayoutMetrics
        .filter((metric) => metric.sectionBottom >= minVisibleY && metric.sectionTop <= maxVisibleY)
        .map((metric) => metric.fileId),
    );
  }, [baseSectionLayoutMetrics, scrollViewport.height, scrollViewport.top]);

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

  const sectionMetrics = useMemo(
    () =>
      files.map((file, index) => {
        const visibleNotes = visibleAgentNotesByFile.get(file.id) ?? EMPTY_VISIBLE_AGENT_NOTES;
        if (visibleNotes.length === 0) {
          return baseSectionMetrics[index]!;
        }

        return measureDiffSectionMetrics(
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
      baseSectionMetrics,
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
    () => sectionMetrics.map((metrics) => metrics.bodyHeight),
    [sectionMetrics],
  );
  const sectionLayoutMetrics = useMemo(
    () => buildSectionLayoutMetrics(files, estimatedBodyHeights),
    [estimatedBodyHeights, files],
  );
  // Read the live scroll box position during render so sticky-header ownership flips
  // immediately after imperative scrolls instead of waiting for the polled viewport snapshot.
  const effectiveScrollTop = scrollRef.current?.scrollTop ?? scrollViewport.top;

  const totalContentHeight =
    sectionLayoutMetrics[sectionLayoutMetrics.length - 1]?.sectionBottom ?? 0;

  const stickyHeaderFile = useMemo(() => {
    if (files.length < 2) {
      return null;
    }

    const owner = findHeaderOwningSection(sectionLayoutMetrics, effectiveScrollTop);
    if (!owner || effectiveScrollTop <= owner.headerTop) {
      return null;
    }

    return files[owner.sectionIndex] ?? null;
  }, [effectiveScrollTop, files, sectionLayoutMetrics]);

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

    const selectedSectionLayout = sectionLayoutMetrics[selectedFileIndex];
    if (!selectedSectionLayout) {
      return null;
    }

    const clampedHunkIndex = Math.max(
      0,
      Math.min(selectedHunkIndex, selectedFile.metadata.hunks.length - 1),
    );
    const hunkBounds = sectionMetrics[selectedFileIndex]?.hunkBounds.get(clampedHunkIndex);
    if (!hunkBounds) {
      return null;
    }

    return {
      top: selectedSectionLayout.bodyTop + hunkBounds.top,
      height: hunkBounds.height,
      startRowId: hunkBounds.startRowId,
      endRowId: hunkBounds.endRowId,
      sectionTop: selectedSectionLayout.sectionTop,
    };
  }, [sectionLayoutMetrics, sectionMetrics, selectedFile, selectedFileIndex, selectedHunkIndex]);

  /** Absolute scroll offset and height of the first inline note in the selected hunk, if any. */
  const selectedNoteBounds = useMemo(() => {
    if (!scrollToNote || !selectedEstimatedHunkBounds || selectedFileIndex < 0) {
      return null;
    }

    const metrics = sectionMetrics[selectedFileIndex];
    if (!metrics) {
      return null;
    }

    const sectionRelativeHunkTop =
      selectedEstimatedHunkBounds.top - selectedEstimatedHunkBounds.sectionTop;
    const sectionRelativeHunkBottom = sectionRelativeHunkTop + selectedEstimatedHunkBounds.height;
    const noteRow = metrics.rowMetrics.find(
      (row) =>
        row.key.startsWith("inline-note:") &&
        row.offset >= sectionRelativeHunkTop &&
        row.offset < sectionRelativeHunkBottom,
    );

    if (!noteRow) {
      return null;
    }

    return {
      top: selectedEstimatedHunkBounds.sectionTop + noteRow.offset,
      height: noteRow.height,
    };
  }, [scrollToNote, sectionMetrics, selectedEstimatedHunkBounds, selectedFileIndex]);

  // Track the previous selected anchor to detect actual selection changes.
  const prevSelectedAnchorIdRef = useRef<string | null>(null);

  /** Clear any pending "selected file to top" follow-up. */
  const clearPendingFileTopAlign = useCallback(() => {
    pendingFileTopAlignFileIdRef.current = null;
  }, []);

  /** Scroll one file header to the top using the latest planned section geometry. */
  const scrollFileHeaderToTop = useCallback(
    (fileId: string) => {
      const headerTop = resolveFileHeaderTop(sectionLayoutMetrics, fileId);
      if (headerTop == null) {
        return false;
      }

      const scrollBox = scrollRef.current;
      if (!scrollBox) {
        return false;
      }

      scrollBox.scrollTo(headerTop);
      return true;
    },
    [scrollRef, sectionLayoutMetrics],
  );

  useLayoutEffect(() => {
    const wrapChanged = previousWrapLinesRef.current !== wrapLines;
    const previousSectionMetrics = previousSectionMetricsRef.current;
    const previousFiles = previousFilesRef.current;

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
      );
      if (anchor) {
        const nextTop = resolveViewportRowAnchorTop(files, sectionMetrics, anchor);
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
        previousSectionMetricsRef.current = sectionMetrics;
        previousFilesRef.current = files;

        return () => {
          timeouts.forEach((timeout) => clearTimeout(timeout));
        };
      }
    }

    previousWrapLinesRef.current = wrapLines;
    previousSectionMetricsRef.current = sectionMetrics;
    previousFilesRef.current = files;
  }, [files, scrollRef, scrollViewport.top, sectionMetrics, wrapLines, wrapToggleScrollTop]);

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

    if (scrollFileHeaderToTop(pendingFileId)) {
      clearPendingFileTopAlign();
    }
  }, [clearPendingFileTopAlign, files, scrollFileHeaderToTop, sectionLayoutMetrics]);

  useLayoutEffect(() => {
    if (suppressNextSelectionAutoScrollRef.current) {
      suppressNextSelectionAutoScrollRef.current = false;
      // Consume this selection transition so the next render does not re-center the selected hunk.
      prevSelectedAnchorIdRef.current = selectedAnchorId;
      return;
    }

    if (!selectedAnchorId && !selectedEstimatedHunkBounds) {
      prevSelectedAnchorIdRef.current = null;
      return;
    }

    // Only auto-scroll when the selection actually changes, not when metrics update during
    // scrolling or when the selected section refines its measured bounds.
    const isSelectionChange = prevSelectedAnchorIdRef.current !== selectedAnchorId;
    prevSelectedAnchorIdRef.current = selectedAnchorId;

    if (!isSelectionChange) {
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
    const retryDelays = [0, 16, 48];
    const timeouts = retryDelays.map((delay) => setTimeout(scrollSelectionIntoView, delay));
    return () => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
    };
  }, [
    scrollRef,
    scrollViewport.height,
    selectedAnchorId,
    selectedEstimatedHunkBounds,
    selectedNoteBounds,
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
          {/* Keep the current file header visible once its real header has scrolled offscreen. */}
          {stickyHeaderFile ? (
            <box style={{ width: "100%", height: 1, minHeight: 1, flexShrink: 0 }}>
              <DiffFileHeaderRow
                file={stickyHeaderFile}
                headerLabelWidth={headerLabelWidth}
                headerStatsWidth={headerStatsWidth}
                theme={theme}
                onSelect={() => onSelectFile(stickyHeaderFile.id)}
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
                  // section geometry so scroll math and sticky-header ownership stay stable.
                  if (!shouldRenderSection) {
                    return (
                      <DiffSectionPlaceholder
                        key={file.id}
                        bodyHeight={estimatedBodyHeights[index] ?? 0}
                        file={file}
                        headerLabelWidth={headerLabelWidth}
                        headerStatsWidth={headerStatsWidth}
                        separatorWidth={separatorWidth}
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
                      selected={file.id === selectedFileId}
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
