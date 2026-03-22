import type { ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import type { AgentAnnotation, DiffFile, LayoutMode } from "../../../core/types";
import { AgentCard } from "./AgentCard";
import { annotationLocationLabel, type VisibleAgentNote } from "../../lib/agentAnnotations";
import { buildAgentPopoverContent, resolveAgentPopoverPlacement } from "../../lib/agentPopover";
import { estimateDiffBodyRows, estimateHunkAnchorRow } from "../../lib/sectionHeights";
import { diffHunkId, diffSectionId } from "../../lib/ids";
import type { AppTheme } from "../../themes";
import { DiffSection } from "./DiffSection";
import { DiffSectionPlaceholder } from "./DiffSectionPlaceholder";

const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

function maxLineNumber(file: DiffFile) {
  return Math.max(file.metadata.additionLines.length, file.metadata.deletionLines.length, 0);
}

function noteAnchorColumn(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  width: number,
  showLineNumbers: boolean,
  note: VisibleAgentNote,
) {
  if (layout === "split") {
    return note.annotation.oldRange && !note.annotation.newRange
      ? 1
      : Math.max(2, Math.floor(width * 0.58));
  }

  return showLineNumbers ? Math.max(2, String(maxLineNumber(file)).length + 4) : 2;
}

/** Render the main multi-file review stream. */
export function DiffPane({
  activeAnnotations,
  diffContentWidth,
  dismissedAgentNoteIds,
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
  onDismissAgentNote,
  onOpenAgentNotesAtHunk,
  onSelectFile,
}: {
  activeAnnotations: AgentAnnotation[];
  diffContentWidth: number;
  dismissedAgentNoteIds: string[];
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
  onDismissAgentNote: (id: string) => void;
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

    if (!showAgentNotes || !selectedFileId) {
      return next;
    }

    const dismissedIdSet = new Set(dismissedAgentNoteIds);
    const visibleNotes = activeAnnotations
      .map((annotation, index) => ({
        id: `annotation:${selectedFileId}:${selectedHunkIndex}:${index}`,
        annotation,
      }))
      .filter((note) => !dismissedIdSet.has(note.id));

    // Notes only render for the currently selected file/hunk so they stay spatially anchored.
    if (visibleNotes.length > 0) {
      next.set(selectedFileId, visibleNotes);
    }

    return next;
  }, [activeAnnotations, dismissedAgentNoteIds, selectedFileId, selectedHunkIndex, showAgentNotes]);

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

  const estimatedBodyHeights = useMemo(
    () => files.map((file) => estimateDiffBodyRows(file, layout, showHunkHeaders)),
    [files, layout, showHunkHeaders],
  );
  const selectedOverlayNote = useMemo(() => {
    if (!selectedFileId) {
      return null;
    }

    const selectedFileIndex = files.findIndex((file) => file.id === selectedFileId);
    if (selectedFileIndex < 0) {
      return null;
    }

    const selectedFile = files[selectedFileIndex]!;
    const visibleNotes = visibleAgentNotesByFile.get(selectedFileId) ?? EMPTY_VISIBLE_AGENT_NOTES;
    const note = visibleNotes[0];
    if (!note) {
      return null;
    }

    let sectionTop = 0;
    for (let index = 0; index < selectedFileIndex; index += 1) {
      sectionTop += (index > 0 ? 1 : 0) + 1 + (estimatedBodyHeights[index] ?? 0);
    }

    sectionTop += (selectedFileIndex > 0 ? 1 : 0) + 1;
    const anchorRowTop =
      sectionTop + estimateHunkAnchorRow(selectedFile, layout, showHunkHeaders, selectedHunkIndex);
    const anchorColumn = noteAnchorColumn(
      selectedFile,
      layout,
      diffContentWidth,
      showLineNumbers,
      note,
    );
    const noteWidth = Math.min(
      Math.max(34, Math.floor(diffContentWidth * 0.42)),
      Math.max(12, diffContentWidth - 2),
    );
    const locationLabel = annotationLocationLabel(selectedFile, note.annotation);
    const popover = buildAgentPopoverContent({
      summary: note.annotation.summary,
      rationale: note.annotation.rationale,
      locationLabel,
      noteIndex: 0,
      noteCount: visibleNotes.length,
      width: noteWidth,
    });

    const contentHeight = files.reduce(
      (total, file, index) => total + (index > 0 ? 1 : 0) + 1 + (estimatedBodyHeights[index] ?? 0),
      0,
    );
    const placement = resolveAgentPopoverPlacement({
      anchorColumn,
      anchorRowTop,
      anchorRowHeight: 1,
      contentHeight,
      noteHeight: popover.height,
      noteWidth,
      viewportWidth: diffContentWidth,
    });

    return {
      note,
      noteCount: visibleNotes.length,
      noteWidth,
      left: placement.left,
      top: placement.top,
      locationLabel,
    };
  }, [
    diffContentWidth,
    estimatedBodyHeights,
    files,
    layout,
    selectedFileId,
    selectedHunkIndex,
    showHunkHeaders,
    showLineNumbers,
    visibleAgentNotesByFile,
  ]);

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
    top += estimateHunkAnchorRow(selectedFile, layout, showHunkHeaders, selectedHunkIndex);
    return top;
  }, [
    estimatedBodyHeights,
    files,
    layout,
    selectedFile,
    selectedFileIndex,
    selectedHunkIndex,
    showHunkHeaders,
  ]);

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
          <box
            style={{
              width: "100%",
              flexDirection: "column",
              position: "relative",
              overflow: "visible",
            }}
          >
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
                  visibleAgentNotes={EMPTY_VISIBLE_AGENT_NOTES}
                  onDismissAgentNote={onDismissAgentNote}
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
            {selectedFileId && selectedOverlayNote ? (
              <box
                style={{
                  position: "absolute",
                  top: selectedOverlayNote.top,
                  left: selectedOverlayNote.left,
                  zIndex: 20,
                }}
              >
                <AgentCard
                  locationLabel={selectedOverlayNote.locationLabel}
                  noteCount={selectedOverlayNote.noteCount}
                  rationale={selectedOverlayNote.note.annotation.rationale}
                  summary={selectedOverlayNote.note.annotation.summary}
                  theme={theme}
                  width={selectedOverlayNote.noteWidth}
                  onClose={() => onDismissAgentNote(selectedOverlayNote.note.id)}
                />
              </box>
            ) : null}
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
