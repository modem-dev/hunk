import { mergeProps, Show } from "solid-js";
import type { DiffFile, LayoutMode, UserNoteLineTarget } from "../../../core/types";
import type { FileSourceStatus } from "../../diff/expandCollapsedRows";
import { PierreDiffView, type ActiveAddNoteAffordance } from "../../diff/PierreDiffView";
import type { VisibleBodyBounds } from "../../diff/rowWindowing";
import type { DiffSectionGeometry } from "../../diff/diffSectionGeometry";
import type { VisibleAgentNote } from "../../lib/agentAnnotations";
import type { CopySelectedRowRange } from "./copySelection";
import { diffSectionId } from "../../lib/ids";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import { DiffFileHeaderRow } from "./DiffFileHeaderRow";

interface DiffSectionProps {
  codeHorizontalOffset: number;
  expandedGapKeys: ReadonlySet<string>;
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  selectedHunkIndex: number;
  copySelectedRowRanges?: Map<string, CopySelectedRowRange>;
  copySelectedSide?: "left" | "right";
  shouldLoadHighlight: boolean;
  sectionGeometry?: DiffSectionGeometry;
  separatorWidth: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  sourceStatus: FileSourceStatus | undefined;
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
  onActiveAddNoteAffordanceChange?: (affordance: ActiveAddNoteAffordance | null) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  onSelect: () => void;
  onToggleGap: (gapKey: string) => void;
}

/**
 * Render one file section in the main review stream.
 *
 * Solid is fine-grained, so the previous React memo comparator (which relied on
 * stable upstream object identity for `file`, `visibleAgentNotes`, and
 * `visibleBodyBounds`) is unnecessary: bindings update only when the specific
 * values they read change.
 */
export function DiffSection(props: DiffSectionProps) {
  const merged = mergeProps({ hoverActive: true, hoverClearSignal: 0 }, props);
  return (
    <box
      id={diffSectionId(merged.file.id)}
      onMouseOver={merged.onHover}
      onMouseScroll={merged.onMouseScroll}
      style={{
        width: "100%",
        flexDirection: "column",
        backgroundColor: merged.theme.panel,
        overflow: "visible",
      }}
    >
      <Show when={merged.showSeparator}>
        <box
          style={{
            width: "100%",
            height: 1,
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: merged.theme.panel,
          }}
        >
          <text fg={merged.theme.border}>
            {fitText("─".repeat(merged.separatorWidth), merged.separatorWidth)}
          </text>
        </box>
      </Show>

      <Show when={merged.showHeader}>
        <DiffFileHeaderRow
          file={merged.file}
          headerLabelWidth={merged.headerLabelWidth}
          headerStatsWidth={merged.headerStatsWidth}
          theme={merged.theme}
          onSelect={merged.onSelect}
        />
      </Show>

      <PierreDiffView
        expandedGapKeys={merged.expandedGapKeys}
        file={merged.file}
        layout={merged.layout}
        showLineNumbers={merged.showLineNumbers}
        showHunkHeaders={merged.showHunkHeaders}
        sourceStatus={merged.sourceStatus}
        wrapLines={merged.wrapLines}
        codeHorizontalOffset={merged.codeHorizontalOffset}
        copySelectedRowRanges={merged.copySelectedRowRanges}
        copySelectedSide={merged.copySelectedSide}
        theme={merged.theme}
        width={merged.viewWidth}
        visibleAgentNotes={merged.visibleAgentNotes}
        hoverActive={merged.hoverActive}
        hoverClearSignal={merged.hoverClearSignal}
        onHover={merged.onHover}
        onActiveAddNoteAffordanceChange={merged.onActiveAddNoteAffordanceChange}
        onStartUserNoteAtHunk={merged.onStartUserNoteAtHunk}
        onToggleGap={merged.onToggleGap}
        selectedHunkIndex={merged.selectedHunkIndex}
        sectionGeometry={merged.sectionGeometry}
        shouldLoadHighlight={merged.shouldLoadHighlight}
        // The parent review stream owns scrolling across files.
        scrollable={false}
        visibleBodyBounds={merged.visibleBodyBounds}
      />
    </box>
  );
}
