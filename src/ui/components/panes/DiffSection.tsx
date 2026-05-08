import { memo } from "react";
import type { DiffFile, LayoutMode } from "../../../core/types";
import { PierreDiffView } from "../../diff/PierreDiffView";
import type { VisibleBodyBounds } from "../../diff/rowWindowing";
import type { DiffSectionGeometry } from "../../lib/diffSectionGeometry";
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
  sectionGeometry?: DiffSectionGeometry;
  separatorWidth: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  showHeader: boolean;
  showSeparator: boolean;
  theme: AppTheme;
  visibleAgentNotes: VisibleAgentNote[];
  visibleBodyBounds?: VisibleBodyBounds;
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
  sectionGeometry,
  separatorWidth,
  showLineNumbers,
  showHunkHeaders,
  wrapLines,
  showHeader,
  showSeparator,
  theme,
  visibleAgentNotes,
  visibleBodyBounds,
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

      {file.commitHeaderText ? (
        <CommitHeaderBlock text={file.commitHeaderText} theme={theme} />
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
        sectionGeometry={sectionGeometry}
        shouldLoadHighlight={shouldLoadHighlight}
        // The parent review stream owns scrolling across files.
        scrollable={false}
        visibleBodyBounds={visibleBodyBounds}
      />
    </box>
  );
}

/**
 * Render the verbatim commit metadata block above a diff section that opens a new
 * commit. Mirrors the `git log -p` look in `less`: dimmed text, no border or chrome,
 * one trailing blank row to visually separate the message from the diff.
 */
function CommitHeaderBlock({ text, theme }: { text: string; theme: AppTheme }) {
  // Trim trailing newlines and split so we render exactly the captured lines, then
  // add one blank row below to mirror `git log`'s spacing in `less`.
  const lines = text.replace(/\n+$/, "").split("\n");
  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      {lines.map((line, index) => (
        <box key={index} style={{ width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text fg={theme.muted}>{line}</text>
        </box>
      ))}
      <box style={{ width: "100%", height: 1 }} />
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
    previous.sectionGeometry === next.sectionGeometry &&
    previous.separatorWidth === next.separatorWidth &&
    previous.showLineNumbers === next.showLineNumbers &&
    previous.showHunkHeaders === next.showHunkHeaders &&
    previous.wrapLines === next.wrapLines &&
    previous.showHeader === next.showHeader &&
    previous.showSeparator === next.showSeparator &&
    previous.theme === next.theme &&
    previous.visibleAgentNotes === next.visibleAgentNotes &&
    previous.visibleBodyBounds === next.visibleBodyBounds &&
    previous.viewWidth === next.viewWidth
  );
});
