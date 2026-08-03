import { memo } from "react";
import type { DiffFile, LayoutMode, UserNoteLineTarget } from "../../../core/types";
import type { FileSourceStatus } from "../../diff/expandCollapsedRows";
import { PierreDiffView, type ActiveAddNoteAffordance } from "../../diff/PierreDiffView";
import type { CursorHighlight } from "../../diff/renderRows";
import type { VisibleBodyBounds } from "../../diff/rowWindowing";
import type { DiffSectionGeometry } from "../../diff/diffSectionGeometry";
import type { VisibleAgentNote } from "../../lib/agentAnnotations";
import type { CopySelectedRowRange } from "./copySelection";
import { diffSectionId } from "../../lib/ids";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";
import { FileView, type FileViewRowFailure } from "./FileView";
import type { ResolvedFileViewLayout } from "../../fileViews/useFileViews";

interface DiffSectionProps {
  codeHorizontalOffset: number;
  expandedGapKeys: ReadonlySet<string>;
  file: DiffFile;
  fileView?: ResolvedFileViewLayout;
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  selectedHunkIndex: number;
  copySelectedRowRanges?: Map<string, CopySelectedRowRange>;
  copySelectedSide?: "left" | "right";
  cursorHighlight?: CursorHighlight;
  shouldLoadHighlight: boolean;
  sectionGeometry?: DiffSectionGeometry;
  separatorWidth: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  sourceStatus: FileSourceStatus | undefined;
  tabWidth: number;
  wrapLines: boolean;
  showHeader: boolean;
  showSeparator: boolean;
  theme: AppTheme;
  visibleAgentNotes: VisibleAgentNote[];
  visibleBodyBounds?: VisibleBodyBounds;
  viewWidth: number;
  hoverActive?: boolean;
  hoverClearSignal?: number;
  onHover: () => void;
  onMouseScroll?: () => void;
  onFileViewRowFailure?: (failure: FileViewRowFailure) => void;
  onActiveAddNoteAffordanceChange?: (affordance: ActiveAddNoteAffordance | null) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  onSelect: () => void;
  onToggleGap: (gapKey: string) => void;
}

/** Render one file section in the main review stream. */
function DiffSectionComponent({
  codeHorizontalOffset,
  expandedGapKeys,
  file,
  fileView,
  headerLabelWidth,
  headerStatsWidth,
  layout,
  selectedHunkIndex,
  copySelectedRowRanges,
  copySelectedSide,
  cursorHighlight,
  shouldLoadHighlight,
  sectionGeometry,
  separatorWidth,
  showLineNumbers,
  showHunkHeaders,
  sourceStatus,
  tabWidth,
  wrapLines,
  showHeader,
  showSeparator,
  theme,
  visibleAgentNotes,
  visibleBodyBounds,
  viewWidth,
  hoverActive = true,
  hoverClearSignal = 0,
  onHover,
  onMouseScroll,
  onFileViewRowFailure,
  onActiveAddNoteAffordanceChange,
  onStartUserNoteAtHunk,
  onSelect,
  onToggleGap,
}: DiffSectionProps) {
  return (
    <box
      id={diffSectionId(file.id)}
      onMouseOver={onHover}
      onMouseScroll={onMouseScroll}
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

      {fileView ? (
        <FileView
          file={file}
          fileView={fileView}
          geometry={
            sectionGeometry ?? {
              bodyHeight: 0,
              hunkAnchorRows: new Map(),
              hunkBounds: new Map(),
              lineNumberDigits: 1,
              plannedRows: [],
              rowBounds: [],
              rowBoundsByKey: new Map(),
              rowBoundsByStableKey: new Map(),
            }
          }
          cursorHighlight={cursorHighlight}
          selectedHunkIndex={selectedHunkIndex}
          theme={theme}
          visibleBodyBounds={visibleBodyBounds}
          width={viewWidth}
          onRowFailure={onFileViewRowFailure}
        />
      ) : (
        <PierreDiffView
          expandedGapKeys={expandedGapKeys}
          file={file}
          layout={layout}
          showLineNumbers={showLineNumbers}
          showHunkHeaders={showHunkHeaders}
          sourceStatus={sourceStatus}
          tabWidth={tabWidth}
          wrapLines={wrapLines}
          codeHorizontalOffset={codeHorizontalOffset}
          copySelectedRowRanges={copySelectedRowRanges}
          copySelectedSide={copySelectedSide}
          cursorHighlight={cursorHighlight}
          theme={theme}
          width={viewWidth}
          visibleAgentNotes={visibleAgentNotes}
          hoverActive={hoverActive}
          hoverClearSignal={hoverClearSignal}
          onHover={onHover}
          onActiveAddNoteAffordanceChange={onActiveAddNoteAffordanceChange}
          onStartUserNoteAtHunk={onStartUserNoteAtHunk}
          onToggleGap={onToggleGap}
          selectedHunkIndex={selectedHunkIndex}
          sectionGeometry={sectionGeometry}
          shouldLoadHighlight={shouldLoadHighlight}
          // The parent review stream owns scrolling across files.
          scrollable={false}
          visibleBodyBounds={visibleBodyBounds}
        />
      )}
    </box>
  );
}

/** Memoize file sections so hunk navigation does not rerender the whole review stream. */
export const DiffSection = memo(DiffSectionComponent, (previous, next) => {
  // This comparator relies on stable upstream object identity for files, visible-note arrays,
  // and visibleBodyBounds: DiffPane reuses the previous bounds object whenever top/height are
  // numerically unchanged, so a reference change here always means the visible slice moved.
  return (
    previous.codeHorizontalOffset === next.codeHorizontalOffset &&
    previous.expandedGapKeys === next.expandedGapKeys &&
    previous.file === next.file &&
    previous.fileView === next.fileView &&
    previous.headerLabelWidth === next.headerLabelWidth &&
    previous.headerStatsWidth === next.headerStatsWidth &&
    previous.layout === next.layout &&
    previous.selectedHunkIndex === next.selectedHunkIndex &&
    previous.copySelectedRowRanges === next.copySelectedRowRanges &&
    previous.copySelectedSide === next.copySelectedSide &&
    previous.cursorHighlight === next.cursorHighlight &&
    previous.shouldLoadHighlight === next.shouldLoadHighlight &&
    previous.sectionGeometry === next.sectionGeometry &&
    previous.separatorWidth === next.separatorWidth &&
    previous.showLineNumbers === next.showLineNumbers &&
    previous.showHunkHeaders === next.showHunkHeaders &&
    previous.sourceStatus === next.sourceStatus &&
    previous.tabWidth === next.tabWidth &&
    previous.wrapLines === next.wrapLines &&
    previous.showHeader === next.showHeader &&
    previous.showSeparator === next.showSeparator &&
    previous.hoverActive === next.hoverActive &&
    previous.hoverClearSignal === next.hoverClearSignal &&
    previous.onMouseScroll === next.onMouseScroll &&
    previous.onFileViewRowFailure === next.onFileViewRowFailure &&
    previous.onActiveAddNoteAffordanceChange === next.onActiveAddNoteAffordanceChange &&
    previous.onStartUserNoteAtHunk === next.onStartUserNoteAtHunk &&
    previous.theme === next.theme &&
    previous.visibleAgentNotes === next.visibleAgentNotes &&
    previous.visibleBodyBounds === next.visibleBodyBounds &&
    previous.viewWidth === next.viewWidth
  );
});
