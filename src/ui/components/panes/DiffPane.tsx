import type { ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import type { DiffFile, LayoutMode } from "../../../core/types";
import type { VisibleAgentNote } from "../../lib/agentAnnotations";
import { measureDiffSectionMetrics } from "../../lib/sectionHeights";
import { diffHunkId, diffSectionId } from "../../lib/ids";
import type { AppTheme } from "../../themes";
import { DiffSection } from "./DiffSection";
import { DiffSectionPlaceholder } from "./DiffSectionPlaceholder";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

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
  separatorWidth,
  pagerMode = false,
  showAgentNotes,
  showLineNumbers,
  showHunkHeaders,
  wrapLines,
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
  separatorWidth: number;
  pagerMode?: boolean;
  showAgentNotes: boolean;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
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

  const visibleAgentNotesByFile = useMemo(() => {
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

  // Keep exact row rendering for wrapped lines and visible notes; otherwise reserve
  // offscreen section height and only materialize rows near the viewport.
  const windowingEnabled = !wrapLines && visibleAgentNotesByFile.size === 0;
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });

  useEffect(() => {
    const updateViewport = () => {
      const nextTop = scrollRef.current?.scrollTop ?? 0;
      const nextHeight = scrollRef.current?.viewport.height ?? 0;

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

  const sectionMetrics = useMemo(
    () => files.map((file) => measureDiffSectionMetrics(file, layout, showHunkHeaders, theme)),
    [files, layout, showHunkHeaders, theme],
  );
  const estimatedBodyHeights = useMemo(
    () => sectionMetrics.map((metrics) => metrics.bodyHeight),
    [sectionMetrics],
  );

  const visibleViewportFileIds = useMemo(() => {
    const overscanRows = 8;
    const minVisibleY = Math.max(0, scrollViewport.top - overscanRows);
    const maxVisibleY = scrollViewport.top + scrollViewport.height + overscanRows;
    let offsetY = 0;
    const next = new Set<string>();

    files.forEach((file, index) => {
      const sectionHeight = (index > 0 ? 1 : 0) + 1 + (estimatedBodyHeights[index] ?? 0);
      const sectionStart = offsetY;
      const sectionEnd = sectionStart + sectionHeight;

      if (sectionEnd >= minVisibleY && sectionStart <= maxVisibleY) {
        next.add(file.id);
      }

      offsetY = sectionEnd;
    });

    return next;
  }, [estimatedBodyHeights, files, scrollViewport.height, scrollViewport.top]);

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
  const selectedEstimatedScrollTop = useMemo(() => {
    if (!selectedFile || selectedFileIndex < 0) {
      return null;
    }

    let top = 0;
    for (let index = 0; index < selectedFileIndex; index += 1) {
      top += (index > 0 ? 1 : 0) + 1 + (estimatedBodyHeights[index] ?? 0);
    }

    if (selectedFileIndex > 0) {
      top += 1;
    }

    top += 1;

    if (selectedFile.metadata.hunks.length > 0) {
      const clampedHunkIndex = Math.max(
        0,
        Math.min(selectedHunkIndex, selectedFile.metadata.hunks.length - 1),
      );
      top += sectionMetrics[selectedFileIndex]?.hunkAnchorRows.get(clampedHunkIndex) ?? 0;
    }

    return top;
  }, [estimatedBodyHeights, sectionMetrics, selectedFile, selectedFileIndex, selectedHunkIndex]);

  useLayoutEffect(() => {
    if (!selectedAnchorId) {
      return;
    }

    const scrollSelectionIntoView = () => {
      const scrollBox = scrollRef.current;
      if (!scrollBox) {
        return;
      }

      // In the common no-wrap/no-note path we can estimate the selected hunk row and keep it
      // comfortably below the top edge instead of merely making it barely visible.
      if (!wrapLines && visibleAgentNotesByFile.size === 0 && selectedEstimatedScrollTop !== null) {
        const topPaddingRows = Math.max(2, Math.floor(scrollViewport.height * 0.25));
        scrollBox.scrollTo(Math.max(0, selectedEstimatedScrollTop - topPaddingRows));
        return;
      }

      scrollBox.scrollChildIntoView(selectedAnchorId);
    };

    // Run after this pane renders the selected section/hunk, then retry briefly while layout settles.
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
    selectedEstimatedScrollTop,
    visibleAgentNotesByFile.size,
    wrapLines,
  ]);

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
          <box style={{ width: "100%", flexDirection: "column", overflow: "visible" }}>
            {files.map((file, index) => {
              const shouldRenderSection = visibleWindowedFileIds?.has(file.id) ?? true;
              const shouldPrefetchVisibleHighlight =
                Boolean(selectedHighlightKey) &&
                prefetchAnchorKey === selectedHighlightKey &&
                visibleViewportFileIds.has(file.id);

              return shouldRenderSection ? (
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
                  onOpenAgentNotesAtHunk={(hunkIndex) => onOpenAgentNotesAtHunk(file.id, hunkIndex)}
                  onSelect={() => onSelectFile(file.id)}
                />
              ) : (
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
            })}
          </box>
        </scrollbox>
      ) : (
        <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
          <text fg={theme.muted}>No files match the current filter.</text>
        </box>
      )}
    </box>
  );
}
