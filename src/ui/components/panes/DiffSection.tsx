import { memo } from "react";
import type { DiffFile, LayoutMode } from "../../../core/types";
import { PierreDiffView } from "../../diff/PierreDiffView";
import { getAnnotatedHunkIndices, type VisibleAgentNote } from "../../lib/agentAnnotations";
import { diffSectionId } from "../../lib/ids";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";

interface DiffSectionProps {
  codeHorizontalOffset: number;
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  selectedHunkIndex: number;
  shouldLoadHighlight: boolean;
  separatorWidth: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  showHeader: boolean;
  showSeparator: boolean;
  theme: AppTheme;
  visibleAgentNotes: VisibleAgentNote[];
  viewWidth: number;
  onOpenAgentNotesAtHunk: (hunkIndex: number) => void;
  onSelect: () => void;
}

/** Render one file section in the main review stream. */
function DiffSectionComponent({
  codeHorizontalOffset,
  file,
  headerLabelWidth,
  headerStatsWidth,
  layout,
  selectedHunkIndex,
  shouldLoadHighlight,
  separatorWidth,
  showLineNumbers,
  showHunkHeaders,
  wrapLines,
  showHeader,
  showSeparator,
  theme,
  visibleAgentNotes,
  viewWidth,
  onOpenAgentNotesAtHunk,
  onSelect,
}: DiffSectionProps) {
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

      {showHeader ? (
        <DiffFileHeaderRow
          file={file}
          headerLabelWidth={headerLabelWidth}
          headerStatsWidth={headerStatsWidth}
          theme={theme}
          onSelect={onSelect}
        />
      ) : null}

      <PierreDiffView
        file={file}
        layout={layout}
        showLineNumbers={showLineNumbers}
        showHunkHeaders={showHunkHeaders}
        wrapLines={wrapLines}
        codeHorizontalOffset={codeHorizontalOffset}
        theme={theme}
        width={viewWidth}
        annotatedHunkIndices={annotatedHunkIndices}
        visibleAgentNotes={visibleAgentNotes}
        onOpenAgentNotesAtHunk={onOpenAgentNotesAtHunk}
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
    previous.codeHorizontalOffset === next.codeHorizontalOffset &&
    previous.file === next.file &&
    previous.headerLabelWidth === next.headerLabelWidth &&
    previous.headerStatsWidth === next.headerStatsWidth &&
    previous.layout === next.layout &&
    previous.selectedHunkIndex === next.selectedHunkIndex &&
    previous.shouldLoadHighlight === next.shouldLoadHighlight &&
    previous.separatorWidth === next.separatorWidth &&
    previous.showLineNumbers === next.showLineNumbers &&
    previous.showHunkHeaders === next.showHunkHeaders &&
    previous.wrapLines === next.wrapLines &&
    previous.showHeader === next.showHeader &&
    previous.showSeparator === next.showSeparator &&
    previous.theme === next.theme &&
    previous.visibleAgentNotes === next.visibleAgentNotes &&
    previous.viewWidth === next.viewWidth
  );
});
