import { memo } from "react";
import type { DiffFile, LayoutMode } from "../../../core/types";
import { PierreDiffView } from "../../diff/PierreDiffView";
import { getAnnotatedHunkIndices, type VisibleAgentNote } from "../../lib/agentAnnotations";
import { diffSectionId } from "../../lib/ids";
import { fileLabel } from "../../lib/files";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";

interface DiffSectionProps {
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  selected: boolean;
  selectedHunkIndex: number;
  shouldLoadHighlight: boolean;
  onHighlightReady?: () => void;
  separatorWidth: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  showSeparator: boolean;
  theme: AppTheme;
  visibleAgentNotes: VisibleAgentNote[];
  viewWidth: number;
  onDismissAgentNote: (id: string) => void;
  onOpenAgentNotesAtHunk: (hunkIndex: number) => void;
  onSelect: () => void;
}

/** Render one file section in the main review stream. */
function DiffSectionComponent({
  file,
  headerLabelWidth,
  headerStatsWidth,
  layout,
  selected,
  selectedHunkIndex,
  shouldLoadHighlight,
  onHighlightReady,
  separatorWidth,
  showLineNumbers,
  showHunkHeaders,
  wrapLines,
  showSeparator,
  theme,
  visibleAgentNotes,
  viewWidth,
  onDismissAgentNote,
  onOpenAgentNotesAtHunk,
  onSelect,
}: DiffSectionProps) {
  const additionsText = `+${file.stats.additions}`;
  const deletionsText = `-${file.stats.deletions}`;
  const annotatedHunkIndices = getAnnotatedHunkIndices(file);

  return (
    <box
      id={diffSectionId(file.id)}
      style={{
        width: "100%",
        flexDirection: "column",
        backgroundColor: theme.panel,
        overflow: "visible",
      }}
    >
      {showSeparator ? (
        <box
          style={{
            width: "100%",
            height: 1,
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: theme.panel,
          }}
        >
          <text fg={theme.border}>{fitText("─".repeat(separatorWidth), separatorWidth)}</text>
        </box>
      ) : null}

      <box
        style={{
          width: "100%",
          height: 1,
          flexDirection: "row",
          justifyContent: "space-between",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: theme.panel,
        }}
        onMouseUp={onSelect}
      >
        {/* Clicking the file header jumps the main stream selection without collapsing to a single-file view. */}
        <text fg={theme.text}>{fitText(fileLabel(file), headerLabelWidth)}</text>
        <box
          style={{
            width: headerStatsWidth,
            height: 1,
            flexDirection: "row",
            justifyContent: "flex-end",
          }}
        >
          <text fg={theme.badgeAdded}>{additionsText}</text>
          <text fg={theme.muted}> </text>
          <text fg={theme.badgeRemoved}>{deletionsText}</text>
        </box>
      </box>

      <PierreDiffView
        file={file}
        layout={layout}
        showLineNumbers={showLineNumbers}
        showHunkHeaders={showHunkHeaders}
        wrapLines={wrapLines}
        theme={theme}
        width={viewWidth}
        annotatedHunkIndices={annotatedHunkIndices}
        visibleAgentNotes={visibleAgentNotes}
        onDismissAgentNote={onDismissAgentNote}
        onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
        onHighlightReady={onHighlightReady}
        selectedHunkIndex={selectedHunkIndex}
        shouldLoadHighlight={shouldLoadHighlight}
        // The parent review stream owns scrolling across files.
        scrollable={false}
      />
    </box>
  );
}

/** Memoize file sections so hunk navigation does not rerender the whole review stream. */
export const DiffSection = memo(DiffSectionComponent, (previous, next) => {
  // This comparator relies on stable upstream object identity for files and visible-note arrays.
  return (
    previous.file === next.file &&
    previous.headerLabelWidth === next.headerLabelWidth &&
    previous.headerStatsWidth === next.headerStatsWidth &&
    previous.layout === next.layout &&
    previous.selected === next.selected &&
    previous.selectedHunkIndex === next.selectedHunkIndex &&
    previous.shouldLoadHighlight === next.shouldLoadHighlight &&
    previous.separatorWidth === next.separatorWidth &&
    previous.showLineNumbers === next.showLineNumbers &&
    previous.showHunkHeaders === next.showHunkHeaders &&
    previous.wrapLines === next.wrapLines &&
    previous.showSeparator === next.showSeparator &&
    previous.theme === next.theme &&
    previous.visibleAgentNotes === next.visibleAgentNotes &&
    previous.viewWidth === next.viewWidth
  );
});
